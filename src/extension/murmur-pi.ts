import { execFileSync } from "node:child_process";
import { tmux } from "../mux.js";
import type { Store } from "../store.js";
import type { Activity, AgentMeta, Location } from "../types.js";
import { driverFromEnv, settledState } from "./decide.js";
import type { StoreModule } from "./store-api.js";

// Declared here rather than imported: murmur must not depend on pi to build,
// and this is the whole surface the extension touches. getSessionName is
// optional because an older pi does not have it, and a missing method must
// degrade to "no name" rather than break the extension.
//
// The five events murmur needs, and no `reason` on any of them. pi puts a reason
// on session_shutdown ("quit" | "reload" | "new" | "resume" | "fork"), but the
// correct response is the same for all five: release the agent, clear the badge,
// drop the store handle. What differs is only whether anything follows, and
// session_start answers that by firing.
type ExtensionAPI = {
  on(
    event: "agent_start" | "agent_end" | "agent_settled" | "session_shutdown" | "session_start",
    handler: () => void | Promise<void>,
  ): void;
  getSessionName?(): string | undefined;
};

// Where to import the store from.
//
// The bare specifier only resolves when murmur is a dependency of the importer,
// which it never is: the extension is loaded from ~/.pi/agent/extensions, and a
// globally linked or installed murmur is not resolvable from there. Unpinned,
// the import throws, getStore swallows it, and every write silently no-ops
// while the tmux badge still paints -- so nothing looks broken while the store
// stays empty and the node exports nothing.
//
// Two ways it gets pinned, because there are two install shapes:
//
//   $MURMUR_STORE_MODULE  set by the shim `murmur link pi` writes, which is a
//                         re-export of THIS file from the murmur install. The
//                         shim cannot rewrite this constant (it does not copy
//                         the source), so it passes the path instead.
//   link pi --copy        inlines this file and rewrites the string literal.
const storeModule = process.env.MURMUR_STORE_MODULE || "@martintrojer/murmur/extension-store";
const muManaged = process.env.MU_MANAGED_AGENT === "1";
const driver = driverFromEnv(process.env);

