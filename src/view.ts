import type { NodeIdentity } from "./identity.js";
import type { PaneId, SessionId, WindowId } from "./ids.js";
import type { Store } from "./store.js";
import {
  type Activity,
  type AttentionKind,
  DEFAULT_DRIVER,
  type Driver,
  type SnapshotPane,
} from "./types.js";

export type Freshness = "fresh" | "stale";

/**
 * What a surface paints. Presentation only, derived from the three independent
 * facts and never stored.
 */
export type RenderState = "crashed" | "blocked" | "done" | "running" | "idle";

/**
 * THE single ordering table: which state matters most, for sorting and for
 * choosing one word to show.
 *
 * `status.ts` and `pick.ts` import this rather than declaring their own copies.
 * Three near-identical tables previously disagreed about whether `crashed` or
 * `blocked` led, so two surfaces sorted the same list differently.
 */
export const RENDER_PRIORITY: readonly RenderState[] = [
  "crashed",
  "blocked",
  "done",
  "running",
  "idle",
];

/**
 * One pane, as every surface reads it: address, the three independent facts,
 * owner metadata, and ages.
 *
 * Local and remote panes are the same type, built by the same mapping, because
 * `Store.localPanes()` and a peer's cached snapshot both return
 * `SnapshotPane[]`. The old model had one fold for local and the same fold with
 * `() => true` for remote, and three of the audited bugs lived in that seam.
 */
export type PaneView = {
  // address
  host_id: string;
  /** The name the operator typed, or this node's display_name. */
  host: string;
  local: boolean;
  pane: PaneId;
  session: SessionId;
  window: WindowId;
  session_name: string | null;
  window_name: string | null;
  // the three independent facts
  /** Null for an attention-only pane, which has no agent row. */
  activity: Activity | null;
  attention: AttentionKind[];
  freshness: Freshness;
  // owner-reported metadata, null for an attention-only pane
  agent_id: string | null;
  agent_name: string | null;
  pi_session: string | null;
  workstream: string | null;
  role: string | null;
  cli: string | null;
  driver: Driver;
  // ages
  /** When the pane's own node last said something. Never `fetched_at`. */
  updated_at: number | null;
  /** When that node generated its snapshot. Null for local. */
  snapshot_at: number | null;
  /** When we last reached that node. Null for local. */
  fetched_at: number | null;
};

/**
 * How long a peer may go unfetched before its panes render stale.
 *
 * Re-exported from here rather than imported from the collector by view
 * consumers, so freshness has one definition. See collector.ts for why sixty
 * seconds.
 */
export const STALENESS_MS = 60_000;

/**
 * A duration as the shortest thing worth reading: "5m", "2h", "3d".
 *
 * Under a minute is the empty string: an age that changes every second is noise
 * in a status column. This and `freshness` are the only two places a duration
 * becomes text or a verdict.
 */
export function age(ms: number | null): string {
  if (ms === null || ms < 60_000) return "";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

/**
 * Freshness of a NODE, never of an agent.
 *
 * A peer we have never reached is stale rather than fresh: null means the first
 * collect has not succeeded yet, and an unreachable host you just added must not
 * render as up to date.
 */
export function freshness(
  fetchedAt: number | null,
  now: number,
  thresholdMs = STALENESS_MS,
): Freshness {
  return fetchedAt !== null && now - fetchedAt <= thresholdMs ? "fresh" : "stale";
}

/**
 * One word for a pane. Attention wins over activity, because attention is a
 * request and activity is a description.
 *
 * A running agent with `blocked` attention is a valid and expected state, and
 * surfaces that can show both, do — this is only for the ones that must pick.
 */
export function renderState(view: Pick<PaneView, "activity" | "attention">): RenderState {
  for (const kind of ["crashed", "blocked", "done"] as const) {
    if (view.attention.includes(kind)) return kind;
  }
  return view.activity === "running" ? "running" : "idle";
}

/** The newest attention request on a pane, for the `updated_at` of one with no agent. */
function newestAttention(pane: SnapshotPane): number | null {
  let newest: number | null = null;
  for (const entry of pane.attention) {
    if (newest === null || entry.requested_at > newest) newest = entry.requested_at;
  }
  return newest;
}

type ViewSource = {
  host_id: string;
  host: string;
  local: boolean;
  freshness: Freshness;
  snapshot_at: number | null;
  fetched_at: number | null;
};

function paneView(pane: SnapshotPane, source: ViewSource): PaneView {
  const agent = pane.agent;
  return {
    host_id: source.host_id,
    host: source.host,
    local: source.local,
    pane: pane.pane,
    session: pane.session,
    window: pane.window,
    session_name: pane.session_name,
    window_name: pane.window_name,
    activity: agent?.activity ?? null,
    attention: pane.attention.map((entry) => entry.kind),
    freshness: source.freshness,
    agent_id: agent?.agent_id ?? null,
    agent_name: agent?.agent_name ?? null,
    pi_session: agent?.pi_session ?? null,
    workstream: agent?.workstream ?? null,
    role: agent?.role ?? null,
    cli: agent?.cli ?? null,
    driver: agent?.driver ?? DEFAULT_DRIVER,
    updated_at: agent?.updated_at ?? newestAttention(pane),
    snapshot_at: source.snapshot_at,
    fetched_at: source.fetched_at,
  };
}

/**
 * Every pane this node knows about: its own, plus one cached snapshot per peer.
 *
 * `identity` is non-null because every caller is a command that already requires
 * `murmur init`. The optional chaining that used to hang off it classed local
 * panes as remote whenever identity happened to be absent.
 *
 * No liveness is probed here, for local or remote. A remote pane's `activity` is
 * whatever its own node last said; a stale node keeps its last-known fields
 * verbatim beside an explicit warning.
 */
export function paneViews(store: Store, identity: NodeIdentity, now = Date.now()): PaneView[] {
  const views = store.localPanes().map((pane) =>
    paneView(pane, {
      host_id: identity.host_id,
      host: identity.display_name,
      local: true,
      // Local panes are always fresh: we are the node that authored them.
      freshness: "fresh",
      snapshot_at: null,
      fetched_at: null,
    }),
  );

  for (const peer of store.peers()) {
    const snapshot = peer.snapshot;
    if (!snapshot) continue;
    const source: ViewSource = {
      host_id: snapshot.host_id,
      // The name the human typed, not the machine's self-reported hostname: a
      // peer added as `linuxpc` can report a container id, which appears
      // nowhere else in the tool and cannot be typed at `peer remove`.
      host: peer.name,
      local: false,
      freshness: freshness(peer.fetched_at, now),
      snapshot_at: peer.snapshot_at,
      fetched_at: peer.fetched_at,
    };
    for (const pane of snapshot.panes) views.push(paneView(pane, source));
  }

  return views;
}

const ORDER = new Map<RenderState, number>(RENDER_PRIORITY.map((state, index) => [state, index]));

/** Attention-first ordering, then the newest news. */
export function viewSort(views: PaneView[]): PaneView[] {
  return [...views].sort((left, right) => {
    const byState = (ORDER.get(renderState(left)) ?? 99) - (ORDER.get(renderState(right)) ?? 99);
    if (byState !== 0) return byState;
    return (right.updated_at ?? 0) - (left.updated_at ?? 0);
  });
}
