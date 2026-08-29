import { execFileSync } from "node:child_process";
import type { AgentState } from "./types.js";

export type Location = {
  session: string;
  window: string;
  pane: string;
  session_name: string | null;
  window_name: string | null;
};

export interface Mux {
  currentWindow(): Location | null;
  liveWindows(): Set<string> | null;
  setState(window: string, state: AgentState | null): void;
  attach(session: string, window: string): void;
  windowNames(): Map<string, string>;
  windowForPane(pane: string): string | null;
  windowNamed(name: string): string | null;
  selectWindow(window: string): void;
  capture(pane: string, lines?: number): string | null;
}

function runTmux(args: string[]): string | null {
  try {
    return execFileSync("tmux", args, {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export const tmux: Mux = {
  currentWindow() {
    // $TMUX_PANE is the only trustworthy signal that we are inside a pane, and
    // it is set by tmux for every process in one.
    //
    // Asking tmux instead does not work: `display-message` answers from any
    // process on a machine with a running server, and reports whichever pane
    // that server considers active. A pi started outside tmux -- a bare ssh
    // login, a plain terminal, cron -- would then record itself as living in
    // some unrelated agent's pane and overwrite that agent's state. Falling
    // back to `display-message` here was exactly that bug.
    const pane = process.env.TMUX_PANE;
    if (!pane) return null;

    // One call for ids and names together. The names are recorded on every
    // event because a reader cannot resolve a remote window id against its own
    // tmux, so they have to travel with the event.
    const fields = runTmux([
      "display-message",
      "-t",
      pane,
      "-p",
      "#{session_id}\t#{window_id}\t#{session_name}\t#{window_name}",
    ]);
    const [session, window, sessionName, windowName] = fields?.split("\t") ?? [];
    if (!session || !window) return null;
    return {
      session,
      window,
      pane,
      session_name: sessionName || null,
      window_name: windowName || null,
    };
  },

  // Which of this host's windows still exist. Only the authoring node can
  // answer this, which is why the check runs on export rather than on the
  // reader: a peer holding a `blocked` row for a window that died has nothing
  // to supersede it, and the agent stays in every HUD forever.
  //
  // null means "could not tell" (no tmux server, tmux missing) and is
  // deliberately distinct from an empty set, which means "tmux answered, and
  // there are no windows". Treating the first as the second would clear every
  // agent on the host the moment tmux was unreachable.
  //
  // Unlike currentWindow, this deliberately asks tmux rather than reading the
  // environment, and it is right to: "which windows exist on this host" is a
  // server-wide question with one answer, and export runs over ssh with no
  // pane of its own. currentWindow asks "which pane am I in", which only
  // $TMUX_PANE can answer.
  liveWindows() {
    const out = runTmux(["list-windows", "-a", "-F", "#{window_id}"]);
    if (out === null) return null;
    return new Set(out.split("\n").filter(Boolean));
  },

  setState(window, state) {
    if (state === null) {
      runTmux(["set-window-option", "-qu", "-t", window, "@agent_state"]);
    } else {
      runTmux(["set-window-option", "-q", "-t", window, "@agent_state", state]);
      runTmux(["set-window-option", "-q", "-t", window, "@pane_agent", "1"]);
    }
    runTmux(["refresh-client", "-S"]);
  },

  attach(session, window) {
    // Two steps, because switch-client alone is a no-op when the target window
    // is in the session you are already attached to — which is the common case
    // for a local agent, and why "enter" appeared to do nothing.
    // switch-client moves the client between sessions; select-window moves
    // that session to the right window.
    runTmux(["switch-client", "-t", session]);
    runTmux(["select-window", "-t", window]);
  },

  // Window ids are what the log stores, because they are stable; names are
  // what a human recognises in a picker. Names are live tmux state, not
  // history, so they are resolved at render time rather than recorded.
  windowNames() {
    const out = runTmux(["list-windows", "-a", "-F", "#{window_id}\t#{window_name}"]);
    const names = new Map<string, string>();
    for (const line of out?.split("\n") ?? []) {
      const [id, name] = line.split("\t");
      if (id && name) names.set(id, name);
    }
    return names;
  },

  // First window carrying this exact name, or null. Used to reuse a per-host
  // ssh window instead of opening another one.
  windowNamed(name) {
    const out = runTmux(["list-windows", "-a", "-F", "#{window_id}\t#{window_name}"]);
    for (const line of out?.split("\n") ?? []) {
      const [id, windowName] = line.split("\t");
      if (id && windowName === name) return id;
    }
    return null;
  },

  selectWindow(window) {
    runTmux(["select-window", "-t", window]);
  },

  // The window a pane belongs to, for a pane murmur has no event for. Clearing
  // a badge is a tmux operation and does not require murmur to own the pane.
  windowForPane(pane) {
    return runTmux(["display-message", "-t", pane, "-p", "#{window_id}"]) || null;
  },

  capture(pane, lines) {
    const args = ["capture-pane", "-p", "-t", pane];
    if (lines !== undefined) args.push("-S", `-${lines}`);
    return runTmux(args);
  },
};

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
