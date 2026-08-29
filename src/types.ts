export type AgentState = "working" | "blocked" | "done" | "crashed" | "cleared";

export type Driver = "human" | "orchestrated";

export const DEFAULT_DRIVER: Driver = "human";

export type Event = {
  host_id: string;
  seq: number;
  ts: number;
  agent_id: string;
  session: string;
  window: string;
  pane: string;
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
