import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createIdentity } from "../src/identity.js";
import { asPaneId, asSessionId, asWindowId, type PaneId } from "../src/ids.js";
import { parseSnapshot, SnapshotInvalidError } from "../src/snapshot.js";
import { openStore, type Store } from "../src/store.js";
import type { AgentMeta, Location, Snapshot } from "../src/types.js";
import { builtArtifact } from "./helpers/built.js";

/**
 * The snapshot document, as the ONE thing a node publishes.
 *
 * The claims here are about the document rather than about the tables:
 * everything murmur knows about a node is in it, absence from it is absence,
 * and nothing partially valid can be read back out of one. A reader needs no
 * state of its own to interpret a snapshot, so there is no state for it to hold
 * wrongly.
 *
 * `store.test.ts` owns the store's write semantics; this file owns the round
 * trip: build -> serialise -> validate, plus the shipped `murmur export` that
 * performs it.
 */

const stores: Store[] = [];

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-snapshot-"));
});

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
  }
});

function store(): Store {
  const opened = openStore();
  stores.push(opened);
  return opened;
}

function location(pane: string, window = "@1"): Location {
  return {
    server: { kind: "default" },
    session: asSessionId("$0"),
    window: asWindowId(window),
    pane: asPaneId(pane),
    session_name: "work",
    window_name: "worker-1",
  };
}

const META: AgentMeta = {
  agent_name: "worker-1",
  pi_session: "01JQ",
  workstream: "murmur",
  role: "implementer",
  cli: "pi",
  driver: "orchestrated",
};

const alive =
  (pids: number[]) =>
  (pid: number): boolean =>
    pids.includes(pid);

const IDENTITY = { host_id: "H", display_name: "here" };

function live(...panes: string[]): Set<PaneId> {
  return new Set(panes.map(asPaneId));
}

// --- the document round trip ---------------------------------------------

test("a built snapshot validates as one, and survives serialisation unchanged", () => {
  // The property that makes the two-node case work at all: what this node
  // publishes is exactly what a peer's validator accepts. A build path and a
  // validate path that disagreed would be undetectable locally and would show
  // up as "that host is broken" on every OTHER machine.
  const s = store();
  s.claimAgent({ location: location("%1"), owner_pid: process.pid, meta: META, now: 5 });
  s.setActivity({
    agent_id: s.localPanes()[0]?.agent?.agent_id as string,
    owner_pid: process.pid,
    activity: "running",
    location: location("%1"),
    now: 6,
  });
  s.requestAttention({
    kind: "blocked",
    location: location("%2", "@2"),
    message: "needs input",
    source: "codex",
    now: 7,
  });

  const built = s.buildLocalSnapshot(IDENTITY, {
    server: { kind: "default" },
    panes: live("%1", "%2"),
    isAlive: alive([process.pid]),
    now: 42,
  });
  const parsed = parseSnapshot(JSON.stringify(built));

  expect(parsed).toEqual(built);
  expect(parsed.panes.map((pane) => pane.pane)).toEqual(["%1", "%2"]);
  // An attention-only pane is a first-class row: no agent, still addressed,
  // still carrying its own location so a reader can jump to it.
  expect(parsed.panes[1]).toMatchObject({
    agent: null,
    session: "$0",
    window: "@2",
    attention: [{ kind: "blocked", message: "needs input", source: "codex", requested_at: 7 }],
  });
});

test("the document carries exactly the keys it declares, and no others", () => {
  // A closed key set, asserted as a shape rather than as prose: an unknown key
  // that survived a hop would let a reader act on something no writer here ever
  // agreed to.
  const s = store();
  s.claimAgent({ location: location("%1"), owner_pid: process.pid, meta: META, now: 1 });

  const built = s.buildLocalSnapshot(IDENTITY, {
    server: { kind: "default" },
    panes: live("%1"),
    isAlive: alive([process.pid]),
    now: 2,
  });

  expect(Object.keys(built).sort()).toEqual([
    "display_name",
    "generated_at",
    "host_id",
    "murmur_snapshot",
    "murmur_version",
    "panes",
  ]);
  expect(Object.keys(built.panes[0] ?? {}).sort()).toEqual([
    "agent",
    "attention",
    "pane",
    "session",
    "session_name",
    "window",
    "window_name",
  ]);
});

