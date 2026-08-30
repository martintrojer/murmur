import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import type { Channel } from "../src/channel.js";
import { versionCell } from "../src/cli/peer.js";
import { collect } from "../src/collector.js";
import { exportJsonl, SCHEMA_VERSION } from "../src/export.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { VERSION } from "../src/index.js";
import { openStore } from "../src/store.js";
import type { Peer } from "../src/types.js";
import { runBuiltCli } from "./helpers/built.js";

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-peerver-"));
});

const OURS = 2;

function cell(over: Partial<Pick<Peer, "murmur_version" | "schema_version">>) {
  return versionCell({ murmur_version: null, schema_version: null, ...over }, OURS);
}

/** An envelope-plus-events string, as a peer's `murmur export` would print it. */
function wire(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: SCHEMA_VERSION,
    host_id: "REMOTE",
    display_name: "bubba",
    exported_at: 1,
    epoch: "e1",
    murmur_version: "0.1.4",
    ...over,
  });
}

test("the envelope carries this node's murmur version, additively", () => {
  // Additive means no SCHEMA_VERSION bump, and that is not a style preference
  // here: resetIfStale deletes every local events.db on a STORE_VERSION change,
  // and the two constants are one careless edit apart. Same tripwire the epoch
  // work left, extended to cover this field.
  const store = openStore();
  store.append({
    agent_id: "a",
    session: asSessionId("$0"),
    window: asWindowId("@1"),
    pane: asPaneId("%1"),
    workstream: null,
    role: null,
    cli: "pi",
    driver: "human",
    kind: "state",
    state: "done",
    message: "",
    pid: null,
    synthetic: false,
    reason: "",
    extra: {},
  });
  const envelope = JSON.parse(
    exportJsonl(store, 0, () => true)
      .trim()
      .split("\n")[0] ?? "{}",
  ) as Record<string, unknown>;
  store.close();

  // A real semver, and the SAME one the SDK advertises. Two readers of
  // package.json (index.ts for the SDK, export.ts for the wire) must not be
  // able to disagree about what this node is.
  expect(envelope.murmur_version).toMatch(/^\d+\.\d+\.\d+/);
  expect(envelope.murmur_version).toBe(VERSION);
  // Literals, not the constants. Comparing the wire against the constant passes
  // whatever the constant is, so it cannot notice a bump at all.
  expect(envelope.schema_version).toBe(2);
  expect(SCHEMA_VERSION).toBe(2);
});

test("a collect records what the peer is running", async () => {
  const store = openStore();
  store.upsertPeer({ name: "bubba", target: "bubba" });
  const channel: Channel = { exec: async () => wire() };

  await collect(store, channel, 5_000);

  const peer = store.peers()[0];
  expect(peer?.murmur_version).toBe("0.1.4");
  expect(peer?.schema_version).toBe(SCHEMA_VERSION);
  store.close();
});

test("a peer REFUSED for a newer schema still records who it is and what it runs", async () => {
  // The case the whole feature exists for, and it was the one case that
  // recorded nothing. `parseJsonl` threw before `upsertPeer` ran, so the row
  // kept host_id, display_name and version all null — verified against a real
  // store before this was changed. `peer list` could show a version column for
  // every peer EXCEPT the incompatible one.
  const store = openStore();
  store.upsertPeer({ name: "newer", target: "newer" });
  const channel: Channel = {
    exec: async () => wire({ schema_version: SCHEMA_VERSION + 7, murmur_version: "9.9.9" }),
  };

  const results = await collect(store, channel, 5_000);

  expect(results[0]).toMatchObject({ ok: false, error: expect.stringContaining("unsupported") });
  const peer = store.peers()[0];
  expect(peer?.murmur_version).toBe("9.9.9");
  expect(peer?.schema_version).toBe(SCHEMA_VERSION + 7);
  expect(peer?.host_id).toBe("REMOTE");
  // But it did NOT get credit for a successful sync: fetched_at stays null, so
  // it renders "never" rather than freshly collected. An existing collector test
  // pins the same property for a peer that already had a fetched_at.
  expect(peer?.fetched_at).toBeNull();
  store.close();
});

test("an older peer that sends no version reads as unreported, not as a value", async () => {
  // Rollout direction. A peer running a murmur from before this field exists
  // sends no `murmur_version`; it must not be rendered as anything that looks
  // like a version, and it must not be called incompatible — it interoperates
  // fine, which is the entire point of an additive field.
  const store = openStore();
  store.upsertPeer({ name: "old", target: "old" });
  const { murmur_version: _dropped, ...withoutVersion } = JSON.parse(wire()) as Record<
    string,
    unknown
  >;
  await collect(store, { exec: async () => JSON.stringify(withoutVersion) }, 5_000);

  const peer = store.peers()[0];
  expect(peer?.murmur_version).toBeNull();
  expect(peer?.schema_version).toBe(SCHEMA_VERSION);
  // Answered, but cannot say what it is. Distinct from never having answered.
  expect(versionCell(peer as Peer)).toEqual({ text: "unreported", incompatible: false });
  store.close();
});

