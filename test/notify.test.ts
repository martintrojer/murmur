import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  notifyFields,
  notifyKind,
  parsePayload,
  payloadFromArgs,
  runNotify,
} from "../src/cli/notify.js";
import type { NodeIdentity } from "../src/identity.js";
import { createIdentity } from "../src/identity.js";
import type { WindowId } from "../src/ids.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { status } from "../src/status.js";
import { openStore, type Store } from "../src/store.js";
import type { RenderState } from "../src/view.js";
import { fakeMux } from "./helpers/fake-mux.js";

let store: Store;
let identity: NodeIdentity;

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-notify-"));
  identity = createIdentity("here");
  store = openStore();
});

afterEach(() => {
  store.close();
});

/** A tmux that reports the caller sitting in pane %1 of window @1. */
function inPane(panes: string[] = ["%1"]) {
  return fakeMux({
    currentWindow: () => ({
      session: asSessionId("$0"),
      window: asWindowId("@1"),
      pane: asPaneId("%1"),
      session_name: "dev",
      window_name: "codex",
    }),
    panesInWindow: () => panes.map((pane) => asPaneId(pane)),
  });
}

// @agent_state is a WINDOW option projecting the highest-priority state in that
// window, and RENDER_PRIORITY puts crashed above blocked above done. notify used
// to paint its own kind unconditionally, so a notification on one pane erased a
// crashed agent's glyph on another pane of the same window -- attention rows
// still correct, only the surface a human scans wrong. clear.ts paid for the
// same class of bug in the other direction.
test("a notification cannot downgrade a crashed glyph on a sibling pane", () => {
  const badges: [WindowId, RenderState | null][] = [];
  const mux = inPane(["%1", "%2"]);
  mux.setWindowBadge = (window: WindowId, state: RenderState | null) => {
    badges.push([window, state]);
  };

  // A crashed agent in %2, the same window the notifier is reporting from.
  store.recordCrash({
    session: asSessionId("$0"),
    window: asWindowId("@1"),
    pane: asPaneId("%2"),
    session_name: "dev",
    window_name: "codex",
  });

  const ok = runNotify(
    store,
    { source: "codex", eventType: "agent-turn-complete", title: "Codex" },
    {},
    mux,
  );

  expect(ok).toBe(true);
  // The pane's own `done` is recorded -- the request is not being discarded.
  expect(store.localPanes().find((pane) => pane.pane === "%1")?.attention).toMatchObject([
    { kind: "done" },
  ]);
  // ...but the WINDOW keeps the stronger word, because a human scanning the
  // status bar must see the crash first.
  expect(badges).toEqual([[asWindowId("@1"), "crashed"]]);
});

test("a notification with no recognised event records blocked for the caller's pane", () => {
  // Flags only, no payload: the shape every notifier that predates the payload
  // reader still uses. An unrecognised event stays `blocked`, which is the
  // answer that cannot lose information -- see `UNKNOWN_KIND`.
  const ok = runNotify(
    store,
    { source: "codex", eventType: "notify", title: "Codex" },
    {},
    inPane(),
  );

  expect(ok).toBe(true);
  const pane = store.localPanes()[0];
  // Addressed by PANE and nothing else, which is what makes it safe: there is
  // no field on the request for an agent id, a pid or an activity.
  expect(pane).toMatchObject({ pane: "%1", window: "@1", agent: null });
  expect(pane?.attention).toEqual([
    // Falls back to the title when no message is given, rather than a
    // placeholder. `source` carries the harness name; `driver` is not its to
    // set.
    { kind: "blocked", message: "Codex", source: "codex", requested_at: expect.any(Number) },
  ]);
});

test("a codex turn-complete records DONE, not blocked", () => {
  // The bug this table exists to fix, and it fired on every single codex turn.
  // `runNotify` hard-coded `blocked`, while codex's notify hook fires exactly
  // one event -- `agent-turn-complete`, meaning the turn ended and the agent is
  // waiting for you. That is the same fact pi's extension reports as `done`, so
  // one harness called a finished turn `done` and the other called it `blocked`:
  // a codex agent that had simply finished was indistinguishable from one
  // waiting on an answer, and after `blocked` began sorting oldest-first it sat
  // at the top of the picker.
  const ok = runNotify(
    store,
    // The documented hook line's flags, unchanged, so this pins the behaviour of
    // a config already in people's files.
    { source: "codex", eventType: "notify", title: "Codex" },
    { type: "agent-turn-complete", "last-assistant-message": "Rename complete." },
    inPane(),
  );

  expect(ok).toBe(true);
  expect(store.localPanes()[0]?.attention).toEqual([
    {
      kind: "done",
      // The assistant's own summary, not the `--title Codex` the hook line
      // passes: before argv was read, every codex row in the picker said the
      // word "Codex", which the `source` column already carries.
      message: "Rename complete.",
      source: "codex",
      requested_at: expect.any(Number),
    },
  ]);
});

