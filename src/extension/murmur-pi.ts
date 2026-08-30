import { execFileSync } from "node:child_process";
import { type Location, tmux } from "../mux.js";
import type { Store } from "../store.js";
import type { AgentState } from "../types.js";
import { driverFromEnv, endState } from "./decide.js";
import type { StoreModule } from "./store-api.js";

// Declared here rather than imported: murmur must not depend on pi to build,
// and this is the whole surface the extension touches. getSessionName is
// optional because an older pi does not have it, and a missing method must
// degrade to "no name" rather than break the extension.
// The four events murmur needs, and no `reason` on any of them.
//
// pi puts a reason on session_shutdown ("quit" | "reload" | "new" | "resume" |
// "fork"), but the correct response is the same for all five: clear the badge,
// record the clear, drop the store handle. What differs is only whether
// anything follows, and session_start answers that by firing -- so branching on
// the reason would be a second, weaker way to learn the same thing.
type ExtensionAPI = {
  on(
    event: "agent_start" | "agent_end" | "session_shutdown" | "session_start",
    handler: () => void | Promise<void>,
  ): void;
  getSessionName?(): string | undefined;
};

// Where to import the store from.
//
// The bare specifier only resolves when murmur is a dependency of the importer,
// which it never is: the extension is loaded from ~/.pi/agent/extensions, and a
// globally linked or installed murmur is not resolvable from there. Unpinned,
// the import throws, getStore swallows it, and every append silently no-ops
// while the tmux badge still paints -- so nothing looks broken while the log
// stays empty and the node exports nothing.
//
// Two ways it gets pinned, because there are two install shapes:
//
//   $MURMUR_STORE_MODULE  set by the shim `murmur link pi` writes, which is a
//                         re-export of THIS file from the murmur install. The
//                         shim cannot rewrite this constant (it does not copy
//                         the source), so it passes the path instead.
//   link pi --copy        inlines this file and rewrites the string literal.
//
// The bare specifier remains the fallback, which keeps a hand-copied extension
// working inside a project that really does depend on murmur.
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
// never be the reason an event is lost.
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
   * moved painted its badge on the window it used to live in, recorded a stale
   * window on every later event, and became unjumpable: `liveWindows()` prunes
   * rows whose window is gone, so closing the old window deleted a live agent.
   *
   * The pane is the identity and does not change, so `agent_id` stays stable
   * across a move; only the location is re-read. Falls back to the startup
   * location if tmux cannot answer, which keeps a transient failure from
   * rewriting an agent's address to nothing.
   */
  let lastWindow = startLocation.window;
  const here = (): Location => {
    const location = tmux.currentWindow() ?? startLocation;
    // A move leaves the badge behind on the window the agent used to be in,
    // where nothing else will ever clear it: the badge belongs to the window,
    // and the only process that knows this agent left is this one. Verified
    // against real tmux -- a `working` glyph sat on an agent-less window, and
    // the status bar and tms picker both read it.
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

  // One variable, three named states, so the combinations that must not exist
  // cannot be written down.
  //
  // This was a `Store | null | undefined` plus a separate `absent` boolean --
  // six combinations for three meanings -- and conflating two of them silenced
  // the extension for the life of the process: `null` meant both "murmur is not
  // installed, stop trying" and "a write failed, let go of the handle", so one
  // transient failure latched the cache off and every later event was dropped
  // while the tmux badge still painted.
  //
  // Only `absent` is permanent, and only a failed import or a missing identity
  // produces it. A dropped handle returns to `untried`, so the next event
  // reopens.
  type StoreState = { kind: "untried" } | { kind: "open"; store: Store } | { kind: "absent" };
  let state: StoreState = { kind: "untried" };
  let hostId: string | null = null;
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    queue = queue.then(work, work);
    return queue;
  };

  const getStore = async (): Promise<Store | null> => {
    // Permanent: murmur is not installed, or this node has no identity. Neither
    // becomes true later in the same process, so retrying every event would pay
    // a failed dynamic import per turn forever. `session_start` re-arms it,
    // because both ARE fixable from outside a running pi.
    if (state.kind === "absent") return null;
    if (state.kind === "open") return state.store;
    try {
      const { loadIdentity, openStore } = (await import(storeModule)) as StoreModule;
      hostId = loadIdentity()?.host_id ?? null;
      if (!hostId) {
        state = { kind: "absent" };
        return null;
      }
      state = { kind: "open", store: openStore() };
      return state.store;
    } catch {
      state = { kind: "absent" };
      return null;
    }
  };

  // Drop the cached handle, closing it first. The catch in `append` used to
  // just assign null, which left an open SQLite connection to garbage
  // collection while the next event opened another one -- so a peer with a
  // recurring transient write failure leaked a connection and its WAL read
  // state per event, inside a pi process that can run for days. Shared with
  // session_shutdown so there is one way to let go of the store.
  // Close the handle and go back to "not tried yet". A failed write is usually
  // transient -- a lock held by a concurrent writer, a WAL hiccup -- and the
  // agent has hours of events left to report, so the next one must reopen.
  // Never sets `absent`: that is reserved for "murmur is not here at all".
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

  const append = async (
    state: AgentState,
    pid: number | null,
    location: Location,
  ): Promise<void> => {
    try {
      const currentStore = await getStore();
      if (!currentStore || !hostId) return;
      currentStore.append({
        // The PANE is the identity and survives a move between windows; the
        // window is only where it currently lives.
        agent_id: `${hostId}:${location.pane}`,
        session: location.session,
        window: location.window,
        pane: location.pane,
        session_name: location.session_name,
        window_name: location.window_name,
        // mu names its agents; pi names its sessions. Both beat a window name
        // when present, and neither can be recovered from tmux.
        agent_name: process.env.MU_AGENT_NAME ?? null,
        pi_session: safeSessionName(pi),
        workstream: process.env.MU_WORKSTREAM ?? null,
        role: process.env.MU_ROLE ?? null,
        cli: "pi",
        driver,
        kind: "state",
        state,
        message: "",
        pid,
        synthetic: false,
        reason: "",
        extra: {},
      });
    } catch {
      dropStore();
    }
  };

  pi.on("agent_start", () => {
    void enqueue(async () => {
      const location = here();
      tmux.setWindowBadge(location.window, "working");
      await append("working", process.pid, location);
    });
  });

  pi.on("agent_end", () => {
    void enqueue(async () => {
      const location = here();
      const state = endState(focused(location.pane), muManaged);
      tmux.setWindowBadge(location.window, state === "cleared" ? null : state);
      await append(state, null, location);
    });
  });

  // `session_shutdown` does not mean "the process is exiting". pi fires it for
  // `/reload`, and for session switch, resume and fork, then rebinds and keeps
  // going -- its own docs say to clean up here and reestablish in
  // `session_start`. Treating it as terminal killed reporting permanently on
  // the first `/reload`: events kept firing, every one was dropped, and the
  // tmux badge still painted, so the agent looked fine and recorded nothing.
  // Observed live, twice.
  pi.on("session_shutdown", async () => {
    await enqueue(async () => {
      const location = here();
      tmux.setWindowBadge(location.window, null);
      await append("cleared", null, location);
      // Always let go of the handle: on a quit nothing follows, and on a
      // reload the store must be reopened rather than reused across the
      // rebind.
      dropStore();
    });
  });

  // Reestablish, per pi's documented contract. A reload leaves this instance
  // live but with its store dropped and its cached location possibly wrong --
  // the pane can have moved while the session was being switched. Re-resolving
  // here means the first event after a reload is already correct rather than
  // being the one that discovers the move.
  pi.on("session_start", () => {
    void enqueue(async () => {
      if (state.kind === "absent") state = { kind: "untried" };
      const location = here();
      lastWindow = location.window;
    });
  });
}
