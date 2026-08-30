import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { isVisible, runPick } from "../src/cli/pick.js";
import { createIdentity } from "../src/identity.js";
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

/** A picker whose fzf returns `selected`, recording what it was asked to jump to. */
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

  const { jumped, rows } = await pickReturning("LOCAL\t%9\tlabel");

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
    const { jumped } = await pickReturning("LOCAL\t%404\tlabel");

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

  const { jumped, rows } = await pickReturning("LOCAL\t%7\tlabel");

  expect(rows.some((row) => row.split("\t")[1] === "%7")).toBe(true);
  expect(jumped).toEqual(["%7"]);
});
