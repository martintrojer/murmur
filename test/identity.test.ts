import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { createIdentity, loadIdentity, setDisplayName } from "../src/identity.js";
import { parseSnapshot } from "../src/snapshot.js";
import { openStore } from "../src/store.js";

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-"));
});

test("createIdentity mints once and refuses a second time", () => {
  const identity = createIdentity("box");

  expect(identity.host_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(identity.display_name).toBe("box");
  // Not idempotent, deliberately: `murmur init` is the only caller, and a
  // second mint would replace the host_id every peer knows this node by.
  expect(() => createIdentity("other")).toThrow(/already exists/);
});

test("setDisplayName renames without changing the host_id", () => {
  // `murmur init --name` on an already-initialised node used to be ignored in
  // silence, which is the one thing a rename must not do.
  const first = createIdentity("box");

  const renamed = setDisplayName("laptop");

  expect(renamed).toEqual({ host_id: first.host_id, display_name: "laptop" });
  expect(loadIdentity()).toEqual(renamed);
});

test("loadIdentity returns null before init", () => {
  expect(loadIdentity()).toBeNull();
});

test("an unpublishable name is refused at the writer, both ways in", () => {
  // The snapshot contract requires a non-empty `display_name`, so an empty one
  // made this node produce a document it would itself reject. The failure was
  // entirely OFF-NODE and therefore invisible where it was caused: locally
  // status, pick and export all worked, while every peer that collected this
  // node classed it reachable-but-broken.
  //
  // A validator stricter than its producer is the real defect, so the guard
  // lives at the only writer -- which is why both entry points are asserted.
  expect(() => createIdentity("")).toThrow(/cannot be empty/);
  // Whitespace-only satisfies the validator's `!== ""` and is unusable in every
  // surface that prints it.
  expect(() => createIdentity("   ")).toThrow(/cannot be empty/);
  // Nothing was written by either refusal.
  expect(loadIdentity()).toBeNull();

  createIdentity("box");
  expect(() => setDisplayName("")).toThrow(/cannot be empty/);
  // And the refusal did not damage the existing identity.
  expect(loadIdentity()?.display_name).toBe("box");
});

test("every identity this module can produce survives its own validator", () => {
  // The constraint as a test rather than as prose: "this node cannot produce a
  // snapshot it would itself reject". That was stated in ARCHITECTURE and
  // enforced nowhere, which is how the empty name shipped -- and this fails for
  // the NEXT field that gains a `text()` rule, not just for display_name.
  const identity = createIdentity("box");
  const store = openStore();
  try {
    const snapshot = store.buildLocalSnapshot(identity, { panes: new Set() });
    // The real round trip: serialise exactly as `murmur export` does, then feed
    // it to the validator a peer runs. No throw means a peer accepts us.
    expect(() => parseSnapshot(JSON.stringify(snapshot))).not.toThrow();
  } finally {
    store.close();
  }
});
