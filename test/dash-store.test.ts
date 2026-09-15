import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openDashStore, refreshDashStore } from "../src/dash-store.js";
import { dbPath } from "../src/paths.js";
import { openStore, type Store } from "../src/store.js";

const stores: Store[] = [];

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-dash-store-"));
});

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // The generation swap already closed it.
    }
  }
});

function tracked(store: Store): Store {
  stores.push(store);
  return store;
}

test("a dash store retries a missing replacement and reopens the new SQLite inode", () => {
  const first = openDashStore();
  stores.push(first.store);
  const oldStore = first.store;
  oldStore.addPeer("old", "old.example");

  // This is the schema rebuild's filesystem operation, not a fake Store: the
  // open SQLite handle keeps reading the now-unlinked inode while the path is
  // briefly absent.
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath()}${suffix}`, { force: true });

  expect(refreshDashStore(first)).toBe(false);
  expect(first.store.peers().map((peer) => peer.name)).toEqual(["old"]);

  const replacement = tracked(openStore());
  replacement.addPeer("new", "new.example");

  expect(refreshDashStore(first)).toBe(true);
  stores.push(first.store);
  expect(first.store.peers().map((peer) => peer.name)).toEqual(["new"]);
  expect(() => oldStore.peers()).toThrow();

  // The production incident was a link-count-zero state.db descriptor. Once
  // the dash switches generations, this process must hold no such descriptor.
  if (process.platform !== "win32") {
    const deleted = spawnSync("lsof", ["+L1", "-a", "-p", String(process.pid)], {
      encoding: "utf8",
    }).stdout;
    expect(deleted).not.toContain("state.db");
  }
});
