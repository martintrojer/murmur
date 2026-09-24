import { expect, test } from "vitest";
import { isReportableTurn, runtimeFromContext, usageFromMessage } from "../src/extension/decide.js";

/**
 * Reading pi's live values, as a pure function.
 *
 * The handlers that call this need a running pi and are not testable in this
 * suite; the mapping is where every decision lives, so it is the part that is
 * tested. Shapes below are pi's own, verified against the installed typings:
 * `ctx.model` is `Model | undefined` with `id` and `provider` as separate
 * fields, `ctx.thinkingLevel` is a `ThinkingLevel`, and `ctx.getContextUsage()`
 * returns `{ tokens, contextWindow, percent }` where `percent` is explicitly
 * null right after a compaction.
 *
 * THE RULE: if pi does not offer a value, the field is absent. No inference, no
 * derivation from a sibling, and never a read of the pane -- the scraper is a
 * display-time fallback and must not author state that crosses the wire.
 */

test("runtimeFromContext reads every field pi offers", () => {
  expect(
    runtimeFromContext({
      model: { id: "claude-opus-5", provider: "anthropic" },
      thinkingLevel: "medium",
      getContextUsage: () => ({ tokens: 92_000, contextWindow: 800_000, percent: 11.7 }),
    }),
  ).toEqual({
    model: "claude-opus-5",
    provider: "anthropic",
    effort: "medium",
    context_pct: 11.7,
    context_tokens: 92_000,
    context_window: 800_000,
  });
});

test("a null context percent is reported, not skipped", () => {
  // pi returns `percent: null` right after a compaction, before the next
  // response. The card must lose the percentage rather than keep a stale one, so
  // the null is written rather than omitted.
  const runtime = runtimeFromContext({
    model: { id: "m", provider: "p" },
    thinkingLevel: "high",
    getContextUsage: () => ({ tokens: null, contextWindow: 800_000, percent: null }),
  });
  expect(runtime).toMatchObject({ context_pct: null, context_tokens: null });
  // The key is PRESENT, which is what makes `setRuntime` write the null rather
  // than leave the old value in place.
  expect("context_pct" in runtime).toBe(true);
});

test("an older pi missing the members yields nothing to write", () => {
  // Every member is optional because murmur declares pi's API rather than
  // importing it -- murmur must not depend on pi to build. A pi without these
  // must degrade to reporting nothing, not crash the extension.
  expect(runtimeFromContext({})).toEqual({});
});

test("a thinking level pi invented later is dropped, not passed through", () => {
  // `effort` is CHECK-constrained in the schema and `member()`-validated on the
  // wire, so an unrecognised value would fail the WHOLE document for every peer
  // that collects this node. Dropped at the source, where the blast radius is
  // one field.
  expect(runtimeFromContext({ thinkingLevel: "ludicrous" })).toEqual({});
  expect(runtimeFromContext({ thinkingLevel: "off" })).toEqual({ effort: "off" });
});

test("getContextUsage throwing costs only the context fields", () => {
  // It is a live read inside someone else's process. A model or effort that was
  // read successfully must still be reported.
  expect(
    runtimeFromContext({
      model: { id: "m", provider: "p" },
      thinkingLevel: "low",
      getContextUsage: () => {
        throw new Error("no session");
      },
    }),
  ).toEqual({ model: "m", provider: "p", effort: "low" });
});

test("usageFromMessage maps pi's Usage onto the wire bundle", () => {
  // pi's field names are camelCase and nest cost; murmur's are snake_case and
  // flat within the bundle. One mapping, in one place, so no handler has to know
  // both vocabularies.
  expect(
    usageFromMessage({
      usage: {
        input: 213_000,
        output: 55_000,
        cacheRead: 4_100_000,
        cacheWrite: 12_000,
        cacheWrite1h: 500,
        reasoning: 9_000,
        totalTokens: 4_380_000,
        cost: { input: 1.2, output: 2.4, cacheRead: 0.41, cacheWrite: 0.6, total: 4.61 },
      },
      providerThinkingLevel: "medium",
    }),
  ).toEqual({
    provider_effort: "medium",
    usage: {
      input: 213_000,
      output: 55_000,
      cache_read: 4_100_000,
      cache_write: 12_000,
      cache_write_1h: 500,
      reasoning: 9_000,
      total_tokens: 4_380_000,
      cost_input: 1.2,
      cost_output: 2.4,
      cost_cache_read: 0.41,
      cost_cache_write: 0.6,
      cost_total: 4.61,
    },
  });
});

