import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { isVisible, runPick } from "../src/cli/pick.js";
import { createIdentity, loadIdentity } from "../src/identity.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
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

function meta(driver: Driver): AgentMeta {
  return {
    agent_name: null,
    pi_session: null,
    workstream: "murmur",
    role: null,
    cli: "pi",
    driver,
  };
}

/** A local pane with a running agent. */
function agent(pane: string, driver: Driver = "human"): void {
  const claim = store.claimAgent({
    location: location(pane),
    owner_pid: process.pid,
    meta: meta(driver),
  });
  store.setActivity({
    agent_id: "agent_id" in claim ? claim.agent_id : "",
    owner_pid: process.pid,
    activity: "running",
    location: location(pane),
  });
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
