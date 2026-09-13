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
    model: null,
    provider: null,
    effort: null,
    provider_effort: null,
    context_pct: null,
    context_tokens: null,
    context_window: null,
    usage: null,
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

/**
 * pi's status footer, condensed.
 *
 * The footer is always the LAST line a pi pane prints, so it is always what the
 * fallback chain lands on -- the card was spending its one line on token
 * counters, cache-hit rate and spend, none of which a reader scanning a dash
 * for an agent to attend to can act on. What matters is which model is running,
 * at what effort, and how close the context is to full.
 */
test("a pi status footer is condensed to model, effort and context", () => {
  const footer =
    "↑213k ↓55k R4.4M CH99.0% $4.633 10.5%/800k (auto)     anthropic/claude-opus-5 • medium";
  expect(oneLiner(view(), footer)).toBe("claude-opus-5 · medium · 10.5%");
});

test("the provider prefix is dropped, however many segments it has", () => {
  expect(
    oneLiner(
      view(),
      "↑344k ↓23k R4.6M CH99.1% $4.717 15.1%/850k (auto)   meta-openai/gpt-5.6-sol • medium",
    ),
  ).toBe("gpt-5.6-sol · medium · 15.1%");
});

test("a footer missing a field states the fields it has", () => {
  // Effort is a pi preference and not always shown; a missing one must not cost
  // the reader the model and the context too.
  expect(
    oneLiner(view(), "↑1k ↓1k R1M CH9.0% $0.10 3.0%/800k (auto)    anthropic/claude-opus-5"),
  ).toBe("claude-opus-5 · 3.0%");
});

test("a line that is not a pi footer is left alone", () => {
  // The condensing is keyed on the footer's own shape. Ordinary output that
  // happens to contain a percentage or a slash is the agent talking, and
  // rewriting it would be the fallback chain lying about what the pane said.
  expect(oneLiner(view(), "running 3 tests, 99.0% covered")).toBe("running 3 tests, 99.0% covered");
  expect(oneLiner(view(), "src/view.ts • medium")).toBe("src/view.ts • medium");
});

test("an attention message still beats a pi footer", () => {
  const agent = view({
    attention: [{ kind: "blocked", requested_at: 1, message: "needs input" }],
  });
  expect(
    oneLiner(agent, "↑1k ↓1k R1M CH9.0% $0.10 3.0%/800k (auto)  anthropic/claude-opus-5 • medium"),
  ).toBe("needs input");
});

// --- reported fields beat the scrape -------------------------------------

test("reported fields beat the scraped footer", () => {
  // The whole point of snapshot v2: reported state, not text read out of a
  // pane. The footer here deliberately disagrees with the stored fields, so a
  // test that passed by coincidence cannot.
  const agent = view({ model: "gpt-5.6-sol", effort: "high", context_pct: 42.4 });
  const footer = "↑1k ↓1k R1M CH9.0% $0.10 3.0%/800k (auto)  anthropic/claude-opus-5 • medium";
  expect(oneLiner(agent, footer)).toBe("gpt-5.6-sol · high · 42.4%");
});

test("a partial report states what it has", () => {
  // Each field is independently nullable -- a harness may report a model and no
  // effort -- and a missing one must not cost the reader the others.
  expect(oneLiner(view({ model: "m", effort: null, context_pct: 5 }), "")).toBe("m · 5.0%");
  expect(oneLiner(view({ model: "m", effort: "low", context_pct: null }), "")).toBe("m · low");
  expect(oneLiner(view({ model: null, effort: null, context_pct: 12.5 }), "")).toBe("12.5%");
});

test("a reported percentage is formatted like the scraped one", () => {
  // One decimal, matching `piFooter`, so a card does not visibly change shape
  // the moment an agent starts reporting. A stored 5 reads "5.0%", not "5%".
  expect(oneLiner(view({ model: "m", effort: null, context_pct: 5 }), "")).toContain("5.0%");
  expect(oneLiner(view({ model: "m", effort: null, context_pct: 0 }), "")).toContain("0.0%");
});

