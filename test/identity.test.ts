import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { ensureIdentity, loadIdentity } from "../src/identity.js";

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-"));
});

test("ensureIdentity is idempotent", () => {
  const a = ensureIdentity("box");
  const b = ensureIdentity("other");
  expect(b).toEqual(a);
  expect(a.host_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(a.display_name).toBe("box");
});

test("loadIdentity returns null before init", () => {
  expect(loadIdentity()).toBeNull();
});