test("the badge shows the kind actually recorded, not a fixed word", () => {
  // Two surfaces, one pane, one word. The badge was hard-coded `blocked`
  // alongside the store write, so fixing only the write would have put `done` in
  // the store and `blocked` on the status bar for the same pane.
  const badges: [WindowId, RenderState | null][] = [];
  const mux = fakeMux({
    currentWindow: () => ({
      session: asSessionId("$0"),
      window: asWindowId("@1"),
      pane: asPaneId("%1"),
      session_name: "dev",
      window_name: "codex",
    }),
    // Real tmux lists the pane the notifier is sitting in; the fake defaults to
    // an empty window, which is a state tmux cannot produce.
    panesInWindow: () => [asPaneId("%1")],
    setWindowBadge: (window, state) => void badges.push([window, state]),
  });

  runNotify(store, { source: "codex" }, { type: "agent-turn-complete" }, mux);

  expect(badges).toEqual([["@1", "done"]]);
});

test("an event type maps to a kind, and an unknown one fails safe to blocked", () => {
  // codex's single event, and opencode's name for the same fact.
  expect(notifyKind({}, { type: "agent-turn-complete" })).toBe("done");
  expect(notifyKind({}, { type: "session.idle" })).toBe("done");

  // `blocked` for anything unrecognised, because it is the answer that cannot
  // lose information: a harness told us something and we do not know what.
  // `done` would file it as handled and hide it from the default picker;
  // `blocked` puts a row in front of a human, and focusing the pane takes it
  // back.
  expect(notifyKind({}, { type: "mystery.event" })).toBe("blocked");
  expect(notifyKind({}, {})).toBe("blocked");
  expect(notifyKind({ source: "codex" })).toBe("blocked");

  // The flag can pin an event murmur does not know, for the same reason flags
  // beat the payload everywhere else on this path.
  expect(notifyKind({ eventType: "agent-turn-complete" }, {})).toBe("done");
  // And the payload is consulted when the flag names nothing recognised, so the
  // documented `--event-type notify` does not mask a real event beside it.
  expect(notifyKind({ eventType: "notify" }, { type: "agent-turn-complete" })).toBe("done");

  // Never `crashed`, whatever either half says: an external notifier cannot know
  // a process died, and only reconciliation holds the pid that could tell.
  for (const type of ["crashed", "crash", "agent-crashed"]) {
    expect(notifyKind({ eventType: type }, { type })).toBe("blocked");
  }
});

test("a Cursor stop payload maps completed to done, and anything else to blocked", () => {
  // Cursor's hooks write JSON on stdin with no `type` field. The outcome lives
  // in `status`; without this mapping every stop would fall through to the
  // unknown-event default and a finished turn would look blocked forever.
  expect(notifyKind({}, { hook_event_name: "stop", status: "completed" })).toBe("done");
  expect(notifyKind({}, { hook_event_name: "stop", status: "aborted" })).toBe("blocked");
  expect(notifyKind({}, { hook_event_name: "stop", status: "error" })).toBe("blocked");
  expect(notifyKind({}, { hook_event_name: "stop" })).toBe("blocked");

  // A known `type` still wins when both are present: flags/table first, Cursor
  // shape only on a miss.
  expect(
    notifyKind({}, { type: "agent-turn-complete", hook_event_name: "stop", status: "error" }),
  ).toBe("done");
});

test("a Cursor stop with no message text uses status as the row text", () => {
  expect(notifyFields({ source: "cursor" }, { hook_event_name: "stop", status: "error" })).toEqual({
    source: "cursor",
    message: "error",
  });
});

