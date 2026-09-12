import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { isVisible, runPick } from "../src/cli/pick.js";
import { createIdentity, loadIdentity } from "../src/identity.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import type { Mux } from "../src/mux.js";
import { openStore, type Store } from "../src/store.js";
import type { AgentMeta, Driver, Location } from "../src/types.js";
import type { PaneView } from "../src/view.js";

let store: Store;

beforeEach(() => {
  vi.stubEnv("MURMUR_STATE_DIR", mkdtempSync(join(tmpdir(), "murmur-pick-jump-")));
  createIdentity("here");
  store = openStore();
});

afterEach(() => {
  store.close();
  vi.unstubAllEnvs();
  process.exitCode = 0;
});

/** This node's host_id, which is half of every row key fzf hands back. */
function here(): string {
  return loadIdentity()?.host_id ?? "";
}

function location(pane: string): Location {
  return {
    session: asSessionId("$0"),
    window: asWindowId("@1"),
    pane: asPaneId(pane),
    session_name: "dev",
    window_name: pane,
  };
}

function meta(driver: Driver, agentName: string | null = null): AgentMeta {
  return {
    agent_name: agentName,
    pi_session: null,
    workstream: "murmur",
    role: null,
    cli: "pi",
    driver,
  };
}

/** A local pane with a running agent. */
function agent(pane: string, driver: Driver = "human", agentName: string | null = null): void {
  const claim = store.claimAgent({
    location: location(pane),
    owner_pid: process.pid,
    meta: meta(driver, agentName),
  });
  store.setActivity({
    agent_id: "agent_id" in claim ? claim.agent_id : "",
    owner_pid: process.pid,
    activity: "running",
    location: location(pane),
  });
}

function remotePane(pane: string) {
  return {
    pane: asPaneId(pane),
    session: asSessionId("$9"),
    window: asWindowId("@9"),
    session_name: "far",
    window_name: "remote",
    agent: {
      agent_id: "remote-agent",
      activity: "running" as const,
      agent_name: "remote-worker",
      pi_session: null,
      workstream: null,
      role: null,
      cli: "pi",
      driver: "human" as const,
      claimed_at: 1,
      updated_at: 1,
    },
    attention: [],
  };
}

/**
 * A picker whose fzf returns `selected`, recording what it was asked to jump to.
 *
 * No mux injection, and none is needed: `runPick` reads the cache and never
 * collects, so nothing reconciles these fixtures against the real tmux server
 * of whoever runs the suite. That coupling is what the injected mux existed to
 * break -- the fixtures were being deleted between the claim and the read, so
 * the suite passed with no tmux server and failed inside tmux.
 */
async function pickReturning(selected: string): Promise<{ jumped: string[]; rows: string[] }> {
  const jumped: string[] = [];
  const rows: string[] = [];
  await runPick(
    store,
    {},
    {
      fzf: (_args, input) => {
        rows.push(...input.split("\n"));
        return selected;
      },
      jump: (_store, pane: PaneView) => {
        jumped.push(pane.pane);
        return { ok: true };
      },
      collect: () => {},
    },
  );
  return { jumped, rows };
}

test("the picker binds only jump and the crew toggle", async () => {
  // The dash owns the glance now, so the picker is a jump list and nothing else.
  // Every binding below was deleted rather than moved: a preview window that
  // sshs per keypress, a refresh, a preview-layout cycle, an attach-again
  // expect key, and four state filters plus ctrl aliases. They are asserted
  // absent because a dead --bind string is invisible until someone presses it.
  agent("%1");
  let captured: string[] = [];
  await runPick(
    store,
    {},
    {
      fzf: (args) => {
        captured = args;
        return "";
      },
      jump: () => ({ ok: true }),
      collect: () => {},
    },
  );

  const joined = captured.join(" ");
  for (const gone of [
    "--preview",
    "--preview-window",
    "--expect",
    "ctrl-r",
    "ctrl-p",
    "alt-enter",
    "alt-b",
    "alt-w",
    "alt-d",
    "alt-x",
    "ctrl-w",
    "ctrl-d",
    "ctrl-x",
  ]) {
    expect(joined, gone).not.toContain(gone);
  }
  // The crew toggle survives: it is the one key that changes WHICH agents the
  // list holds, which no amount of typing can do.
  expect(joined).toContain("alt-a");

  // And the key legend is gone from the header, leaving the notice and the
  // column labels -- the action and the grid, no furniture.
  const header = captured[captured.indexOf("--header") + 1] ?? "";
  expect(header).not.toContain("refresh");
  expect(header).not.toContain("filter:");
  expect(header).not.toContain("enter focus");
});

