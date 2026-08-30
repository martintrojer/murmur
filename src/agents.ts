import { spawnSync } from "node:child_process";
import { SSH_OPTIONS } from "./channel.js";
import { loadIdentity } from "./identity.js";
import { asPaneId } from "./ids.js";
import { type Mux, tmux } from "./mux.js";
import type { Status } from "./status.js";
import type { Store } from "./store.js";

export type Agent = Status["agents"][number];

/**
 * The most specific human-readable name an agent has, never a tmux id.
 *
 * Four sources, most to least specific: mu's agent name, pi's session name,
 * the tmux window name, the tmux session name. The old picker showed window
 * names and that was the thing it did better than raw `$26:@79`; these are all
 * recorded on the event, so this reads the same for a local and a remote agent.
 *
 * Falls back to the window id only when a node recorded no names at all, which
 * means a pre-names event or a non-tmux harness.
 */
export function agentLabel(agent: Agent): string {
  const name = agent.agent_name ?? agent.pi_session ?? agent.window_name ?? agent.session_name;
  return terminalText(name ?? agent.window);
}

/**
 * Where the agent lives, for the second column. Names only -- the ids are what
 * jumps, not what a human reads.
 */
export function agentLocation(agent: Agent): string {
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

export const spawnRunner: Runner = (file, args, inherit = false) => {
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
      // Local to this process: the picker prints `message` and nothing else, so
      // no reason code here is stored, folded or sent over the wire. (The
      // `window_gone` string in export.ts IS on the wire and stays as it is.)
      // That is what made renaming this one a vocabulary fix rather than a
      // schema change.
      reason: "no_peer" | "unreachable" | "no_tmux" | "pane_gone" | "attach_failed";
      message: string;
    };

/**
 * Drop a dead agent's rows from the local replica.
 *
 * Export on the authoring node clears dead agents, but that only runs when the
 * peer is next polled, and a pane can die between a fetch and a jump. When a
 * jump proves the pane is gone, the agent should leave this HUD now rather
 * than at the next collect.
 *
 * "Proves" is load-bearing and was once false: the caller asked whether the
 * agent's WINDOW still existed, which a live pane routinely outlives, so this
 * delete fired on healthy agents.
 *
 * DELETE rather than append a `cleared` event, because this node cannot author
 * an event about another node's agent. `store.append` stamps the local host_id,
 * and `status()` folds local and remote events separately (local needs a pid
 * check, remote cannot have one) -- so a local row about a remote agent lands
 * in the other fold and shows up as a SECOND agent with the same agent_id,
 * which is exactly what it did before this was a delete.
 *
 * Deleting a replica is safe ONLY IF the rows can come back, and that needs the
 * peer's watermark rewound as well. Ingest asks for events after the watermark,
 * so deleting rows below it deletes them permanently: bubba's agents vanished
 * from the picker and no amount of collecting brought them back, even with the
 * node alive and the events still in its log.
 *
 * Rewinding to zero rather than to the deleted seq: the log is bounded by the
 * retention horizon, ingest is idempotent on (host_id, seq), and a re-read of a
 * small table is cheaper than tracking which seq belonged to which agent. The
 * next collect re-reads everything the peer still has, so if the window is
 * genuinely alive the agent reappears -- which is the answer to the race where
 * the host comes back up between the jump and the next poll.
 *
 * For a local agent there is no watermark and nothing to rewind: the pane is
 * gone, so nothing will ever author about it again.
 */
/**
 * A jump proved this peer has no tmux server, so none of its agents exist.
 *
 * Drops every replicated row for that origin and rewinds the watermark, the
 * same recoverable delete `forgetReplica` does for one agent — just scoped to
 * the node, because "no tmux server" is a fact about the host rather than about
 * the pane we happened to aim at. Leaving the rows and only labelling them
 * meant the picker kept offering four dead agents you had just been told were
 * gone.
 *
 * The mark stays on the peer as well: it is what stops an empty export being
 * read as recovery, and it is why the rows do not immediately reappear.
 */
export function forgetHostReplica(store: Store, hostId: string): void {
  try {
    const peer = store.peers().find((candidate) => candidate.host_id === hostId);
    store.forgetHost(hostId);
    if (peer) {
      // Watermark deliberately NOT rewound here, unlike the single-agent case.
      // Rewinding re-ingests the very rows just deleted, and because the
      // collector reads any ingest as "the node is authoring again", it also
      // cleared the mark -- so the dead agents reappeared looking healthy on
      // the next collect, one second later.
      //
      // Keeping the watermark means recovery waits for a NEW event, which is
      // the correct bar: the node has to actually say something before its
      // agents come back. Nothing is lost, since the rows describe windows a
      // live tmux server would re-announce.
      store.upsertPeer({
        name: peer.name,
        target: peer.target,
        tmux_down_at: Date.now(),
      });
    }
  } catch {
    // Advisory only: the next collect reconciles either way.
  }
}

export function forgetReplica(store: Store, agentId: string, hostId: string): void {
  try {
    store.forgetAgent(agentId);
    const peer = store.peers().find((candidate) => candidate.host_id === hostId);
    if (peer) store.upsertPeer({ name: peer.name, target: peer.target, watermark: 0 });
  } catch {
    // Cosmetic only: the next collect reconciles either way.
  }
}

/**
 * Drop one agent from the picker by hand.
 *
 * The escape hatch for a row that is stuck and that nothing else will clear: an
 * agent whose pane died in a way that left no terminal event, or a replica from
 * a peer that will never report again. Everything else here reconciles on its
 * own, so this exists for the cases that do not.
 *
 * A local agent also gets its tmux badge cleared. Deleting only the row would
 * leave `@agent_state` set, which the status bar and the tms session picker
 * both read — so the glyph would survive the row it came from and nothing would
 * ever clear it.
 *
 * Not authoritative, and cannot be: for a remote agent this deletes a replica,
 * and the owning node still holds the truth. If that node reports again the
 * agent comes back, which is correct — a row you dismissed while the agent was
 * alive should return.
 */
export function forgetOneAgent(store: Store, agent: Agent, mux: Mux = tmux): void {
  const identity = loadIdentity();
  if (agent.host_id === identity?.host_id) {
    try {
      mux.setWindowBadge(agent.window, null);
    } catch {
      // Best effort: the row still goes.
    }
  }
  forgetReplica(store, agent.agent_id, agent.host_id);
}

export function jumpToAgent(
  store: Store,
  agent: Agent,
  mux: Mux = tmux,
  run: Runner = spawnRunner,
): JumpResult {
  const identity = loadIdentity();
  if (agent.host_id === identity?.host_id) {
    // The PANE decides, and only the pane. This asked `liveWindows()` about
    // `agent.window` -- the exact rule 0e546c7 removed from the sweep, left
    // live on the jump path -- and then DELETED the row. A pane keeps its id
    // across move-pane and break-pane while the window it left stops existing,
    // so one keypress on a healthy agent deleted it and reported it as gone.
    // Verified against real tmux: after `move-pane -s %0 -t @1`, list-panes
    // still has %0 and list-windows no longer has @0.
    //
    // Worse here than in the sweep, because the delete is unrecoverable: a
    // local agent has no peer row, so forgetReplica's watermark rewind has
    // nothing to rewind and nothing will ever re-author the rows.
    const panes = mux.livePanes();
    if (panes && !panes.has(agent.pane)) {
      forgetReplica(store, agent.agent_id, agent.host_id);
      return {
        ok: false,
        reason: "pane_gone",
        message: `${agentLabel(agent)} is gone -- its pane no longer exists. Cleared.`,
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

  // Check the agent's PANE is still there before opening a window to attach to
  // it. Panes, not windows: `list-windows -a -F '#{window_id}'` cannot answer
  // the only question that matters -- whether the agent exists -- because the
  // window on its last event goes stale every time the pane moves. Asking the
  // wrong one here deleted the replica of a live remote agent.
  // Without this the attach fails inside a new tmux window that closes
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

    // ssh worked, tmux did not. That is a real fact about the host and the
    // strongest one available: a successful export only proves the murmur
    // binary ran, which it does happily on a box whose tmux server is gone --
    // which is why these agents read as fresh for three hours.
    forgetHostReplica(store, agent.host_id);
    return {
      ok: false,
      reason: "no_tmux",
      message: `${target} has no tmux server running, so its agents are gone. Removed them; they will come back when it reports again.`,
    };
  }
  const remotePanes = new Set(probe.stdout.split("\n").filter(Boolean).map(asPaneId));
  if (!remotePanes.has(agent.pane)) {
    forgetReplica(store, agent.agent_id, agent.host_id);
    return {
      ok: false,
      reason: "pane_gone",
      message: `${agentLabel(agent)} is gone -- ${target} no longer has that pane. Cleared.`,
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
