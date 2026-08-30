import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { notifyFields, parsePayload, runNotify } from "../src/cli/notify.js";
import { ensureIdentity } from "../src/identity.js";
import type { WindowId } from "../src/ids.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { status } from "../src/status.js";
import { openStore, type Store } from "../src/store.js";
import type { AgentState } from "../src/types.js";
import { fakeMux } from "./helpers/fake-mux.js";

let store: Store;
let hostId: string;

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-notify-"));
  hostId = ensureIdentity().host_id;
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

test("a codex notification records blocked for the pane the hook ran in", () => {
  // The live consumer, verbatim. The shipped codex hook line is
  //   notify = [..., 'agent-attention notify --source codex --event-type notify
  //             --title Codex']
  // so these are the exact three flags that must work, and the pane comes from
  // $TMUX_PANE because the hook runs as a child of the agent process.
  const ok = runNotify(
    store,
    { source: "codex", eventType: "notify", title: "Codex" },
    {},
    inPane(),
  );

  expect(ok).toBe(true);
  const event = store.allEvents().at(-1);
  expect(event).toMatchObject({
    // host:pane, the same identity the pi extension builds. A bare pane id would
    // be a second agent for the same pane.
    agent_id: `${hostId}:%1`,
    pane: "%1",
    window: "@1",
    state: "blocked",
    cli: "codex",
    driver: "human",
    reason: "notify",
  });
  // Falls back to the title when no message is given, rather than a placeholder.
  expect(event?.message).toBe("Codex");
});

test("the row carries no pid, which is what makes the ownership exception safe", () => {
  // 3281cff established that only a pane's owner may report for it, because six
  // pids had each written `working` to one row and the row then folded off a
  // dead child's pid. notify is a deliberate exception, and this is the property
  // that keeps it from reopening that hole.
  //
  // The distinction: a nested pi CLAIMS TO BE the agent, writing `working` with
  // its own pid. A notifier SPEAKS ABOUT the agent and writes `blocked` with no
  // pid at all. `pid` is the crash-detection probe -- fold turns `working` into
  // `crashed` when the recorded pid is gone -- so a row with no pid makes no
  // claim about any process's liveness and there is nothing for a dying
  // notifier to corrupt.
  runNotify(store, { source: "codex" }, {}, inPane());

  const event = store.allEvents().at(-1);
  expect(event?.pid).toBeNull();
  expect(event?.state).toBe("blocked");
});

test("notify can only ever say blocked", () => {
  // The exception is narrow in WHAT it may assert, not just in who may assert
  // it. An external process cannot know that an agent started, finished or
  // crashed, so those states stay the owner's alone -- there is no flag that
  // reaches `state`, by construction.
  //
  // Asserted against the shape of the input type rather than by trying to pass
  // a state: a caller cannot express one, which is the point.
  for (const attempt of [
    { source: "codex" },
    { source: "codex", message: "working" },
    { source: "codex", eventType: "crashed" },
  ]) {
    const before = store.allEvents().length;
    runNotify(store, attempt, { state: "working", pid: 4242 }, inPane());
    const event = store.allEvents().at(-1);
    expect(store.allEvents().length).toBe(before + 1);
    // Even a payload that names a state and a pid cannot set either.
    expect(event?.state).toBe("blocked");
    expect(event?.pid).toBeNull();
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
  expect(store.allEvents()).toHaveLength(0);
});

test("the window badge is set, so the status bar does not wait for a collect", () => {
  const badges: [WindowId, AgentState | null][] = [];
  const mux = fakeMux({
    currentWindow: () => ({
      session: asSessionId("$0"),
      window: asWindowId("@1"),
      pane: asPaneId("%1"),
      session_name: "dev",
      window_name: "codex",
    }),
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
  expect(store.allEvents().at(-1)).toMatchObject({
    agent_id: `${hostId}:%2`,
    pane: "%2",
    // Session and window are exactly what two panes in one window share.
    window: "@1",
  });

  // A pane in another window is refused rather than guessed: recording a
  // location this process cannot verify writes a row nothing can ever clear.
  const before = store.allEvents().length;
  const ok = runNotify(store, { source: "codex", pane: "%99" }, {}, inPane(["%1", "%2"]));
  expect(ok).toBe(false);
  expect(store.allEvents()).toHaveLength(before);
});

test("a notify row supersedes the pane's own agent instead of forking it", () => {
  // The integration property, and the reason agent_id must be host:pane rather
  // than a bare pane id. A pi agent is already reporting for this pane; the
  // notification is about THAT agent, not a second one.
  //
  // Verified end to end against the real binary before being written down: two
  // events, one agent, and `murmur status` reports `blocked 1` rather than
  // counting two agents in the same pane.
  store.append({
    agent_id: `${hostId}:%1`,
    session: asSessionId("$0"),
    window: asWindowId("@1"),
    pane: asPaneId("%1"),
    cli: "pi",
    driver: "human",
    kind: "state",
    state: "working",
    message: "",
    pid: process.pid,
    synthetic: false,
    reason: "",
    extra: {},
    workstream: null,
    role: null,
  });

  runNotify(store, { source: "codex", title: "Codex" }, {}, inPane());

  const events = store.allEvents();
  expect(events).toHaveLength(2);
  // One agent, not two: the fold takes the newest row it recognises, so the
  // notification is what the pane now says.
  expect(new Set(events.map((event) => event.agent_id)).size).toBe(1);
  expect(status(store).agents).toHaveLength(1);
  expect(status(store).agents[0]?.state).toBe("blocked");
});
