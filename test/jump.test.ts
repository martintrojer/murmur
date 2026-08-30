import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  agentLabel,
  agentLocation,
  jumpToAgent,
  type Runner,
  remoteSessionName,
} from "../src/agents.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { tmux } from "../src/mux.js";
import { openStore, type Store } from "../src/store.js";
import type { PaneView } from "../src/view.js";
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

/**
 * One pane as every surface sees it. Remote by default, because that is the path
 * with the probe, the wrapper session and the classification rules.
 */
function view(over: Partial<PaneView> = {}): PaneView {
  return {
    host_id: "remote-host",
    host: "p",
    local: false,
    pane: asPaneId("%9"),
    session: asSessionId("$0"),
    window: asWindowId("@9"),
    session_name: null,
    window_name: null,
    activity: "running",
    attention: [],
    freshness: "fresh",
    agent_id: "agent-9",
    agent_name: null,
    pi_session: null,
    workstream: "api",
    role: null,
    cli: "pi",
    driver: "human",
    updated_at: 1,
    snapshot_at: null,
    fetched_at: null,
    ...over,
  };
}

function localView(over: Partial<PaneView> = {}): PaneView {
  return view({ host_id: "LOCAL", host: "here", local: true, ...over });
}

/**
 * A peer whose cached snapshot names `host_id`, which is how `jumpToAgent`
 * resolves a pane's host to an ssh target. Recorded through the snapshot rather
 * than set directly, because that is the only way a host_id can enter the cache:
 * it comes out of the document the peer served.
 */
function peer(name: string, hostId: string, panes: string[] = []): void {
  store.addPeer(name, name);
  store.replacePeerSnapshot(name, {
    ok: true,
    at: 1_000,
    snapshot: {
      murmur_snapshot: 1,
      host_id: hostId,
      display_name: name,
      murmur_version: "0.2.0",
      generated_at: 1,
      panes: panes.map((id) => ({
        pane: asPaneId(id),
        session: asSessionId("$0"),
        window: asWindowId("@9"),
        session_name: null,
        window_name: null,
        agent: null,
        attention: [{ kind: "done" as const, message: "", source: "pi", requested_at: 1 }],
      })),
    },
  });
}

function ok(stdout = ""): ReturnType<Runner> {
  return { status: 0, stdout, failed: false };
}

/**
 * A jump that failed must have written NOTHING: one keypress on a healthy agent
 * must not be able to remove it. Only the owning node may author facts about its
 * own panes, and a jump is a read.
 */
function snapshotOfEverything(): string {
  return JSON.stringify({ panes: store.localPanes(), peers: store.peers() });
}

test("agentLabel prefers a human name over any tmux id", () => {
  // The picker showed raw "$26:@79" for remote panes because names were resolved
  // against the LOCAL tmux and skipped for remote rows. Names now travel in the
  // snapshot, recorded by the node that owns the pane, so both read the same.
  const agent = view({
    window: asWindowId("@79"),
    session: asSessionId("$26"),
    session_name: "murmur",
    window_name: "nvim",
    agent_name: "reviewer-1",
    pi_session: "review the picker",
  });

  expect(agentLabel(agent)).toBe("reviewer-1");
  expect(agentLabel({ ...agent, agent_name: null })).toBe("review the picker");
  expect(agentLabel({ ...agent, agent_name: null, pi_session: null })).toBe("nvim");
  expect(agentLocation(agent)).toBe("murmur:nvim");
});

test("agentLabel falls back to the window id only when no name exists", () => {
  expect(
    agentLabel(
      view({
        window: asWindowId("@79"),
        session_name: null,
        window_name: null,
        agent_name: null,
        pi_session: null,
      }),
    ),
  ).toBe("@79");
});

test("the real tmux reports a missing per-host wrapper as absent", () => {
  // Against a real tmux, unlike the fakes below: sessionNamed does exact
  // matching over `list-sessions`, and a bare `has-session -t name` would have
  // matched by PREFIX, so a wrapper for `bub` would be found by a session called
  // `bubba`.
  expect(tmux.sessionNamed("murmur-test-no-such-session~")).toBe(false);
});

test("ssh's own failure is unreachable, and writes nothing", () => {
  peer("p", "remote-host");
  const before = snapshotOfEverything();

  const result = jumpToAgent(store, view(), fakeMux(), () => ({
    status: 255,
    stdout: "",
    failed: false,
  }));

  expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  // Proves nothing about the peer's panes -- they may be alive behind a cold
  // socket -- so nothing is touched, `last_error` included.
  expect(snapshotOfEverything()).toBe(before);
});

