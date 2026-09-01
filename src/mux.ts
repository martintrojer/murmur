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
  // Sets `@agent_state` on a WINDOW though the attention belongs to a pane. The
  // asymmetry is tmux's: the status bar and the `tms` picker read a window
  // option and there is no per-pane equivalent. The consequence is that a pane
  // moving between windows must clear the badge it left behind, since nothing
  // else knows it moved.
  setWindowBadge(window: WindowId, state: RenderState | null): void;
  // Reports whether the attach happened. runTmux swallows failures into null,
  // and a silently failed jump looked exactly like "enter did nothing" -- the
  // symptom the remote probe exists to prevent, reproduced locally.
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
 * The window name worth RECORDING, given tmux's own answer and whether tmux is
 * renaming that window itself.
 *
 * Null while `automatic-rename` is on -- tmux's DEFAULT -- because the name is
 * then just the foreground process: the picker's `agent` column showed `Python`,
 * `node` and `zsh` for real agents.
 *
 * A name nobody chose is not a name, and recording it as one is worse than
 * recording nothing, because `agentLabel` prefers the window over the session,
 * so a process name shadowed `hacking/murmur` -- the string the reader searches
 * on. Dropped at RECORDING rather than at render, so every surface and every
 * peer agrees on what counts as a name.
 *
 * Split out of `currentWindow` to be testable: that method shells out to a real
 * tmux server, leaving the format string as the only thing a test could assert.
 */
export function chosenWindowName(
  name: string | undefined,
  autoRename: string | undefined,
): string | null {
  if (autoRename === "1") return null;
  return name || null;
}

/**
 * A session NAME as an exact target, in the two spellings tmux needs. Neither
 * takes a SessionId, which is why neither is branded.
 *
 * Bare names match by PREFIX, so a wrapper for host `bub` silently retargets a
 * session called `bubba` once one exists -- verified, and it sets options on the
 * wrong session rather than failing. A leading `=` demands an exact match.
 * (`name=` is not the syntax: it reads as part of the name and matches nothing.)
 *
 * The trailing colon is the easy part to get wrong. `switch-client -t` takes a
 * target-SESSION, where `=name` is right; `set-option -t` and `show-options -t`
 * take a target-PANE, where `=name` fails with `no such session` and the exact
 * form is `=name:`, the empty window/pane part resolving to the current pane.
 * Hence `exactPaneTarget` being named for what it RETURNS.
 *
 * Neither rescues a name starting with `@`, `$` or `%`, which introduce tmux's
 * id syntax. `remoteSessionName` keeps those out.
 */
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
    // tmux sets it for every process in one.
    //
    // Asking tmux does not work: `display-message` answers from any process on a
    // machine with a running server, reporting whichever pane that server
    // considers active. A pi started outside tmux -- bare ssh, a plain terminal,
    // cron -- would record itself in some unrelated agent's pane and overwrite
    // that agent's state. Falling back to `display-message` was exactly that bug.
    const raw = process.env.TMUX_PANE;
    if (!raw) return null;
    const pane = asPaneId(raw);

    // One call for ids and names together. Names travel with every snapshot row,
    // because a reader cannot resolve a remote id against its own tmux.
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

  // Which of this host's PANES still exist: the only liveness question tmux is
  // asked, and the one matching how an agent is addressed, since a pane keeps its
  // id across windows while a recorded window id can be gone with the agent
  // alive.
  //
  // null means tmux could not answer, an empty set means there are none.
  // Conflating them would delete every agent the moment tmux was unreachable.
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
    // Two steps: switch-client moves the client between sessions, select-window
    // moves that session to the right window. switch-client alone is a no-op
    // when the target is in the session you are already attached to -- the
    // common case for a local agent, and why "enter" appeared to do nothing.
    //
    // Only select-window decides the result: switch-client legitimately fails
    // when there is no client to switch (outside tmux), and treating that as a
    // failed jump would report an error for a working attach.
    runTmux(["switch-client", "-t", session]);
    return runTmux(["select-window", "-t", window]) !== null;
  },

  // Sibling panes, for deciding whether an unowned pane may clear the window's
  // badge: a window holding an agent and a shell must keep it when you focus
  // the shell.
  panesInWindow(window) {
    const out = runTmux(["list-panes", "-t", window, "-F", "#{pane_id}"]);
    return out?.split("\n").filter(Boolean).map(asPaneId) ?? [];
  },

  // Which client to send home when the remote attach exits. `switch-client`
  // without -c moves whichever client tmux considers current, and the picker
  // usually runs in a popup -- its own client, which dies with the popup. Naming
  // the real client is what lets the return outlive the picker.
  clientName() {
    return runTmux(["display-message", "-p", "#{client_name}"]) || null;
  },

  // Where the jump started, as a switch-client target. Window-level, since the
  // right session and the wrong window is still the wrong place. The window id
  // is stable where its index is not, renumber-windows renumbering on close.
  currentTarget() {
    return runTmux(["display-message", "-p", "#{session_name}:#{window_id}"]) || null;
  },

  // Whether a wrapper session for this host exists. Returns no id on purpose: a
  // session is addressed by name, so a `#{session_id}` would only be converted
  // back into one.
  sessionNamed(name) {
    const out = runTmux(["list-sessions", "-F", "#{session_name}"]);
    if (out === null) return false;
    return out.split("\n").includes(name);
  },

  newSession(name, command) {
    // Detached, because the caller sets the per-session options before showing
    // it: attached would paint one frame with the local status bar up and the
    // local prefix live, the flicker this design exists to remove.
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

  // The window a pane belongs to, for a pane murmur holds no row for: clearing a
  // badge is a tmux operation and does not require owning the pane.
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