test("panes are emitted sorted by pane id, and order carries no meaning", () => {
  // Sorted for DIFFABLE output only. The contract says order is presentation,
  // so the assertion is that the reader gets the same set whatever order it
  // arrives in -- a reader that depended on order would be reading a fact the
  // writer never promised.
  const s = store();
  for (const pane of ["%30", "%4", "%100"]) {
    s.requestAttention({ kind: "done", location: location(pane), message: "", source: "pi" });
  }

  const built = s.buildLocalSnapshot(IDENTITY, {
    server: { kind: "default" },
    panes: live("%30", "%4", "%100"),
    isAlive: alive([]),
    now: 1,
  });

  expect(built.panes.map((pane) => pane.pane)).toEqual(["%100", "%30", "%4"]);
  const shuffled = { ...built, panes: [...built.panes].reverse() };
  expect(new Set(parseSnapshot(JSON.stringify(shuffled)).panes.map((p) => p.pane))).toEqual(
    new Set(["%100", "%30", "%4"]),
  );
});

test("absence from a snapshot is absence: a build reconciles before it publishes", () => {
  // The whole reason `buildLocalSnapshot` reconciles rather than trusting the
  // caller to: a document built from unreconciled rows publishes agents whose
  // panes are gone, and a reader that treats absence as absence has no way to
  // tell it was lied to.
  const s = store();
  s.claimAgent({ location: location("%live"), owner_pid: process.pid, meta: META, now: 1 });
  s.claimAgent({ location: location("%gone"), owner_pid: 424_242, meta: META, now: 1 });
  s.requestAttention({
    kind: "blocked",
    location: location("%gone"),
    message: "stale",
    source: "codex",
  });

  const built = s.buildLocalSnapshot(IDENTITY, {
    server: { kind: "default" },
    panes: live("%live"),
    isAlive: alive([process.pid]),
    now: 9,
  });

  expect(built.panes.map((pane) => pane.pane)).toEqual(["%live"]);
  // And the local tables agree, so a second reader of the same node sees the
  // same thing the document said.
  expect(s.localPanes().map((pane) => pane.pane)).toEqual(["%live"]);
});

test("a snapshot never carries owner_pid, so remote liveness is unrepresentable", () => {
  // Structural, over the whole object graph: reading the TYPE proves nothing
  // about what JSON.stringify put on the wire, and it is the wire a peer reads.
  const s = store();
  s.claimAgent({ location: location("%1"), owner_pid: process.pid, meta: META, now: 1 });

  const text = JSON.stringify(
    s.buildLocalSnapshot(IDENTITY, {
      server: { kind: "default" },
      panes: live("%1"),
      isAlive: alive([process.pid]),
      now: 2,
    }),
  );

  expect(text).not.toContain("owner_pid");
  expect(text).not.toContain(String(process.pid));
});

test("a pane with nothing to say is a pane nobody mentions, locally or on the wire", () => {
  // Rule 3 -- "a pane with no agent and no attention must not be emitted" -- is
  // upheld by CONSTRUCTION, not by a filter that could be forgotten: every pane
  // entry exists because a row exists, so there is no way to build an empty
  // one. Asserted at both layers, because the validator rejects such an entry
  // (see the rejection table above) and a node that could build one would
  // therefore be reported as broken by every peer it has.
  const s = store();
  s.claimAgent({ location: location("%1"), owner_pid: process.pid, meta: META, now: 1 });
  const agentId = s.localPanes()[0]?.agent?.agent_id as string;
  s.requestAttention({ kind: "done", location: location("%2"), message: "", source: "pi" });

  // %1 loses its agent and never had attention; %2 keeps a `done` its agent
  // never owned. Releasing deliberately does not clear attention, so this is
  // the state a settled-then-exited agent actually leaves behind.
  s.releaseAgent({ agent_id: agentId, owner_pid: process.pid, location: location("%1") });

  expect(s.localPanes().map((pane) => pane.pane)).toEqual(["%2"]);
  for (const pane of s.localPanes()) {
    expect(pane.agent !== null || pane.attention.length > 0).toBe(true);
  }
  const built = s.buildLocalSnapshot(IDENTITY, {
    server: { kind: "default" },
    panes: live("%1", "%2"),
    isAlive: alive([process.pid]),
    now: 3,
  });
  expect(built.panes.map((pane) => pane.pane)).toEqual(["%2"]);
  expect(parseSnapshot(JSON.stringify(built)).panes).toHaveLength(1);
});