test("no reported fields falls back to the scraped footer", () => {
  // The fallback is load-bearing, not vestigial: a bare shell, codex, or any
  // agent without the pi extension has all three null and must still show
  // something on the selected card.
  const footer = "↑1k ↓1k R1M CH9.0% $0.10 3.0%/800k (auto)  anthropic/claude-opus-5 • medium";
  expect(oneLiner(view({ model: null, effort: null, context_pct: null }), footer)).toBe(
    "claude-opus-5 · medium · 3.0%",
  );
});

test("an attention message still beats a report", () => {
  // Unchanged precedence. A human sentence written by the agent outranks any
  // derived status line, reported or scraped.
  const agent = view({
    model: "m",
    effort: "low",
    context_pct: 5,
    attention: [{ kind: "blocked", requested_at: 1, message: "needs input" }],
  });
  expect(oneLiner(agent, "")).toBe("needs input");
});

test("a reported agent needs no glance at all", () => {
  // What makes every card showable without a capture: with fields reported, the
  // line is derived from state the collector already carries, local or remote.
  expect(oneLiner(view({ model: "m", effort: "max", context_pct: 1 }))).toBe("m · max · 1.0%");
  expect(oneLiner(view({ model: "m", effort: "max", context_pct: 1 }), null)).toBe(
    "m · max · 1.0%",
  );
});

// --- what the scraper must and must not match ---------------------------

test("a diff or log line quoting a footer is not treated as one", () => {
  // Found by running the scraper against every real footer on the author's
  // machine and then probing the edges it did not cover.
  //
  // The anchor was the `<pct>%/<budget>` pair, and everything AFTER it was taken
  // as the model tail -- so any line that happened to contain that pair plus a
  // slash read as a status footer. A diff of this very file did it: the line
  // `-  const pct = 50.0%/800k (auto)  anthropic/x • y` rendered as
  // `x · y · 50.0%`, a plausible-looking model that does not exist.
  //
  // The fix anchors the whole line, not a substring: a real footer BEGINS with
  // its counters or its percentage, so anything before them disqualifies it.
  const agent = view();
  for (const line of [
    "-  const pct = 50.0%/800k (auto)  anthropic/x • y",
    '+  expect(summary).toBe("1.0%/800k (auto) anthropic/y • low")',
    "log: rebuilt at 50.0%/800k (auto) via anthropic/x • y",
  ]) {
    expect(oneLiner(agent, line), line).toBe(line);
  }
});

test("a footer with a trailing parenthetical is still a footer", () => {
  // `(auto)` is stripped as noise, and stripping it left any SECOND
  // parenthetical in place -- which then failed the model match and dropped the
  // whole condensation, showing the raw counter line instead. Two parentheticals
  // is not a shape pi emits today, but the failure mode was silent: a footer
  // format change would quietly restore the token-counter card this condensing
  // exists to replace.
  const agent = view();
  expect(oneLiner(agent, "1.0%/800k (auto) (x)   anthropic/claude-opus-5 • medium")).toBe(
    "claude-opus-5 · medium · 1.0%",
  );
});

test("the real footer shapes on this machine all condense", () => {
  // Captured from live panes across both model families, plus the two variants
  // the live set did not cover: a session before its first turn, and a footer
  // with no thinking level.
  const agent = view();
  const cases: [line: string, expected: string][] = [
    [
      "↑15M ↓533k R323M CH99.8% $247.838 19.1%/800k (auto)   anthropic/claude-opus-5 • medium",
      "claude-opus-5 · medium · 19.1%",
    ],
    [
      "↑344k ↓23k R4.6M CH99.1% $4.717 15.1%/850k (auto)   meta-openai/gpt-5.6-sol • medium",
      "gpt-5.6-sol · medium · 15.1%",
    ],
    // A session that has not taken a turn yet: no counters at all, so the line
    // BEGINS with the percentage.
    ["0.0%/850k (auto)   meta-openai/gpt-5.6-sol • medium", "gpt-5.6-sol · medium · 0.0%"],
    // No thinking level reported, so the effort segment is simply absent.
    ["0.0%/850k (auto)   meta-openai/gpt-5.6-sol", "gpt-5.6-sol · 0.0%"],
  ];
  for (const [line, expected] of cases) expect(oneLiner(agent, line), line).toBe(expected);
});
