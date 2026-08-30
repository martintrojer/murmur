import { homedir } from "node:os";
import { join } from "node:path";

export function stateDir(): string {
  return (
    process.env.MURMUR_STATE_DIR ??
    join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "murmur")
  );
}

export function configDir(): string {
  return (
    process.env.MURMUR_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "murmur")
  );
}

/**
 * The current-state database. Not `events.db`, which held the deleted event log
 * and is removed on open rather than migrated.
 */
export function dbPath(): string {
  return join(stateDir(), "state.db");
}