test("a snapshot states its own version and speaks snapshot 2", () => {
  const built = store().buildLocalSnapshot(IDENTITY, {
    server: { kind: "default" },
    panes: live(),
    now: 1,
  });

  expect(built.murmur_snapshot).toBe(2);
  expect(built.murmur_version).toMatch(/^\d+\.\d+\.\d+/);
  // An empty node is a valid, complete document: it says "nothing here", which
  // is a fact, not an absence of one.
  expect(parseSnapshot(JSON.stringify(built)).panes).toEqual([]);
});

// --- validation ----------------------------------------------------------

test("parseSnapshot names the first failing path so an operator can act", () => {
  // The message is the whole diagnostic a remote operator gets: `peer list`
  // shows `last_error` and nothing else. "invalid snapshot" would send them to
  // read code on another machine.
  const bad = JSON.stringify({
    murmur_snapshot: 2,
    host_id: "H",
    display_name: "d",
    murmur_version: "0.1.0",
    generated_at: 1,
    panes: [
      {
        pane: "%1",
        session: "$0",
        window: "@1",
        session_name: null,
        window_name: null,
        agent: null,
        attention: [{ kind: "working", message: "", source: "x", requested_at: 1 }],
      },
    ],
  });

  expect(() => parseSnapshot(bad)).toThrow(SnapshotInvalidError);
  expect(() => parseSnapshot(bad)).toThrow("panes[0].attention[0].kind");
});

