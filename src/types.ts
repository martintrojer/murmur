import type { PaneId, SessionId, WindowId } from "./ids.js";

/**
 * The three independent facts, as types.
 *
 * `activity` is what the pane's own process says it is doing. `attention` is
 * whether a human is wanted. `freshness` (src/view.ts) is how recently we
 * reached the node that reported. They are never folded into one enum, and
 * there is no `cleared`: absence of an attention row IS "nothing to see", and
 * absence of an agent row IS "no agent here".
 */
export type Activity = "running" | "stopped";
export type AttentionKind = "done" | "blocked" | "crashed";

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
 * move-pane and break-pane. Reading a window id as evidence about existence
 * deleted ten live agents once, which is what the brands in ./ids.js exist to
 * prevent.
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

export type AgentRow = AgentMeta & {
  /**
   * A UUID minted per PROCESS INSTANCE, not derived from the pane.
   *
   * So a replacement owner is a different row, and a late write from the
   * previous owner matches nothing and is silently ineffective rather than
   * destructive.
   */
  agent_id: string;
  pane: PaneId;
  /**
   * Local only. Never in a snapshot, never on the wire: a remote pid names a
   * process in another machine's table, so keeping it local makes remote
   * liveness inference unrepresentable rather than merely discouraged.
   */
  owner_pid: number;
  activity: Activity;
  session: SessionId;
  window: WindowId;
  session_name: string | null;
  window_name: string | null;
  claimed_at: number;
  updated_at: number;
};

/**
 * One attention request, addressed by pane.
 *
 * No `agent_id`, no `owner_pid`, no activity, no owner metadata: an attention
 * writer structurally cannot address an agent's identity. That is the whole fix
 * for the live-store corruption where `murmur notify` replaced a working
 * agent's row and nulled its name, workstream, role and driver.
 *
 * It carries its own location so an attention-only pane -- a codex agent murmur
 * never instrumented -- is listable and jumpable with no agent row.
 */
export type AttentionRow = {
  pane: PaneId;
  kind: AttentionKind;
  message: string;
  source: string;
  session: SessionId;
  window: WindowId;
  session_name: string | null;
  window_name: string | null;
  requested_at: number;
};

export type PeerRecord = {
  name: string;
  target: string;
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
 * Everything an attention writer may say. There is no agent_id, no owner_pid,
 * no activity and no owner metadata field, and adding one is a contract change.
 */
export type AttentionRequest = {
  kind: AttentionKind;
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
