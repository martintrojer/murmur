import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runPreview } from "../src/cli/pick.js";
import { createIdentity } from "../src/identity.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { openStore, type Store } from "../src/store.js";
import type { Location, Snapshot, SnapshotPane } from "../src/types.js";

let store: Store;

beforeEach(() => {
  vi.stubEnv("MURMUR_STATE_DIR", mkdtempSync(join(tmpdir(), "murmur-preview-")));
  createIdentity("here");
  store = openStore();
});

afterEach(() => {
  store.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = 0;
});

function location(pane: string): Location {
  return {
    session: asSessionId("$0"),
    window: asWindowId("@1"),
    pane: asPaneId(pane),
    session_name: "dev",
    window_name: "local-window",
  };
}

function remoteSnapshot(panes: SnapshotPane[]): Snapshot {
  return {
    murmur_snapshot: 1,
    host_id: "REMOTE",
    display_name: "container-id",
    murmur_version: "0.2.0",
    generated_at: 1_000,
    panes,
  };
}

function remotePane(pane: string): SnapshotPane {
  return {
    pane: asPaneId(pane),
    session: asSessionId("$9"),
    window: asWindowId("@9"),
    session_name: "far",
    window_name: "remote-window",
    agent: {
      agent_id: `agent-${pane}`,
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
  };
}

/**
 * The preview text, plus every ssh target the glance actually dialled.
 *
 * The runner is injected rather than spied: `execFileSync` is an ESM namespace
 * export and not configurable, so `vi.spyOn` throws on it. Same seam the jump
 * tests use for the same reason.
 */
function preview(
  pane: string,
  host?: string,
  glanceOutput = "pane contents",
): { text: string; dialled: string[] } {
  const written: string[] = [];
  const dialled: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  try {
    runPreview(store, pane, host, (target) => {
      dialled.push(target);
      return glanceOutput;
    });
  } finally {
    stdout.mockRestore();
  }
  return { text: written.join(""), dialled };
}

test("the preview resolves the host as well as the pane", () => {
  // Pane ids are unique per NODE and nothing more, so two machines routinely
  // hold a `%1`. fzf hands both keys back -- the row is `host_id \t pane` and
  // the preview command is built with `{1}` and `{2}` -- and resolving on the
  // pane alone previewed whichever row the sort happened to put first. A local
  // pane's preview then ran a local capture-pane for a remote agent.
  store.claimAgent({
    location: location("%1"),
    owner_pid: process.pid,
    meta: {
      agent_name: "local-worker",
      pi_session: null,
      workstream: "murmur",
      role: null,
      cli: "pi",
      driver: "human",
    },
  });
  store.addPeer("bubba", "bubba.example");
  store.replacePeerSnapshot("bubba", {
    ok: true,
    at: Date.now(),
    snapshot: remoteSnapshot([remotePane("%1")]),
  });

  const remote = preview("%1", "REMOTE").text;
  expect(remote).toContain("remote-worker");
  expect(remote).toContain("bubba");
  expect(remote).not.toContain("local-worker");

  const local = preview("%1", "LOCAL_MISSING_HOST_ID").text;
  // A host we hold nothing for is a miss, not a silent fall-through to another
  // node's pane of the same id.
  expect(local).not.toContain("remote-worker");
});

test("a peer whose last fetch failed is not dialled for a glance", () => {
  // The preview runs PER KEYPRESS as the cursor moves, and an ssh to a host that
  // cannot authenticate costs ~1.5s to fail -- measured against a real peer
  // rejecting keyboard-interactive. That turned every pass over one row into a
  // stall, which is what "the picker is slow to render" actually was.
  //
  // The store already knows: `replacePeerSnapshot` clears `last_error` on
  // success, so a non-null value means the MOST RECENT attempt failed. Asking it
  // costs a read we have already done.
  store.addPeer("dev", "dev.example");
  store.replacePeerSnapshot("dev", {
    ok: true,
    at: Date.now(),
    snapshot: remoteSnapshot([remotePane("%7")]),
  });
  // Then a failed attempt, which is the shape a sleeping or auth-broken peer
  // leaves behind: the cached snapshot stands, so the ROW is still listed.
  store.replacePeerSnapshot("dev", {
    ok: false,
    at: Date.now(),
    error: "Permission denied (keyboard-interactive)",
  });

  const { text, dialled } = preview("%7", "REMOTE");

  // The row still previews -- the metadata is cached and worth showing.
  expect(text).toContain("remote-worker");
  // But no ssh was attempted, and the pane section says why.
  expect(dialled).toEqual([]);
  expect(text).toContain("unreachable");
});

test("a reachable peer is still dialled for a glance", () => {
  // The other half: the skip must be keyed on a FAILED attempt, not on being
  // remote. A peer whose last fetch succeeded is exactly the case the glance
  // exists for, and gating on `local` would have removed the feature.
  store.addPeer("bubba", "bubba.example");
  store.replacePeerSnapshot("bubba", {
    ok: true,
    at: Date.now(),
    snapshot: remoteSnapshot([remotePane("%8")]),
  });

  const { text, dialled } = preview("%8", "REMOTE");

  expect(dialled).toEqual(["bubba.example"]);
  expect(text).toContain("pane contents");
});

test("a pane that is gone says so rather than previewing nothing", () => {
  // The preview is a child process whose whole output is the pane it was asked
  // about. Printing nothing looks exactly like a broken preview command, and
  // the row can genuinely vanish between the collect and the keypress.
  const text = preview("%404", "LOCAL").text;
  expect(text).toContain("%404");
});