test("the payload is read from a trailing argv token, which is how codex sends it", () => {
  // The second half of the bug. Codex appends the event JSON as ONE MORE
  // ARGUMENT and sets stdin to null; murmur only read stdin, so for the
  // documented hook the payload was silently discarded -- every message was the
  // `--title`, and the `type` field that names the event never arrived.
  const payload = { type: "agent-turn-complete", "last-assistant-message": "Done." };
  expect(payloadFromArgs([JSON.stringify(payload)])).toEqual(payload);

  // SCANNED, not taken by position, because position cannot be relied on: a
  // wrapper may forward the payload before or after its own tokens.
  expect(payloadFromArgs(["codex-notify", JSON.stringify(payload)])).toEqual(payload);
  expect(payloadFromArgs([JSON.stringify(payload), "trailing"])).toEqual(payload);

  // Nothing that is not a JSON object, and no throw on a token that merely
  // starts like one -- this runs on every notification.
  expect(payloadFromArgs([])).toEqual({});
  expect(payloadFromArgs(["codex-notify", "--source", "codex"])).toEqual({});
  expect(payloadFromArgs(["{not json"])).toEqual({});
  expect(payloadFromArgs(["[1,2,3]"])).toEqual({});
  expect(payloadFromArgs(["{}"])).toEqual({});
});

test("a notifier cannot name a process, whatever its payload claims", () => {
  // Narrow by CONSTRUCTION rather than by care at the call site:
  // `AttentionRequest` has no state field, no pid field and no owner metadata
  // field, so a payload naming a state and a pid cannot reach either.
  for (const attempt of [
    { source: "codex" },
    { source: "codex", message: "working" },
    { source: "codex", eventType: "crashed" },
  ]) {
    runNotify(store, attempt, { state: "working", pid: 4242, activity: "running" }, inPane());
    const pane = store.localPanes()[0];
    // The kind is now chosen by event type, but the RANGE is still the two a
    // human can answer: a payload naming a state cannot promote itself past
    // them, and `crashed` is unreachable from here by construction.
    expect(pane?.attention.map((entry) => entry.kind)).toEqual(["blocked"]);
    expect(pane?.agent).toBeNull();
    // A closed key set, not a substring search for the pid: `requested_at` is a
    // wall clock, so any digit sequence appears in it eventually and a
    // `not.toContain` on the serialised row fails at random times of day.
    // Asserting the shape says the stronger thing anyway -- there is no field
    // for a pid, a state or an activity, so no value can land in one.
    expect(Object.keys(pane?.attention[0] ?? {}).sort()).toEqual([
      "kind",
      "message",
      "requested_at",
      "source",
    ]);
  }
});

test("the opencode plugin's stdin JSON form works, and flags beat the payload", () => {
  // opencode pipes a JSON object; codex passes flags. Both consumers are already
  // written against these exact names, including the mismatch where the payload
  // spells it `type` and the flag is `--event-type`.
  expect(
    notifyFields(
      {},
      { source: "opencode", type: "session.idle", title: "OpenCode", message: "Task completed" },
    ),
  ).toEqual({ source: "opencode", message: "Task completed" });

  // Flags win, so the codex hook line behaves identically whether or not
  // something also arrives on stdin. The legacy script's documented rule.
  expect(notifyFields({ source: "codex" }, { source: "opencode" }).source).toBe("codex");
});

test("message falls back through title then event type, never to a bare placeholder", () => {
  // A notification whose text is a placeholder is worse than one carrying
  // whatever the harness did manage to say.
  expect(notifyFields({ source: "codex", title: "Codex" }).message).toBe("Codex");
  expect(notifyFields({ source: "codex", eventType: "permission.asked" }).message).toBe(
    "permission.asked",
  );
  expect(notifyFields({ source: "codex" }).message).toBe("attention");
  // And an unnamed harness still gets a usable row.
  expect(notifyFields({}).source).toBe("agent");
});

test("control characters are stripped, because this text reaches a status line", () => {
  // The message arrives from another program's event payload and lands in a tmux
  // status line and a picker row. An embedded escape or newline corrupts both.
  const { message } = notifyFields({ message: "line one\nline\ttwo\u001b[31mred" });
  expect(message).not.toContain("\n");
  expect(message).not.toContain("\t");
  expect(message).not.toContain(String.fromCharCode(27));
  // The escape BYTE goes and its printable tail stays. Stripping the whole
  // sequence is the read side's job (terminalText); this only has to guarantee
  // no control byte reaches a status line.
  expect(message).toBe("line one line two [31mred");
});

