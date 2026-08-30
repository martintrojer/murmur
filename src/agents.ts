import { spawnSync } from "node:child_process";
import { SSH_OPTIONS } from "./channel.js";
import { asPaneId } from "./ids.js";
import { type Mux, tmux } from "./mux.js";
import type { Store } from "./store.js";
import type { PaneView } from "./view.js";

/**
 * The most specific human-readable name a pane's agent has, never a tmux id.
 *
 * Four sources, most to least specific: mu's agent name, pi's session name, the
 * tmux window name, the tmux session name. All are recorded by the node that
 * owns the pane, so this reads the same for a local and a remote pane -- a
 * reader cannot resolve a remote window id against its own tmux.
 *
 * Falls back to the window id only when a node recorded no names at all, which
 * means a non-tmux harness.
 */
export function agentLabel(agent: PaneView): string {
  const name = agent.agent_name ?? agent.pi_session ?? agent.window_name ?? agent.session_name;
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
 * The trailing `~` marks it as murmur's, both for a human reading a session
 * list and for the `#{m:*~,...}` match in the suggested escape-hatch binding.
 *
 * The leading character is the part that matters. A tmux `-t` target starting
 * with `@`, `$` or `%` is parsed as a window, session or pane id, so a session
 * named `@bubba` -- which is exactly what the old per-host WINDOW was called --
 * cannot be addressed at all: every `-t @bubba` fails with `can't find window`.
 * Window names were never targets, so the old name was safe; session names are.
 */
export function remoteSessionName(peerName: string): string {
  return `${peerName.replace(/^[@$%=]+/, "")}~`;
}

/**
 * The one process call jump makes that is not a tmux command: the remote probe,
 * and the direct ssh attach when we are not inside tmux. Injectable so the jump
 * decision table can be tested without an ssh binary or a live peer -- without
 * this seam, `jumpToAgent` had no behavioural coverage at all and replacing its
 * body with `return { ok: true }` kept every jump test green.
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
    // spawnSync reports a failure to even start the child in `error`, leaving
    // status null. Collapsing both here keeps the decision table below reading
    // as one question rather than two.
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
    // The PANE decides, and only the pane. This once asked whether the agent's
    // WINDOW still existed, which a live pane routinely outlives: after
    // `move-pane -s %0 -t @1`, list-panes still has %0 and list-windows no
    // longer has @0. Asking the wrong one reported healthy agents as gone.
    const panes = mux.livePanes();
    if (panes && !panes.has(agent.pane)) {
      return {
        ok: false,
        reason: "pane_gone",
        message: `${agentLabel(agent)} is gone -- its pane no longer exists.`,
      };
    }
    // Reporting the attach rather than assuming it. A select-window that fails
    // is the local twin of the remote symptom: the picker closes, nothing
    // moves, and nothing says why.
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

  // Check the pane is still there before opening a window to attach to it.
  // Panes, not windows: a recorded window id goes stale every time the pane
  // moves, so it cannot answer whether the agent exists. Without this the attach fails inside a new tmux window that closes
  // instantly, which is indistinguishable from "enter did nothing" -- the
  // symptom that sent us looking for a quoting bug that did not exist.
  // ssh does not take an argv: it joins its arguments and hands the string to a
  // shell on the far side. An unquoted `#{window_id}` is mangled by that shell
  // and tmux answers `-F expects an argument`, which looked exactly like an
  // unreachable host. One quoted string, so the remote shell passes the format
  // through untouched.
  //
  // Shares the collector's SSH_OPTIONS rather than passing BatchMode alone.
  // Without ControlPath the probe could not use the warm master socket the
  // collector rides, and without ConnectTimeout it inherited the kernel's dial
  // -- 75s on macOS, bounded only by the timeout below, so a sleeping laptop
  // froze the picker for ten seconds before admitting it was unreachable.
  const probe = run("ssh", [
    ...SSH_OPTIONS,
    target,
    `tmux list-panes -a -F ${shellQuote("#{pane_id}")}`,
  ]);
  if (probe.status !== 0) {
    // 255 is ssh's own failure code; anything else came from the remote
    // command. Conflating them was wrong in the common case: with a warm
    // ControlMaster socket the host answers instantly and it is tmux that is
    // gone, so "unreachable" sent you looking at the network for a problem that
    // was not there.
    const sshFailed = probe.status === 255 || probe.failed;
    if (sshFailed) {
      // No mark: we learned nothing about the peer's tmux, only that we could
      // not ask. Its agents may be perfectly alive behind a cold socket or a
      // sleeping laptop, and deleting them here would be guessing.
      return {
        ok: false,
        reason: "unreachable",
        message: `cannot reach ${target} over ssh. Nothing here ever prompts for auth, so check the host is awake and reachable, or connect once by hand to see the real error.`,
      };
    }

    // ssh worked, tmux did not. A real fact about the host, and reported as
    // one: nothing is deleted here. The peer's own next snapshot is what
    // removes its panes, because only that node may author about them, and a
    // reader that evicts rows on a probe failure is guessing.
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
  // here. `murmur pick` is usually a display-popup, and a popup is modal: an
  // ssh started inside it is killed the moment the picker exits, so the remote
  // pane flashed and vanished. A session outlives the popup and gives the
  // remote tmux a real terminal to attach to.
  //
  // A session, not a window, because session options are per-session and that
  // is what makes the nesting stop being felt:
  //
  //   status off   -- no local status bar, so the remote's own bar is the only
  //                   one on screen and the jump reads as a full-screen ssh.
  //   prefix None  -- no local prefix at all, so ^b reaches the remote
  //                   directly. No ^b b, and no second prefix to learn.
  //
  // Both would be global if this were a window, and would break every local
  // session. The cost is that the local server is unreachable from inside the
  // wrapper; the README documents a root-table key that detaches out.
  if (process.env.TMUX) {
    // Read BEFORE the wrapper exists, or we would record the wrapper itself as
    // the place to come back to and the return would be a no-op.
    const client = mux.clientName();
    const origin = mux.currentTarget();

    // Named after the peer as configured, matching the picker's host column.
    // The machine's self-reported display_name can be a container id, which
    // makes the session unrecognisable in a session list.
    const name = remoteSessionName(peer?.name ?? target);

    // Reuse an existing wrapper for this host rather than stacking a new one on
    // every jump. Jumping to bubba three times used to leave three identical
    // windows behind. Matched on name, the only handle available: the ssh is
    // opaque from here and the remote session id is not a local address.
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
    // string is expanded LOCALLY before ssh sees it. A tmux session id is
    // always `$N`, so `$0:@6` arrived as `:@6` and the remote attach failed
    // with "can't find session". shellQuote alone is not enough: it protects
    // the remote shell, this protects the local one.
    const attach = `ssh -t ${shellQuote(target)} tmux attach -t ${shellQuote(attachTarget)}`;

    // The return home, as part of the wrapper's own command. When the attach
    // exits -- inner detach, remote session killed, ssh dropped -- this runs,
    // then the wrapper has no command left and tmux destroys it.
    //
    // Explicit, rather than relying on detach-on-destroy: `previous` picks
    // tmux's idea of the previous session, which in testing was a stray
    // unrelated session rather than the one the jump started from. It is still
    // set below as a fallback for when this command cannot run (SIGKILL).
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
  // inherited, so this blocks until the user leaves the remote session; a
  // nonzero exit means the attach itself failed.
  //
  // None of the wrapper-session machinery above applies here, and it must not:
  // there is no local client to switch, nothing to return to but the shell that
  // invoked us, and no local status bar or prefix to suppress. This path is
  // already full-screen and already prefix-clean -- the whole problem is an
  // artifact of being inside tmux. Creating a local session here would attach a
  // client to a server the user never asked for, and leave them inside tmux on
  // exit rather than back at their prompt.
  //
  // The tradeoff is no reuse of an existing attach, since there is no local
  // server holding one. That is correct rather than missing.
  const attach = run("ssh", ["-t", target, "tmux", "attach", "-t", attachTarget], true);
  return attach.status === 0 && !attach.failed
    ? { ok: true }
    : {
        ok: false,
        reason: "attach_failed",
        message: `ssh attach to ${target} failed.`,
      };
}
