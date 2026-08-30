import type { PaneId, SessionId, WindowId } from "./ids.js";
import { type AgentState, DEFAULT_DRIVER, type Driver, type Event } from "./types.js";

export type LiveCheck = (pid: number) => boolean;

/**
 * The resolved state of an agent, as every surface must read it.
 *
 * `idle` rather than null-or-cleared, because null is not a state -- it is the
 * absence of one, and four sites were independently translating it: status.ts
 * did `state === null || state === "cleared" ? "idle" : state` and pick.ts did
 * `agent.state ?? "idle"` three times. Same question, four answers, one of
 * which tested a condition that cannot happen (see resolveState).
 *
 * `cleared` is deliberately NOT in this union, and that is the point of having
 * one. A stored row can say `cleared`; a RESOLVED agent cannot, because a clear
 * means "nothing to see", which is `idle`. Exhausted over the whole two-event
 * state space against the built fold: the reachable results are blocked,
 * crashed, done, working and idle, and nothing else. Encoding that in the type
 * is what makes the dead branch impossible to write again.
 */
export type ResolvedState = "working" | "blocked" | "done" | "crashed" | "idle";

/**
 * THE ONE ANSWER to "what is this agent doing, right now".
 *
 * Fourteen sites across six files used to derive some part of this
 * independently, and six shipped bugs came from the seams between them. The
 * worst was a dead-pid `working` row, where three paths gave three answers:
 * fold read it as `crashed`, export WROTE a synthetic `crashed`, and clear saw
 * the raw `working` and refused to clear what the user had been shown.
 *
 * Two rules, and only these two, live here:
 *
 *   1. The newest row that says something wins, and a `working` row is only
 *      `working` while its pid answers. That is the fold.
 *   2. Nothing to see is `idle`. A clear, an empty history, and a history of
 *      states this version does not recognise all mean the same thing.
 *
 * The probe is injected rather than imported so this stays testable without a
 * process table, and because the RIGHT probe differs by caller: a local agent
 * is probed with `pidAlive`, a remote one with `() => true`, since a remote pid
 * names a process in another machine's table and means nothing here. That
 * choice stays with the caller: `status()` is the only place that folds a mixed
 * local/remote list, so centralising it bought one caller a worse signature.
 *
 * FAILS CLOSED, and the direction is the whole safety property. `pidAlive`
 * reports death only on ESRCH, so a probe that cannot answer (EPERM, or
 * anything else) says alive, which resolves to `working`, which is NOT
 * clearable. An unanswerable pid must never promote a live agent into a
 * clearable one -- that is cbcd9c4, which wiped 50 of 84 turns on one agent.
 *
 * Presentation stays out. This returns a state; glyphs, colours, sorting and
 * counting are the callers' business, and letting any of them in here is how a
 * resolver becomes a second renderer.
 */
export function resolveState(events: Event[], isAlive: LiveCheck): ResolvedState {
  return viewState(foldAgent(events, isAlive));
}

/**
 * The same answer for an agent that has ALREADY been folded.
 *
 * `status()` folds once and hands `AgentView`s to the picker and the status bar,
 * so those callers must not re-fold -- they have no events and no business
 * probing pids again. What they were each doing instead was the last step of
 * the resolver by hand, `agent.state ?? "idle"`, in four places.
 *
 * Deliberately takes the narrowest possible shape rather than a full AgentView,
 * so it can be applied to a fold result directly and cannot grow a dependency
 * on anything presentational.
 */
export function viewState(view: { state: AgentState | null }): ResolvedState {
  // `cleared` is handled rather than asserted away, even though a fold cannot
  // produce it. The compiler is right to demand this: `AgentState` includes
  // `cleared`, so "foldAgent never returns it" is a fact about the fold's body,
  // not something the signature guarantees. Mapping it to `idle` here means the
  // invariant holds by construction instead of by comment -- and if some future
  // fold path ever does return `cleared`, it degrades to the correct answer
  // rather than to a lie a cast would have hidden.
  if (view.state === null || view.state === "cleared") return "idle";
  return view.state;
}

export type AgentView = {
  agent_id: string;
  host_id: string;
  state: AgentState | null;
  event: Event | null;
  workstream: string | null;
  role: string | null;
  cli: string | null;
  driver: Driver;
  session: SessionId;
  window: WindowId;
  pane: PaneId;
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
        // Not "the agent is gone": the extension emits this at the end of a
        // turn when the pane is focused, so an agent in active use sits here
        // between turns. The event is dropped as well as the state -- it is a
        // *clear*, so its timestamp must not become the row's "last said
        // something" age.
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

/**
 * A duration as the shortest thing worth reading: "5m", "2h", "3d".
 *
 * Lives beside isStale because both answer "how old is this", and both the
 * picker and `peer list` render it -- the two must not drift into saying the
 * same age differently. Under a minute is the empty string: an age that changes
 * every second is noise in a status column.
 */
export function age(ms: number | null): string {
  if (ms === null || ms < 60_000) return "";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export function isStale(fetchedAt: number | null, now: number, thresholdMs = 60_000): boolean {
  return fetchedAt !== null && now - fetchedAt > thresholdMs;
}
