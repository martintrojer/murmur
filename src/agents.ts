import { spawnSync } from "node:child_process";
import { SSH_OPTIONS } from "./channel.js";
import { asPaneId } from "./ids.js";
import { type Mux, tmux } from "./mux.js";
import type { Store } from "./store.js";
import type { PaneView } from "./view.js";

/**
 * The last segment of a slash-separated tmux session name.
 *
 * Session names are conventionally paths -- `tms` and friends name a session
 * after the directory it was opened in -- so the last segment identifies the
 * work: `hacking/murmur` is about `murmur`.
 *
 * SESSION names only. A window name that reaches the label is one a human chose
 * (see `chosenWindowName`) and shortening it would be presumptuous; a session
 * name is the last-resort fallback and almost never chosen by hand.
 *
 * Not `path.basename`: a session name only looks like a path. Splitting on `/`
 * cannot start resolving `..` or behaving differently per platform.
 *
 * Degenerate inputs keep the original rather than returning "": a session called
 * `/` has no last segment, and an empty name column is worse than an odd one.
 */
export function sessionLeaf(session: string): string {
  const leaf = session.split("/").filter(Boolean).at(-1);
  return leaf ?? session;
}

/**
 * The most specific human-readable name a pane's agent has, never a tmux id.
 *
 * Four sources, most to least specific: mu's agent name, pi's session name, the
 * tmux window name, the tmux session name. All are recorded by the node owning
 * the pane, so a local and a remote row read the same -- a reader cannot resolve
 * a remote window id against its own tmux.
 *
 * The session name is shortened to its last segment, and that last rung is
 * reached far more often than it looks: `agent_name` is mu-only, `window_name`
 * is null whenever tmux is auto-renaming (its default), and `pi_session` is
 * null for the whole life of an unnamed session, because pi's auto-namer runs
 * at CLOSE. So the common row for a hand-started pi printed `hacking/murmur` --
 * a path where a name belongs.
 *
 * The full name is not lost: the picker's stream column shows it, and shows it
 * BECAUSE of this shortening, since that column blanks when it would repeat the
 * name. Shortened, the row reads `murmur` + `hacking/murmur` -- same width,
 * strictly more information.
 *
 * Falls back to the window id only when a node recorded no names at all, which
 * means a non-tmux harness.
 */
export function agentLabel(agent: PaneView): string {
  const name =
    agent.agent_name ??
    agent.pi_session ??
    agent.window_name ??
    (agent.session_name === null ? null : sessionLeaf(agent.session_name));
  return terminalText(name ?? agent.window);
}

/**
 * Where the pane lives, for the second column. Names only -- the ids are what
 * jumps, not what a human reads.
 */
export function agentLocation(agent: PaneView): string {
  const session = agent.session_name ?? agent.session;
  const window = agent.window_name ?? agent.window;
  return terminalText(session === window ? session : `${session}:${window}`);
}

export function terminalText(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f) ? "�" : character;
    })
    .join("");
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The local session name that wraps a remote attach.
 *
 * The trailing `~` marks it as murmur's, for a human reading a session list and
 * for the `#{m:*~,...}` match in the suggested escape-hatch binding.
 *
 * The LEADING character is what matters. tmux parses a `-t` target starting with
 * `@`, `$` or `%` as a window, session or pane id, so a session named `@bubba`
 * -- what the old per-host window was called -- cannot be addressed at all:
 * every `-t @bubba` fails with `can't find window`. Window names were never
 * targets, so the old name was safe; session names are.
 */
export function remoteSessionName(peerName: string): string {
  return `${peerName.replace(/^[@$%=]+/, "")}~`;
}

/**
 * The one process call jump makes that is not a tmux command: the remote probe,
 * and the direct ssh attach when outside tmux. Injectable so the jump decision
 * table is testable without an ssh binary or a live peer -- without this seam,
 * replacing `jumpToAgent`'s body with `return { ok: true }` kept every jump
 * test green.
 */
export type Runner = (
  file: string,
  args: string[],
  inherit?: boolean,
) => { status: number | null; stdout: string; failed: boolean };

const spawnRunner: Runner = (file, args, inherit = false) => {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    timeout: 10_000,
    ...(inherit ? { stdio: "inherit" as const } : {}),
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    // spawnSync reports a failure to start the child in `error` and leaves
    // status null. Collapsing both keeps the decision table below one question.
    failed: result.error !== undefined,
  };
};

