import { foldAgent, type LiveCheck } from "./fold.js";
import { ensureIdentity } from "./identity.js";
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
export function clearDeadWindows(store: Store, hostId: string, live: Set<string> | null): void {
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
    if (event.state === "cleared") continue;
    if (live.has(event.window)) continue;
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
