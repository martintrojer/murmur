import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  type Agent,
  agentLabel,
  agentLocation,
  forgetHostReplica,
  forgetOneAgent,
  forgetReplica,
  jumpToAgent,
  type Runner,
} from "../src/agents.js";
import { ensureIdentity } from "../src/identity.js";
import { type Mux, tmux } from "../src/mux.js";
import { status } from "../src/status.js";
import { type NewEvent, openStore, type Store } from "../src/store.js";
import type { Event } from "../src/types.js";

let store: Store;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "murmur-jump-"));
  vi.stubEnv("MURMUR_STATE_DIR", dir);
  store = openStore();
});

afterEach(() => {
  store.close();
  vi.unstubAllEnvs();
});

const base: NewEvent = {
  agent_id: "remote-host:%9",
  session: "$0",
  window: "@9",
  pane: "%9",
  workstream: "api",
  role: null,
  cli: "pi",
  driver: "human",
  kind: "state",
  state: "blocked",
  message: "",
  pid: null,
  synthetic: false,
  reason: "",
  extra: {},
};

test("forgetAgent removes a remote agent instead of forking it in two", () => {
  // A local `cleared` event about a REMOTE agent does not clear it: status()
  // folds local and remote events separately (local needs a pid check, remote
  // cannot have one), so the local row lands in the other fold and the agent
  // appears TWICE with the same agent_id -- once blocked, once cleared. Seen
  // live against bubba. Deleting the replica rows is the only correct move for
  // a node that is not the agent's author.
  store.ingest([
    {
      ...base,
      host_id: "remote-host",
      seq: 1,
      ts: 1,
      session_name: null,
      window_name: null,
      agent_name: null,
      pi_session: null,
    },
  ]);
  expect(status(store).agents).toHaveLength(1);

  store.forgetAgent("remote-host:%9");
  expect(status(store).agents).toHaveLength(0);
});

test("agentLabel prefers a human name over any tmux id", () => {
  // The picker showed raw "$26:@79" for remote agents because names were
  // resolved against the LOCAL tmux and skipped for remote rows. Names now
  // travel on the event, so both cases read the same.
  const agent = {
    window: "@79",
    session: "$26",
    session_name: "murmur",
    window_name: "nvim",
    agent_name: "reviewer-1",
    pi_session: "audit the fold",
  } as never;
  expect(agentLabel(agent)).toBe("reviewer-1");
  expect(agentLabel({ ...(agent as object), agent_name: null } as never)).toBe("audit the fold");
  expect(agentLabel({ ...(agent as object), agent_name: null, pi_session: null } as never)).toBe(
    "nvim",
  );
  expect(agentLocation(agent)).toBe("murmur:nvim");
});

test("agentLabel falls back to the window id only when no name exists", () => {
  const agent = {
    window: "@79",
    session: "$26",
    session_name: null,
    window_name: null,
    agent_name: null,
    pi_session: null,
  } as never;
  expect(agentLabel(agent)).toBe("@79");
});

test("forgetting a replica rewinds the peer watermark", () => {
  // Deleting rows below the watermark deletes them for good: ingest only asks
  // for events after it, so bubba's agents vanished from the picker and no
  // amount of collecting brought them back, with the node alive and the events
  // still in its log. The comment claimed the next collect would restore them;
  // it could not. Rewinding is what makes the delete recoverable, and it is
  // what lets a host coming back up win the race against a stale jump.
  const store = openStore();
  store.upsertPeer({ name: "p", target: "p", host_id: "H", watermark: 7 });
  store.ingest([
    {
      ...base,
      agent_id: "H:%1",
      host_id: "H",
      seq: 1,
      ts: Date.now(),
      session_name: null,
      window_name: null,
      agent_name: null,
      pi_session: null,
    },
  ]);
  expect(store.allEvents()).toHaveLength(1);

  forgetReplica(store, "H:%1", "H");

  expect(store.allEvents()).toHaveLength(0);
  expect(store.peers()[0]?.watermark).toBe(0);
});

test("a no-tmux jump forgets every agent on that host", () => {
  // The complaint that prompted this: selecting a bubba agent said "no tmux
  // server", and the next picker still listed all four bubba agents. Marking
  // the peer was not enough — a host with no tmux server has no agents, so the
  // rows have to go, not just get a label. Scoped to the node rather than the
  // one window, because that is what the probe actually proved.
  const store = openStore();
  store.upsertPeer({ name: "p", target: "p", host_id: "H", watermark: 9 });
  const remote = (seq: number, agentId: string) => ({
    ...base,
    agent_id: agentId,
    host_id: "H",
    seq,
    ts: Date.now(),
    session_name: null,
    window_name: null,
    agent_name: null,
    pi_session: null,
  });
  store.ingest([remote(1, "H:%1"), remote(2, "H:%2")]);
  // A different host must be untouched: one dead node is not evidence about any
  // other.
  store.ingest([{ ...remote(1, "K:%1"), host_id: "K" }]);
  expect(store.allEvents()).toHaveLength(3);

  forgetHostReplica(store, "H");

  expect(store.allEvents().map((event) => event.host_id)).toEqual(["K"]);
  const peer = store.peers()[0];
  // Watermark held, not rewound: see the ssh-vs-tmux test below for why.
  expect(peer?.watermark).toBe(9);
  expect(peer?.tmux_down_at).not.toBeNull();
});

