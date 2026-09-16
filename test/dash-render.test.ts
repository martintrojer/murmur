import { renderToString } from "ink";
import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { App } from "../src/cli/dash.js";
import type { DashStore } from "../src/dash-store.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import type { Status } from "../src/status.js";
import type { PaneView } from "../src/view.js";

const pane: PaneView = {
  host_id: "here",
  host: "here",
  local: true,
  server: { kind: "default" },
  pane: asPaneId("%1"),
  session: asSessionId("$1"),
  window: asWindowId("@1"),
  session_name: "work",
  window_name: null,
  activity: "running",
  attention: [],
  freshness: "fresh",
  agent_id: "agent-1",
  agent_name: "worker-1",
  pi_session: null,
  workstream: "murmur",
  role: null,
  cli: "pi",
  driver: "human",
  model: null,
  provider: null,
  effort: null,
  provider_effort: null,
  context_pct: null,
  context_tokens: null,
  context_window: null,
  usage: null,
  updated_at: 1,
  snapshot_at: null,
  fetched_at: null,
  attached_pane: null,
};
const counts = { crashed: 0, blocked: 0, done: 0, running: 1, idle: 0 };
const initial: Status = {
  counts,
  orchestrated_counts: { crashed: 0, blocked: 0, done: 0, running: 0, idle: 0 },
  panes: [pane],
  peers: [],
};

/** First render is the seam that catches same-scope temporal-dead-zone errors. */
test("dash renders its first frame", () => {
  const dashStore = {
    store: {},
    generation: { dev: 0n, ino: 0n },
  } as unknown as DashStore;

  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    expect(() => renderToString(createElement(App, { dashStore, initial }))).not.toThrow();
  } finally {
    stderr.mockRestore();
  }
});
