import { statSync } from "node:fs";
import { dbPath } from "./paths.js";
import { openStore, type Store } from "./store.js";

type FileGeneration = {
  dev: bigint;
  ino: bigint;
};

export type DashStore = {
  store: Store;
  generation: FileGeneration;
};

function fileGeneration(): FileGeneration | null {
  try {
    const { dev, ino } = statSync(dbPath(), { bigint: true });
    return { dev, ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameGeneration(left: FileGeneration, right: FileGeneration): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Open the store and remember the filesystem generation backing its path. */
export function openDashStore(): DashStore {
  // Stat on both sides so a concurrent rebuild cannot pair a handle to the old
  // file with the generation of the new path.
  for (;;) {
    const before = fileGeneration();
    const store = openStore();
    const after = fileGeneration();
    if (after !== null && (before === null || sameGeneration(before, after))) {
      return { store, generation: after };
    }
    store.close();
  }
}

/** Reopen a long-running dash after a schema rebuild replaces state.db. */
export function refreshDashStore(current: DashStore): boolean {
  const generation = fileGeneration();
  // A rebuild briefly removes the path. Keep the known-good handle and retry
  // next collect rather than creating a competing database or going blind.
  if (generation === null || sameGeneration(generation, current.generation)) return false;

  // Open first: failure must never cost the dash its only readable handle.
  const replacement = openDashStore();
  const previous = current.store;
  current.store = replacement.store;
  current.generation = replacement.generation;
  previous.close();
  return true;
}
