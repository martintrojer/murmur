import { type Channel, ssh } from "./channel.js";
import { type CollectOptions, collect } from "./collector.js";
import type { NodeIdentity } from "./identity.js";
import type { Store } from "./store.js";
import {
  freshness,
  NEEDS_HUMAN,
  type PaneView,
  paneViews,
  RENDER_PRIORITY,
  type RenderState,
  renderState,
  viewSort,
} from "./view.js";

type Counts = Record<RenderState, number>;

export type Status = {
  counts: Counts;
  orchestrated_counts: Counts;
  panes: PaneView[];
  peers: {
    name: string;
    display_name: string | null;
    fetched_at: number | null;
    snapshot_at: number | null;
    last_error: string | null;
    stale: boolean;
  }[];
};

function emptyCounts(): Counts {
  const counts = {} as Counts;
  for (const state of RENDER_PRIORITY) counts[state] = 0;
  return counts;
}

export function tmuxStatus(view: Status): string {
  // Orchestrated agents are counted for the states only a human can answer, and
  // hidden for the rest: a supervisor consumes a `done` worker's result, so
  // nobody needs to acknowledge it, and `running` asks for nothing. The list is
  // `NEEDS_HUMAN` in view.ts, shared with the picker's visibility rule so the
  // status bar and the list cannot disagree about which crew rows matter.
  const needsHuman = new Set<string>(NEEDS_HUMAN);
  const total = (state: RenderState): number =>
    view.counts[state] + (needsHuman.has(state) ? view.orchestrated_counts[state] : 0);
  return (
    RENDER_PRIORITY.filter((state) => total(state) > 0)
      // The tmux renderer's public vocabulary predates the internal activity
      // rename. Keep that external protocol stable until the renderer is updated.
      .map((state) => `${state === "running" ? "working" : state}\t${total(state)}\n`)
      .join("")
  );
}

/**
 * The current view. Pure with respect to the network: the caller decides whether
 * to collect first (see `statusWithCollect`).
 *
 * `identity` is required rather than resolved here, because every caller is a
 * command that already fails without one.
 */
export function status(store: Store, identity: NodeIdentity, now = Date.now()): Status {
  const counts = emptyCounts();
  const orchestratedCounts = emptyCounts();
  const panes = viewSort(paneViews(store, identity, now));
  for (const pane of panes) {
    const target = pane.driver === "human" ? counts : orchestratedCounts;
    target[renderState(pane)] += 1;
  }

  return {
    counts,
    orchestrated_counts: orchestratedCounts,
    panes,
    peers: store.peers().map((peer) => ({
      name: peer.name,
      display_name: peer.display_name,
      fetched_at: peer.fetched_at,
      // Their clock and ours, separately: a peer polled a second ago can be
      // serving a three-hour-old fact, and one number cannot say both.
      snapshot_at: peer.snapshot_at,
      last_error: peer.last_error,
      // The view's verdict, not a second threshold spelled the same way. A
      // peer we have never reached is stale rather than fresh -- null
      // `fetched_at` means the first collect has not succeeded yet -- and
      // `freshness` is the one place that decides, so this list and the panes
      // the peer contributes cannot disagree about the same host.
      stale: freshness(peer.fetched_at, now) === "stale",
    })),
  };
}

/**
 * Collect from peers, then read. This is what every user-facing surface wants:
 * the view reflects the sync that just ran, rather than the one before it.
 *
 * Awaiting matters for two reasons. A fire-and-forget collect makes every
 * invocation show data one run stale. And the callers close the store in a
 * `finally`, so a collect still in flight lands on a closed handle and reports
 * "The database connection is not open", which looks like corruption rather
 * than a race.
 *
 * Sync must never fail a command, and on this path it must never print either:
 * `status` runs on every status-bar tick and `pick` runs inside a
 * display-popup, so one sleeping laptop would otherwise write ssh diagnostics
 * to stderr several times a minute, forever. `murmur collect`, which a human
 * runs deliberately, is the only place that prints.
 *
 * `floorMs` is how a caller says whether it is a TIMER or a PERSON. The status
 * bar repaints on `status-interval` and passes COLLECT_FLOOR_MS, so fetch rate
 * stops being tied to redraw rate. The picker passes nothing: pressing the key
 * is a person asking now, and its `^r` reload comes back through here too --
 * a refresh key that skipped the fetch would be a key that silently does
 * nothing.
 */
export async function statusWithCollect(
  store: Store,
  identity: NodeIdentity,
  now = Date.now(),
  channel: Channel = ssh,
  options: CollectOptions = {},
): Promise<Status> {
  try {
    await collect(store, channel, now, options);
  } catch {
    // Total by construction: a read of whatever the cache already holds is
    // always better than no output, and this path has no one to tell.
  }
  return status(store, identity, now);
}
