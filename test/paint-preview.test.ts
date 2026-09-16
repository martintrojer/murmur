import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { warmSocketCommand } from "../src/channel.js";
import { glance } from "../src/glance.js";
import { createIdentity, loadIdentity } from "../src/identity.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { tmux } from "../src/mux.js";
import { previewText } from "../src/paint.js";
import { status } from "../src/status.js";
import { openStore, type Store } from "../src/store.js";
import type { Location, Snapshot, SnapshotPane, TmuxServer } from "../src/types.js";

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
    server: { kind: "default" },
    session: asSessionId("$0"),
    window: asWindowId("@1"),
    pane: asPaneId(pane),
    session_name: "dev",
    window_name: "local-window",
  };
}

function remoteSnapshot(panes: SnapshotPane[]): Snapshot {
  return {
    murmur_snapshot: 3,
    host_id: "REMOTE",
    display_name: "container-id",
    murmur_version: "0.2.0",
    generated_at: 1_000,
    panes,
  };
}

function remotePane(pane: string, server: TmuxServer = { kind: "default" }): SnapshotPane {
  return {
    server,
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
      model: null,
      provider: null,
      context_tokens: null,
      context_window: null,
      provider_effort: null,
      usage: null,
      effort: null,
      context_pct: null,
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
 *
 * Resolves the pane the way any caller must: `previewText` takes ONE agent and
 * the already-resolved peers, so the host column is part of the lookup here.
 * Pane ids are unique per node and nothing more, so two machines routinely hold
 * a `%1` and matching on the pane alone renders the wrong agent.
 */
function preview(
  pane: string,
  host?: string,
  glanceOutput = "pane contents",
  // No warm socket by default, so a gated peer READS gated. The probe is
  // injected because the real one consults the developer's own ssh control
  // sockets: without it, whether the gated-peer test passed depended on whether
  // someone had a session open to that host, and it flipped the moment one
  // appeared. A test must assert the code, not the machine.
  warm: (target: string) => boolean = () => false,
): { text: string; dialled: string[]; argv: string[][] } {
  const dialled: string[] = [];
  // The argv too, because the pane id crosses a remote LOGIN SHELL: ssh joins
  // its arguments into one string, so how the id is quoted is the whole defence
  // and asserting only the target would miss it entirely.
  const argv: string[][] = [];
  const identity = loadIdentity();
  if (!identity) throw new Error("no identity");
  const view = status(store, identity, Date.now(), warm);
  const agent = view.panes.find(
    (candidate) => candidate.pane === pane && (host === undefined || candidate.host_id === host),
  );
  const text = agent
    ? previewText(store, agent, view.peers, (target, args) => {
        dialled.push(target);
        argv.push(args);
        return glanceOutput;
      })
    : "";
  return { text, dialled, argv };
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
  expect(local).toBe("");
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
  //
  // A failure murmur cannot explain, deliberately -- an x2ssh proxy drop, which
  // the classifier reads as unreachable rather than auth-class. This test owns
  // the skip and the GENERIC message; the gated case below owns the named one,
  // and seeding an auth error here would silently move this test onto that
  // branch and leave "murmur does not know why" untested.
  store.replacePeerSnapshot("dev", {
    ok: false,
    at: Date.now(),
    error: "Connection closed by UNKNOWN port 65535",
  });

  // A DIFFERENT peer is gated at the same time, which is the normal state of a
  // mesh where one host does 2FA. The message must be keyed on the previewed
  // pane's own host: `find` with no host comparison names whichever gated peer
  // sorts first, so this row would have advised `ssh macmini` for a machine
  // that has nothing to do with it.
  store.addPeer("macmini", "macmini.invalid");
  store.replacePeerSnapshot("macmini", {
    ok: false,
    at: Date.now(),
    error: "Permission denied (keyboard-interactive).",
  });

  const { text, dialled } = preview("%7", "REMOTE");

  // The row still previews -- the metadata is cached and worth showing.
  expect(text).toContain("remote-worker");
  // But no ssh was attempted, and the pane section says why.
  expect(dialled).toEqual([]);
  expect(text).toContain("unreachable");
  expect(text).not.toContain("ssh macmini");
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

test.each([
  [{ kind: "default" } as const, "'tmux' 'capture-pane' '-p' '-e' '-t' '%1' '-S' '-40'"],
  [
    { kind: "label", value: "co'op; touch /tmp/server-pwned" } as const,
    "'tmux' '-L' 'co'\\''op; touch /tmp/server-pwned' 'capture-pane' '-p' '-e' '-t' '%1' '-S' '-40'",
  ],
  [
    { kind: "path", value: "/tmp/co'op; touch /tmp/server-pwned.sock" } as const,
    "'tmux' '-S' '/tmp/co'\\''op; touch /tmp/server-pwned.sock' 'capture-pane' '-p' '-e' '-t' '%1' '-S' '-40'",
  ],
])(
  "the remote glance selects the pane's %s tmux server with one inert command",
  (server, command) => {
    // A missing selector silently asks the default server, where the same pane id
    // may name another process. Quoting the assembled argv one argument at a time
    // keeps both private-server values and pane ids inert in ssh's login shell.
    store.addPeer("bubba", "bubba.example");
    store.replacePeerSnapshot("bubba", {
      ok: true,
      at: Date.now(),
      snapshot: remoteSnapshot([remotePane("%1", server)]),
    });

    expect(preview("%1", "REMOTE").argv).toEqual([[command]]);
  },
);

test("a hostile pane id is inert in the remote command", () => {
  const hostile = "%1';touch /tmp/murmur-pwned;'";
  store.addPeer("bubba", "bubba.example");
  store.replacePeerSnapshot("bubba", {
    ok: true,
    at: Date.now(),
    snapshot: remoteSnapshot([remotePane(hostile)]),
  });

  expect(preview(hostile, "REMOTE").argv).toEqual([
    ["'tmux' 'capture-pane' '-p' '-e' '-t' '%1'\\'';touch /tmp/murmur-pwned;'\\''' '-S' '-40'"],
  ]);
});

test("a glance failure returns no preview without deleting cached state", () => {
  store.addPeer("bubba", "bubba.example");
  store.replacePeerSnapshot("bubba", {
    ok: true,
    at: Date.now(),
    snapshot: remoteSnapshot([
      remotePane("%8", { kind: "path", value: "/tmp/missing-murmur.sock" }),
    ]),
  });
  const identity = loadIdentity();
  if (!identity) throw new Error("no identity");
  const agent = status(store, identity).panes.find((candidate) => candidate.pane === "%8");
  if (!agent) throw new Error("no remote pane");

  expect(
    glance(store, agent, 40, () => {
      throw new Error("capture failed");
    }),
  ).toBeNull();
  expect(status(store, identity).panes.some((candidate) => candidate.pane === "%8")).toBe(true);
});

test("a remote glance captures a real private tmux pane", () => {
  const label = `murmur-glance-${process.pid}`;
  let socket: string | null = null;
  try {
    execFileSync(
      "tmux",
      [
        "-L",
        label,
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "glance",
        "printf 'PRIVATE_GLANCE_VISIBLE\\n'; exec sleep 30",
      ],
      { stdio: "ignore" },
    );
    socket = execFileSync("tmux", ["-L", label, "display-message", "-p", "#{socket_path}"], {
      encoding: "utf8",
    }).trim();
    const pane = execFileSync("tmux", ["-L", label, "list-panes", "-F", "#{pane_id}"], {
      encoding: "utf8",
    }).trim();

    store.addPeer("private", "unused.example");
    store.replacePeerSnapshot("private", {
      ok: true,
      at: Date.now(),
      snapshot: remoteSnapshot([remotePane(pane, { kind: "label", value: label })]),
    });
    const identity = loadIdentity();
    if (!identity) throw new Error("no identity");
    const agent = status(store, identity).panes.find((candidate) => candidate.pane === pane);
    if (!agent) throw new Error("no private pane");

    expect(glance(store, { ...agent, local: true })).toContain("PRIVATE_GLANCE_VISIBLE");
    const captured = glance(store, agent, 40, (_target, [command = ""]) =>
      execFileSync("sh", ["-c", command], { encoding: "utf8" }),
    );
    expect(captured).toContain("PRIVATE_GLANCE_VISIBLE");
  } finally {
    if (socket) {
      try {
        execFileSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
      } catch {}
      rmSync(socket, { force: true });
    }
  }
});

test("a gated peer's preview says why, and names the command", () => {
  // The skip is right; the MESSAGE was a guess. `unavailable (host unreachable,
  // or pane gone)` is what murmur says when it does not know, and here it knows
  // exactly: a human must authenticate. The cached metadata above still renders,
  // which is the part the blanket suppression was costing.
  store.addPeer("dev", "dev");
  store.replacePeerSnapshot("dev", {
    ok: true,
    at: Date.now(),
    snapshot: remoteSnapshot([remotePane("%7")]),
  });
  store.replacePeerSnapshot("dev", {
    ok: false,
    at: Date.now(),
    error: "Permission denied (keyboard-interactive).",
  });

  const { text, dialled } = preview("%7", "REMOTE");

  expect(text).toContain("remote-worker");
  expect(dialled).toEqual([]);
  expect(text).toContain("needs an interactive session");
  // The working command, from the shared helper, so the preview and the header
  // cannot suggest different things.
  expect(text).toContain(warmSocketCommand("dev"));
  expect(text).not.toContain("pane gone");
});

test("a tab in captured pane text is expanded, not passed through", () => {
  // A tab is one byte and eight columns. `string-width` scores it 2, so ink's
  // `truncate-end` measured a line as fitting, handed it whole to the terminal,
  // and the terminal advanced to the next tab stop -- overflowing the box,
  // wrapping, and shifting every row below it. Tabs are ordinary in pane output
  // (`git status`, `make`, `cat -t`-less logs), so the dash mis-rendered on
  // normal content.
  //
  // Expanded to the 8-column stops the terminal would have used, so table-ish
  // output keeps its columns, and measurable width now equals painted width.
  store.addPeer("bubba", "bubba.example");
  store.replacePeerSnapshot("bubba", {
    ok: true,
    at: Date.now(),
    snapshot: remoteSnapshot([remotePane("%9")]),
  });

  const { text } = preview("%9", "REMOTE", "ab\tcd\tefghi\tj");

  expect(text).not.toContain("\t");
  expect(text).toContain("ab      cd      efghi   j");
});

test("a remote glance is captured with escape sequences too", () => {
  // The local and remote halves must show the same thing. `-e` was added to the
  // local `capture-pane` first, so a remote row previewed grey next to a
  // coloured local one -- which reads as "that agent is idle".
  store.addPeer("bubba", "bubba.example");
  store.replacePeerSnapshot("bubba", {
    ok: true,
    at: Date.now(),
    snapshot: remoteSnapshot([remotePane("%11")]),
  });

  const { argv } = preview("%11", "REMOTE");

  expect(argv[0]?.[0]).toContain("'-e'");
});

test("the previewed pane keeps its colours and emphasis", () => {
  // The whole feature: a pane's own styling is the fastest signal a reader has
  // about what happened in it, and a preview that flattens it throws that away.
  store.addPeer("bubba", "bubba.example");
  store.replacePeerSnapshot("bubba", {
    ok: true,
    at: Date.now(),
    snapshot: remoteSnapshot([remotePane("%12")]),
  });

  const { text } = preview("%12", "REMOTE", `\u001b[1;31mFAIL\u001b[0m ok`);

  expect(text).toContain("\u001b[1;31mFAIL");
});

test("non-SGR control sequences in pane output are stripped", () => {
  // A preview is a fixed box inside the dash, not a terminal. Cursor movement
  // and erases paint OUTSIDE the box and corrupt the chrome around it; an OSC 52
  // would write the reader's clipboard once per redraw.
  store.addPeer("bubba", "bubba.example");
  store.replacePeerSnapshot("bubba", {
    ok: true,
    at: Date.now(),
    snapshot: remoteSnapshot([remotePane("%13")]),
  });

  const { text } = preview(
    "%13",
    "REMOTE",
    `\u001b[2J\u001b[1;1Hclean\u001b]52;c;cGF5bG9hZA==\u0007 end`,
  );

  expect(text).toContain("clean end");
  expect(text).not.toContain("[2J");
  expect(text).not.toContain("52;c;");
});

test("a pane line left mid-attribute is reset at the line boundary", () => {
  // tmux captures half-drawn output all the time -- a progress bar, a `less`
  // status line -- so an unterminated background is normal rather than
  // pathological. Without a reset per line the pane's colour bled into the
  // dash's border and the facts below it.
  store.addPeer("bubba", "bubba.example");
  store.replacePeerSnapshot("bubba", {
    ok: true,
    at: Date.now(),
    snapshot: remoteSnapshot([remotePane("%14")]),
  });

  const { text } = preview("%14", "REMOTE", "\u001b[41mhot");

  expect(text).toContain("\u001b[41mhot\u001b[0m");
});

test("a tab after a colour code still lands on its column stop", () => {
  // Tab expansion counts COLUMNS, so it has to ignore the escape bytes: with
  // `-e` on, the same `git status` output that used to expand correctly gained a
  // colour prefix, and counting those bytes shifted every stop left.
  store.addPeer("bubba", "bubba.example");
  store.replacePeerSnapshot("bubba", {
    ok: true,
    at: Date.now(),
    snapshot: remoteSnapshot([remotePane("%15")]),
  });

  const { text } = preview("%15", "REMOTE", "\u001b[32mab\tcd");

  expect(text).toContain("\u001b[32mab      cd");
});

test("a LOCAL capture is sanitised on the same terms as a remote one", () => {
  // Every other sanitation assertion here goes through the remote branch, so
  // dropping `previewSafe` from the local one left the whole suite green: the
  // pane a reader previews most often -- one on their own machine -- was the
  // untested path. Local and remote are two call sites of one rule, and they
  // drift by exactly this kind of omission.
  //
  // `tmux.capture` is stubbed rather than the child process, because that
  // object IS the seam on the local branch, and a real pane cannot be made to
  // emit a clipboard write and a mid-attribute line on demand.
  store.claimAgent({
    location: location("%20"),
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
  const identity = loadIdentity();
  if (!identity) throw new Error("no identity");
  const agent = status(store, identity).panes.find((candidate) => candidate.pane === "%20");
  if (!agent) throw new Error("no local pane");
  vi.spyOn(tmux, "capture").mockReturnValue(
    "\u001b[2J\u001b[1;1H\u001b[31mred\u001b]52;c;cGF5bG9hZA==\u0007\thot\n\u001b[41mbled",
  );

  const captured = glance(store, agent);

  if (captured === null) throw new Error("no local glance");
  // Colours kept; cursor move, erase and the clipboard write gone; the tab
  // expanded from its VISIBLE column; the unterminated background closed at the
  // line boundary instead of bleeding into the dash chrome.
  expect(captured).toContain("\u001b[31mred");
  expect(captured).not.toContain("[2J");
  expect(captured).not.toContain("52;c;");
  expect(captured).toContain("red     hot");
  expect(captured.split("\n")[1]).toBe("\u001b[41mbled\u001b[0m");
});
