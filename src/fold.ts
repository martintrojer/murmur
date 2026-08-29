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
};

export function foldAgent(
  events: Event[],
  isAlive: LiveCheck,
): { state: AgentState | null; event: Event | null } {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;

    switch (event.state) {
      case "blocked":
      case "done":
      case "crashed":
        return { state: event.state, event };
      case "cleared":
        return { state: null, event: null };
      case "working":
        return {
          state: event.pid !== null && event.pid > 0 && isAlive(event.pid) ? "working" : "crashed",
          event,
        };
    }
  }

  return { state: null, event: null };
}

export function foldAll(events: Event[], isAlive: LiveCheck): AgentView[] {
  const byAgent = new Map<string, Event[]>();
  for (const event of events) {
    const agentEvents = byAgent.get(event.agent_id);
    if (agentEvents) agentEvents.push(event);
    else byAgent.set(event.agent_id, [event]);
  }

  return [...byAgent.values()].map((agentEvents) => {
    const folded = foldAgent(agentEvents, isAlive);
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