export type JumpResult =
  | { ok: true }
  | {
      ok: false;
      // Local to this process: the picker prints `message` and nothing else, and
      // no reason code here is ever stored or published in a snapshot.
      reason: "no_peer" | "unreachable" | "no_tmux" | "pane_gone" | "attach_failed";
      message: string;
    };

/**
 * Jump to a pane, wherever it lives.
 *
 * NEVER MUTATES STATE ON FAILURE. A failure is a report: a reason and a message,
 * nothing written. The next collect reconciles either way, and only the owning
 * node can author facts about its own panes.
 */
export function jumpToAgent(
  store: Store,
  agent: PaneView,
  mux: Mux = tmux,
  run: Runner = spawnRunner,
): JumpResult {
  if (agent.local) {
    // The PANE decides. This once asked about the WINDOW, which a live pane
    // routinely outlives: after `move-pane -s %0 -t @1`, list-panes still has
    // %0 and list-windows no longer has @0, so healthy agents read as gone.
    const panes = mux.livePanes();
    if (panes && !panes.has(agent.pane)) {
      return {
        ok: false,
        reason: "pane_gone",
        message: `${agentLabel(agent)} is gone -- its pane no longer exists.`,
      };
    }
    // Reported, not assumed. A failed select-window is the local twin of the
    // remote symptom: the picker closes, nothing moves, nothing says why.
    if (!mux.attach(agent.session, agent.window)) {
      return {
        ok: false,
        reason: "attach_failed",
        message: `could not attach to ${agentLabel(agent)} (tmux select-window failed).`,
      };
    }
    return { ok: true };
  }
  const peer = store.peers().find((candidate) => candidate.host_id === agent.host_id);
  const target = peer?.target ?? peer?.name;
  if (!target) {
    return {
      ok: false,
      reason: "no_peer",
      message: `No peer configured for host ${agent.host_id.slice(0, 8)}. Try: murmur peer add <target>`,
    };
  }

  // Confirm the pane exists before opening a window to attach to it, and ask
  // about PANES: a recorded window id goes stale every time the pane moves.
  // Without this the attach fails inside a new tmux window that closes
  // instantly, indistinguishable from "enter did nothing" -- the symptom that
  // sent us hunting a quoting bug that did not exist.
  //
  // The format string is quoted because ssh takes no argv: it joins its
  // arguments and hands the string to a remote shell, which mangles a bare
  // `#{pane_id}` into tmux answering `-F expects an argument` -- which looked
  // exactly like an unreachable host.
  //
  // Shares the collector's SSH_OPTIONS rather than passing BatchMode alone.
  // Without ControlPath the probe misses the warm master socket the collector
  // rides; without ConnectTimeout it inherits the kernel's 75s dial, so a
  // sleeping laptop froze the picker for ten seconds before admitting it.
  const probe = run("ssh", [
    ...SSH_OPTIONS,
    target,
    `tmux list-panes -a -F ${shellQuote("#{pane_id}")}`,
  ]);
  if (probe.status !== 0) {
    // 255 is ssh's own failure code; anything else came from the remote command.
    // Conflating them was wrong in the common case: on a warm socket the host
    // answers instantly and it is tmux that is gone, so "unreachable" sent you
    // looking at the network for a problem that was not there.
    const sshFailed = probe.status === 255 || probe.failed;
    if (sshFailed) {
      // Nothing recorded: we learned only that we could not ask. Its agents may
      // be alive behind a cold socket, so deleting them would be guessing.
      return {
        ok: false,
        reason: "unreachable",
        message: `cannot reach ${target} over ssh. Nothing here ever prompts for auth, so check the host is awake and reachable, or connect once by hand to see the real error.`,
      };
    }

    // ssh worked, tmux did not: a real fact about the host, still nothing
    // deleted. The peer's own next snapshot removes its panes, because only
    // that node may author about them.
    return {
      ok: false,
      reason: "no_tmux",
      message: `${target} has no tmux server running, so its agents are gone. They will disappear on the next collect.`,
    };
  }
  const remotePanes = new Set(probe.stdout.split("\n").filter(Boolean).map(asPaneId));
  if (!remotePanes.has(agent.pane)) {
    return {
      ok: false,
      reason: "pane_gone",
      message: `${agentLabel(agent)} is gone -- ${target} no longer has that pane.`,
    };
  }

  const attachTarget = shellQuote(`${agent.session}:${agent.window}`);

  // Hand the ssh to tmux as its own detached SESSION rather than running it
  // here: `murmur pick` is usually a display-popup, and a popup is modal, so an
  // ssh started inside it dies the moment the picker exits and the remote pane
  // flashed and vanished.
  //
  // A session, not a window, because session options are per-session and that is
  // what makes the nesting stop being felt:
  //
  //   status off   -- the remote's own bar is the only one on screen.
  //   prefix None  -- ^b reaches the remote directly. No ^b b to learn.
  //
  // Both would be global on a window and would break every local session. The
  // cost is that the local server is unreachable from inside the wrapper; the
  // README documents a root-table key that detaches out.
  if (process.env.TMUX) {
    // Read BEFORE the wrapper exists, or the wrapper itself is recorded as the
    // place to come back to and the return is a no-op.
    const client = mux.clientName();
    const origin = mux.currentTarget();

    // Named after the peer as configured, matching the picker's host column: a
    // self-reported display_name can be a container id, unrecognisable in a
    // session list.
    const name = remoteSessionName(peer?.name ?? target);

    // Reuse this host's wrapper rather than stacking one per jump -- three jumps
    // to bubba left three identical windows. Matched on name, the only handle
    // available: the ssh is opaque and a remote session id is not a local
    // address.
    if (mux.sessionNamed(name)) {
      return mux.switchClient(client, name)
        ? { ok: true }
        : {
            ok: false,
            reason: "attach_failed",
            message: `could not switch to the existing ${name} session.`,
          };
    }

    // `tmux new-session <command>` runs the command through a shell, so the
    // string expands LOCALLY before ssh sees it. A session id is always `$N`, so
    // `$0:@6` arrived as `:@6` and the remote attach failed with "can't find
    // session". shellQuote protects the remote shell; this protects the local.
    const attach = `ssh -t ${shellQuote(target)} tmux attach -t ${shellQuote(attachTarget)}`;

    // The return home, inside the wrapper's own command: when the attach exits
    // -- inner detach, remote session killed, ssh dropped -- this runs, then the
    // wrapper has no command left and tmux destroys it.
    //
    // Explicit rather than trusting detach-on-destroy, whose `previous` picked a
    // stray unrelated session in testing rather than the one the jump started
    // from. Still set below, as the fallback for when this cannot run (SIGKILL).
    const restore = origin
      ? `; tmux switch-client ${client ? `-c ${shellQuote(client)} ` : ""}-t ${shellQuote(`=${origin}`)}`
      : "";

    if (!mux.newSession(name, `${attach}${restore}`)) {
      return {
        ok: false,
        reason: "attach_failed",
        message: `could not open a session to attach to ${target}.`,
      };
    }

    mux.setSessionOption(name, "status", "off");
    mux.setSessionOption(name, "prefix", "None");
    mux.setSessionOption(name, "detach-on-destroy", "previous");

    return mux.switchClient(client, name)
      ? { ok: true }
      : {
          ok: false,
          reason: "attach_failed",
          message: `attached to ${target} in session ${name}, but could not switch to it.`,
        };
  }

  // Outside tmux there is no popup to escape, so run it directly. stdio is
  // inherited, so this blocks until the user leaves the remote session.
  //
  // None of the wrapper machinery above applies, and must not: there is no local
  // client to switch, nothing to return to but the invoking shell, and no local
  // status bar or prefix to suppress -- this path is already full-screen and
  // prefix-clean, since the whole problem is an artifact of being inside tmux.
  // A local session here would attach a client to a server the user never asked
  // for and leave them in tmux on exit rather than at their prompt.
  //
  // The tradeoff, no reuse of an existing attach, is correct rather than
  // missing: there is no local server holding one.
  const attach = run("ssh", ["-t", target, "tmux", "attach", "-t", attachTarget], true);
  return attach.status === 0 && !attach.failed
    ? { ok: true }
    : {
        ok: false,
        reason: "attach_failed",
        message: `ssh attach to ${target} failed.`,
      };
}
