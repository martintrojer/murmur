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
  remoteSessionName,
} from "../src/agents.js";
import { ensureIdentity } from "../src/identity.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { tmux } from "../src/mux.js";
import { status } from "../src/status.js";
import { type NewEvent, openStore, type Store } from "../src/store.js";
import type { Event } from "../src/types.js";
import { fakeMux } from "./helpers/fake-mux.js";

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
  session: asSessionId("$0"),
  window: asWindowId("@9"),
  pane: asPaneId("%9"),
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

test("the real tmux reports a missing per-host wrapper as absent", () => {
  // The seam behind the reported bug: selecting a remote agent opened a NEW
  // tmux window every time. The extra terminal is legitimate — a remote attach
  // needs one that outlives the popup — but one per host is the whole
  // requirement, so the jump looks for an existing wrapper first.
  //
  // Against a real tmux, unlike the fakes above: sessionNamed does exact
  // matching over `list-sessions`, and a bare `has-session -t name` would have
  // matched by PREFIX, so a wrapper for `bub` would be found by a session
  // called `bubba`. The reuse itself ends in spawnSync and is verified by hand.
  expect(tmux.sessionNamed("murmur-test-no-such-session~")).toBe(false);
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
  const spy = fakeMux({
    setWindowBadge: (window, state) => void cleared.push(state === null ? window : state),
  });
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
  store.ingest([
    replica(),
    replica({ agent_id: "remote-host:%8", seq: 2, ts: 2, pane: asPaneId("%8") }),
  ]);
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

test("an existing per-host session is switched to, and no new one is opened", () => {
  store.upsertPeer({ name: "p", target: "p", host_id: "remote-host" });
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  let opened = 0;
  const switched: string[] = [];

  const result = jumpToAgent(
    store,
    remoteAgent(),
    fakeMux({
      sessionNamed: () => true,
      newSession: () => {
        opened += 1;
        return true;
      },
      switchClient: (_client, session) => {
        switched.push(session);
        return true;
      },
    }),
    () => ok("@9\n"),
  );

  expect(result).toEqual({ ok: true });
  expect(opened).toBe(0);
  expect(switched).toEqual(["p~"]);
});

test("with no existing session, exactly one is opened for the peer", () => {
  store.upsertPeer({ name: "p", target: "p", host_id: "remote-host" });
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  const opened: string[] = [];

  const result = jumpToAgent(
    store,
    remoteAgent(),
    fakeMux({
      newSession: (name, command) => {
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
  expect(opened[0]).toContain("p~ ::");
  expect(opened[0]).toContain("'$0:@9'");
});

test("the wrapper session hides the local status bar and disables the local prefix", () => {
  // The whole point of a session rather than a window. Without `prefix None`
  // the local tmux eats ^b and you need ^b b to reach the remote; without
  // `status off` two status bars stack and the jump does not read as full
  // screen. Both options are per-session, which is what makes this safe -- as a
  // window they would have been global and broken every local session.
  store.upsertPeer({ name: "p", target: "p", host_id: "remote-host" });
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  const options: string[] = [];

  jumpToAgent(
    store,
    remoteAgent(),
    fakeMux({
      setSessionOption: (session, option, value) => options.push(`${session} ${option}=${value}`),
    }),
    () => ok("@9\n"),
  );

  expect(options).toEqual(["p~ status=off", "p~ prefix=None", "p~ detach-on-destroy=previous"]);
});

test("the wrapper returns the originating client to where the jump started", () => {
  // The return is part of the wrapper's own command, so leaving the remote --
  // by any means -- lands you back where you were. It must name the client
  // explicitly: `murmur pick` runs in a popup, which is a client of its own
  // that dies with the picker, so a bare switch-client would move the wrong
  // one. The origin must also be read BEFORE the wrapper exists, or it would
  // record the wrapper as home and the return would be a no-op.
  store.upsertPeer({ name: "p", target: "p", host_id: "remote-host" });
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  let command = "";

  jumpToAgent(
    store,
    remoteAgent(),
    fakeMux({
      clientName: () => "/dev/ttys004",
      currentTarget: () => "work:@3",
      newSession: (_name, cmd) => {
        command = cmd;
        return true;
      },
    }),
    () => ok("@9\n"),
  );

  // Ordered: attach first, return only once it exits.
  //
  // The remote target is quoted TWICE, and both layers are load-bearing. This
  // string is a wrapper command, so a local shell strips the outer layer to
  // `'$0:@9'`, ssh joins its arguments and a remote shell strips the inner one
  // to `$0:@9`. With one layer the local shell expanded `$0` and the remote
  // attach failed with "can't find session"; verified by hand through `sh -c`.
  expect(command).toBe(
    `ssh -t 'p' tmux attach -t ''\\''$0:@9'\\'''; ` +
      `tmux switch-client -c '/dev/ttys004' -t '=work:@3'`,
  );
});

test("a wrapper name never starts with a tmux id sigil", () => {
  // The trap this design walked into: the old per-host WINDOW was named
  // `@<host>`, which is harmless for a window name but fatal for a session
  // name. `-t @bubba` parses as a window id, so every set-option and
  // switch-client against it failed with `can't find window` -- verified
  // against a real tmux while designing this.
  expect(remoteSessionName("bubba")).toBe("bubba~");
  expect(remoteSessionName("@bubba")).toBe("bubba~");
  expect(remoteSessionName("$0")).toBe("0~");
  expect(remoteSessionName("%1")).toBe("1~");
});

test("a failed new-session is reported, not swallowed as success", () => {
  store.upsertPeer({ name: "p", target: "p", host_id: "remote-host" });
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");

  const result = jumpToAgent(store, remoteAgent(), fakeMux({ newSession: () => false }), () =>
    ok("@9\n"),
  );

  expect(result).toMatchObject({ ok: false, reason: "attach_failed" });
});

test("a wrapper that opens but cannot be switched to is reported", () => {
  // Distinct from the above: the ssh IS running, so the message must not claim
  // nothing happened. Silently returning ok here would leave an invisible
  // session holding a live remote attach.
  store.upsertPeer({ name: "p", target: "p", host_id: "remote-host" });
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");

  const result = jumpToAgent(store, remoteAgent(), fakeMux({ switchClient: () => false }), () =>
    ok("@9\n"),
  );

  expect(result).toMatchObject({ ok: false, reason: "attach_failed" });
  if (!result.ok) expect(result.message).toContain("p~");
});

test("outside tmux, no local wrapper session is created", () => {
  // The case the wrapper must not touch. There is no local client to switch,
  // nothing to return to but the invoking shell, and no local status bar or
  // prefix to suppress -- a direct ssh is already full-screen and prefix-clean.
  // Creating a session here would attach a client to a server the user never
  // asked for, and leave them inside tmux on exit rather than at their prompt.
  store.upsertPeer({ name: "p", target: "p", host_id: "remote-host" });
  vi.stubEnv("TMUX", "");
  let sessions = 0;
  const attached: string[][] = [];

  const result = jumpToAgent(
    store,
    remoteAgent(),
    fakeMux({
      newSession: () => {
        sessions += 1;
        return true;
      },
    }),
    (_file, args) => {
      if (args.includes("attach")) {
        attached.push(args);
        return ok();
      }
      return ok("@9\n");
    },
  );

  expect(result).toEqual({ ok: true });
  expect(sessions).toBe(0);
  // Attached directly as argv, so there is no LOCAL shell to protect against
  // and only one layer of quoting -- unlike the wrapper command above. ssh
  // still joins argv and hands it to a remote shell, which is what this layer
  // is for.
  expect(attached).toEqual([["-t", "p", "tmux", "attach", "-t", "'$0:@9'"]]);
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
    fakeMux({ liveWindows: () => new Set([asWindowId("@9")]), attach: () => false }),
  );

  expect(result).toMatchObject({ ok: false, reason: "attach_failed" });
});

test("a local jump to a live window succeeds", () => {
  const identity = ensureIdentity();
  const agent = remoteAgent({ agent_id: `${identity.host_id}:%1`, host_id: identity.host_id });

  const result = jumpToAgent(
    store,
    agent,
    fakeMux({ liveWindows: () => new Set([asWindowId("@9")]), attach: () => true }),
  );

  expect(result).toEqual({ ok: true });
});