test("a malformed or non-object payload is ignored rather than fatal", () => {
  // The flags may carry everything needed, so a notifier that pipes something
  // odd should still get its attention row.
  expect(parsePayload("")).toEqual({});
  expect(parsePayload("not json")).toEqual({});
  expect(parsePayload("[1,2,3]")).toEqual({});
  expect(parsePayload('"a string"')).toEqual({});
  expect(parsePayload('{"source":"opencode"}')).toEqual({ source: "opencode" });
});

test("outside tmux it records nothing and does not fail the caller", () => {
  // This runs from another program's notification hook. A harness used outside
  // tmux must not have its own exit code broken by murmur having nothing to
  // record, and there is no pane to attribute an event to anyway.
  const ok = runNotify(store, { source: "codex" }, {}, fakeMux({ currentWindow: () => null }));

  expect(ok).toBe(false);
  expect(store.localPanes()).toHaveLength(0);
});

test("the window badge is set, so the status bar does not wait for a collect", () => {
  const badges: [WindowId, RenderState | null][] = [];
  // No payload, so this stays the `blocked` path -- the kind-tracking case is
  // its own test above.
  const mux = fakeMux({
    currentWindow: () => ({
      session: asSessionId("$0"),
      window: asWindowId("@1"),
      pane: asPaneId("%1"),
      session_name: "dev",
      window_name: "codex",
    }),
    // The badge is RECOMPUTED from the window's panes, so the window must
    // contain the pane being reported for, as real tmux guarantees.
    panesInWindow: () => [asPaneId("%1")],
    setWindowBadge: (window, state) => void badges.push([window, state]),
  });

  runNotify(store, { source: "codex" }, {}, mux);

  expect(badges).toEqual([["@1", "blocked"]]);
});

test("--pane may name a sibling pane, and refuses a pane it cannot verify", () => {
  // Kept because the legacy interface had it, though neither live consumer
  // passes it -- checked against the codex hook line and the opencode plugin.
  // Deliberately implemented without adding a pane-to-session lookup to Mux: it
  // narrows the location currentWindow already resolved.
  runNotify(store, { source: "codex", pane: "%2" }, {}, inPane(["%1", "%2"]));
  expect(store.localPanes()[0]).toMatchObject({
    pane: "%2",
    // Session and window are exactly what two panes in one window share.
    window: "@1",
  });

  // A pane in another window is refused rather than guessed: recording a
  // location this process cannot verify writes a row nothing can ever clear.
  const before = store.localPanes().length;
  const ok = runNotify(store, { source: "codex", pane: "%99" }, {}, inPane(["%1", "%2"]));
  expect(ok).toBe(false);
  expect(store.localPanes()).toHaveLength(before);
});

test("a notification leaves the pane's live agent untouched and joins onto it", () => {
  // The integration property, and the reason attention is keyed on pane alone.
  // A pi agent is already reporting for this pane; the notification is about
  // THAT pane, and used to be recorded by superseding the agent's row -- which
  // is how a live `running` agent lost its name, workstream, role and driver.
  //
  // Now the two facts sit side by side: one pane, one agent row, one attention
  // row, and `status` counts one blocked pane rather than two agents.
  const claim = store.claimAgent({
    location: {
      session: asSessionId("$0"),
      window: asWindowId("@1"),
      pane: asPaneId("%1"),
      session_name: "dev",
      window_name: "codex",
    },
    owner_pid: process.pid,
    meta: {
      agent_name: "worker-1",
      pi_session: null,
      workstream: "murmur",
      role: null,
      cli: "pi",
      driver: "human",
    },
  });
  store.setActivity({
    agent_id: "agent_id" in claim ? claim.agent_id : "",
    owner_pid: process.pid,
    activity: "running",
    location: {
      session: asSessionId("$0"),
      window: asWindowId("@1"),
      pane: asPaneId("%1"),
      session_name: "dev",
      window_name: "codex",
    },
  });

  runNotify(store, { source: "codex", title: "Codex" }, {}, inPane());

  const panes = store.localPanes();
  expect(panes).toHaveLength(1);
  // The agent survives verbatim: still running, still named, still a pi agent.
  expect(panes[0]?.agent).toMatchObject({
    activity: "running",
    agent_name: "worker-1",
    workstream: "murmur",
    cli: "pi",
  });
  expect(panes[0]?.attention.map((entry) => entry.source)).toEqual(["codex"]);

  const view = status(store, identity);
  expect(view.panes).toHaveLength(1);
  expect(view.counts.blocked).toBe(1);
});