test("windowNamed finds an existing per-host window", () => {
  // The seam behind the reported bug: selecting a remote agent opened a NEW
  // tmux window every time. The window itself is legitimate — a remote attach
  // needs a terminal that outlives the popup — but one per host is the whole
  // requirement, so the jump looks for an existing @<host> window first.
  // Exercised here against a real tmux via the mux seam; the reuse itself is
  // verified by hand, since it ends in spawnSync.
  expect(tmux.windowNamed("murmur-test-no-such-window")).toBeNull();
});

test("an ssh failure keeps the agents, a dead tmux server removes them", () => {
  // "unreachable" used to cover both, and it was wrong in the common case: with
  // a warm ControlMaster socket the host answers instantly and it is tmux that
  // is gone, so the message sent you looking at the network for a problem that
  // was not there. ssh reports its own failures as 255; anything else is the
  // remote command's exit code.
  //
  // The consequence matters more than the wording. A dead tmux server is proof
  // the agents are gone, so they go. An ssh we could not complete proves
  // nothing about them — they may be alive behind a cold socket or a sleeping
  // laptop — so deleting them there would be guessing.
  const store = openStore();
  store.upsertPeer({ name: "p", target: "p", host_id: "H", watermark: 4 });
  store.ingest([
    {
      ...base,
      agent_id: "H:%1",
      host_id: "H",
      seq: 1,
      ts: Date.now(),
      session_name: null,
      window_name: null,
      agent_name: null,
      pi_session: null,
    },
  ]);

  forgetHostReplica(store, "H");

  expect(store.allEvents()).toHaveLength(0);
  // Watermark NOT rewound, unlike the single-agent case: rewinding re-ingests
  // the rows just deleted, and the collector reads any ingest as recovery, so
  // the dead agents reappeared looking healthy one second later.
  expect(store.peers()[0]?.watermark).toBe(4);
  expect(store.peers()[0]?.tmux_down_at).not.toBeNull();
});

test("forgetting a local agent clears its tmux badge as well as the row", () => {
  // The manual escape hatch for a stuck row. Deleting only the row would leave
  // @agent_state set, which the status bar and the tms session picker both read
  // — so the glyph would outlive the row it came from, and nothing would ever
  // clear it.
  const store = openStore();
  const identity = ensureIdentity();
  const cleared: (string | null)[] = [];
  const spy: Mux = {
    currentWindow: () => null,
    liveWindows: () => new Set<string>(),
    setState: (window, state) => cleared.push(state === null ? window : state),
    attach: () => true,
    capture: () => null,
    windowNames: () => new Map(),
    windowForPane: () => null,
    panesInWindow: () => [],
    windowNamed: () => null,
    selectWindow: () => true,
    newWindow: () => true,
  };
  const agent = {
    agent_id: `${identity.host_id}:%1`,
    host_id: identity.host_id,
    window: "@7",
  } as unknown as Agent;

  forgetOneAgent(store, agent, spy);

  expect(cleared).toEqual(["@7"]);
});

// --- jumpToAgent decision table -------------------------------------------
//
// These were the gap a test review found: every jump test exercised a helper
// (forgetHostReplica, tmux.windowNamed) but none called jumpToAgent, so
// replacing its whole body with `return { ok: true }` kept the file green. The
// probe classification, the window check, window reuse and the attach paths had
// no coverage at all.

function fakeMux(over: Partial<Mux> = {}): Mux {
  return {
    currentWindow: () => null,
    liveWindows: () => new Set<string>(),
    setState: () => {},
    attach: () => true,
    capture: () => null,
    windowNames: () => new Map(),
    windowForPane: () => null,
    panesInWindow: () => [],
    windowNamed: () => null,
    selectWindow: () => true,
    newWindow: () => true,
    ...over,
  };
}

// `base` is a NewEvent; ingest wants a full Event, so fill the replica fields
// the authoring node would have sent.
function replica(over: Partial<Event> = {}): Event {
  return {
    ...base,
    host_id: "remote-host",
    seq: 1,
    ts: 1,
    session_name: null,
    window_name: null,
    agent_name: null,
    pi_session: null,
    ...over,
  } as Event;
}

function ok(stdout = ""): ReturnType<Runner> {
  return { status: 0, stdout, failed: false };
}

function remoteAgent(over: Partial<Agent> = {}): Agent {
  return {
    agent_id: "remote-host:%9",
    host_id: "remote-host",
    session: "$0",
    window: "@9",
    pane: "%9",
    ...over,
  } as unknown as Agent;
}

test("ssh's own failure is unreachable, and keeps the agents", () => {
  store.ingest([replica()]);
  store.upsertPeer({ name: "p", target: "p", host_id: "remote-host" });

  const result = jumpToAgent(store, remoteAgent(), fakeMux(), () => ({
    status: 255,
    stdout: "",
    failed: false,
  }));

  expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  // Proves nothing about the agents, so they stay.
  expect(store.allEvents()).toHaveLength(1);
});

