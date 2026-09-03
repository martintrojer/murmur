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
 * `status.ts` and `pick.ts` import this rather than declaring their own copies,
 * so no two surfaces can sort one list differently.
 */
export const RENDER_PRIORITY: readonly RenderState[] = [
  "crashed",
  "blocked",
  "done",
  "running",
  "idle",
];

/**
 * The attention kinds only a human can answer, and the second table both
 * surfaces must agree on.
 *
 * `blocked` means waiting for an answer an orchestrator cannot give -- mu places
 * work, it cannot choose between two approaches. `crashed` means the process
 * died. Everything else about an orchestrated agent is its supervisor's
 * business.
 *
 * `pick.ts` uses it for which crew rows are visible by default, `status.ts` for
 * which crew states reach the status bar. Two literals in two files answering
 * one question is how a row that needed a human became one a human could not
 * see.
 */
export const NEEDS_HUMAN: readonly AttentionKind[] = ["blocked", "crashed"];

/**
 * One attention request as a surface reads it: the kind, and WHEN it was asked.
 *
 * The timestamp is per kind rather than folded into the pane's `updated_at`,
 * because urgency is per request: a pane crashed an hour ago and blocked ten
 * seconds ago has two different ages, and the one that decides its position is
 * the one belonging to the kind it renders as. Collapsing them to a single
 * `max` -- which is what `updated_at` is -- let a fresh `done` mask a starving
 * `blocked` on the same pane.
 *
 * `message` and `source` stay in the snapshot and out of here: nothing paints
 * them, and a field carried for a future reader is a field nobody keeps true.
 */
export type PaneAttention = { kind: AttentionKind; requested_at: number };

/** Does this pane want this kind of attention? */
export function wants(
  view: { attention: readonly { kind: AttentionKind }[] },
  kind: AttentionKind,
): boolean {
  return view.attention.some((entry) => entry.kind === kind);
}

/**
 * One pane, as every surface reads it: address, the three independent facts,
 * owner metadata, and ages.
 *
 * Local and remote panes are the same type, built by the same mapping, because
 * `Store.localPanes()` and a peer's cached snapshot both return
 * `SnapshotPane[]`. One mapping means local and remote cannot drift apart.
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
  attention: PaneAttention[];
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
 * DEFINED here, because freshness is a view concept: the collector re-exports it
 * for callers already importing from there. The comment this replaces claimed
 * the opposite direction and sent a reader to collector.ts for a rationale that
 * was written nowhere.
 *
 * Sixty seconds is a ceiling on how wrong the HUD may be about a reachable host,
 * chosen against the collect cadence rather than derived: it must leave room for
 * a peer to miss two consecutive ambient attempts before it reads stale, so a
 * single slow poll does not make a healthy fleet flap.
 *
 * That is a real coupling and the compiler cannot see it:
 * `COLLECT_FLOOR_MS + COLLECT_JITTER_MS / 2` must stay strictly under this, or an
 * unlucky jitter draw pushes a reachable peer over the line on its own.
 * test/collector.test.ts asserts both halves of that inequality, so changing
 * either number fails a test rather than silently making the HUD flap.
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
 * A running agent with `blocked` attention is valid and expected, and surfaces
 * that can show both do -- this is only for the ones that must pick one.
 */
export function renderState(view: {
  activity: Activity | null;
  attention: readonly { kind: AttentionKind }[];
}): RenderState {
  for (const kind of ["crashed", "blocked", "done"] as const) {
    if (wants(view, kind)) return kind;
  }
  return view.activity === "running" ? "running" : "idle";
}

/** The later of two clock readings, either of which may be absent. */
function newest(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

/** The newest attention request on a pane, and half of its `updated_at`. */
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
    attention: pane.attention.map((entry) => ({
      kind: entry.kind,
      requested_at: entry.requested_at,
    })),
    freshness: source.freshness,
    agent_id: agent?.agent_id ?? null,
    agent_name: agent?.agent_name ?? null,
    pi_session: agent?.pi_session ?? null,
    workstream: agent?.workstream ?? null,
    role: agent?.role ?? null,
    cli: agent?.cli ?? null,
    driver: agent?.driver ?? DEFAULT_DRIVER,
    // The NEWER of the two, not the agent row with attention as a fallback.
    //
    // `??` consulted the attention clock only for a pane with no agent row, so
    // an existing agent row discarded every attention timestamp -- including a
    // newer one. Both numbers are the owning node's own clock, so this was never
    // a two-clocks problem; it was one clock read from the wrong row.
    //
    // The writer it hurt is the one that structurally cannot touch an agent row:
    // `murmur notify` writes attention with no agent field, by design. So a
    // codex agent blocked seconds ago on a pane whose pi last reported two hours
    // ago carried a two-hour age -- and `viewSort`'s second key is "the newest
    // news", so the freshest request for a human sank in the list the human
    // opened to act on it. The picker prints the same field as `age` and `said`.
    //
    // Matches the field's docblock, which says "when the pane's own node last
    // said something": a `blocked` row IS the node saying something.
    updated_at: newest(agent?.updated_at ?? null, newestAttention(pane)),
    snapshot_at: source.snapshot_at,
    fetched_at: source.fetched_at,
  };
}