function focused(pane: string): boolean {
  try {
    return (
      execFileSync(
        "tmux",
        [
          "display-message",
          "-t",
          pane,
          "-p",
          "#{&&:#{pane_active},#{&&:#{window_active},#{session_attached}}}",
        ],
        { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
      ).trim() === "1"
    );
  } catch {
    return false;
  }
}

// pi.getSessionName() is a live read and a session can be unnamed, so this must
// never be the reason a report is lost.
function safeSessionName(pi: ExtensionAPI): string | null {
  try {
    return pi.getSessionName?.() || null;
  } catch {
    return null;
  }
}

export default function murmurPi(pi: ExtensionAPI): void {
  const startLocation = tmux.currentWindow();
  if (!startLocation) return;

  /**
   * Where this agent is NOW, not where it started.
   *
   * A pane can be moved between windows -- `move-pane`, `break-pane`, or a
   * keybinding that wraps them -- and tmux keeps the pane id while the window
   * id changes. Resolving the window once at startup meant an agent that was
   * moved painted its badge on the window it used to live in and recorded a
   * stale location on every later write.
   *
   * The pane is the address and does not change, so the agent row stays put;
   * only the location is re-read. Falls back to the startup location if tmux
   * cannot answer, which keeps a transient failure from rewriting an agent's
   * address to nothing.
   */
  let lastWindow = startLocation.window;
  const here = (): Location => {
    const location = tmux.currentWindow() ?? startLocation;
    // A move leaves the badge behind on the window the agent used to be in,
    // where nothing else will ever clear it: the badge belongs to the window,
    // and the only process that knows this agent left is this one.
    if (location.window !== lastWindow) {
      try {
        tmux.setWindowBadge(lastWindow, null);
      } catch {
        // Best effort; the new window's badge matters more than the old one's.
      }
      lastWindow = location.window;
    }
    return location;
  };

  const meta = (): AgentMeta => ({
    // mu names its agents; pi names its sessions. Both beat a window name when
    // present, and neither can be recovered from tmux.
    agent_name: process.env.MU_AGENT_NAME ?? null,
    pi_session: safeSessionName(pi),
    workstream: process.env.MU_WORKSTREAM ?? null,
    role: process.env.MU_ROLE ?? null,
    cli: "pi",
    driver,
  });

  /**
   * One variable, three named states, so the combinations that must not exist
   * cannot be written down.
   *
   * This was a `Store | null | undefined` plus a separate `absent` boolean --
   * six combinations for three meanings -- and conflating two of them silenced
   * the extension for the life of the process: `null` meant both "murmur is not
   * installed, stop trying" and "a write failed, let go of the handle", so one
   * transient failure latched reporting off while the tmux badge still painted.
   *
   * Only `absent` is permanent, and only a failed import, a missing identity or
   * a REFUSED claim produces it. A dropped handle returns to `untried`, so the
   * next event reopens.
   */
  type StoreState = { kind: "untried" } | { kind: "open"; store: Store } | { kind: "absent" };
  let state: StoreState = { kind: "untried" };
  /**
   * This process is nested, permanently and unrecoverably.
   *
   * Separate from `absent`, which `session_start` re-arms: a missing murmur and
   * a missing identity are both fixable from outside a running pi, but a second
   * live process in one pane never becomes the owner. Re-arming that would let a
   * nested pi start reporting as the parent agent after the first /reload.
   */
  let refused = false;
  /** This process's agent row, for the life of the process. */
  let agentId: string | null = null;
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    queue = queue.then(work, work);
    return queue;
  };

  const dropStore = (): void => {
    if (state.kind === "open") {
      try {
        state.store.close();
      } catch {
        // Best effort: extension failures must never reach pi.
      }
    }
    state = { kind: "untried" };
  };

  /**
   * Open the store and claim the pane, in that order, once.
   *
   * `refused` is the nested-agent case, and it is permanent for this process: a
   * pi launched inside an agent's pane inherits $TMUX_PANE and would otherwise
   * report AS the parent agent. Six pids once wrote to one pane that way and the
   * parent read as idle while it was working. The claim's liveness probe answers
   * this with the database rather than with an environment marker a process
   * launched in an unusual way could drop -- and a refused caller registers
   * nothing, paints nothing, and says nothing.
   */
  const getStore = async (): Promise<Store | null> => {
    // Permanent: murmur is not installed, this node has no identity, or this
    // process is nested. None becomes false later in the same process, so
    // retrying would pay a failed dynamic import per turn forever.
    // `session_start` re-arms it, because the first two ARE fixable from
    // outside a running pi.
    if (state.kind === "absent") return null;
    if (refused) return null;
    if (state.kind === "open") return state.store;
    try {
      const { loadIdentity, openStore } = (await import(storeModule)) as StoreModule;
      // Read, never minted: an extension load must not bring a node into
      // existence.
      if (!loadIdentity()) {
        state = { kind: "absent" };
        return null;
      }
      const store = openStore();
      const claim = store.claimAgent({
        location: here(),
        owner_pid: process.pid,
        meta: meta(),
      });
      if (claim.outcome === "refused") {
        store.close();
        refused = true;
        state = { kind: "absent" };
        return null;
      }
      // `retained` is what makes /reload a no-op: pi re-runs this factory in the
      // same process, and the store recognises our own pid.
      agentId = claim.agent_id;
      state = { kind: "open", store };
      return store;
    } catch {
      state = { kind: "absent" };
      return null;
    }
  };

  /**
   * Report activity. Never touches attention, never touches owner metadata.
   *
   * `setActivity` returning false is not an error and is not retried: it means
   * this process is no longer the owner of record, and the correct response is
   * silence.
   */
  const report = async (activity: Activity, location: Location): Promise<void> => {
    try {
      const store = await getStore();
      if (!store || !agentId) return;
      store.setActivity({ agent_id: agentId, owner_pid: process.pid, activity, location });
    } catch {
      dropStore();
    }
  };

  /**
   * Claim the pane NOW, not on the first event.
   *
   * A nested process must paint no badge, and the badge is painted by the same
   * handler that reports -- so ownership has to be settled before any handler
   * can run.
   *
   * ONE DEVIATION FROM THE CONTRACT, stated because it is visible: §9.1 says a
   * refused process registers no handlers. It cannot, quite. The store arrives
   * through a dynamic `import()` of a path pinned at runtime, so the claim is
   * asynchronous, and pi's extension factory is not -- handlers must be attached
   * before the first `await` resolves or the extension misses events it does own.
   *
   * The observable behaviour is identical, which is what the contract is
   * actually about: the claim goes on the queue that already serialises every
   * handler, so each handler runs after it, and a refused process writes
   * nothing, paints nothing and holds no store handle. `refused` is checked in
   * both places that could act -- the badge and the store -- rather than being
   * relied on to be checked once.
   */
  void enqueue(async () => {
    await getStore();
  });

  /** Paint only if we own the pane. A nested agent is deliberately invisible. */
  const badge = (location: Location, state: "running" | null): void => {
    if (refused) return;
    tmux.setWindowBadge(location.window, state);
  };

  pi.on("agent_start", () => {
    void enqueue(async () => {
      const location = here();
      badge(location, "running");
      await report("running", location);
    });
  });

  pi.on("agent_end", () => {
    void enqueue(async () => {
      const location = here();
      badge(location, null);
      await report("stopped", location);
    });
  });

  // The event that produces `done`. agent_end alone cannot express it: agent_end
  // fires when a run's loop ends, which is not the same as "nothing more will
  // happen" -- pi re-enters the loop for a retry, a compaction, or a queued
  // message, and each re-entry emits its own start/end pair. Only
  // `agent_settled` means finished and waiting. See the table in decide.ts.
  pi.on("agent_settled", () => {
    void enqueue(async () => {
      const location = here();
      const settled = settledState(focused(location.pane), muManaged);
      if (settled === null) return;
      try {
        const store = await getStore();
        if (!store || refused) return;
        // Attention is pane-addressed, and this call structurally cannot name an
        // agent, a pid or an activity. Completion is `done`; `blocked` is never
        // authored by an owner.
        store.requestAttention({
          kind: settled,
          location,
          message: "",
          source: "pi",
        });
        tmux.setWindowBadge(location.window, settled);
      } catch {
        dropStore();
      }
    });
  });

  // `session_shutdown` does not mean "the process is exiting". pi fires it for
  // `/reload`, and for session switch, resume and fork, then rebinds and keeps
  // going -- its own docs say to clean up here and reestablish in
  // `session_start`. Treating it as terminal killed reporting permanently on
  // the first `/reload`.
  //
  // Releasing the agent deletes the row but deliberately NOT its attention: a
  // `done` raised at settle must survive the process quitting, or completion
  // becomes invisible the moment the agent exits.
  pi.on("session_shutdown", async () => {
    await enqueue(async () => {
      const location = here();
      badge(location, null);
      try {
        if (state.kind === "open" && agentId) {
          state.store.releaseAgent({ agent_id: agentId, owner_pid: process.pid });
        }
      } catch {
        // The handle goes either way.
      }
      agentId = null;
      dropStore();
    });
  });

  // Reestablish, per pi's documented contract. A reload leaves this instance
  // live but with its store dropped and its cached location possibly wrong --
  // the pane can have moved while the session was being switched.
  pi.on("session_start", () => {
    void enqueue(async () => {
      if (state.kind === "absent") state = { kind: "untried" };
      const location = here();
      lastWindow = location.window;
    });
  });
}
