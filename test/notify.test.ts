import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { notifyFields, parsePayload, runNotify } from "../src/cli/notify.js";
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

test("a notifier cannot say anything except blocked, and cannot name a process", () => {
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