test("a spawn that never starts is also unreachable", () => {
  peer("p", "remote-host");

  const result = jumpToAgent(store, view(), fakeMux(), () => ({
    status: null,
    stdout: "",
    failed: true,
  }));

  expect(result).toMatchObject({ ok: false, reason: "unreachable" });
});

test("a dead remote tmux is reported, and still writes nothing", () => {
  // This used to delete every replicated row for the host, which was defensible
  // under the event model -- nothing else would ever supersede them. Under
  // snapshots it is both unnecessary and wrong: the peer's next document is
  // authoritative and will simply not contain those panes, and a reader that
  // evicts rows on a probe failure is authoring about a node it does not own.
  peer("p", "remote-host");
  const before = snapshotOfEverything();

  // Not 255: ssh worked, the remote tmux did not.
  const result = jumpToAgent(store, view(), fakeMux(), () => ({
    status: 1,
    stdout: "",
    failed: false,
  }));

  expect(result).toMatchObject({ ok: false, reason: "no_tmux" });
  expect(snapshotOfEverything()).toBe(before);
});

test("a pane the peer no longer lists is pane_gone, and writes nothing", () => {
  peer("p", "remote-host");
  const before = snapshotOfEverything();

  // Peer answers, but %9 is not among its panes.
  const result = jumpToAgent(store, view(), fakeMux(), () => ok("%1\n%2\n"));

  expect(result).toMatchObject({ ok: false, reason: "pane_gone" });
  expect(snapshotOfEverything()).toBe(before);
});

test("the remote probe asks tmux for PANES, not windows", () => {
  // The probe is the remote half of the same rule the local path gets from
  // `livePanes()`, and `list-windows -a -F '#{window_id}'` cannot express it:
  // no answer to a question about windows says whether a pane exists. So the
  // command on the wire is part of the fix, not an implementation detail.
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "");
  const probes: string[] = [];

  jumpToAgent(store, view(), fakeMux(), (_file, args) => {
    if (args.includes("attach")) return ok();
    probes.push(args.at(-1) ?? "");
    return ok("%9\n");
  });

  // Quoted as one string: ssh joins argv and hands it to a remote shell, which
  // would otherwise mangle the `#{...}` format and make tmux answer `-F expects
  // an argument` -- indistinguishable from an unreachable host.
  expect(probes).toEqual([`tmux list-panes -a -F '#{pane_id}'`]);
});

test("a remote agent whose pane MOVED window survives the jump", () => {
  // The regression, remote half. The peer no longer has @9 -- the pane moved --
  // but %9 is alive and jumpable. Probing windows deleted this replica and told
  // the user the agent was gone.
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "");
  const attached: string[][] = [];

  const result = jumpToAgent(store, view(), fakeMux(), (_file, args) => {
    if (args.includes("attach")) {
      attached.push(args);
      return ok();
    }
    // Every pane on the peer, and no window @9 to be found anywhere.
    return ok("%9\n%3\n");
  });

  expect(result).toEqual({ ok: true });
  expect(attached).toHaveLength(1);
});

test("no configured peer for the host is no_peer", () => {
  const result = jumpToAgent(store, view(), fakeMux(), () => ok("%9\n"));

  expect(result).toMatchObject({ ok: false, reason: "no_peer" });
});

test("an existing per-host session is switched to, and no new one is opened", () => {
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  let opened = 0;
  const switched: string[] = [];

  const result = jumpToAgent(
    store,
    view(),
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
    () => ok("%9\n"),
  );

  expect(result).toEqual({ ok: true });
  expect(opened).toBe(0);
  expect(switched).toEqual(["p~"]);
});