test("nothing is coerced, defaulted or carried through", () => {
  const base = {
    murmur_snapshot: 2,
    host_id: "H",
    display_name: "d",
    murmur_version: "0.1.0",
    generated_at: 1,
    panes: [] as unknown[],
  };
  const pane = {
    pane: "%1",
    session: "$0",
    window: "@1",
    session_name: null,
    window_name: null,
    agent: null,
    attention: [{ kind: "done", message: "", source: "pi", requested_at: 1 }],
  };
  // One process instance, as two panes would report it if a document claimed it.
  const owner = {
    agent_id: "one-process",
    activity: "running",
    agent_name: null,
    pi_session: null,
    workstream: null,
    role: null,
    cli: "pi",
    driver: "human",
    model: null,
    provider: null,
    context_tokens: null,
    context_window: null,
    provider_effort: null,
    usage: null,
    effort: null,
    context_pct: null,
    claimed_at: 1,
    updated_at: 1,
  };
  // Each entry is a document a node could plausibly serve, and each names the
  // way a lenient parser would have let it through: a coerced number, a
  // defaulted null, an unknown key kept "just in case".
  const rejected: [why: string, document: unknown][] = [
    // Both directions, because compatibility is offered in neither: a reader
    // that accepted the older document would be guessing at the fields that
    // version added, which are exactly the state a human acts on.
    ["a newer protocol", { ...base, murmur_snapshot: 3 }],
    ["an older protocol", { ...base, murmur_snapshot: 1 }],
    ["a stringly-typed clock", { ...base, generated_at: "1" }],
    ["a fractional clock", { ...base, generated_at: 1.5 }],
    ["a negative clock", { ...base, generated_at: -1 }],
    ["an empty host_id", { ...base, host_id: "" }],
    [
      "a missing murmur_version",
      { murmur_snapshot: 2, host_id: "H", display_name: "d", generated_at: 1, panes: [] },
    ],
    ["an unknown top-level key", { ...base, extra: 3 }],
    ["panes as an object", { ...base, panes: {} }],
    ["a pane missing window_name", { ...base, panes: [{ ...pane, window_name: undefined }] }],
    ["an unknown pane key", { ...base, panes: [{ ...pane, rank: 4 }] }],
    ["an empty pane id", { ...base, panes: [{ ...pane, pane: "" }] }],
    // Every nullable string, each wrong in the same way. `textOrNull` guards six
    // fields and NONE was covered: a sweep made it return `value as string |
    // null` -- accepting a number for all six -- and the suite stayed green.
    ["a numeric session_name", { ...base, panes: [{ ...pane, session_name: 7 }] }],
    ["a numeric window_name", { ...base, panes: [{ ...pane, window_name: 7 }] }],
    ["a numeric agent_name", { ...base, panes: [{ ...pane, agent: { ...owner, agent_name: 7 } }] }],
    ["a numeric pi_session", { ...base, panes: [{ ...pane, agent: { ...owner, pi_session: 7 } }] }],
    ["a numeric workstream", { ...base, panes: [{ ...pane, agent: { ...owner, workstream: 7 } }] }],
    ["a numeric role", { ...base, panes: [{ ...pane, agent: { ...owner, role: 7 } }] }],
    ["a duplicate pane", { ...base, panes: [pane, pane] }],
    [
      // An agent_id is minted per process instance, so the same id in two panes
      // claims one process owns two addresses -- which the local store cannot
      // produce, since `pane` is UNIQUE in `agents`.
      "the same agent_id in two panes",
      {
        ...base,
        panes: [
          { ...pane, agent: owner },
          { ...pane, pane: "%2", agent: owner },
        ],
      },
    ],
    [
      "a duplicate kind in one pane",
      { ...base, panes: [{ ...pane, attention: [...pane.attention, ...pane.attention] }] },
    ],
    ["a pane with nothing to say", { ...base, panes: [{ ...pane, attention: [] }] }],
    [
      "an agent missing driver",
      {
        ...base,
        panes: [
          {
            ...pane,
            agent: {
              agent_id: "a",
              activity: "running",
              agent_name: null,
              pi_session: null,
              workstream: null,
              role: null,
              cli: "pi",
              claimed_at: 1,
              updated_at: 1,
            },
          },
        ],
      },
    ],
  ];

  for (const [why, document] of rejected) {
    expect(() => parseSnapshot(JSON.stringify(document)), why).toThrow(SnapshotInvalidError);
  }
});

test("a document that is not JSON is a snapshot error, not a crash", () => {
  // What an unconfigured host actually answers with: ssh succeeds, the command
  // does not exist, and the "document" is a shell error on stdout.
  expect(() => parseSnapshot("murmur: command not found")).toThrow(SnapshotInvalidError);
  expect(() => parseSnapshot("")).toThrow(SnapshotInvalidError);
  expect(() => parseSnapshot("[]")).toThrow(SnapshotInvalidError);
  expect(() => parseSnapshot("null")).toThrow(SnapshotInvalidError);
});

// --- the shipped command -------------------------------------------------

/** `murmur export` as a peer's ssh would run it: the built CLI, a scratch node. */
function runExport(env: NodeJS.ProcessEnv = {}): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [builtArtifact("cli.js"), "export"], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; status?: number };
    return { stdout: failure.stdout ?? "", status: failure.status ?? 1 };
  }
}

test("murmur export prints exactly one snapshot document and nothing else", () => {
  const dir = process.env.MURMUR_STATE_DIR as string;
  createIdentity("exporter");

  const { stdout, status } = runExport({ MURMUR_STATE_DIR: dir });

  expect(status).toBe(0);
  // One line, one document. A second line would let a reader split on newlines
  // and parse each piece, which is a reader that can act on half a document.
  expect(stdout.trimEnd().split("\n")).toHaveLength(1);
  const parsed: Snapshot = parseSnapshot(stdout);
  expect(parsed).toMatchObject({ murmur_snapshot: 2, display_name: "exporter", panes: [] });
});

