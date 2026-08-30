import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { stateDir } from "./paths.js";

export type NodeIdentity = {
  host_id: string;
  display_name: string;
};

function identityPath(): string {
  return join(stateDir(), "identity.json");
}

/**
 * Memoized per process, keyed on the resolved path.
 *
 * `identity.json` cannot change under a running command, and the audit measured
 * eight redundant reads per invocation. Keyed on the path rather than a bare
 * boolean so a test that repoints `MURMUR_STATE_DIR` mid-process is not served
 * another directory's identity.
 */
let cache: { path: string; identity: NodeIdentity | null } | null = null;

/**
 * This node's identity, or null when it has none.
 *
 * A READ, and only a read: nothing mints here. Every command that needs a
 * host_id fails with "murmur is not initialised on this node; run: murmur init"
 * rather than bringing a node into existence as a side effect of a status-bar
 * tick.
 */
export function loadIdentity(): NodeIdentity | null {
  const path = identityPath();
  if (cache?.path === path) return cache.identity;
  const identity = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as NodeIdentity)
    : null;
  cache = { path, identity };
  return identity;
}

function write(identity: NodeIdentity): NodeIdentity {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(identityPath(), `${JSON.stringify(identity, null, 2)}\n`);
  cache = { path: identityPath(), identity };
  return identity;
}

/** Create this node's identity. Only `murmur init` calls it. */
export function createIdentity(displayName = hostname()): NodeIdentity {
  if (loadIdentity()) throw new Error(`identity already exists: ${identityPath()}`);
  return write({ host_id: randomUUID(), display_name: displayName });
}

/**
 * Rename an existing node, keeping its `host_id`.
 *
 * `murmur init --name` on an already-initialised node used to ignore the flag
 * silently, which is the one thing a rename must not do.
 */
export function setDisplayName(displayName: string): NodeIdentity {
  const existing = loadIdentity();
  return write(
    existing
      ? { host_id: existing.host_id, display_name: displayName }
      : { host_id: randomUUID(), display_name: displayName },
  );
}
