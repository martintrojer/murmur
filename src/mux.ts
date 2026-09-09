import { execFileSync } from "node:child_process";
import { asPaneId, asSessionId, asWindowId, type PaneId, type WindowId } from "./ids.js";
import type { Location } from "./types.js";
import type { RenderState } from "./view.js";

export type LocalPaneProcess = {
  pane: PaneId;
  current_command: string;
  arguments: string;
};

export interface Mux {
  currentWindow(): Location | null;
  livePanes(): Set<PaneId> | null;
  localPaneProcesses(): LocalPaneProcess[];
  // Sets `@agent_state` on a WINDOW though the attention belongs to a pane. The
  // asymmetry is tmux's: the status bar and the `tms` picker read a window
  // option and there is no per-pane equivalent. The consequence is that a pane
  // moving between windows must clear the badge it left behind, since nothing
  // else knows it moved.
  setWindowBadge(window: WindowId, state: RenderState | null): void;
  // Takes the PANE, which is the address, so one call resolves session, window
  // and pane together. Reports whether the attach happened: runTmux swallows
  // failures into null, and a silently failed jump looked exactly like "enter
  // did nothing" -- the symptom the remote probe exists to prevent, reproduced
  // locally.
  attach(pane: PaneId): boolean;
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

  // A separate best-effort read for presentation. Unlike livePanes(), failure
  // and no panes have the same harmless result here: no attachment hint.
  localPaneProcesses() {
    const out = runTmux([
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}\t#{pane_current_command}\t#{pane_pid}",
    ]);
    if (!out) return [];
    const rows = out.split("\n").flatMap((line) => {
      const [pane, currentCommand, pid] = line.split("\t");
      // A pid is all digits, and it is interpolated into a `ps` argument list --
      // so this is the argv boundary, checked rather than trusted.
      if (!pane || !currentCommand || !pid || !/^\d+$/.test(pid)) return [];
      return [{ pane: asPaneId(pane), current_command: currentCommand, pid }];
    });
    if (rows.length === 0) return [];

    // ONE `ps` for every pane, not one per pane. This runs on every status tick,
    // so a fork per pane was a dozen forks a second on a busy machine to find a
    // substring.
    //
    // `ww` and NOT `eww`. The `e` flag appends the process ENVIRONMENT, which
    // murmur has no business reading: measured at 3452 bytes for one pane,
    // including `BRAVE_SEARCH_API_KEY` and `MODELBRIDGE_API_KEY`. It was added
    // on the theory that macOS `ps` might expose MU_AGENT_NAME that way -- it
    // does not, which was the finding of the commit that added it -- so it
    // leaked every secret in every pane's environment into a string for no
    // consumer at all. argv is what the matcher reads and all it needs.
    let listing: string;
    try {
      listing = execFileSync("ps", ["ww", "-o", "pid=,command=", ...rows.map((row) => row.pid)], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      // ps refuses the whole call if ANY pid is gone, which is ordinary: a pane
      // can die between the tmux read and this one. No attachment hint is the
      // harmless answer, same as every other failure on this path.
      return [];
    }

    const argvByPid = new Map<string, string>();
    for (const line of listing.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match?.[1] && match[2]) argvByPid.set(match[1], match[2].trim());
    }
    return rows.flatMap((row) => {
      const arguments_ = argvByPid.get(row.pid);
      return arguments_
        ? [{ pane: row.pane, current_command: row.current_command, arguments: arguments_ }]
        : [];
    });
  },

  setWindowBadge(window, state) {
    if (state === null) {
      runTmux(["set-window-option", "-qu", "-t", window, "@agent_state"]);
      runTmux(["set-window-option", "-qu", "-t", window, "@pane_agent"]);
    } else {
      runTmux(["set-window-option", "-q", "-t", window, "@agent_state", tmuxBadgeState(state)]);
      // The tmux status bar and picker read this as "an agent is in this window".
      runTmux(["set-window-option", "-q", "-t", window, "@pane_agent", "1"]);
    }
    runTmux(["refresh-client", "-S"]);
  },

  attach(pane) {
    // ONE call, targeting the pane. tmux resolves a bare `%N` to its session,
    // window and pane together, which is the whole reason this takes the
    // address rather than a session and window.
    //
    // The two-step it replaced (`switch-client -t $session` then
    // `select-window -t @window`) was wrong twice over:
    //
    //   It landed on the window's ACTIVE pane, not the one asked for. A window
    //   holding an agent beside a shell put the cursor on whichever was last
    //   focused, so enter on the agent row selected the shell.
    //
    //   It targeted the RECORDED window id, which a live pane routinely
    //   outlives -- `move-pane` and `break-pane` keep the pane and change the
    //   window. `jumpToAgent` proves the pane is alive and then failed to
    //   attach to it, reporting `attach_failed` for a healthy moved agent.
    //   test/mux-targets.test.ts pins that a stale window id is not a usable
    //   target, which is the mechanism.
    //
    // Both were symptoms of addressing by window when the model says the pane
    // is the address, so both go away together here rather than being patched
    // one at a time.
    return runTmux(["switch-client", "-t", pane]) !== null;
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
