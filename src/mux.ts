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
  // Reports whether the attach actually happened. runTmux swallows failures to
  // return null, and a jump that silently failed looked exactly like "enter did
  // nothing" -- the symptom the remote probe was added to prevent, reproduced
  // on the local path.
  attach(session: string, window: string): boolean;
  windowNames(): Map<string, string>;
  windowForPane(pane: string): string | null;
  panesInWindow(window: string): string[];
  windowNamed(name: string): string | null;
  selectWindow(window: string): boolean;
  newWindow(name: string, command: string): boolean;
  capture(pane: string, lines?: number): string | null;
  // --- remote-jump session seam -------------------------------------------
  // A remote attach lives in its own local session rather than a window, so it
  // can be full-screen (no local status bar) and prefix-free (no nested ^b).
  // See jumpToAgent for why that is worth five extra methods.
  clientName(): string | null;
  currentTarget(): string | null;
  sessionNamed(name: string): boolean;
  newSession(name: string, command: string): boolean;
  setSessionOption(session: string, option: string, value: string): void;
  switchClient(client: string | null, session: string): boolean;
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

/**
 * A session name as an exact target, in the two spellings tmux needs.
 *
 * Bare names match by PREFIX, so a wrapper for host `bub` silently retargets a
 * session called `bubba` once one exists -- verified, and it sets options on
 * the wrong session rather than failing. A leading `=` demands an exact match.
 * (`name=` is not the syntax; it reads as part of the name and matches nothing.)
 *
 * The trailing colon is the part that is easy to get wrong. `switch-client -t`
 * takes a target-SESSION, where `=name` is right, but `set-option -t` and
 * `show-options -t` take a target-PANE, where `=name` fails outright with `no
 * such session` and the exact form is `=name:` -- the empty window/pane part
 * resolving to the session's current pane.
 *
 * Neither rescues a name starting with `@`, `$` or `%`: those introduce tmux's
 * window, session and pane id syntax. remoteSessionName keeps them out.
 */
export function exactSession(session: string): string {
  return `=${session}`;
}

export function exactPane(session: string): string {
  return `=${session}:`;
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
    //
    // Only select-window decides the result. switch-client legitimately fails
    // when there is no client to switch (running outside tmux), and treating
    // that as a failed jump would report an error for a working attach.
    runTmux(["switch-client", "-t", session]);
    return runTmux(["select-window", "-t", window]) !== null;
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
  // Sibling panes, for deciding whether an unowned pane may clear the window's
  // badge. A window holding an agent and a shell must not lose the badge when
  // you focus the shell.
  panesInWindow(window) {
    const out = runTmux(["list-panes", "-t", window, "-F", "#{pane_id}"]);
    return out?.split("\n").filter(Boolean) ?? [];
  },

  windowNamed(name) {
    const out = runTmux(["list-windows", "-a", "-F", "#{window_id}\t#{window_name}"]);
    for (const line of out?.split("\n") ?? []) {
      const [id, windowName] = line.split("\t");
      if (id && windowName === name) return id;
    }
    return null;
  },

  selectWindow(window) {
    return runTmux(["select-window", "-t", window]) !== null;
  },

  newWindow(name, command) {
    return runTmux(["new-window", "-n", name, command]) !== null;
  },

  // Which client to send home when the remote attach exits. `switch-client`
  // with no -c moves whichever client tmux considers current, and `murmur pick`
  // usually runs in a popup -- a client of its own, which dies with the popup.
  // Naming the real client is what lets the return outlive the picker.
  clientName() {
    return runTmux(["display-message", "-p", "#{client_name}"]) || null;
  },

  // Where the jump started, as a switch-client target. Window-level, not just
  // the session: coming back to the right session but the wrong window is
  // still the wrong place. The window id is stable where its index is not,
  // since renumber-windows renumbers on every close.
  currentTarget() {
    return runTmux(["display-message", "-p", "#{session_name}:#{window_id}"]) || null;
  },

  // Whether a wrapper session for this host already exists. Deliberately not
  // returning an id: a session is addressed by name, so a `#{session_id}` would
  // only have to be turned back into one.
  sessionNamed(name) {
    const out = runTmux(["list-sessions", "-F", "#{session_name}"]);
    if (out === null) return false;
    return out.split("\n").includes(name);
  },

  newSession(name, command) {
    // Detached, because the caller sets the per-session options before showing
    // it. Creating it attached would paint one frame with the local status bar
    // up and the local prefix live, which is the flicker this design exists to
    // remove.
    return runTmux(["new-session", "-d", "-s", name, command]) !== null;
  },

  setSessionOption(session, option, value) {
    runTmux(["set-option", "-t", exactPane(session), option, value]);
  },

  switchClient(client, session) {
    const target = exactSession(session);
    const args = client
      ? ["switch-client", "-c", client, "-t", target]
      : ["switch-client", "-t", target];
    return runTmux(args) !== null;
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
