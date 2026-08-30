import { foldAgent, type LiveCheck } from "./fold.js";
import { ensureIdentity, loadIdentity } from "./identity.js";
import { tmux } from "./mux.js";
import type { Store } from "./store.js";
import type { Driver, Event } from "./types.js";

export const SCHEMA_VERSION = 2;

export type Envelope = {
  schema_version: number;
  host_id: string;
  display_name: string;
  exported_at: number;
};

const EVENT_FIELDS = new Set([
  "host_id",
  "seq",
  "ts",
  "agent_id",
  "session",
  "window",
  "pane",
  "session_name",
  "window_name",
  "agent_name",
  "pi_session",
  "workstream",
  "role",
  "cli",
  "driver",
  "kind",
  "state",
  "message",
  "pid",
  "synthetic",
  "reason",
]);

function eventToWire(event: Event): Record<string, unknown> {
  const { extra, ...known } = event;
  return { ...extra, ...known };
}

export function eventFromWire(wire: Record<string, unknown>): Event {
  const extra = Object.fromEntries(Object.entries(wire).filter(([key]) => !EVENT_FIELDS.has(key)));
  return {
    host_id: wire.host_id as string,
    seq: wire.seq as number,
    ts: wire.ts as number,
    agent_id: wire.agent_id as string,
    session: wire.session as string,
    window: wire.window as string,
    pane: wire.pane as string,
    session_name: (wire.session_name as string | null | undefined) ?? null,
    window_name: (wire.window_name as string | null | undefined) ?? null,
    agent_name: (wire.agent_name as string | null | undefined) ?? null,
    pi_session: (wire.pi_session as string | null | undefined) ?? null,
    workstream: (wire.workstream as string | null | undefined) ?? null,
    role: (wire.role as string | null | undefined) ?? null,
    cli: (wire.cli as string | null | undefined) ?? null,
    driver: (wire.driver as Driver | null | undefined) ?? null,
    kind: wire.kind as string,
    state: wire.state as string,
    message: wire.message as string,
    pid: (wire.pid as number | null | undefined) ?? null,
    synthetic: wire.synthetic as boolean,
    reason: wire.reason as string,
    extra,
  };
}

function synthesizeCrashes(store: Store, hostId: string, isAlive: LiveCheck): void {
  const byAgent = new Map<string, Event[]>();
  for (const event of store.allEvents()) {
    if (event.host_id !== hostId) continue;
    const events = byAgent.get(event.agent_id);
    if (events) events.push(event);
    else byAgent.set(event.agent_id, [event]);
  }

  for (const events of byAgent.values()) {
    events.sort((left, right) => left.seq - right.seq);
    const newest = events.at(-1);
    if (
      newest &&
      newest.state === "working" &&
      !newest.synthetic &&
      foldAgent(events, isAlive).state === "crashed"
    ) {
      const { host_id: _hostId, seq: _seq, ts: _ts, ...event } = newest;
      store.append({ ...event, state: "crashed", synthetic: true, reason: "pid_gone" });
    }
  }
}

/**
 * Clear agents whose tmux window is gone.
 *
 * A window that dies takes its agent with it, but the log's newest row still
 * says `blocked`, so every peer keeps showing an agent that cannot be jumped
 * to -- the fold has nothing to supersede that row with. Only the authoring
 * node can tell, which is why this runs on export beside crash synthesis
 * rather than on the reader.
 *
 * `cleared` is the right state: it already means "no longer wants attention"
 * and resets the fold to none. An appended event rather than an export-time
 * filter, so the fact replicates once and explains itself, instead of every
 * peer having to re-derive it from an absence.
 */
/**
 * Drop this host's agents whose tmux window is gone and whose last state is
 * already `cleared`.
 *
 * The delete-only half of clearDeadWindows, callable without building an
 * export. Housekeeping runs from `collect`, which happens on every invocation
 * including with no peers; export only runs when a peer asks over ssh, so a
 * single-machine node reaped never.
 *
 * Resolves identity and tmux itself because both are facts only the owning host
 * can know, and this must be a no-op on a node that has neither.
 */
export function reapDeadAgents(store: Store, live: Set<string> | null = tmux.liveWindows()): void {
  const identity = loadIdentity();
  if (!identity || live === null) return;
  clearDeadWindows(store, identity.host_id, live, "reap-only");
}

export function clearDeadWindows(
  store: Store,
  hostId: string,
  live: Set<string> | null,
  mode: "full" | "reap-only" = "full",
): void {
  // null means tmux could not answer. An empty set means it did and there are
  // no windows. Conflating them would clear every agent on the host whenever
  // tmux was briefly unreachable.
  if (live === null) return;

  const newest = new Map<string, Event>();
  for (const event of store.allEvents()) {
    if (event.host_id !== hostId) continue;
    const previous = newest.get(event.agent_id);
    if (!previous || event.seq > previous.seq) newest.set(event.agent_id, event);
  }

  for (const event of newest.values()) {
    if (live.has(event.window)) continue;

    // The window is gone AND the agent already reported cleared, so there is no
    // state left to supersede and nothing a human could learn from the row.
    // Drop it outright.
    //
    // Without this the row was immortal, which is a leak from two correct rules
    // meeting. Retention keeps the newest event per agent forever so a
    // long-idle agent does not vanish, and this loop only ever CONVERTED a live
    // row to cleared -- an already-cleared row had nothing to supersede, so it
    // was skipped. A dead agent's final `cleared` was therefore protected by
    // pruning and removed by nothing: four crew rows on the author's machine
    // had outlived their windows indefinitely.
    //
    // Deliberately narrow. `blocked`, `done` and `crashed` on a dead window
    // still become a synthetic `cleared` below rather than being deleted: those
    // are unacknowledged facts, and sweeping them away silently would hide the
    // very failures this tool exists to surface. Only a row that already says
    // "nothing to see" is discarded.
    if (event.state === "cleared") {
      store.forgetAgent(event.agent_id);
      continue;
    }

    // reap-only: never author. Synthesising a `cleared` is an authorship
    // decision that belongs to export, where crash synthesis already lives and
    // where the envelope that carries it is being built. Housekeeping only
    // removes rows that say nothing.
    if (mode === "reap-only") continue;
    const { host_id: _hostId, seq: _seq, ts: _ts, ...rest } = event;
    store.append({
      ...rest,
      state: "cleared",
      synthetic: true,
      reason: "window_gone",
      message: "",
    });
  }
}

export function exportJsonl(
  store: Store,
  since: number,
  isAlive: LiveCheck,
  live?: Set<string> | null,
): string {
  const identity = ensureIdentity();
  synthesizeCrashes(store, identity.host_id, isAlive);
  if (live !== undefined) clearDeadWindows(store, identity.host_id, live);

  const envelope: Envelope = {
    schema_version: SCHEMA_VERSION,
    host_id: identity.host_id,
    display_name: identity.display_name,
    exported_at: Date.now(),
  };
  const lines = [
    JSON.stringify(envelope),
    ...store
      .eventsSince(identity.host_id, since)
      .map((event) => JSON.stringify(eventToWire(event))),
  ];
  return `${lines.join("\n")}\n`;
}
