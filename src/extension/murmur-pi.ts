import { execFileSync } from "node:child_process";
import { tmux } from "../mux.js";
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
  const location = tmux.currentWindow();
  if (!location) return;

  let store: Store | null | undefined;
  let hostId: string | null = null;
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    queue = queue.then(work, work);
    return queue;
  };

  const getStore = async (): Promise<Store | null> => {
    if (store !== undefined) return store;
    try {
      const { loadIdentity, openStore } = (await import(storeModule)) as StoreModule;
      hostId = loadIdentity()?.host_id ?? null;
      if (!hostId) {
        store = null;
        return store;
      }
      store = openStore();
      return store;
    } catch {
      store = null;
      return store;
    }
  };

  const append = async (state: AgentState, pid: number | null): Promise<void> => {
    try {
      const currentStore = await getStore();
      if (!currentStore || !hostId) return;
      currentStore.append({
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
      store = null;
    }
  };

  pi.on("agent_start", () => {
    void enqueue(async () => {
      tmux.setState(location.window, "working");
      await append("working", process.pid);
    });
  });

  pi.on("agent_end", () => {
    void enqueue(async () => {
      const state = endState(focused(location.pane), muManaged);
      tmux.setState(location.window, state === "cleared" ? null : state);
      await append(state, null);
    });
  });

  pi.on("session_shutdown", async () => {
    await enqueue(async () => {
      tmux.setState(location.window, null);
      await append("cleared", null);
      try {
        store?.close();
      } catch {
        // Best effort: extension failures must never reach pi.
      }
      store = null;
    });
  });
}
