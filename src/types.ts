import type { PaneId, SessionId, WindowId } from "./ids.js";

export type AgentState = "working" | "blocked" | "done" | "crashed" | "cleared";

export type Driver = "human" | "orchestrated";

export const DEFAULT_DRIVER: Driver = "human";

export type Event = {
  host_id: string;
  seq: number;
  ts: number;
  agent_id: string;
  // Three tmux ids, and they are not three of a kind. `pane` is the identity
  // component of `agent_id` (`host:pane`) and does not change for the life of
  // the agent: a pane keeps its id across move-pane, break-pane, and a window
  // closed and reopened. `session` and `window` are LOCATION -- where that pane
  // currently lives -- and may legitimately differ between two events for the
  // same agent, so neither is evidence about anything but the moment it was
  // recorded.
  //
  // Hence the rule, which is what the brands on these three types exist to
  // enforce: only a pane may decide whether an agent exists. A window id on an
  // agent's last event tells you nothing about whether the agent is still
  // running, and reading it as death deleted ten live agents (a0fb6ec, fixed in
  // 0e546c7).
  session: SessionId;
  window: WindowId;
  pane: PaneId;
  // Human-readable names, recorded by the node that owns the pane. tmux ids are
  // stable and are what jumps; names are what a human recognises. They are
  // *recorded* rather than resolved at render time because a reader cannot look
  // a remote window id up in its own tmux -- doing so labelled a remote agent
  // with whatever this host had at that id. Cost: a renamed window keeps its
  // old name until the next event, which is the same property the history rows
  // always had.
  session_name: string | null;
  window_name: string | null;
  // The agent's own idea of what it is working on: pi's session name, and mu's
  // $MU_AGENT_NAME for an orchestrated agent. Both are richer than the window
  // name when they exist, and neither is derivable from tmux.
  agent_name: string | null;
  pi_session: string | null;
  workstream: string | null;
  role: string | null;
  cli: string | null;
  driver: Driver | null;
  kind: string;
  state: AgentState | string;
  message: string;
  pid: number | null;
  synthetic: boolean;
  reason: string;
  extra: Record<string, unknown>;
};

export type Peer = {
  name: string;
  target: string;
  host_id: string | null;
  display_name: string | null;
  watermark: number;
  fetched_at: number | null;
  /** When a jump last found this peer's tmux server down. Null once it answers. */
  tmux_down_at: number | null;
};
