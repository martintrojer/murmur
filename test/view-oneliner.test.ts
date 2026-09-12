import { expect, test } from "vitest";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { oneLiner, type PaneView } from "../src/view.js";

/**
 * The card one-liner: what a pane says about itself in one line.
 *
 * The rule is a fallback chain, not a merge: an attention message is a human
 * sentence written by the agent, the glance is terminal output that happens to
 * end somewhere. So a message always wins, and only a message that is actually
 * there -- whitespace is not a sentence -- keeps the glance from showing.
 */

function view(over: Partial<PaneView> = {}): PaneView {
  return {
    host_id: "H",
    host: "here",
    local: true,
    pane: asPaneId("%1"),
    session: asSessionId("$0"),
    window: asWindowId("@0"),
    session_name: "work",
    window_name: "w",
    activity: "running",
    attention: [],
    freshness: "fresh",
    agent_id: "a-1",
    agent_name: null,
    pi_session: null,
    workstream: null,
    role: null,
    cli: "pi",
    driver: "human",
    updated_at: 1_000,
    snapshot_at: null,
    fetched_at: null,
    attached_pane: null,
    ...over,
  };
}

test("an attention message beats the glance", () => {
  const agent = view({
    attention: [{ kind: "blocked", requested_at: 1, message: "waiting on the hook" }],
  });
  expect(oneLiner(agent, "noise")).toBe("waiting on the hook");
});

test("the first non-empty message wins, and it is trimmed", () => {
  const agent = view({
    attention: [
      { kind: "done", requested_at: 1, message: "" },
      { kind: "blocked", requested_at: 2, message: "  needs input  " },
      { kind: "crashed", requested_at: 3, message: "finished" },
    ],
  });
  expect(oneLiner(agent, "noise")).toBe("needs input");
});

test("a whitespace-only message falls through to the glance", () => {
  const agent = view({ attention: [{ kind: "done", requested_at: 1, message: "   " }] });
  expect(oneLiner(agent, "still here")).toBe("still here");
});

test("with no message the last non-empty glance line shows", () => {
  expect(oneLiner(view(), "foo\nbar\n")).toBe("bar");
  expect(oneLiner(view(), "tail\n  \n\n")).toBe("tail");
});

test("the glance line is trimmed", () => {
  expect(oneLiner(view(), "   indented output   ")).toBe("indented output");
});

test("no message and no glance is the empty string", () => {
  expect(oneLiner(view())).toBe("");
  expect(oneLiner(view(), null)).toBe("");
  expect(oneLiner(view(), "")).toBe("");
  expect(oneLiner(view(), "\n \n")).toBe("");
});