/**
 * Every pane this node knows about: its own, plus one cached snapshot per peer.
 *
 * `identity` is non-null because every caller is a command that already requires
 * `murmur init`, so no pane can be misclassified as remote by an absent one.
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
      // The name the human typed, not the self-reported hostname: a peer added
      // as `linuxpc` can report a container id, which appears nowhere else and
      // cannot be typed at `peer remove`.
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

/**
 * Which way age points, per state.
 *
 * Not one rule, and the single rule it replaces was wrong for half the table.
 * `done` is news: the freshest result is the one you have not seen, and an
 * acknowledged-but-unfocused pane from this morning is the one you have. But a
 * request for a human STARVES -- an agent blocked forty minutes ago has been
 * waiting forty minutes, and newest-first buried it under one blocked thirty
 * seconds ago, every single time the newer one appeared. The list a human opens
 * to unblock things sorted the longest-waiting thing to the bottom.
 *
 * `running` and `idle` ask for nothing, so the direction there is only a
 * tiebreak and newest reads best: it is the pane you last touched.
 */
const OLDEST_FIRST: readonly RenderState[] = ["crashed", "blocked"];

/**
 * How much a signal is worth, in MINUTES OF WAITING.
 *
 * One unit for every bonus, so each is a sentence a reader can check against
 * their own list -- "being in the stream you are working in is worth ten minutes
 * of age" -- rather than a dimensionless weight that can only be tuned by
 * flailing. It also means a bonus can never dominate: age is unbounded, so a
 * genuinely starving row eventually outranks any pile of nudges, which is what
 * `OLDEST_FIRST` exists to guarantee.
 *
 * These are the same knobs a config file would set, and none is set anywhere
 * yet, deliberately: every signal here is already in the snapshot, so the
 * ordering improves for everyone with nothing to configure and nothing to parse.
 */
const BONUS_MINUTES = {
  /** Per attention kind BEYOND the one the row renders as. */
  pile: 15,
  /** The row is in the workstream (or tmux session) you are sitting in. */
  stream: 10,
  /** A keypress away, against an ssh and a nested tmux attach. */
  local: 2,
} as const;

/** What a reader knows about themselves. Everything optional; all of it a nudge. */
export type SortContext = {
  now?: number;
  /** The pane the reader is sitting in, if they are in one. */
  here?: string;
};

/** The context after defaulting, plus the stream `viewSort` resolved from the list. */
type Resolved = { now: number; here: string; stream: string | null };

/**
 * When the fact a row RENDERS was reported, or null if nothing said.
 *
 * The rendered kind's own `requested_at`, not the pane's `updated_at`, which is
 * the max over every fact on the pane. A pane crashed an hour ago and marked
 * `done` a second ago renders `crashed` and must carry the crash's age: under
 * the max it read as a one-second-old crash and sorted above genuinely fresh
 * ones.
 */
function statedAt(view: PaneView, state: RenderState): number | null {
  for (const entry of view.attention) {
    if (entry.kind === state) return entry.requested_at;
  }
  return view.updated_at;
}

/**
 * How much this row wants the reader, within its state band. Higher is sooner.
 *
 * Presentation only, and deliberately NOT exported as a number anyone stores or
 * paints: it has no meaning across bands (a hot `idle` never outranks a cold
 * `crashed`), and printing it would invite exactly that comparison.
 *
 * `-Infinity` for a row that never said when: unknown is not new, and it is not
 * urgent either. It sorts last in its band in both directions rather than
 * pretending to a position, which is the same answer the old `?? 0` gave for
 * newest-first, now also correct for oldest-first -- where a missing timestamp
 * read as 1970 and won the whole list.
 */