test("a never-collected peer is unknown and is NOT a mismatch", () => {
  // The constraint the task names: a down or asleep peer is the common case, not
  // an exception. Absence of information is not evidence of incompatibility, and
  // flagging it would make the mark meaningless on a normal fleet.
  expect(cell({})).toEqual({ text: "unknown", incompatible: false });
});

test("only a schema mismatch is flagged; a murmur version difference is shown plainly", () => {
  // The decision the task asked to be made with evidence, and the evidence is
  // what the code enforces. `parseJsonl` refuses a peer whose schema is higher
  // than ours, so events genuinely do not flow — that is a behavioural fact and
  // is the only thing marked.
  //
  // A differing murmur version is not. Two nodes on schema 2 running 0.1.3 and
  // 0.1.4 interoperate, so marking it would fire on every patch release and
  // train the operator to ignore the column.
  expect(cell({ murmur_version: "0.1.3", schema_version: OURS })).toEqual({
    text: "0.1.3",
    incompatible: false,
  });
  expect(cell({ murmur_version: "0.9.0", schema_version: OURS })).toEqual({
    text: "0.9.0",
    incompatible: false,
  });

  // Schema differs: flagged, and the cell explains itself rather than just
  // carrying a colour.
  const newer = cell({ murmur_version: "9.9.9", schema_version: 9 });
  expect(newer.incompatible).toBe(true);
  expect(newer.text).toContain("9.9.9");
  expect(newer.text).toContain("schema 9");
  expect(newer.text).toContain(String(OURS));

  // Lower schema too. The collector tolerates parsing it, but the operator still
  // wants to know the pairing is not like-for-like — and the old code flagged
  // this direction nowhere at all.
  expect(cell({ murmur_version: "0.0.9", schema_version: 1 }).incompatible).toBe(true);

  // The schema number appears ONLY when it is the problem, or every row would
  // read "0.1.4 (schema 2)" and the signal would be lost in the noise.
  expect(cell({ murmur_version: "0.1.4", schema_version: OURS }).text).not.toContain("schema");
});

/**
 * Run the real CLI against a scratch state dir, so the table is the shipped one.
 *
 * `runBuiltCli` rather than a bare execFileSync: this test executes dist/, so a
 * stale build silently tests the PREVIOUS version of the table. That is exactly
 * how this test passed in one checkout and failed in another on identical
 * source, reporting "expected NAME TARGET HOSTNAME... to contain VERSION" --
 * which reads as a formatting bug and says nothing about the build.
 */
function cli(stateDir: string, ...args: string[]): string {
  return runBuiltCli(args, { ...process.env, MURMUR_STATE_DIR: stateDir });
}

test("peer list stays exactly as narrow as today when nothing has been collected", () => {
  // The constraint the task names first: `peer list` must stay useful with ZERO
  // successful collects, because a down or asleep peer is the common case in
  // this tool rather than an exception.
  //
  // So the VERSION column follows the same rule the PEER column already uses --
  // it appears only when some row can answer it. A column every row answers
  // "unknown" to is width spent on nothing.
  const dir = process.env.MURMUR_STATE_DIR as string;
  const store = openStore();
  store.upsertPeer({ name: "asleep", target: "asleep" });
  store.close();

  const out = cli(dir, "peer", "list");
  expect(out).toContain("asleep");
  expect(out).toContain("never");
  expect(out).not.toContain("VERSION");
  // And no scary language on a peer that is merely quiet.
  expect(out).not.toContain("incompatible");
});

test("peer list shows a VERSION column once a peer has reported, and names a real mismatch", () => {
  const dir = process.env.MURMUR_STATE_DIR as string;
  const store = openStore();
  store.upsertPeer({
    name: "matched",
    target: "matched",
    display_name: "macmini",
    murmur_version: "0.1.4",
    schema_version: SCHEMA_VERSION,
    fetched_at: Date.now(),
  });
  store.upsertPeer({
    name: "toonew",
    target: "toonew",
    display_name: "bubba",
    murmur_version: "9.9.9",
    schema_version: SCHEMA_VERSION + 7,
  });
  store.close();

  const out = cli(dir, "peer", "list");

  expect(out).toContain("VERSION");
  expect(out).toContain("0.1.4");
  // The mismatch explains itself in the row, and is named underneath with what
  // it means, rather than being a mark the reader has to decode.
  expect(out).toContain(`schema ${SCHEMA_VERSION + 7}`);
  expect(out).toMatch(/1 peer on an incompatible wire schema/);
  expect(out).toContain("toonew");
  // The compatible peer is not implicated.
  expect(out.split("\n").find((line) => line.includes("matched"))).not.toContain("schema");
});
