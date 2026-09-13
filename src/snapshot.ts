import { asPaneId, asSessionId, asWindowId } from "./ids.js";
import type {
  Activity,
  AgentUsage,
  AttentionKind,
  Driver,
  Snapshot,
  SnapshotAgent,
  SnapshotAttention,
  SnapshotPane,
} from "./types.js";
import { EFFORTS, SNAPSHOT_VERSION } from "./types.js";

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
    // An EMPTY path means the failure is about the document as a whole, not
    // about a field in it, so there is nothing to prefix. Joining regardless
    // produced `bubba: : not JSON (...)` in `peer list` and in the one line
    // `murmur collect` prints -- measured against a real second node, and for
    // the most common remote misconfiguration there is (murmur missing, so the
    // "document" is a shell error). `path` itself stays "", because that is what
    // it means and a caller must not have to know a sentinel.
    super(path === "" ? detail : `${path}: ${detail}`);
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

/**
 * A percentage, 0..100, or null.
 *
 * Nothing is clamped. A document asserting 140% is describing something that did
 * not happen on the node that served it, and saying so is more useful than
 * rendering it. NaN is rejected explicitly because it is a number by `typeof`
 * and would otherwise pass every comparison below.
 */
function percentOrNull(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    fail(path, "expected a number in 0..100 or null");
  }
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
  "model",
  "effort",
  "context_pct",
  "context_tokens",
  "context_window",
  "provider",
  "provider_effort",
  "usage",
  "claimed_at",
  "updated_at",
] as const;
const ATTENTION_KEYS = ["kind", "message", "source", "requested_at"] as const;
const USAGE_KEYS = [
  "input",
  "output",
  "cache_read",
  "cache_write",
  "total_tokens",
  "cache_write_1h",
  "reasoning",
  "cost_input",
  "cost_output",
  "cost_cache_read",
  "cost_cache_write",
  "cost_total",
] as const;

/**
 * A token count or a cost: finite, non-negative, and not necessarily an integer.
 *
 * Costs are fractional dollars, so `timestamp`'s integer rule does not apply --
 * but the rest of it does. Nothing is clamped or coerced: a negative cost is a
 * node describing something that did not happen.
 */
function quantity(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(path, "expected a non-negative finite number");
  }
  return value;
}

function quantityOrNull(value: unknown, path: string): number | null {
  return value === null ? null : quantity(value, path);
}

/**
 * Tokens and money, or null when no turn has completed.
 *
 * Validated as strictly as the rest of the document despite being optional
 * baggage nothing renders yet: the point of collecting these early is that a
 * later display can trust them, and a lenient parse here would mean the first
 * surface to read them is the one that discovers they are garbage.
 */
export function parseUsage(value: unknown, path = "usage"): AgentUsage | null {
  if (value === null) return null;
  const row = object(value, path, USAGE_KEYS);
  return {
    input: quantity(row.input, `${path}.input`),
    output: quantity(row.output, `${path}.output`),
    cache_read: quantity(row.cache_read, `${path}.cache_read`),
    cache_write: quantity(row.cache_write, `${path}.cache_write`),
    total_tokens: quantity(row.total_tokens, `${path}.total_tokens`),
    // Null rather than absent: only some providers report these, and "the
    // provider said nothing" is not the same claim as zero.
    cache_write_1h: quantityOrNull(row.cache_write_1h, `${path}.cache_write_1h`),
    reasoning: quantityOrNull(row.reasoning, `${path}.reasoning`),
    cost_input: quantity(row.cost_input, `${path}.cost_input`),
    cost_output: quantity(row.cost_output, `${path}.cost_output`),
    cost_cache_read: quantity(row.cost_cache_read, `${path}.cost_cache_read`),
    cost_cache_write: quantity(row.cost_cache_write, `${path}.cost_cache_write`),
    cost_total: quantity(row.cost_total, `${path}.cost_total`),
  };
}

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
    model: textOrNull(row.model, `${path}.model`),
    // Null-tolerant `member`: the set is closed, but not reporting is always
    // allowed. A harness with no notion of effort says null, not "off" -- those
    // are different claims, and "off" is one pi can actually make.
    effort: row.effort === null ? null : member(row.effort, `${path}.effort`, EFFORTS),
    context_pct: percentOrNull(row.context_pct, `${path}.context_pct`),
    context_tokens: quantityOrNull(row.context_tokens, `${path}.context_tokens`),
    context_window: quantityOrNull(row.context_window, `${path}.context_window`),
    provider: textOrNull(row.provider, `${path}.provider`),
    provider_effort: textOrNull(row.provider_effort, `${path}.provider_effort`),
    usage: parseUsage(row.usage, `${path}.usage`),
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
 * `murmur_snapshot` must be exactly 2. A higher value is rejected, and so is a
 * LOWER one: compatibility is offered in neither direction, because a reader
 * that accepted an older document would be guessing at the fields that version
 * added -- which is precisely the state a human is acting on. A version mismatch
 * is an operator-visible pairing problem, and saying so is the honest report.
 */
export function parseSnapshot(input: string): Snapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    fail("", `not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const top = object(parsed, "", TOP_KEYS);
  if (top.murmur_snapshot !== SNAPSHOT_VERSION) {
    fail(
      "murmur_snapshot",
      `expected ${SNAPSHOT_VERSION}, got ${JSON.stringify(top.murmur_snapshot)}`,
    );
  }
  if (!Array.isArray(top.panes)) fail("panes", "expected an array");

  const panes = top.panes.map((entry, index) => parsePane(entry, `panes[${index}]`));
  const seen = new Set<string>();
  const owners = new Set<string>();
  for (const pane of panes) {
    if (seen.has(pane.pane)) fail("panes", `duplicate pane ${pane.pane}`);
    seen.add(pane.pane);

    // An agent_id is minted per PROCESS INSTANCE when it claims a pane, so the
    // same id in two panes says one process owns two addresses -- a state the
    // local store cannot produce, since `pane` is UNIQUE in `agents` and a
    // claim writes exactly one row. A document asserting it is describing
    // something that did not happen on the node that served it.
    //
    // Checked for the same reason duplicate panes are: the reader trusts this
    // document to be a coherent picture of one node, and a late or replayed
    // write is exactly how an incoherent one would arrive.
    const owner = pane.agent?.agent_id;
    if (owner !== undefined && owner !== null) {
      if (owners.has(owner)) fail("panes", `duplicate agent_id ${owner}`);
      owners.add(owner);
    }
  }

  return {
    murmur_snapshot: SNAPSHOT_VERSION,
    host_id: text(top.host_id, "host_id"),
    display_name: text(top.display_name, "display_name"),
    murmur_version: text(top.murmur_version, "murmur_version"),
    generated_at: timestamp(top.generated_at, "generated_at"),
    panes,
  };
}
