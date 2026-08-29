import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { stateDir } from "./paths.js";

export type NodeIdentity = {
  host_id: string;
  display_name: string;
};

export function loadIdentity(): NodeIdentity | null {
  const path = join(stateDir(), "identity.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

export function ensureIdentity(displayName = hostname()): NodeIdentity {
  const existing = loadIdentity();
  if (existing) return existing;

  const identity = { host_id: randomUUID(), display_name: displayName };
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(join(stateDir(), "identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
  return identity;
}
