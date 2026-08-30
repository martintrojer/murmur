import { execFileSync } from "node:child_process";
import {
  asPaneId,
  asSessionId,
  asWindowId,
  type PaneId,
  type SessionId,
  type WindowId,
} from "./ids.js";
import type { Location } from "./types.js";
import type { RenderState } from "./view.js";

export interface Mux {
  currentWindow(): Location | null;
  livePanes(): Set<PaneId> | null;
  // Sets `@agent_state` on a WINDOW, even though the attention it expresses
  // belongs to a pane. The asymmetry is tmux's: the status bar and the `tms`
  // picker read a window option, and there is no per-pane equivalent they
  // would read instead. Its consequence is that a pane moving between windows
  // must clear the badge it left behind, since nothing else knows it moved.
  setWindowBadge(window: WindowId, state: RenderState | null): void;
  // Reports whether the attach actually happened. runTmux swallows failures to
  // return null, and a jump that silently failed looked exactly like "enter did
  // nothing" -- the symptom the remote probe was added to prevent, reproduced
  // on the local path.
  attach(session: SessionId, window: WindowId): boolean;
  windowForPane(pane: PaneId): WindowId | null;
  panesInWindow(window: WindowId): PaneId[];
  capture(pane: PaneId, lines?: number): string | null;
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
 *
 * Both take a session NAME -- not a SessionId, which is why neither is branded.
 * `exactPaneTarget` is named for what it RETURNS, a tmux target-pane, because
 * what it takes and what it produces are different things and the old name
 * `exactPane` read as though it took a pane.
 */
/**
 * The window name worth RECORDING, given tmux's own answer and whether tmux is
 * renaming that window itself.
 *
 * Null while `automatic-rename` is on -- which is tmux's DEFAULT -- because the
 * name is then just the foreground process. The picker's `agent` column showed
 * `Python`, `node` and `zsh` for real agents: pi's own interpreter, labelled
 * "agent".
 *
 * A name nobody chose is not a name, and recording it as one is worse than
 * recording nothing: `agentLabel` prefers the window over the session, so a
 * process name shadowed `hacking/murmur` -- the string the reader actually
 * searches on. Dropped at the point of RECORDING rather than at render, so
 * every surface, and every peer reading this node's snapshot, agrees on what
 * counts as a name.
 *
 * Split out of `currentWindow` to be testable: that method shells out to a real
 * tmux server, so the decision had no reachable seam and the format string was
 * the only thing a test could have asserted on.
 */
export function chosenWindowName(
  name: string | undefined,
  autoRename: string | undefined,
): string | null {
  if (autoRename === "1") return null;
  return name || null;
}

export function exactSession(session: string): string {
  return `=${session}`;
}

export function exactPaneTarget(session: string): string {
  return `=${session}:`;
}

export function tmuxBadgeState(state: RenderState): string {
  // @agent_state is consumed by existing tmux configuration, whose public
  // vocabulary calls active work "working". Keep the internal activity named
  // "running" without forcing a coordinated config rollout.
  return state === "running" ? "working" : state;
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
    const raw = process.env.TMUX_PANE;
    if (!raw) return null;
    const pane = asPaneId(raw);

    // One call for ids and names together. The names travel with every row a
    // snapshot carries, because a reader cannot resolve a remote session or
    // window id against its own tmux.
    const fields = runTmux([
      "display-message",
      "-t",
      pane,
      "-p",
      "#{session_id}\t#{window_id}\t#{session_name}\t#{window_name}\t#{?automatic-rename,1,0}",
    ]);
    const [session, window, sessionName, windowName, autoRename] = fields?.split("\t") ?? [];
    if (!session || !window) return null;
    return {
      session: asSessionId(session),
      window: asWindowId(window),
      pane,
      session_name: sessionName || null,
      window_name: chosenWindowName(windowName, autoRename),
    };
  },

  // Which of this host's PANES still exist. The only liveness question tmux is
  // ever asked, and the one that matches how an agent is addressed: a pane keeps
  // its id when it moves between windows, so a recorded window id can be gone
  // while the agent is very much alive.
  //
  // null means tmux could not answer; an empty set means it did and there are
  // none. Conflating the two would delete every agent on the host the moment
  // tmux was briefly unreachable.
  livePanes() {
    const out = runTmux(["list-panes", "-a", "-F", "#{pane_id}"]);
    if (out === null) return null;
    return new Set(out.split("\n").filter(Boolean).map(asPaneId));
  },

  setWindowBadge(window, state) {
    if (state === null) {
      runTmux(["set-window-option", "-qu", "-t", window, "@agent_state"]);
    } else {
      runTmux(["set-window-option", "-q", "-t", window, "@agent_state", tmuxBadgeState(state)]);
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

  // Sibling panes, for deciding whether an unowned pane may clear the window's
  // badge. A window holding an agent and a shell must not lose the badge when
  // you focus the shell.
  panesInWindow(window) {
    const out = runTmux(["list-panes", "-t", window, "-F", "#{pane_id}"]);
    return out?.split("\n").filter(Boolean).map(asPaneId) ?? [];
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
    runTmux(["set-option", "-t", exactPaneTarget(session), option, value]);
  },

  switchClient(client, session) {
    const target = exactSession(session);
    const args = client
      ? ["switch-client", "-c", client, "-t", target]
      : ["switch-client", "-t", target];
    return runTmux(args) !== null;
  },

  // The window a pane belongs to, for a pane murmur holds no row for. Clearing
  // a badge is a tmux operation and does not require murmur to own the pane.
  windowForPane(pane) {
    const out = runTmux(["display-message", "-t", pane, "-p", "#{window_id}"]);
    return out ? asWindowId(out) : null;
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
