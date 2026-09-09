import type { PaneId, SessionId, WindowId } from "./ids.js";

/**
 * The three independent facts, as types.
 *
 * `activity` is what the pane's own process says it is doing. `attention` is
 * whether a human is wanted. `freshness` (src/view.ts) is how recently we
 * reached the node that reported. They are three independent fields, never one
 * enum, and absence carries meaning: no attention row means "nothing to see",
 * no agent row means "no agent here".
 */
export type Activity = "running" | "stopped";
export type AttentionKind = "done" | "blocked" | "crashed";

/**
 * Attention kinds, most urgent first. Beside the type they order.
 *
 * Typed as `AttentionKind` rather than reusing `RENDER_PRIORITY`, which is a
 * list of five `RenderState`s of which these are three. Sorting attention
 * through that table built an index map over two entries that could never be
 * looked up, forced the map to `Map<string, number>` to typecheck, and so
 * required a `?? 99` fallback -- a fallback branch in a sort path, in a repo
 * whose reason for CHECK-constraining this column is that "no sort, count or
 * render path needs a fallback branch". Typed correctly, the fallback deletes
 * itself.
 *
 * The two tables must not disagree about relative order; a test asserts this is
 * an order-consistent subset of `RENDER_PRIORITY` rather than importing one into
 * the other.
 */
export const ATTENTION_PRIORITY: readonly AttentionKind[] = ["crashed", "blocked", "done"];

/**
 * Who is waiting on this agent -- a human, or a supervisor that consumes the
 * result. Not "which harness"; that is `cli`.
 */
export type Driver = "human" | "orchestrated";

export const DEFAULT_DRIVER: Driver = "human";

/**
 * Where a pane currently lives. Location, never identity.
 *
 * `pane` is the address and is stable for the life of the pane; `session` and
 * `window` are only where that pane currently is, and both change under
 * move-pane and break-pane. Only a pane may decide whether an agent exists,
 * which is what the brands in ./ids.js enforce.
 */
export type Location = {
  session: SessionId;
  window: WindowId;
  pane: PaneId;
  session_name: string | null;
  window_name: string | null;
};

/** Owner-reported metadata about the agent in a pane. */
export type AgentMeta = {
  agent_name: string | null;
  pi_session: string | null;
  workstream: string | null;
  role: string | null;
  cli: string;
  driver: Driver;
};

export type PeerRecord = {
  name: string;
  target: string;
  /** Opaque command template for interactive access; `{pane}` is substituted. */
  jump_command: string;
  host_id: string | null;
  display_name: string | null;
  /** The whole validated document, or null when we have never parsed one. */
  snapshot: Snapshot | null;
  /** The PEER's clock: when that node built the document. */
  snapshot_at: number | null;
  /** OUR clock: when we last reached it. Freshness is computed from this. */
  fetched_at: number | null;
  last_attempt_at: number | null;
  last_error: string | null;
  murmur_version: string | null;
  /** The peer's `murmur_snapshot` value, i.e. the document version it speaks. */
  snapshot_version: number | null;
};

/**
 * One node's whole current state. Complete, never a delta: a peer that returns
 * one has said everything it knows, so absence from it is absence.
 */
export type Snapshot = {
  murmur_snapshot: 1;
  host_id: string;
  display_name: string;
  murmur_version: string;
  generated_at: number;
  panes: SnapshotPane[];
};

export type SnapshotPane = {
  pane: PaneId;
  session: SessionId;
  window: WindowId;
  session_name: string | null;
  window_name: string | null;
  /** Null for an attention-only pane: valid, listable, jumpable. */
  agent: SnapshotAgent | null;
  attention: SnapshotAttention[];
};

export type SnapshotAgent = AgentMeta & {
  agent_id: string;
  activity: Activity;
  claimed_at: number;
  updated_at: number;
};

export type SnapshotAttention = {
  kind: AttentionKind;
  message: string;
  source: string;
  requested_at: number;
};

/**
 * Whether a pid is still running. A parameter everywhere it is consulted, so a
 * test needs no process table.
 */
export type LiveCheck = (pid: number) => boolean;

export type AgentClaim = {
  location: Location;
  owner_pid: number;
  meta: AgentMeta;
  now?: number;
  isAlive?: LiveCheck;
};

export type ClaimResult =
  | { outcome: "claimed"; agent_id: string }
  | { outcome: "retained"; agent_id: string }
  | { outcome: "replaced"; agent_id: string; previous_agent_id: string }
  | { outcome: "refused"; held_by_pid: number };

export type ActivityUpdate = {
  agent_id: string;
  owner_pid: number;
  activity: Activity;
  location: Location;
  now?: number;
};

export type AgentRelease = { agent_id: string; owner_pid: number };

/**
 * The kinds an EXTERNAL writer may request.
 *
 * `crashed` is deliberately absent. It is reconciliation's word: it means "the
 * owning process died without saying so", which only the node that can probe
 * that pid may conclude. A caller asserting it would be manufacturing a fact it
 * cannot observe, and the rule was previously only a convention -- nothing
 * stopped `requestAttention({ kind: "crashed" })` from an extension, a notify
 * hook, or a future surface, and a sweep confirmed such a row lands in
 * `localPanes` indistinguishable from a real crash.
 *
 * The narrower type is the enforcement. Reconciliation writes its own row
 * through the same statement without going through this shape.
 */
export type RequestableKind = Exclude<AttentionKind, "crashed">;

/**
 * Everything an attention writer may say. There is no agent_id, no owner_pid,
 * no activity and no owner metadata field, and adding one is a contract change.
 */
export type AttentionRequest = {
  kind: RequestableKind;
  location: Location;
  message: string;
  source: string;
  now?: number;
};

/**
 * The only local facts reconciliation is allowed to consult.
 *
 * `panes` is null when tmux could not answer, which is not evidence of death.
 * `isAlive` and `now` are parameters so a test needs no process table and no
 * clock control.
 */
export type LocalWorld = {
  panes: Set<PaneId> | null;
  isAlive?: LiveCheck;
  now?: number;
};

export type ReconcileSummary = {
  crashed: PaneId[];
  removed: PaneId[];
  attention_removed: PaneId[];
};

export type PeerFetch =
  | { ok: true; snapshot: Snapshot; at: number }
  | { ok: false; error: string; at: number };
