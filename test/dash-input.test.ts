import { expect, test } from "vitest";
import {
  buildEscapeDelivery,
  buildPromptDelivery,
  dashFilter,
  editComposer,
  emptyComposer,
  emptyFilter,
  sendPrompt,
} from "../src/dash-input.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import type { Store } from "../src/store.js";
import type { PaneView } from "../src/view.js";

test("composer inserts and edits text at the cursor", () => {
  let state = editComposer(emptyComposer(), { type: "insert", text: "helo" });
  state = editComposer(state, { type: "left" });
  state = editComposer(state, { type: "insert", text: "l" });
  expect(state).toEqual({ text: "hello", cursor: 4 });

  state = editComposer(state, { type: "backspace" });
  state = editComposer(state, { type: "delete" });
  expect(state).toEqual({ text: "hel", cursor: 3 });
});

test("composer moves across a Unicode glyph without splitting it", () => {
  let state = editComposer(emptyComposer(), { type: "insert", text: "a🙂b" });
  state = editComposer(state, { type: "left" });
  state = editComposer(state, { type: "left" });
  state = editComposer(state, { type: "delete" });
  expect(state).toEqual({ text: "ab", cursor: 1 });
});

test("composer moves to either end and preserves pasted newlines", () => {
  let state = editComposer(emptyComposer(), { type: "insert", text: "one\ntwo" });
  state = editComposer(state, { type: "home" });
  state = editComposer(state, { type: "insert", text: ">" });
  state = editComposer(state, { type: "end" });
  state = editComposer(state, { type: "insert", text: "<" });
  expect(state).toEqual({ text: ">one\ntwo<", cursor: 9 });
});

function pane(local: boolean, id = "%9"): PaneView {
  return {
    host_id: local ? "LOCAL" : "remote-host",
    host: local ? "here" : "dev",
    local,
    pane: asPaneId(id),
    session: asSessionId("$1"),
    window: asWindowId("@1"),
    session_name: "work",
    window_name: "agent",
    activity: "running",
    attention: [],
    freshness: "fresh",
    agent_id: "agent-1",
    agent_name: "worker-1",
    pi_session: null,
    workstream: null,
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
}

test("local prompt delivery keeps prompt bytes on stdin", () => {
  const delivery = buildPromptDelivery(pane(true), "hello 'remote'\nsecond", null, "input-1");
  expect(delivery).toEqual({
    command: "tmux",
    args: [
      "load-buffer",
      "-b",
      "input-1",
      "-",
      ";",
      "paste-buffer",
      "-b",
      "input-1",
      "-t",
      "%9",
      "-p",
      "-d",
      ";",
      "send-keys",
      "-t",
      "%9",
      "Enter",
    ],
    input: "hello 'remote'\nsecond",
  });
});

test("remote prompt delivery wraps tmux in ssh and quotes the pane", () => {
  const delivery = buildPromptDelivery(pane(false, "%9'bad"), "secret", "dev", "input-1");
  expect(delivery.command).toBe("ssh");
  expect(delivery.args).toContain("dev");
  expect(delivery.args).toContain("'%9'\\''bad'");
  expect(delivery.args.filter((arg) => arg === "\\;")).toHaveLength(2);
  expect(delivery.args).not.toContain("secret");
  expect(delivery.input).toBe("secret");
});

test("Escape delivery has no prompt input", () => {
  expect(buildEscapeDelivery(pane(true), null)).toEqual({
    command: "tmux",
    args: ["send-keys", "-t", "%9", "Escape"],
    input: "",
  });
});

test("delivery reports runner failures", async () => {
  const store = { peers: () => [] } as unknown as Store;
  await expect(
    sendPrompt(store, pane(true), "keep me", async () => {
      throw new Error("tmux pane is gone");
    }),
  ).resolves.toEqual({ ok: false, message: "tmux pane is gone" });
});

test("remote delivery refuses an unresolved peer", async () => {
  const store = { peers: () => [] } as unknown as Store;
  await expect(sendPrompt(store, pane(false), "keep me")).resolves.toEqual({
    ok: false,
    message: "no peer for dev",
  });
});

/**
 * The filter editor seam.
 *
 * A pure reducer so the `/` transitions are assertable without rendering a
 * dash: the query is session-local state in `dash.tsx`, and the only thing
 * worth testing about it is which key does what to it.
 */

test("slash opens filter editing and printable text lands in the query", () => {
  let state = emptyFilter();
  expect(state).toEqual({ editing: false, query: emptyComposer() });

  state = dashFilter(state, { type: "open" });
  expect(state.editing).toBe(true);

  state = dashFilter(state, { type: "edit", edit: { type: "insert", text: "work" } });
  expect(state.query.text).toBe("work");
});

test("Backspace and Delete edit the query, and typing is ignored when closed", () => {
  let state = dashFilter(emptyFilter(), { type: "open" });
  state = dashFilter(state, { type: "edit", edit: { type: "insert", text: "worker" } });
  state = dashFilter(state, { type: "edit", edit: { type: "backspace" } });
  expect(state.query.text).toBe("worke");

  state = dashFilter(state, { type: "edit", edit: { type: "left" } });
  state = dashFilter(state, { type: "edit", edit: { type: "delete" } });
  expect(state.query.text).toBe("work");

  const closed = dashFilter(state, { type: "accept" });
  expect(dashFilter(closed, { type: "edit", edit: { type: "insert", text: "x" } })).toEqual(closed);
});

test("Enter keeps the query and leaves editing; slash resumes it", () => {
  let state = dashFilter(emptyFilter(), { type: "open" });
  state = dashFilter(state, { type: "edit", edit: { type: "insert", text: "dash" } });
  state = dashFilter(state, { type: "accept" });
  expect(state).toEqual({ editing: false, query: { text: "dash", cursor: 4 } });

  // `/` re-enters with the query intact rather than starting over.
  expect(dashFilter(state, { type: "open" })).toEqual({
    editing: true,
    query: { text: "dash", cursor: 4 },
  });
});

test("Escape clears the query, whether editing or navigating", () => {
  let state = dashFilter(emptyFilter(), { type: "open" });
  state = dashFilter(state, { type: "edit", edit: { type: "insert", text: "dash" } });
  expect(dashFilter(state, { type: "cancel" })).toEqual(emptyFilter());

  const kept = dashFilter(state, { type: "accept" });
  expect(dashFilter(kept, { type: "cancel" })).toEqual(emptyFilter());
});