test("a spawn that never starts is also unreachable", () => {
  store.upsertPeer({ name: "p", target: "p", host_id: "remote-host" });

  const result = jumpToAgent(store, remoteAgent(), fakeMux(), () => ({
    status: null,
    stdout: "",
    failed: true,
  }));

  expect(result).toMatchObject({ ok: false, reason: "unreachable" });
});

test("a dead remote tmux is no_tmux, and removes that host's agents", () => {
  store.ingest([replica()]);
  store.upsertPeer({ name: "p", target: "p", host_id: "remote-host" });

  // Not 255: ssh worked, the remote tmux did not.
  const result = jumpToAgent(store, remoteAgent(), fakeMux(), () => ({
    status: 1,
    stdout: "",
    failed: false,
  }));

  expect(result).toMatchObject({ ok: false, reason: "no_tmux" });
  expect(store.allEvents()).toHaveLength(0);
});

test("a window the peer no longer lists is window_gone, and drops one replica", () => {
  store.ingest([replica(), replica({ agent_id: "remote-host:%8", seq: 2, ts: 2, pane: "%8" })]);
  store.upsertPeer({ name: "p", target: "p", host_id: "remote-host" });

  // Peer answers, but @9 is not among its windows.
  const result = jumpToAgent(store, remoteAgent(), fakeMux(), () => ok("@1\n@2\n"));

  expect(result).toMatchObject({ ok: false, reason: "window_gone" });
  // Only the jumped-to agent goes; its sibling on the same host stays.
  expect(store.allEvents().map((event) => event.agent_id)).toEqual(["remote-host:%8"]);
});

test("no configured peer for the host is no_peer", () => {
  const result = jumpToAgent(store, remoteAgent(), fakeMux(), () => ok("@9\n"));

  expect(result).toMatchObject({ ok: false, reason: "no_peer" });
});

test("an existing per-host window is selected, and no new one is opened", () => {
  store.upsertPeer({ name: "p", target: "p", host_id: "remote-host" });
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  let opened = 0;

  const result = jumpToAgent(
    store,
    remoteAgent(),
    fakeMux({
      windowNamed: () => "@42",
      newWindow: () => {
        opened += 1;
        return true;
      },
    }),
    () => ok("@9\n"),
  );

  expect(result).toEqual({ ok: true });
  expect(opened).toBe(0);
});

test("with no existing window, exactly one is opened for the peer", () => {
  store.upsertPeer({ name: "p", target: "p", host_id: "remote-host" });
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  const opened: string[] = [];

  const result = jumpToAgent(
    store,
    remoteAgent(),
    fakeMux({
      newWindow: (name, command) => {
        opened.push(`${name} :: ${command}`);
        return true;
      },
    }),
    () => ok("@9\n"),
  );

  expect(result).toEqual({ ok: true });
  expect(opened).toHaveLength(1);
  // Named after the configured peer, and the remote session:window is quoted
  // against the LOCAL shell -- `$0:@9` would otherwise expand to `:@9`.
  expect(opened[0]).toContain("@p ::");
  expect(opened[0]).toContain("'$0:@9'");
});

test("a failed new-window is reported, not swallowed as success", () => {
  store.upsertPeer({ name: "p", target: "p", host_id: "remote-host" });
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");

  const result = jumpToAgent(store, remoteAgent(), fakeMux({ newWindow: () => false }), () =>
    ok("@9\n"),
  );

  expect(result).toMatchObject({ ok: false, reason: "attach_failed" });
});

test("outside tmux, a failed ssh attach is reported", () => {
  store.upsertPeer({ name: "p", target: "p", host_id: "remote-host" });
  vi.stubEnv("TMUX", "");

  const result = jumpToAgent(store, remoteAgent(), fakeMux(), (_file, args) =>
    // The probe succeeds; the attach that follows does not.
    args.includes("attach") ? { status: 1, stdout: "", failed: false } : ok("@9\n"),
  );

  expect(result).toMatchObject({ ok: false, reason: "attach_failed" });
});

test("a local jump reports a failed select-window instead of claiming success", () => {
  const identity = ensureIdentity();
  const agent = remoteAgent({ agent_id: `${identity.host_id}:%1`, host_id: identity.host_id });

  // The window must be live, or this hits window_gone first.
  const result = jumpToAgent(
    store,
    agent,
    fakeMux({ liveWindows: () => new Set(["@9"]), attach: () => false }),
  );

  expect(result).toMatchObject({ ok: false, reason: "attach_failed" });
});

test("a local jump to a live window succeeds", () => {
  const identity = ensureIdentity();
  const agent = remoteAgent({ agent_id: `${identity.host_id}:%1`, host_id: identity.host_id });

  const result = jumpToAgent(
    store,
    agent,
    fakeMux({ liveWindows: () => new Set(["@9"]), attach: () => true }),
  );

  expect(result).toEqual({ ok: true });
});
