import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { isVisible, runPick } from "../src/cli/pick.js";
import { createIdentity, loadIdentity } from "../src/identity.js";
import { asPaneId, asSessionId, asWindowId, type PaneId } from "../src/ids.js";
import { openStore, type Store } from "../src/store.js";
import type { AgentMeta, Driver, Location } from "../src/types.js";
import type { PaneView } from "../src/view.js";
import { fakeMux } from "./helpers/fake-mux.js";

let store: Store;

beforeEach(() => {
  vi.stubEnv("MURMUR_STATE_DIR", mkdtempSync(join(tmpdir(), "murmur-pick-jump-")));
  createIdentity("here");
  store = openStore();
  // Per test, like the database: a pane one test claimed must not keep another
  // test's fixture alive through reconcile.
  claimed.clear();
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
  // Every fixture addresses its pane through here -- agents AND attention-only
  // panes, which have no agent row and so never reach `agent()`. Registering the
  // pane at this one point keeps the injected mux agreeing with whatever the
  // test set up, without each test restating its own pane list.
  claimed.add(asPaneId(pane));
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

/** Every pane these tests claim, as the mux the pre-read collect reconciles against. */
const claimed = new Set<PaneId>();

/**
 * A picker whose fzf returns `selected`, recording what it was asked to jump to.
 *
 * The mux is injected, and that is load-bearing rather than tidiness. `runPick`
 * collects before it reads, and a collect reconciles the local agents against
 * the panes the mux reports -- deleting any whose pane is gone. Against the REAL
 * tmux, every pane these tests invent is gone, so the fixtures were being
 * deleted between the claim and the read. The suite passed on a machine with no
 * tmux server (`livePanes()` returns null, which reconcile treats as absence of
 * evidence and skips) and failed inside tmux, which is where murmur runs.
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
      mux: fakeMux({ livePanes: () => claimed }),
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
