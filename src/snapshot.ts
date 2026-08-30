import { asPaneId, asSessionId, asWindowId } from "./ids.js";
import type {
  Activity,
  AttentionKind,
  Driver,
  Snapshot,
  SnapshotAgent,
  SnapshotAttention,
  SnapshotPane,
} from "./types.js";

/**
 * A peer answered, and what it said is not a snapshot.
 *
 * A distinct type because the collector must be able to tell this from an
 * unreachable host: a node that serves a bad document is REACHABLE BUT BROKEN,
 * and an operator needs to see that rather than "asleep, probably".
 */
export class SnapshotInvalidError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = "SnapshotInvalidError";
  }
}

function fail(path: string, detail: string): never {
  throw new SnapshotInvalidError(path, detail);
}

/**
 * Exactly these keys, no more and no fewer.
 *
 * Unknown keys are rejected rather than carried, and nothing is coerced or
 * defaulted: validation happens BEFORE storage, so no unknown value can reach a
 * sort, a count or a render path.
 */
function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) if (!(key in record)) fail(path, `missing key ${key}`);
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) fail(path, `unknown key ${key}`);
  }
  return record;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") fail(path, "expected a non-empty string");
  return value;
}

function textOrNull(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") fail(path, "expected a string or null");
  return value;
}

function anyText(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "expected a string");
  return value;
}

function timestamp(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(path, "expected a non-negative integer");
  }
  return value;
}

function member<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(path, `expected one of ${allowed.join(", ")}`);
  }
  return value as T;
}

const ACTIVITIES: readonly Activity[] = ["running", "stopped"];
const DRIVERS: readonly Driver[] = ["human", "orchestrated"];
const KINDS: readonly AttentionKind[] = ["done", "blocked", "crashed"];

const TOP_KEYS = [
  "murmur_snapshot",
  "host_id",
  "display_name",
  "murmur_version",
  "generated_at",
  "panes",
] as const;
const PANE_KEYS = [
  "pane",
  "session",
  "window",
  "session_name",
  "window_name",
  "agent",
  "attention",
] as const;
const AGENT_KEYS = [
  "agent_id",
  "activity",
  "agent_name",
  "pi_session",
  "workstream",
  "role",
  "cli",
  "driver",
  "claimed_at",
  "updated_at",
] as const;
const ATTENTION_KEYS = ["kind", "message", "source", "requested_at"] as const;

function parseAgent(value: unknown, path: string): SnapshotAgent | null {
  if (value === null) return null;
  const row = object(value, path, AGENT_KEYS);
  return {
    agent_id: text(row.agent_id, `${path}.agent_id`),
    activity: member(row.activity, `${path}.activity`, ACTIVITIES),
    agent_name: textOrNull(row.agent_name, `${path}.agent_name`),
    pi_session: textOrNull(row.pi_session, `${path}.pi_session`),
    workstream: textOrNull(row.workstream, `${path}.workstream`),
    role: textOrNull(row.role, `${path}.role`),
    cli: text(row.cli, `${path}.cli`),
    driver: member(row.driver, `${path}.driver`, DRIVERS),
    claimed_at: timestamp(row.claimed_at, `${path}.claimed_at`),
    updated_at: timestamp(row.updated_at, `${path}.updated_at`),
  };
}

function parseAttention(value: unknown, path: string): SnapshotAttention[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  const seen = new Set<AttentionKind>();
  return value.map((entry, index) => {
    const at = `${path}[${index}]`;
    const row = object(entry, at, ATTENTION_KEYS);
    const kind = member(row.kind, `${at}.kind`, KINDS);
    if (seen.has(kind)) fail(`${at}.kind`, `duplicate kind ${kind} for this pane`);
    seen.add(kind);
    return {
      kind,
      message: anyText(row.message, `${at}.message`),
      source: anyText(row.source, `${at}.source`),
      requested_at: timestamp(row.requested_at, `${at}.requested_at`),
    };
  });
}

function parsePane(value: unknown, path: string): SnapshotPane {
  const row = object(value, path, PANE_KEYS);
  const agent = parseAgent(row.agent, `${path}.agent`);
  const attention = parseAttention(row.attention, `${path}.attention`);
  // Rule 3 of the document schema: a pane with neither is not a pane worth
  // publishing, so a document carrying one is malformed rather than merely
  // noisy.
  if (agent === null && attention.length === 0) {
    fail(path, "a pane with no agent and no attention must not be emitted");
  }
  return {
    pane: asPaneId(text(row.pane, `${path}.pane`)),
    session: asSessionId(text(row.session, `${path}.session`)),
    window: asWindowId(text(row.window, `${path}.window`)),
    session_name: textOrNull(row.session_name, `${path}.session_name`),
    window_name: textOrNull(row.window_name, `${path}.window_name`),
    agent,
    attention,
  };
}

/**
 * Parse and totally validate one snapshot document.
 *
 * `murmur_snapshot` must be exactly 1: a higher value is rejected too, because
 * forward compatibility is not offered here and a version mismatch is an
 * operator-visible pairing problem. Saying so is the honest report; guessing at
 * a newer document's meaning is not.
 */
export function parseSnapshot(input: string): Snapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    fail("", `not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const top = object(parsed, "", TOP_KEYS);
  if (top.murmur_snapshot !== 1) {
    fail("murmur_snapshot", `expected 1, got ${JSON.stringify(top.murmur_snapshot)}`);
  }
  if (!Array.isArray(top.panes)) fail("panes", "expected an array");

  const panes = top.panes.map((entry, index) => parsePane(entry, `panes[${index}]`));
  const seen = new Set<string>();
  for (const pane of panes) {
    if (seen.has(pane.pane)) fail("panes", `duplicate pane ${pane.pane}`);
    seen.add(pane.pane);
  }

  return {
    murmur_snapshot: 1,
    host_id: text(top.host_id, "host_id"),
    display_name: text(top.display_name, "display_name"),
    murmur_version: text(top.murmur_version, "murmur_version"),
    generated_at: timestamp(top.generated_at, "generated_at"),
    panes,
  };
}
