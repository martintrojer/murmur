import { type AgentState, DEFAULT_DRIVER, type Driver, type Event } from "./types.js";

export type LiveCheck = (pid: number) => boolean;

export type AgentView = {
  agent_id: string;
  host_id: string;
  state: AgentState | null;
  event: Event | null;
  workstream: string | null;
  role: string | null;
  cli: string | null;
  driver: Driver;
  session: string;
  window: string;
  pane: string;
  // Names as recorded by the authoring node, so a remote agent is labelled by
  // its own host's tmux rather than by whatever this host has at that id.
  session_name: string | null;
  window_name: string | null;
  agent_name: string | null;
  pi_session: string | null;
  fetched_at: number | null;
  // Only meaningful on an idle row; "unknown" everywhere else. See Liveness.
  liveness: Liveness;
};

/**
 * Whether an agent's process is still running, for a row that carries no state.
 *
 * `alive` and `exited` are only ever reported for an idle row. A state of its
 * own would have to be ordered against blocked/done/crashed in every consumer,
 * and it does not belong on that axis: "is the process there" is orthogonal to
 * "does it need me", which is the question the picker sorts by.
 */
export type Liveness = "alive" | "exited" | "unknown";

/**
 * The last pid the agent reported, alive or not.
 *
 * `cleared` and `done` events carry `pid: null` -- the process is not the
 * subject of those events -- so the pid has to come from the last event that
 * had one. Same pane, so the same process: an agent_id IS a pane.
 */
function lastKnownPid(events: Event[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const pid = events[index]?.pid;
    if (pid !== null && pid !== undefined && pid > 0) return pid;
  }
  return null;
}

export function foldAgent(
  events: Event[],
  isAlive: LiveCheck,
  // Whether a pid on these events can be asked about at all. Only the authoring
  // node can: a remote pid names a process in another machine's table, so
  // checking it locally answers about an unrelated process or nothing.
  pidsAreLocal = true,
): { state: AgentState | null; event: Event | null; liveness: Liveness } {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;

    switch (event.state) {
      case "blocked":
      case "done":
      case "crashed":
        return { state: event.state, event, liveness: "unknown" };
      case "cleared": {
        // `cleared` is not "the agent is gone": the pi extension emits it at the
        // end of every TURN when the pane is focused (see endState), so a pi you
        // are actively using sits here between turns. The row is still correctly
        // idle -- it wants nothing -- but reporting only that made a live agent
        // indistinguishable from an exited one, and the picker showed both as
        // plain idle for as long as they existed.
        //
        // The event is still dropped, deliberately: it is a *clear*, so its
        // timestamp must not become the row's "last said something" age. Only
        // the liveness of the process it belonged to survives.
        const pid = pidsAreLocal ? lastKnownPid(events) : null;
        return {
          state: null,
          event: null,
          liveness: pid === null ? "unknown" : isAlive(pid) ? "alive" : "exited",
        };
      }
      case "working":
        return {
          state: event.pid !== null && event.pid > 0 && isAlive(event.pid) ? "working" : "crashed",
          event,
          liveness: "unknown",
        };
    }
  }

  return { state: null, event: null, liveness: "unknown" };
}

export function foldAll(
  events: Event[],
  isAlive: LiveCheck,
  pids: "local" | "unknown" = "local",
): AgentView[] {
  const byAgent = new Map<string, Event[]>();
  for (const event of events) {
    const agentEvents = byAgent.get(event.agent_id);
    if (agentEvents) agentEvents.push(event);
    else byAgent.set(event.agent_id, [event]);
  }

  return [...byAgent.values()].map((agentEvents) => {
    const folded = foldAgent(agentEvents, isAlive, pids === "local");
    const source = folded.event ?? agentEvents[agentEvents.length - 1];
    if (!source) throw new Error("agent event group cannot be empty");

    return {
      agent_id: source.agent_id,
      host_id: source.host_id,
      state: folded.state,
      event: folded.event,
      workstream: source.workstream,
      role: source.role,
      cli: source.cli,
      driver: source.driver ?? DEFAULT_DRIVER,
      session: source.session,
      window: source.window,
      pane: source.pane,
      session_name: source.session_name,
      window_name: source.window_name,
      agent_name: source.agent_name,
      pi_session: source.pi_session,
      fetched_at: null,
      liveness: folded.liveness,
    };
  });
}

const ATTENTION_ORDER: Record<AgentState, number> = {
  blocked: 0,
  done: 1,
  crashed: 2,
  working: 3,
  cleared: 4,
};

export function attentionSort(views: AgentView[]): AgentView[] {
  return [...views].sort((left, right) => {
    const stateOrder =
      (left.state === null ? 4 : ATTENTION_ORDER[left.state]) -
      (right.state === null ? 4 : ATTENTION_ORDER[right.state]);
    if (stateOrder !== 0) return stateOrder;
    return (right.event?.ts ?? 0) - (left.event?.ts ?? 0);
  });
}

export function isStale(fetchedAt: number | null, now: number, thresholdMs = 60_000): boolean {
  return fetchedAt !== null && now - fetchedAt > thresholdMs;
}