test("with no existing session, exactly one is opened for the peer", () => {
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  const opened: string[] = [];

  const result = jumpToAgent(
    store,
    view(),
    fakeMux({
      newSession: (name, command) => {
        opened.push(`${name} :: ${command}`);
        return true;
      },
    }),
    () => ok("%9\n"),
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
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  const options: string[] = [];

  jumpToAgent(
    store,
    view(),
    fakeMux({
      setSessionOption: (session, option, value) => options.push(`${session} ${option}=${value}`),
    }),
    () => ok("%9\n"),
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
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  let command = "";

  jumpToAgent(
    store,
    view(),
    fakeMux({
      clientName: () => "/dev/ttys004",
      currentTarget: () => "work:@3",
      newSession: (_name, cmd) => {
        command = cmd;
        return true;
      },
    }),
    () => ok("%9\n"),
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
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");

  const result = jumpToAgent(store, view(), fakeMux({ newSession: () => false }), () => ok("%9\n"));

  expect(result).toMatchObject({ ok: false, reason: "attach_failed" });
});

test("a wrapper that opens but cannot be switched to is reported", () => {
  // Distinct from the above: the ssh IS running, so the message must not claim
  // nothing happened. Silently returning ok here would leave an invisible
  // session holding a live remote attach.
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");

  const result = jumpToAgent(store, view(), fakeMux({ switchClient: () => false }), () =>
    ok("%9\n"),
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
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "");
  let sessions = 0;
  const attached: string[][] = [];

  const result = jumpToAgent(
    store,
    view(),
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
      return ok("%9\n");
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
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "");

  const result = jumpToAgent(store, view(), fakeMux(), (_file, args) =>
    // The probe succeeds; the attach that follows does not.
    args.includes("attach") ? { status: 1, stdout: "", failed: false } : ok("%9\n"),
  );

  expect(result).toMatchObject({ ok: false, reason: "attach_failed" });
});

test("a local jump reports a failed select-window instead of claiming success", () => {
  // A select-window that fails is the local twin of the remote symptom: the
  // picker closes, nothing moves, and nothing says why.
  const result = jumpToAgent(
    store,
    localView(),
    fakeMux({ livePanes: () => new Set([asPaneId("%9")]), attach: () => false }),
  );

  expect(result).toMatchObject({ ok: false, reason: "attach_failed" });
});

test("a local jump to a live pane succeeds", () => {
  const result = jumpToAgent(
    store,
    localView(),
    fakeMux({ livePanes: () => new Set([asPaneId("%9")]), attach: () => true }),
  );

  expect(result).toEqual({ ok: true });
});

test("a local pane that MOVED window is still jumped to, and nothing is written", () => {
  // The regression this rule exists for, and the reproduction that filed it:
  // `move-pane -s %0 -t @1` leaves %0 alive in its new window and removes @0
  // from list-windows entirely. Judging the pane by its recorded WINDOW
  // therefore condemned a healthy pane on one keypress, and the delete was
  // permanent for a local pane.
  store.claimAgent({
    location: {
      session: asSessionId("$0"),
      window: asWindowId("@9"),
      pane: asPaneId("%9"),
      session_name: null,
      window_name: null,
    },
    owner_pid: process.pid,
    meta: {
      agent_name: null,
      pi_session: null,
      workstream: "api",
      role: null,
      cli: "pi",
      driver: "human",
    },
  });
  const before = snapshotOfEverything();
  const attempted: string[] = [];

  const result = jumpToAgent(
    store,
    localView(),
    fakeMux({
      // The pane's recorded window is gone; the pane itself is not. Panes are
      // the only liveness question tmux is asked, which is the structural half
      // of this fix.
      livePanes: () => new Set([asPaneId("%9")]),
      attach: (session, window) => {
        attempted.push(`${session}:${window}`);
        return true;
      },
    }),
  );

  // Attempted, not skipped: the jump is the whole point of not deleting.
  expect(result).toEqual({ ok: true });
  expect(attempted).toEqual(["$0:@9"]);
  expect(snapshotOfEverything()).toBe(before);
});

test("a local pane that is really gone is pane_gone, and still writes nothing", () => {
  // Reported, not cleared. Reconciliation removes the row -- it is the one path
  // that consults tmux and the pid table together, inside one transaction -- and
  // a jump has no business doing half of that job from a keypress.
  store.requestAttention({
    kind: "done",
    location: {
      session: asSessionId("$0"),
      window: asWindowId("@9"),
      pane: asPaneId("%9"),
      session_name: null,
      window_name: null,
    },
    message: "",
    source: "pi",
  });
  const before = snapshotOfEverything();

  const result = jumpToAgent(
    store,
    localView(),
    // tmux answered, and %9 is not among the panes.
    fakeMux({ livePanes: () => new Set([asPaneId("%1")]) }),
  );

  expect(result).toMatchObject({ ok: false, reason: "pane_gone" });
  if (!result.ok) expect(result.message).toContain("its pane no longer exists");
  expect(snapshotOfEverything()).toBe(before);
});

test("a local jump proceeds when tmux cannot answer at all", () => {
  // null is "could not tell", not "no panes". Conflating them deleted every
  // agent on the host the moment tmux was briefly unreachable.
  const result = jumpToAgent(store, localView(), fakeMux({ livePanes: () => null }));

  expect(result).toEqual({ ok: true });
});