test("murmur export takes no options: an unknown flag is rejected, not ignored", () => {
  const dir = process.env.MURMUR_STATE_DIR as string;
  createIdentity("exporter");

  const rejected = (() => {
    try {
      execFileSync(process.execPath, [builtArtifact("cli.js"), "export", "--verbose"], {
        env: { ...process.env, MURMUR_STATE_DIR: dir },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return false;
    } catch {
      return true;
    }
  })();

  // An accepted-and-ignored flag is the dangerous shape: a caller that believes
  // it asked for something narrower would read a full document as though it were
  // the answer to its own question.
  expect(rejected).toBe(true);
});

test("murmur export on an uninitialised node refuses instead of minting a node", () => {
  const dir = process.env.MURMUR_STATE_DIR as string;

  const { stdout, status } = runExport({ MURMUR_STATE_DIR: dir });

  expect(status).toBe(1);
  expect(stdout).toBe("");
});

// --- runtime fields (snapshot v2) ----------------------------------------

/**
 * A valid v2 document with one agent pane, for the runtime-field tests.
 *
 * Local to this section rather than shared with the tests above: those build
 * their documents inline to make each rejection readable beside its reason, and
 * a shared builder would hide which field the case is actually about.
 */
/** A valid usage bundle, for tests that vary one field of it. */
const VALID_USAGE = {
  input: 213_000,
  output: 55_000,
  cache_read: 4_100_000,
  cache_write: 12_000,
  total_tokens: 4_380_000,
  cache_write_1h: 500,
  reasoning: 9_000,
  cost_input: 1.2,
  cost_output: 2.4,
  cost_cache_read: 0.41,
  cost_cache_write: 0.6,
  cost_total: 4.61,
};

function agentDocument(runtime: Record<string, unknown>): string {
  return JSON.stringify({
    murmur_snapshot: 2,
    host_id: "H",
    display_name: "d",
    murmur_version: "0.4.0",
    generated_at: 1,
    panes: [
      {
        pane: "%1",
        session: "$0",
        window: "@1",
        session_name: null,
        window_name: null,
        agent: {
          agent_id: "a-1",
          activity: "running",
          agent_name: null,
          pi_session: null,
          workstream: null,
          role: null,
          cli: "pi",
          driver: "human",
          provider: null,
          context_tokens: null,
          context_window: null,
          provider_effort: null,
          usage: null,
          claimed_at: 1,
          updated_at: 1,
          // Spread LAST, and `model`, `effort` and `context_pct` are
          // deliberately NOT defaulted above, so a caller can omit one to check
          // that absent is rejected rather than quietly defaulted. The other
          // runtime fields are defaulted here because no test varies them.
          ...runtime,
        },
        attention: [],
      },
    ],
  });
}

test("a version 1 document is rejected as firmly as a newer one", () => {
  // Forward compatibility is not offered in EITHER direction. A reader that
  // accepted the older document would be guessing which fields a human is
  // looking at -- and the fields it would be guessing about are the ones this
  // version added, so the guess is exactly wrong.
  const older = agentDocument({ model: null, effort: null, context_pct: null }).replace(
    '"murmur_snapshot":2',
    '"murmur_snapshot":1',
  );
  expect(() => parseSnapshot(older)).toThrow(SnapshotInvalidError);
  expect(() => parseSnapshot(older)).toThrow("murmur_snapshot");
});

test("the runtime fields round-trip", () => {
  const parsed = parseSnapshot(
    agentDocument({ model: "claude-opus-5", effort: "medium", context_pct: 11.7 }),
  );
  expect(parsed.panes[0]?.agent).toMatchObject({
    model: "claude-opus-5",
    effort: "medium",
    context_pct: 11.7,
  });
});

test("every runtime field is nullable", () => {
  // A bare shell, codex, or a notify-only harness reports none of them, and an
  // agent that cannot report one must not be forced to invent it. `context_pct`
  // is null in one more case: pi returns a null percent right after compaction,
  // before the next response.
  const parsed = parseSnapshot(agentDocument({ model: null, effort: null, context_pct: null }));
  expect(parsed.panes[0]?.agent).toMatchObject({
    model: null,
    provider: null,
    context_tokens: null,
    context_window: null,
    provider_effort: null,
    usage: null,
    effort: null,
    context_pct: null,
  });
});

test("an unknown effort fails the whole document", () => {
  // `effort` is a closed set, so a display variant is a broken peer rather than
  // a value to coerce. Strict validation working as designed: the alternative is
  // a sort or a render path receiving a word nothing in murmur defines.
  const bad = agentDocument({ model: "m", effort: "Medium", context_pct: 1 });
  expect(() => parseSnapshot(bad)).toThrow(SnapshotInvalidError);
  expect(() => parseSnapshot(bad)).toThrow("effort");
});

test("a context percentage outside 0..100 is rejected", () => {
  // It is a percentage of a context window, so the range is the whole domain.
  // Nothing is clamped: a document asserting 140% is describing something that
  // did not happen, and saying so is more useful than rendering it.
  for (const percent of [-1, 101, -0.5, 100.5]) {
    expect(() =>
      parseSnapshot(agentDocument({ model: "m", effort: "low", context_pct: percent })),
    ).toThrow(SnapshotInvalidError);
  }
  // The boundaries themselves are valid: a fresh context is 0 and a full one is
  // 100, and both are states an agent is legitimately in.
  for (const percent of [0, 100]) {
    expect(
      parseSnapshot(agentDocument({ model: "m", effort: "low", context_pct: percent })).panes[0]
        ?.agent?.context_pct,
    ).toBe(percent);
  }
});

test("a non-finite context percentage cannot survive the wire", () => {
  // NaN and Infinity are not expressible in JSON -- `JSON.stringify` emits
  // `null` for both -- so a document cannot carry one, and the null it becomes
  // is a legitimate value. `percentOrNull` still rejects them, because it also
  // guards the in-process path where a builder could hand one over directly.
  expect(
    JSON.parse(agentDocument({ model: "m", effort: "low", context_pct: Number.NaN })).panes[0].agent
      .context_pct,
  ).toBeNull();
});

test("a stringly-typed context percentage is rejected", () => {
  expect(() =>
    parseSnapshot(agentDocument({ model: "m", effort: "low", context_pct: "11.7" })),
  ).toThrow("context_pct");
});

test("an agent missing a runtime field is rejected, not defaulted", () => {
  // Same rule every other field follows: absent is not null. A node that means
  // "no model" says so with an explicit null, and one that omits the key is a
  // node speaking a different document than it claims to.
  expect(() => parseSnapshot(agentDocument({ effort: null, context_pct: null }))).toThrow(
    "missing key model",
  );
  expect(() => parseSnapshot(agentDocument({ model: null, context_pct: null }))).toThrow(
    "missing key effort",
  );
  expect(() => parseSnapshot(agentDocument({ model: null, effort: null }))).toThrow(
    "missing key context_pct",
  );
});

test("a negative token count or cost is rejected, per field", () => {
  // Found by mutation: widening `quantity`'s lower bound from 0 to -1 left the
  // whole suite green, because the usage tests only ever round-tripped VALID
  // bundles. A peer could publish impossible negative tokens or dollars and
  // murmur would accept, store and re-serve them as trusted state.
  //
  // Table-driven over every numeric field, because the guard is applied
  // per-field and a single spot-check would not notice one of the twelve using
  // the wrong helper.
  const numeric = [
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

  for (const field of numeric) {
    const document = agentDocument({
      model: "m",
      effort: "low",
      context_pct: 1,
      usage: { ...VALID_USAGE, [field]: -1 },
    });
    expect(() => parseSnapshot(document), field).toThrow(SnapshotInvalidError);
    // Named by path, so an operator reading `peer list` learns which field the
    // other node got wrong rather than "invalid snapshot".
    expect(() => parseSnapshot(document), field).toThrow(`usage.${field}`);
  }

  // Zero stays valid everywhere: a turn that read no cache and cost nothing
  // measurable is an ordinary turn, not a broken report.
  const zeroed = Object.fromEntries(numeric.map((field) => [field, 0]));
  expect(
    parseSnapshot(agentDocument({ model: "m", effort: "low", context_pct: 1, usage: zeroed }))
      .panes[0]?.agent?.usage,
  ).toMatchObject({ input: 0, cost_total: 0 });
});