test("enter focuses an attached local pane instead of opening another remote session", async () => {
  agent("%1", "human", "worker-1");
  store.addPeer("dev", "dev.example", "x2ssh -et dev -c 'tmux attach -t {pane}'");
  store.replacePeerSnapshot("dev", {
    ok: true,
    at: Date.now(),
    snapshot: {
      murmur_snapshot: 1,
      host_id: "REMOTE",
      display_name: "dev",
      murmur_version: "0.2.0",
      generated_at: 1,
      panes: [
        {
          pane: asPaneId("%9"),
          session: asSessionId("$9"),
          window: asWindowId("@9"),
          session_name: "far",
          window_name: "remote",
          agent: {
            agent_id: "remote-agent",
            activity: "running",
            agent_name: "worker-1",
            pi_session: null,
            workstream: "murmur",
            role: null,
            cli: "pi",
            driver: "human",
            claimed_at: 1,
            updated_at: 1,
          },
          attention: [],
        },
      ],
    },
  });

  const attached = asPaneId("%12");
  const mux = {
    localPaneProcesses: () => [
      {
        pane: attached,
        current_command: "x2ssh",
        arguments: "MU_AGENT_NAME=worker-1 MU_WORKSTREAM=murmur x2ssh -et dev",
      },
    ],
    attach: vi.fn(() => true),
  } as unknown as Mux;
  let jumped = false;

  await runPick(
    store,
    {},
    {
      fzf: () => "REMOTE\t%9\tlabel",
      jump: () => {
        jumped = true;
        return { ok: true };
      },
      collect: () => {},
      mux,
    },
  );

  expect(mux.attach).toHaveBeenCalledWith(attached);
  expect(jumped).toBe(false);

  expect(mux.attach).toHaveBeenCalledTimes(1);
  expect(jumped).toBe(false);
});

test("a cold remote jump warns and still proceeds when confirmed", async () => {
  agent("%1");
  store.addPeer("dev", "dev.example");
  store.replacePeerSnapshot("dev", {
    ok: true,
    at: Date.now(),
    snapshot: {
      murmur_snapshot: 1,
      host_id: "REMOTE",
      display_name: "dev",
      murmur_version: "0.2.0",
      generated_at: 1,
      panes: [remotePane("%9")],
    },
  });
  store.replacePeerSnapshot("dev", {
    ok: false,
    at: Date.now(),
    error: "Permission denied (keyboard-interactive).",
  });
  const warnings: string[] = [];
  let jumped = false;

  await runPick(
    store,
    {},
    {
      fzf: (args, _input) => {
        if (args.some((arg) => arg.includes("hardware token"))) {
          warnings.push(args.join("\n"));
          return "jump";
        }
        return "REMOTE\t%9\tlabel";
      },
      jump: () => {
        jumped = true;
        return { ok: true };
      },
      collect: () => {},
      warm: () => false,
    },
  );

  expect(warnings).toHaveLength(1);
  expect(jumped).toBe(true);
});

test("a cold remote jump can be cancelled after the warning", async () => {
  agent("%1");
  store.addPeer("dev", "dev.example");
  store.replacePeerSnapshot("dev", {
    ok: true,
    at: Date.now(),
    snapshot: {
      murmur_snapshot: 1,
      host_id: "REMOTE",
      display_name: "dev",
      murmur_version: "0.2.0",
      generated_at: 1,
      panes: [remotePane("%9")],
    },
  });
  store.replacePeerSnapshot("dev", {
    ok: false,
    at: Date.now(),
    error: "Permission denied (keyboard-interactive).",
  });
  let jumped = false;
  let warned = false;

  await runPick(
    store,
    {},
    {
      fzf: (args) => {
        if (args.some((arg) => arg.includes("hardware token"))) {
          warned = true;
          return "";
        }
        return "REMOTE\t%9\tlabel";
      },
      jump: () => {
        jumped = true;
        return { ok: true };
      },
      collect: () => {},
      warm: () => false,
    },
  );

  expect(warned).toBe(true);
  expect(jumped).toBe(false);
});

test("a crew row revealed by alt-a can actually be jumped to", async () => {
  // The bug: `runPick` built its list ONCE, filtered by isVisible, and resolved
  // fzf's answer against that filtered array. alt-a's reveal is a
  // `reload(... pick --rows --all)` -- rows printed by a SUBPROCESS -- so the
  // parent's array never learned about the crew pane whose row fzf was now
  // displaying. find() returned undefined and the handler did a bare `return`:
  // enter did nothing, exit 0, no message.
  //
  // Drives the parent WITHOUT --all (the state the user is in when they press
  // alt-a) and hands back the hidden pane's key, which is what fzf does after a
  // reveal.
  agent("%1");
  agent("%9", "orchestrated");

  const { jumped, rows } = await pickReturning(`${here()}\t%9\tlabel`);

  // Precondition: this pane really is filtered out of the default display, so
  // the test exercises the gap rather than a coincidence.
  expect(isVisible({ driver: "orchestrated", attention: [] } as unknown as PaneView)).toBe(false);
  expect(rows.some((row) => row.split("\t")[1] === "%9")).toBe(false);

  expect(jumped).toEqual(["%9"]);
  expect(process.exitCode).not.toBe(1);
});

