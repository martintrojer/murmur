import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { createIdentity, loadIdentity, setDisplayName } from "../src/identity.js";

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
