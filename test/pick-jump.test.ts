import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Agent } from "../src/agents.js";
import { isVisible, runPick } from "../src/cli/pick.js";
import { ensureIdentity } from "../src/identity.js";
import { type NewEvent, openStore, type Store } from "../src/store.js";

let store: Store;
let hostId: string;

beforeEach(() => {
  vi.stubEnv("MURMUR_STATE_DIR", mkdtempSync(join(tmpdir(), "murmur-pick-jump-")));
  hostId = ensureIdentity().host_id;
  store = openStore();
});

afterEach(() => {
  store.close();
  vi.unstubAllEnvs();
  process.exitCode = 0;
});

function event(over: Partial<NewEvent>): NewEvent {
  return {
    agent_id: `${hostId}:%1`,
    session: "$0",
    window: "@1",
    pane: "%1",
    workstream: "murmur",
    role: null,
    cli: "pi",
    driver: "human",
    kind: "state",
    state: "idle",
    message: "",
    pid: null,
    synthetic: false,
    reason: "",
    extra: {},
    ...over,
  };
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
        return `${selected}\n`;
      },
      jump: (_store, agent: Agent) => {
        jumped.push(agent.agent_id);
        return { ok: true };
      },
    },
  );
  return { jumped, rows };
}

test("a crew row revealed by alt-a can actually be jumped to", async () => {
  // The bug: `runPick` built its agent list ONCE, filtered by isVisible, and
  // resolved fzf's answer against that filtered array. alt-a's reveal is a
  // `reload(... pick --rows --all)` — rows printed by a SUBPROCESS — so the
  // parent's array never learned about the crew agent whose row fzf was now
  // displaying. find() returned undefined and the handler did a bare `return`:
  // enter did nothing, exit 0, no message. Shipped in ff1a306, which tested the
  // row rendering but never the jump.
  //
  // This test drives the parent WITHOUT --all (the state the user is in when
  // they press alt-a) and hands back the hidden agent's id, which is exactly
  // what fzf does after a reveal.
  const crew = `${hostId}:%9`;
  store.append(event({}));
  store.append(
    event({
      agent_id: crew,
      window: "@9",
      pane: "%9",
      driver: "orchestrated",
      state: "working",
      // A local `working` event with no pid folds to `crashed`, which isVisible
      // DOES show — the fold cannot trust a working claim it cannot verify. Own
      // pid so the row folds to a genuinely busy crew agent, the hidden case.
      pid: process.pid,
    }),
  );

  const { jumped, rows } = await pickReturning(crew);
  // Precondition: this agent really is filtered out of the default display,
  // so the test is exercising the gap and not a coincidence. If isVisible ever
  // starts showing busy crew, this line fails and says so rather than letting
  // the assertion below pass for the wrong reason.
  expect(isVisible({ driver: "orchestrated", state: "working" } as unknown as Agent)).toBe(false);
  expect(rows.some((row) => row.startsWith(crew))).toBe(false);

  expect(jumped).toEqual([crew]);
  expect(process.exitCode).not.toBe(1);
});

test("selecting an agent that is genuinely gone says so instead of exiting silently", async () => {
  // The other half: once the lookup resolves against the unfiltered list, a
  // miss means the agent disappeared between the collect and the keypress. In a
  // popup — the normal way to run this — the window closes the moment runPick
  // returns, so a bare return is indistinguishable from a dead key. Same
  // argument the jump.ok branch two lines below already makes.
  store.append(event({}));
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const { jumped } = await pickReturning(`${hostId}:%404`);
    expect(jumped).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toContain(`${hostId}:%404`);
  } finally {
    stderr.mockRestore();
  }
});