test("the optional usage fields become null, not absent", () => {
  // `cacheWrite1h` is Anthropic-only and `reasoning` exists only where the model
  // exposes a breakdown. The wire requires both keys, so pi's `undefined`
  // becomes an explicit null -- "the provider said nothing", which is a
  // different claim from zero.
  const mapped = usageFromMessage({
    usage: {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  expect(mapped.usage).toMatchObject({ cache_write_1h: null, reasoning: null });
  // No provider effort reported, so the key is absent rather than null: nothing
  // was learned, so nothing should be overwritten.
  expect("provider_effort" in mapped).toBe(false);
});

test("a message with no usage yields nothing to write", () => {
  // Not every assistant message carries usage -- an aborted or errored turn may
  // not. Reporting a bundle of zeroes would claim a turn cost nothing.
  expect(usageFromMessage({})).toEqual({});
  expect(usageFromMessage({ usage: undefined })).toEqual({});
});

test("a handler invoked with no arguments at all reports nothing", () => {
  // Not hypothetical, and not a defensive flourish: murmur's own out-of-process
  // rig (test/helpers/pane-agent.mjs) calls `handlers.get("agent_start")?.()`
  // with no arguments, and an unguarded `ctx.model` read crashed the pi process
  // outright. This file DECLARES pi's API rather than importing it, so anything
  // holding a handler reference may call it however it likes -- and an extension
  // fault reaching the host is the single outcome the extension is arranged to
  // prevent.
  expect(runtimeFromContext(undefined)).toEqual({});
  expect(usageFromMessage(undefined)).toEqual({});
});

test("a provider-qualified model id is split, not stored whole", () => {
  // Verified against a live pi, not assumed: with a routing provider in play,
  // `ctx.model.id` is `anthropic/claude-opus-5` while `ctx.model.provider` is
  // `modelbridge` -- the router, not the vendor. So the id carries its own
  // vendor prefix and `provider` answers a different question.
  //
  // The card wants the leaf, which is what the scraped footer showed and what
  // the reader recognises. The vendor is kept rather than discarded: it is the
  // more useful of the two providers, and losing it would make
  // `anthropic/claude-opus-5` and some other vendor's `claude-opus-5`
  // indistinguishable.
  expect(
    runtimeFromContext({ model: { id: "anthropic/claude-opus-5", provider: "modelbridge" } }),
  ).toEqual({ model: "claude-opus-5", provider: "anthropic" });

  // An unqualified id keeps the provider pi reported, since there is no vendor
  // in the id to prefer.
  expect(runtimeFromContext({ model: { id: "gpt-5.6-sol", provider: "openai" } })).toEqual({
    model: "gpt-5.6-sol",
    provider: "openai",
  });

  // Only the LAST segment is the model; a multi-segment vendor path keeps its
  // full prefix as the provider.
  expect(
    runtimeFromContext({ model: { id: "meta-openai/x/gpt-5.6-sol", provider: "bridge" } }),
  ).toEqual({ model: "gpt-5.6-sol", provider: "meta-openai/x" });
});

test("only a completed assistant message is a reportable turn", () => {
  // pi fires message_end for every role, and its run-failure path synthesises an
  // aborted or errored assistant carrying an all-zero usage bundle.
  expect(isReportableTurn({ role: "assistant", stopReason: "stop" })).toBe(true);
  expect(isReportableTurn({ role: "assistant", stopReason: "toolUse" })).toBe(true);
  expect(isReportableTurn({ role: "assistant", stopReason: "aborted" })).toBe(false);
  expect(isReportableTurn({ role: "assistant", stopReason: "error" })).toBe(false);
  expect(isReportableTurn({ role: "user" })).toBe(false);
  expect(isReportableTurn({ role: "toolResult" })).toBe(false);
  expect(isReportableTurn(undefined)).toBe(false);
});
