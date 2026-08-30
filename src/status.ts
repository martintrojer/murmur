import { type Channel, ssh } from "./channel.js";
import { collect, STALENESS_MS } from "./collector.js";
import {
  type AgentView,
  attentionSort,
  foldAll,
  isStale,
  type ResolvedState,
  viewState,
} from "./fold.js";
import { loadIdentity } from "./identity.js";
import { pidAlive } from "./mux.js";
import type { Store } from "./store.js";

// The resolver's vocabulary, not a second one. This was a local union that
// happened to match; naming it here meant status could drift from what every
// other surface calls the same states.
type StatusState = ResolvedState;
type Counts = Record<StatusState, number>;

export type Status = {
  counts: Counts;
  orchestrated_counts: Counts;
  agents: (AgentView & {
    stale: boolean;
    age_ms: number | null;
    event_age_ms: number | null;
    tmux_down: boolean;
    host: string;
  })[];
  peers: {
    name: string;
    display_name: string | null;
    fetched_at: number | null;
    stale: boolean;
  }[];
};

function emptyCounts(): Counts {
  return { working: 0, blocked: 0, done: 0, crashed: 0, idle: 0 };
}

export function tmuxStatus(view: Status): string {
  const urgency: StatusState[] = ["crashed", "blocked", "done", "working", "idle"];
  // Orchestrated agents are counted here for `blocked` and `crashed` only.
  //
  // Hiding crew is right for the rest: a supervisor consumes a `done` worker's
  // result, so nobody needs to acknowledge it, and `working` asks for nothing.
  // But `blocked` means waiting for an answer that only a human can give -- mu
  // places work, it cannot decide between two approaches -- and `crashed` means
  // a worker died, which a supervisor may or may not retry.
  //
  // So a blocked crew agent is waiting on YOU, and it used to appear on no
  // surface at all: hidden from the picker behind --all, and absent from this
  // count, which read `view.counts` only. `orchestrated_counts` was computed
  // and no caller read it. Verified by seeding one: the status bar printed
  // nothing while a worker sat waiting.
  const needsHuman = new Set<StatusState>(["blocked", "crashed"]);
  const total = (state: StatusState): number =>
    view.counts[state] + (needsHuman.has(state) ? view.orchestrated_counts[state] : 0);
  return urgency
    .filter((state) => total(state) > 0)
    .map((state) => `${state}\t${total(state)}\n`)
    .join("");
}

/**
 * Fold the current view. Pure with respect to the network: the caller decides
 * whether to collect first (see `statusWithCollect`).
 */
export function status(store: Store, now = Date.now()): Status {
  const identity = loadIdentity();
  const peers = store.peers();
  const peersByHost = new Map(
    peers.flatMap((peer) => (peer.host_id === null ? [] : [[peer.host_id, peer] as const])),
  );
  const events = store.allEvents();
  const local = foldAll(
    events.filter((event) => event.host_id === identity?.host_id),
    pidAlive,
  );
  // A remote pid means nothing here: it names a process in another machine's
  // table. `working` rows are trusted because the authoring node checked its
  // own pids before exporting.
  //
  // Left inline rather than pulled into the resolver. It looks like a shared
  // rule, but this is the only function in the codebase that folds a mixed
  // list, so a `probeFor(host, self, probe)` helper had exactly one caller and
  // made the call site worse -- it needed sentinel host ids to express
  // "remote". A one-caller abstraction is the layer this task exists to avoid.
  const remote = foldAll(
    events.filter((event) => event.host_id !== identity?.host_id),
    () => true,
  );
  const counts = emptyCounts();
  const orchestratedCounts = emptyCounts();
  const agents = attentionSort([...local, ...remote]).map((agent) => {
    const peer = peersByHost.get(agent.host_id);
    const fetchedAt = peer?.fetched_at ?? null;
    // One translation, shared with the picker. The `=== "cleared"` half of the
    // old expression here was dead: fold maps a `cleared` row to null, so a
    // resolved view can never carry that string. Verified by exhausting the
    // two-event state space against the built fold -- reachable results are
    // blocked, crashed, done, working and null, never "cleared".
    const state = viewState(agent);
    const target = agent.driver === "human" ? counts : orchestratedCounts;
    target[state] += 1;
    return {
      ...agent,
      fetched_at: fetchedAt,
      // Replica freshness: how long since we last reached the peer. Local rows
      // have no fetched_at and are never stale.
      stale: isStale(fetchedAt, now, STALENESS_MS),
      age_ms: fetchedAt === null ? null : now - fetchedAt,
      // Information age: how long since the agent itself said anything. This
      // is the number a human means by "how stale is that row". A successful
      // fetch of a three-hour-old event resets age_ms to zero but leaves this
      // at three hours, which is why they cannot be the same field.
      event_age_ms: agent.event === null ? null : Math.max(0, now - agent.event.ts),
      // A jump proved this host's tmux was down and nothing has authored since.
      // Stronger than staleness: the host answers, its agents are just gone.
      tmux_down: peer?.tmux_down_at != null,
      // The name the human typed, not the machine's self-reported hostname. A
      // peer added as `linuxpc` reported `18c04d69b860` (a container hostname)
      // and that is what the picker showed — a string that appears nowhere
      // else in the tool and cannot be typed at `peer remove` or searched for.
      // Only the local node, which has no peer row, falls back to its own
      // discovered display_name.
      host:
        peer?.name ?? (agent.host_id === identity?.host_id ? identity.display_name : agent.host_id),
    };
  });

  return {
    counts,
    orchestrated_counts: orchestratedCounts,
    agents,
    peers: peers.map((peer) => ({
      name: peer.name,
      display_name: peer.display_name,
      fetched_at: peer.fetched_at,
      // A peer we have never reached is stale, not fresh. `isStale` reads a
      // null `fetched_at` as "local, therefore never stale", which is right
      // for an agent row but backwards for a peer: null there means the very
      // first collect has not succeeded yet. Left to `isStale`, an
      // unreachable host you just added would render as up to date.
      stale: peer.fetched_at === null || isStale(peer.fetched_at, now, STALENESS_MS),
    })),
  };
}

/**
 * Collect from peers, then fold. This is what every user-facing surface wants:
 * the view reflects the sync that just ran, rather than the one before it.
 *
 * Awaiting matters for two reasons. A fire-and-forget collect makes every
 * invocation show data one run stale — you never see what you just fetched.
 * And the callers close the store in a `finally`, so a collect still in flight
 * lands on a closed handle and reports "The database connection is not open",
 * which looks like corruption rather than a race.
 *
 * Sync must never fail a command, and on this path it must never print either.
 * `status` runs on every status-bar tick and `pick` runs inside a display-popup,
 * so one sleeping laptop used to write two lines of ssh diagnostics to stderr
 * several times a minute, forever. A fleet normally has nodes that are off or
 * asleep, so that is the common case, not a fault worth a log line.
 *
 * The reachability of a peer is already reported where it can be read: the
 * picker's `unreachable` flag and the peer table's age column, per row and on
 * demand. `murmur collect`, which a human runs deliberately, is the only place
 * that prints.
 *
 * With no peers this is a loop over an empty array: no network, no added
 * latency, which is the everyday single-machine path.
 */
export async function statusWithCollect(
  store: Store,
  now = Date.now(),
  channel: Channel = ssh,
): Promise<Status> {
  try {
    await collect(store, channel, now);
  } catch {
    // Total by construction: a fold over whatever the replica already holds is
    // always better than no output, and this path has no one to tell.
  }
  return status(store, now);
}
