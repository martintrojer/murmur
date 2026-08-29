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
type ExtensionAPI = {
  on(
    event: "agent_start" | "agent_end" | "session_shutdown",
    handler: () => void | Promise<void>,
  ): void;
  getSessionName?(): string | undefined;
};

// `murmur link pi` rewrites this line to an absolute path at install time.
// The bare specifier only resolves when murmur is a dependency of the importer,
// which it never is: the extension is copied into ~/.pi/agent/extensions, and a
// globally linked or installed murmur is not resolvable from there. Falling
// back to the bare specifier keeps a hand-copied extension working inside a
// project that does depend on murmur.
const storeModule = "@martintrojer/murmur/extension-store";
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
        tmux.setState(lastWindow, null);
      } catch {
        // Best effort; the new window's badge matters more than the old one's.
      }
      lastWindow = location.window;
    }
    return location;
  };

  // Three states, and conflating two of them silenced the extension for the
  // life of the process. `undefined` is "not tried yet", a Store is "open", and
  // `null` used to mean both "murmur is not installed, stop trying" and "a
  // write failed, let go of the handle" -- so one transient failure latched the
  // cache off and every later event was dropped while the tmux badge still
  // painted. Observed: an agent stopped reporting mid-session and read as idle
  // for two minutes while it was working.
  //
  // `absent` is now the only permanent answer, and only the import or a missing
  // identity produces it. A dropped handle resets to `undefined`, so the next
  // event reopens.
  let store: Store | null | undefined;
  let absent = false;
  let hostId: string | null = null;
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    queue = queue.then(work, work);
    return queue;
  };

  const getStore = async (): Promise<Store | null> => {
    // Permanent: murmur is not installed, or this node has no identity. Neither
    // becomes true later in the same process, so retrying every event would pay
    // a failed dynamic import per turn forever.
    if (absent) return null;
    if (store !== undefined && store !== null) return store;
    try {
      const { loadIdentity, openStore } = (await import(storeModule)) as StoreModule;
      hostId = loadIdentity()?.host_id ?? null;
      if (!hostId) {
        absent = true;
        store = null;
        return null;
      }
      store = openStore();
      return store;
    } catch {
      absent = true;
      store = null;
      return null;
    }
  };

  // Drop the cached handle, closing it first. The catch in `append` used to
  // just assign null, which left an open SQLite connection to garbage
  // collection while the next event opened another one -- so a peer with a
  // recurring transient write failure leaked a connection and its WAL read
  // state per event, inside a pi process that can run for days. Shared with
  // session_shutdown so there is one way to let go of the store.
  const dropStore = (): void => {
    try {
      store?.close();
    } catch {
      // Best effort: extension failures must never reach pi.
    }
    // Back to "not tried yet", not to "absent". A failed write is usually
    // transient -- a lock held by a concurrent writer, a WAL hiccup -- and the
    // agent has hours of events left to report. `absent` is untouched, so a
    // genuinely missing murmur still stops after one attempt.
    //
    // Belt and braces with the `!== null` guard in getStore: either alone stops
    // the latch, so reverting one keeps the tests green. Both are here because
    // they state different things -- this is "let go of a broken handle", that
    // is "null is not a cached answer".
    store = undefined;
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
      tmux.setState(location.window, "working");
      await append("working", process.pid, location);
    });
  });

  pi.on("agent_end", () => {
    void enqueue(async () => {
      const location = here();
      const state = endState(focused(location.pane), muManaged);
      tmux.setState(location.window, state === "cleared" ? null : state);
      await append(state, null, location);
    });
  });

  pi.on("session_shutdown", async () => {
    await enqueue(async () => {
      const location = here();
      tmux.setState(location.window, null);
      await append("cleared", null, location);
      // Nothing follows a shutdown, so this handle is not coming back: mark it
      // absent so a late event cannot reopen the store on the way out.
      absent = true;
      dropStore();
    });
  });
}