test("selecting a pane that is genuinely gone says so instead of exiting silently", async () => {
  // Once the lookup resolves against the unfiltered list, a miss means the pane
  // disappeared between the collect and the keypress. In a popup -- the normal
  // way to run this -- the window closes the moment runPick returns, so a bare
  // return is indistinguishable from a dead key.
  agent("%1");
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const { jumped } = await pickReturning(`${here()}\t%404\tlabel`);

    expect(jumped).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toContain("%404");
  } finally {
    stderr.mockRestore();
  }
});

test("an attention-only pane is selectable, which keying on an agent id would break", async () => {
  // A codex pane has no agent row and therefore no agent id. Keying the picker
  // on one would make exactly the rows that need a human unselectable -- and
  // those rows are the reason the notify verb exists.
  store.requestAttention({
    kind: "blocked",
    location: location("%7"),
    message: "needs input",
    source: "codex",
  });

  const { jumped, rows } = await pickReturning(`${here()}\t%7\tlabel`);

  expect(rows.some((row) => row.split("\t")[1] === "%7")).toBe(true);
  expect(jumped).toEqual(["%7"]);
});

test("a selection is resolved on host AND pane, not on the pane alone", async () => {
  // Pane ids are unique per NODE, so two machines routinely hold a `%1`. The row
  // carries both columns for exactly this reason, and the selection is the whole
  // address -- matching on the pane alone jumped to whichever `%1` the sort put
  // first, which is a local window switch standing in for an ssh.
  agent("%1");
  store.addPeer("bubba", "bubba.example");
  store.replacePeerSnapshot("bubba", {
    ok: true,
    at: Date.now(),
    snapshot: {
      murmur_snapshot: 1,
      host_id: "REMOTE",
      display_name: "container-id",
      murmur_version: "0.2.0",
      generated_at: 1,
      panes: [
        {
          pane: asPaneId("%1"),
          session: asSessionId("$9"),
          window: asWindowId("@9"),
          session_name: "far",
          window_name: "remote",
          agent: {
            agent_id: "remote-agent",
            activity: "running",
            agent_name: "remote-worker",
            pi_session: null,
            workstream: null,
            role: null,
            cli: "pi",
            driver: "human",
            claimed_at: 1,
            updated_at: 1,
          },
          attention: [],
        },
      ],
    },
  });

  const jumped: PaneView[] = [];
  await runPick(
    store,
    {},
    {
      fzf: () => "REMOTE\t%1\tlabel",
      jump: (_store, pane: PaneView) => {
        jumped.push(pane);
        return { ok: true };
      },
      warm: () => true,
    },
  );

  expect(jumped.map((pane) => pane.host_id)).toEqual(["REMOTE"]);
  expect(jumped[0]?.local).toBe(false);
});

test("the launch path paints without waiting for a collect", async () => {
  // THE REGRESSION THIS FILE EXISTS TO CATCH TWICE OVER.
  //
  // v1 awaited a full collect before handing fzf a single row, so the screen was
  // blank for the whole ssh fan-out -- 1-3s against a fleet with one dead peer.
  // v2 moved the fetch to an fzf `start:reload`, which was worse in a way no
  // test could see: a reload DISCARDS the rows fzf already has, so the list
  // showed `0/0` and a spinner for the same duration. The fix is a detached
  // child, and what makes it a fix is precisely that `runPick` never awaits it.
  //
  // Asserted by making the refresh hostile: if anything on the launch path waits
  // for this, the test hangs rather than fails, and a hang is a louder signal
  // than an assertion here.
  agent("%1");
  let started = false;
  const rows: string[] = [];

  await runPick(
    store,
    {},
    {
      fzf: (_args, input) => {
        rows.push(...input.split("\n"));
        // fzf must already have its rows by the time the refresh is asked for.
        expect(started).toBe(true);
        return "";
      },
      jump: () => ({ ok: true }),
      // A refresh that never settles must not stop the picker painting. Returned
      // rather than cast: a `=> void` callback may return a value, TS just
      // ignores it -- which is the whole point, since `runPick` must ignore it
      // too. `as unknown as void` said the same thing and tripped
      // noConfusingVoidType, whose suggested fix (`undefined`) would have
      // quietly removed the hang this test depends on.
      collect: () => {
        started = true;
        return new Promise<void>(() => {});
      },
    },
  );

  expect(started).toBe(true);
  expect(rows.some((row) => row.split("\t")[1] === "%1")).toBe(true);
});
