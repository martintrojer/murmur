import { foldAgent, type LiveCheck } from "./fold.js";
import { ensureIdentity, loadIdentity } from "./identity.js";
import { asPaneId, asSessionId, asWindowId, type PaneId, type WindowId } from "./ids.js";
import { pidAlive, tmux } from "./mux.js";
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
    session: asSessionId(wire.session as string),
    window: asWindowId(wire.window as string),
    pane: asPaneId(wire.pane as string),
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

/**
 * Record a `crashed` row for this host's agents whose pid is gone.
 *
 * Only the authoring host can do this, and that is the whole reason it must not
 * live on the export path. A reader folds a REMOTE `working` row with
 * `() => true` (status.ts) because a remote pid names a process in another
 * machine's table -- so a peer cannot derive `crashed` for this host's agents,
 * ever. If this node does not write the row, no node learns the fact: the
 * replica shows `working` forever.
 *
 * It used to be called only from `exportJsonl`, which runs when a PEER asks
 * over ssh. So a single-machine node synthesized never, and a node whose peers
 * are asleep -- the normal case for this tool -- only when one happened to
 * wake. Live store evidence: 438 raw `working` rows against 2 `crashed`.
 *
 * Exactly the structural mistake `reapDeadAgents` was moved out of export to
 * fix, and this was the half left behind. Housekeeping a zero-peer node needs
 * belongs on `collect`, which runs on every invocation.
 *
 * Resolves identity itself and defaults `isAlive`, like `reapDeadAgents`, so
 * `collect` can call it with no arguments and it is a no-op on a node with no
 * identity yet.
 */
export function synthesizeCrashes(store: Store, isAlive: LiveCheck = pidAlive): void {
  const identity = loadIdentity();
  if (!identity) return;

  const byAgent = new Map<string, Event[]>();
  for (const event of store.allEvents()) {
    if (event.host_id !== identity.host_id) continue;
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
 * Drop this host's agents whose pane is gone and whose last state is already
 * `cleared`.
 *
 * The delete-only half of reconcileDeadAgents, callable without building an
 * export. Housekeeping runs from `collect`, which happens on every invocation
 * including with no peers; export only runs when a peer asks over ssh, so a
 * single-machine node reaped never.
 *
 * Resolves identity and tmux itself because both are facts only the owning host
 * can know, and this must be a no-op on a node that has neither.
 */
export function reapDeadAgents(store: Store, panes: Set<PaneId> | null = tmux.livePanes()): void {
  const identity = loadIdentity();
  if (!identity || panes === null) return;

  const newest = new Map<string, Event>();
  for (const event of store.allEvents()) {
    if (event.host_id !== identity.host_id) continue;
    const previous = newest.get(event.agent_id);
    if (!previous || event.seq > previous.seq) newest.set(event.agent_id, event);
  }

  for (const event of newest.values()) {
    if (panes.has(event.pane)) continue;

    // Only a row that already says "nothing to see". blocked, done and crashed
    // are unacknowledged facts; export supersedes those with a synthetic
    // `cleared` rather than deleting them, so a real failure is never swept
    // away silently.
    if (event.state === "cleared") store.forgetAgent(event.agent_id);
  }
}

/**
 * Reconcile this host's agents against the panes that still exist.
 *
 * A pane that dies takes its agent with it, but the log's newest row still says
 * `blocked`, so every peer keeps showing an agent that cannot be jumped to --
 * the fold has nothing to supersede that row with. Only the authoring node can
 * tell, which is why this runs on export beside crash synthesis rather than on
 * the reader.
 *
 * `cleared` is the right state: it already means "no longer wants attention"
 * and resets the fold to none. An appended event rather than an export-time
 * filter, so the fact replicates once and explains itself, instead of every
 * peer having to re-derive it from an absence.
 *
 * The PANES decide, and that is the whole of the rule this function got wrong
 * once. `agent_id` is `host:pane` and a pane keeps its id when it moves between
 * windows -- move-pane, break-pane, a window closed and reopened -- so the
 * window on an agent's last event goes stale routinely while the agent runs on.
 * Keying on it deleted ten live agents in one sweep. Verified against real
 * tmux: after move-pane the pane id was unchanged and the old window id had
 * vanished from `liveWindows()`.
 *
 * `live` is therefore not a second liveness key. It is only the null-check that
 * proves tmux could answer at all.
 */
export function reconcileDeadAgents(
  store: Store,
  hostId: string,
  live: Set<WindowId> | null,
  panes: Set<PaneId> | null = tmux.livePanes(),
): void {
  // null means tmux could not answer. An empty set means it did and there are
  // no windows. Conflating them would clear every agent on the host whenever
  // tmux was briefly unreachable.
  if (live === null || panes === null) return;

  const newest = new Map<string, Event>();
  for (const event of store.allEvents()) {
    if (event.host_id !== hostId) continue;
    const previous = newest.get(event.agent_id);
    if (!previous || event.seq > previous.seq) newest.set(event.agent_id, event);
  }

  for (const event of newest.values()) {
    if (panes.has(event.pane)) continue;

    // Gone AND already saying "nothing to see": drop it. Without this the row
    // was immortal -- retention keeps the newest event per agent forever, and
    // this loop only ever CONVERTED a live row, so an already-cleared row had
    // nothing to supersede and was skipped.
    if (event.state === "cleared") {
      store.forgetAgent(event.agent_id);
      continue;
    }
    const { host_id: _hostId, seq: _seq, ts: _ts, ...rest } = event;
    store.append({
      ...rest,
      state: "cleared",
      synthetic: true,
      // On the wire, so it stays as it is despite naming a window: peers and
      // stored rows already carry this string, and renaming a reason code is a
      // schema change, not a vocabulary fix.
      reason: "window_gone",
      message: "",
    });
  }
}

export function exportJsonl(
  store: Store,
  since: number,
  isAlive: LiveCheck,
  live?: Set<WindowId> | null,
): string {
  const identity = ensureIdentity();
  synthesizeCrashes(store, isAlive);
  if (live !== undefined) reconcileDeadAgents(store, identity.host_id, live);

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