function urgency(view: PaneView, state: RenderState, context: Resolved): number {
  const at = statedAt(view, state);
  if (at === null) return Number.NEGATIVE_INFINITY;

  const minutes = (context.now - at) / 60_000;
  let score = OLDEST_FIRST.includes(state) ? minutes : -minutes;

  score += BONUS_MINUTES.pile * (view.attention.length - 1);
  if (view.local) score += BONUS_MINUTES.local;
  if (context.stream !== null && stream(view) === context.stream) score += BONUS_MINUTES.stream;
  return score;
}

/**
 * Which piece of work a row belongs to: the workstream mu set, else the tmux
 * session name.
 *
 * The same chain the picker's `stream` column prints, so "in my stream" means
 * exactly what the column a reader can see says, rather than a second answer
 * only the sort knows.
 */
function stream(view: PaneView): string | null {
  return view.workstream ?? view.session_name;
}

/**
 * Attention-first ordering, then confidence, then urgency, then address.
 *
 * The state band is still lexicographic and still `RENDER_PRIORITY`: nothing
 * below may lift an `idle` row above a `blocked` one, because the band is the
 * one thing a reader is entitled to read off a position. Everything else
 * decides only who leads WITHIN a band.
 *
 * Two demotions are categorical rather than scored, because both are statements
 * about whether the row is worth acting on at all:
 *
 *   - The pane you are SITTING IN goes last in its band. You do not need a
 *     picker to reach the pane your cursor is already in, and it was reliably at
 *     the top -- it is the pane that most recently said something.
 *   - A row from a STALE host goes below every fresh row in its band. Its fields
 *     are last-known and may be hours dead; a fresh row we can vouch for should
 *     be reached first. Scoring this instead would have let an ever-growing age
 *     on an unreachable host outrun every fact we can still verify.
 *
 * TOTAL on purpose, which is why the address comparisons remain. Ties are
 * ordinary -- two crashed panes reconciled in one transaction share a
 * `requested_at` exactly -- and `sort` is stable only with respect to the order
 * it was GIVEN, here whatever SQLite and the peer loop produced. An unbroken tie
 * makes the list depend on that: a status bar reshuffles between two identical
 * ticks, and a picker row moves under the keypress aimed at it.
 *
 * Presentation only. No caller may read meaning into a row's position -- pane
 * order in a snapshot carries none either, so a reader sorts for itself.
 */
export function viewSort(views: PaneView[], context: SortContext = {}): PaneView[] {
  const at = context.now ?? Date.now();
  const here = context.here ?? "";
  // The reader's own row, found once rather than per comparison. Local by
  // construction: a pane id names a pane on the machine reading it, and two
  // hosts routinely hold a `%1`.
  //
  // The reader's stream is resolved FROM the list rather than passed in, because
  // it is not a separate fact -- it is whatever the row for their own pane says.
  // A caller supplying it would be deriving it from this same list, one copy of
  // the fallback chain per surface.
  const mine = here ? views.find((view) => view.local && view.pane === here) : undefined;
  const resolved: Resolved = { now: at, here, stream: mine ? stream(mine) : null };

  return [...views].sort((left, right) => {
    const leftState = renderState(left);
    const rightState = renderState(right);
    const byState = (ORDER.get(leftState) ?? 99) - (ORDER.get(rightState) ?? 99);
    if (byState !== 0) return byState;

    const byHere = sittingIn(left, resolved.here) - sittingIn(right, resolved.here);
    if (byHere !== 0) return byHere;

    const byFreshness = stale(left) - stale(right);
    if (byFreshness !== 0) return byFreshness;

    const byUrgency = urgency(right, rightState, resolved) - urgency(left, leftState, resolved);
    // NaN-proof: two `-Infinity` urgencies subtract to NaN, which is neither
    // positive nor negative, so a raw return would leave the pair unordered and
    // hand the position back to the input order this function exists to remove.
    if (byUrgency > 0) return 1;
    if (byUrgency < 0) return -1;

    // Address as the final key, because it is the only field guaranteed unique
    // across the whole view: `pane` is unique per node and `host` per peer.
    const byHost = left.host.localeCompare(right.host);
    return byHost !== 0 ? byHost : left.pane.localeCompare(right.pane);
  });
}

/** 1 for the pane the reader is sitting in, which sorts last in its band. */
function sittingIn(view: PaneView, pane: string): number {
  return pane && view.local && view.pane === pane ? 1 : 0;
}

/** 1 for a row whose host we have not reached lately, which sorts after fresh ones. */
function stale(view: PaneView): number {
  return view.freshness === "stale" ? 1 : 0;
}
