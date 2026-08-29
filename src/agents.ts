import { spawnSync } from "node:child_process";
import { loadIdentity } from "./identity.js";
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

export type JumpResult =
  | { ok: true }
  | { ok: false; reason: "no_peer" | "unreachable" | "no_tmux" | "window_gone"; message: string };

/**
 * Drop a dead agent's rows from the local replica.
 *
 * Export on the authoring node clears dead windows, but that only runs when the
 * peer is next polled, and a window can die between a fetch and a jump. When a
 * jump proves the window is gone, the agent should leave this HUD now rather
 * than at the next collect.
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
 * the window we happened to aim at. Leaving the rows and only labelling them
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
      mux.setState(agent.window, null);
    } catch {
      // Best effort: the row still goes.
    }
  }
  forgetReplica(store, agent.agent_id, agent.host_id);
}

export function jumpToAgent(store: Store, agent: Agent): JumpResult {
  const identity = loadIdentity();
  if (agent.host_id === identity?.host_id) {
    const live = tmux.liveWindows();
    if (live && !live.has(agent.window)) {
      forgetReplica(store, agent.agent_id, agent.host_id);
      return {
        ok: false,
        reason: "window_gone",
        message: `${agentLabel(agent)} is gone -- its window no longer exists. Cleared.`,
      };
    }
    tmux.attach(agent.session, agent.window);
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

  // Check the window is still there before opening a window to attach to it.
  // Without this the attach fails inside a new tmux window that closes
  // instantly, which is indistinguishable from "enter did nothing" -- the
  // symptom that sent us looking for a quoting bug that did not exist.
  // ssh does not take an argv: it joins its arguments and hands the string to a
  // shell on the far side. An unquoted `#{window_id}` is mangled by that shell
  // and tmux answers `-F expects an argument`, which looked exactly like an
  // unreachable host. One quoted string, so the remote shell passes the format
  // through untouched.
  const probe = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", target, `tmux list-windows -a -F ${shellQuote("#{window_id}")}`],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (probe.status !== 0) {
    // 255 is ssh's own failure code; anything else came from the remote
    // command. Conflating them was wrong in the common case: with a warm
    // ControlMaster socket the host answers instantly and it is tmux that is
    // gone, so "unreachable" sent you looking at the network for a problem that
    // was not there.
    const sshFailed = probe.status === 255 || probe.error !== undefined;
    if (sshFailed) {
      // No mark: we learned nothing about the peer's tmux, only that we could
      // not ask. Its agents may be perfectly alive behind a cold socket or a
      // sleeping laptop, and deleting them here would be guessing.
      return {
        ok: false,
        reason: "unreachable",
        message: `cannot reach ${target} over ssh. The collector never prompts for auth, so connect once by hand to warm the connection, then retry.`,
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
  const remoteWindows = new Set((probe.stdout ?? "").split("\n").filter(Boolean));
  if (!remoteWindows.has(agent.window)) {
    forgetReplica(store, agent.agent_id, agent.host_id);
    return {
      ok: false,
      reason: "window_gone",
      message: `${agentLabel(agent)} is gone -- ${target} no longer has that window. Cleared.`,
    };
  }

  const attachTarget = shellQuote(`${agent.session}:${agent.window}`);

  // Hand the ssh to tmux as its own window rather than running it here.
  // `murmur pick` is usually a display-popup, and a popup is modal: an ssh
  // session started inside it is killed the moment the picker exits, so the
  // remote pane flashed and vanished. A new window outlives the popup and
  // gives the remote tmux a real terminal to attach to.
  //
  // Nested tmux is the known cost here (see the spec's open question on inner
  // prefixes); a window at least makes it visible and closable.
  if (process.env.TMUX) {
    // `tmux new-window <command>` runs the command through a shell, so the
    // string is expanded LOCALLY before ssh sees it. A tmux session id is
    // always `$N`, so `$0:@6` arrived as `:@6` and the remote attach failed
    // with "can't find session". shellQuote alone is not enough: it protects
    // the remote shell, this protects the local one.
    const command = `ssh -t ${shellQuote(target)} tmux attach -t ${shellQuote(attachTarget)}`;
    // Named after the peer as configured, matching what the picker's host
    // column shows. The machine's self-reported display_name can be something
    // like a container id, which makes the window unrecognisable.
    const name = `@${peer?.name ?? target}`;

    // Reuse an existing window for this host rather than stacking a new one on
    // every jump. murmur navigates to agents; the window is only here because a
    // remote attach needs a terminal that outlives the popup, so one per host is
    // the whole requirement. Jumping to bubba three times used to leave three
    // identical @bubba windows behind.
    //
    // Matched on window name, which is the only handle available: the ssh is
    // opaque from here, and the remote session id is not a local address.
    const existing = tmux.windowNamed(name);
    if (existing) {
      tmux.selectWindow(existing);
      return { ok: true };
    }

    spawnSync("tmux", ["new-window", "-n", name, command], { stdio: "ignore" });
    return { ok: true };
  }

  // Outside tmux there is no popup to escape, so run it directly.
  spawnSync("ssh", ["-t", target, "tmux", "attach", "-t", attachTarget], { stdio: "inherit" });
  return { ok: true };
}
