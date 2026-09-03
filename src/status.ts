import { type Channel, hasWarmSocket, ssh } from "./channel.js";
import { type CollectOptions, collect, needsInteractiveAuth } from "./collector.js";
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
  type SortContext,
  viewSort,
} from "./view.js";

type Counts = Record<RenderState, number>;

export type Status = {
  counts: Counts;
  orchestrated_counts: Counts;
  panes: PaneView[];
  peers: {
    name: string;
    /**
     * The ssh target, which is what a REMEDY must name. `peer add <name>
     * [target]` takes them separately, so a peer called `dev` can point at
     * `user@box.example` -- and a suggested command built from the name would
     * then not run.
     */
    target: string;
    display_name: string | null;
    fetched_at: number | null;
    snapshot_at: number | null;
    last_error: string | null;
    stale: boolean;
    /**
     * The operator must authenticate interactively before this peer can be
     * collected again: it has answered before, its last attempt was refused on
     * auth, and no warm ControlMaster socket exists to ride.
     *
     * Derived, never stored, which is what makes it self-correcting -- `ssh
     * <host>` creates the socket and this clears on the next read, with no
     * successful fetch required and no state anyone has to remember to clean up.
     */
    needs_session: boolean;
  }[];
};

function emptyCounts(): Counts {
  const counts = {} as Counts;
  for (const state of RENDER_PRIORITY) counts[state] = 0;
  return counts;
}

export function tmuxStatus(view: Status): string {
  // Orchestrated agents count only for the states a human can answer: a
  // supervisor consumes a `done` worker's result and `running` asks for nothing.
  // The list is `NEEDS_HUMAN`, shared with the picker's visibility rule so the
  // two surfaces cannot disagree about which crew rows matter.
  const needsHuman = new Set<RenderState>(NEEDS_HUMAN);
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
export function status(
  store: Store,
  identity: NodeIdentity,
  now = Date.now(),
  // Injected for the same reason `Channel` and `Mux` are: a test must not need
  // an ssh binary, and "was this peer probed at all" has to be assertable --
  // which is the only way to pin the cost control below.
  warm: (target: string) => boolean = hasWarmSocket,
  // Where the reader is sitting, which only affects ORDER within a state band.
  // Read from the environment here rather than in `viewSort`, so the pure
  // function stays pure and a test can place the reader anywhere.
  //
  // $TMUX_PANE, never a tmux query: the same rule `mux.currentWindow()` follows.
  // Asking tmux answers for whichever pane the server thinks is active, which is
  // not the pane this process runs in -- and the status bar renders in the tmux
  // server itself, where that would name an unrelated agent.
  context: SortContext = { here: process.env.TMUX_PANE },
): Status {
  const counts = emptyCounts();
  const orchestratedCounts = emptyCounts();
  const panes = viewSort(paneViews(store, identity, now), { ...context, now });
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
      target: peer.target,
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
      // Candidates ONLY, and the order is the cost control: everything left of
      // `warm(...)` is a free cached read, so the ~20ms probe runs for a peer
      // that could plausibly need it and for no other. Probing all of them would
      // more than double a picker launch path measured at ~60ms, to answer
      // questions nobody reads.
      //
      // NO "has worked before" condition, deliberately. The first version
      // required `snapshot !== null` and that excluded the exact peer this
      // exists for: a peer row re-added by hand holds only `(name, target)`, so
      // its snapshot is NULL and it has never worked as far as murmur knows.
      // Every test passed, because every test seeds a successful fetch first;
      // only the real fleet showed it.
      //
      // The classifier already carries the fact that test was reaching for.
      // Producing `Permission denied` requires a completed TCP connect, key
      // exchange and auth round, so an unreachable host cannot say it -- the
      // error IS the proof of contact. Which is also why nagging `ssh linuxpc`
      // at a switched-off box cannot happen: it fails with `Operation timed
      // out`, which is not auth-class.
      needs_session:
        peer.last_error !== null && needsInteractiveAuth(peer.last_error) && !warm(peer.target),
    })),
  };
}

/**
 * Collect from peers, then read. This is what every user-facing surface wants:
 * the view reflects the sync that just ran, rather than the one before it.
 *
 * Awaiting matters twice over. A fire-and-forget collect shows data one run
 * stale, and callers close the store in a `finally`, so a collect still in
 * flight lands on a closed handle and reports "The database connection is not
 * open" -- which looks like corruption rather than a race.
 *
 * Sync must never fail a command and on this path must never print either:
 * `status` runs on every tick and the picker's reload runs behind a popup, so
 * one sleeping laptop would write ssh diagnostics to stderr several times a
 * minute forever. `murmur collect`, run deliberately, is the only place that
 * prints.
 *
 * `floorMs` is how a caller says whether it is a TIMER or a PERSON. The status
 * bar passes COLLECT_FLOOR_MS so fetch rate stops tracking redraw rate. The
 * picker's rows path passes nothing: `^r` is a person asking now, and a refresh
 * key that skipped the fetch would be a key that silently does nothing.
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
