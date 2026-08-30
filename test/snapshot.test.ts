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
 * and nothing partially valid can be read back out of one. That is what pays
 * for deleting the watermark, the epoch and the delta form -- a reader needs no
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

test("the document is complete: no seq, epoch, watermark or delta field anywhere", () => {
  // Stated as a shape assertion rather than as prose, because the deleted
  // concepts came back through fields before: `extra` round-tripping meant an
  // unknown key survived a hop, so a reader could act on something no writer
  // here had ever agreed to.
  const s = store();
  s.claimAgent({ location: location("%1"), owner_pid: process.pid, meta: META, now: 1 });

  const built = s.buildLocalSnapshot(IDENTITY, {
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
  const text = JSON.stringify(built);
  for (const gone of ["seq", "epoch", "watermark", "synthetic", "since", "schema_version"]) {
    expect(text).not.toContain(gone);
  }
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
  s.releaseAgent({ agent_id: agentId, owner_pid: process.pid });

  expect(s.localPanes().map((pane) => pane.pane)).toEqual(["%2"]);
  for (const pane of s.localPanes()) {
    expect(pane.agent !== null || pane.attention.length > 0).toBe(true);
  }
  const built = s.buildLocalSnapshot(IDENTITY, {
    panes: live("%1", "%2"),
    isAlive: alive([process.pid]),
    now: 3,
  });
  expect(built.panes.map((pane) => pane.pane)).toEqual(["%2"]);
  expect(parseSnapshot(JSON.stringify(built)).panes).toHaveLength(1);
});

test("a snapshot states its own version and speaks snapshot 1", () => {
  const built = store().buildLocalSnapshot(IDENTITY, { panes: live(), now: 1 });

  expect(built.murmur_snapshot).toBe(1);
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
    murmur_snapshot: 1,
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
    murmur_snapshot: 1,
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
  // Each entry is a document a node could plausibly serve, and each names the
  // way a lenient parser would have let it through: a coerced number, a
  // defaulted null, an unknown key kept "just in case".
  const rejected: [why: string, document: unknown][] = [
    ["a newer protocol", { ...base, murmur_snapshot: 2 }],
    ["a stringly-typed clock", { ...base, generated_at: "1" }],
    ["a fractional clock", { ...base, generated_at: 1.5 }],
    ["a negative clock", { ...base, generated_at: -1 }],
    ["an empty host_id", { ...base, host_id: "" }],
    [
      "a missing murmur_version",
      { murmur_snapshot: 1, host_id: "H", display_name: "d", generated_at: 1, panes: [] },
    ],
    ["an unknown top-level key", { ...base, epoch: 3 }],
    ["panes as an object", { ...base, panes: {} }],
    ["a pane missing window_name", { ...base, panes: [{ ...pane, window_name: undefined }] }],
    ["an unknown pane key", { ...base, panes: [{ ...pane, seq: 4 }] }],
    ["an empty pane id", { ...base, panes: [{ ...pane, pane: "" }] }],
    ["a duplicate pane", { ...base, panes: [pane, pane] }],
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
  // One line, one document. Not JSONL: a reader that split on newlines and
  // parsed each line is exactly the reader this rewrite deleted, and a second
  // line here would silently resurrect it.
  expect(stdout.trimEnd().split("\n")).toHaveLength(1);
  const parsed: Snapshot = parseSnapshot(stdout);
  expect(parsed).toMatchObject({ murmur_snapshot: 1, display_name: "exporter", panes: [] });
});

test("murmur export takes no options: --since is gone from the CLI, not just unused", () => {
  const dir = process.env.MURMUR_STATE_DIR as string;
  createIdentity("exporter");

  const rejected = (() => {
    try {
      execFileSync(process.execPath, [builtArtifact("cli.js"), "export", "--since", "0"], {
        env: { ...process.env, MURMUR_STATE_DIR: dir },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return false;
    } catch {
      return true;
    }
  })();

  // An accepted-and-ignored flag is the dangerous shape: an old peer asking for
  // a delta would be served a full document that it then treats as "everything
  // new since N", and every unchanged pane reads as gone.
  expect(rejected).toBe(true);
});

test("murmur export on an uninitialised node refuses instead of minting a node", () => {
  const dir = process.env.MURMUR_STATE_DIR as string;

  const { stdout, status } = runExport({ MURMUR_STATE_DIR: dir });

  expect(status).toBe(1);
  expect(stdout).toBe("");
});
