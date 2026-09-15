import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { remoteSessionName } from "../src/agents.js";
import { DASH_PANE_OPTION, JUMP_CLIENT_OPTION } from "../src/goto.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { exactPaneTarget, exactSession, tmux } from "../src/mux.js";
import { openStore } from "../src/store.js";

// A private tmux server, so nothing here can touch the developer's session.
// Every call carries -L; a bare `tmux` would hit whatever server is running.
//
// -L rather than -S so tmux applies its own socket directory and permissions,
// and pid-suffixed so concurrent runs cannot collide.
const SOCKET = `murmur-targets-${process.pid}`;

// `-f /dev/null`, so the rig never reads the developer's ~/.tmux.conf.
//
// Isolation is the point -- a personal config can rebind keys, set options and
// change defaults this file asserts on -- but the cost was the surprise:
// starting a server that sourced the author's config took 3.5s because of ten
// `run-shell` status hooks, against 0.02s with an empty config. That is a 175x
// difference, and it made the first call flaky against any timeout under
// parallel load. Measured both ways.
const TMUX = ["-L", SOCKET, "-f", "/dev/null"];

function rig(...args: string[]): string {
  return execFileSync("tmux", [...TMUX, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function rigFails(...args: string[]): boolean {
  try {
    rig(...args);
    return false;
  } catch {
    return true;
  }
}

afterAll(() => {
  // kill-server stops the server but leaves the socket file behind, and a test
  // that litters on every run is a test people delete. Ask tmux where the
  // socket is rather than reconstructing the path: on macOS `os.tmpdir()` is
  // the per-user $TMPDIR while tmux uses /tmp, so guessing missed by a mile.
  let socketPath: string | null = null;
  try {
    socketPath = rig("display-message", "-p", "#{socket_path}");
  } catch {
    // Server already gone; nothing to ask and probably nothing to remove.
  }
  try {
    rig("kill-server");
  } catch {
    // Already gone, or never started.
  }
  if (socketPath) rmSync(socketPath, { force: true });
});

// These two spellings are the whole reason this file talks to a real tmux.
// Every other test fakes the Mux, so a wrong target string passes them all --
// and both of these were wrong at first, in ways only tmux itself reports.
test("a claim on a real labeled server survives export liveness", () => {
  rig("new-session", "-d", "-s", "private-live", "sleep 300");
  const pane = asPaneId(rig("list-panes", "-t", "private-live", "-F", "#{pane_id}"));
  const server = { kind: "label", value: SOCKET } as const;
  const previous = process.env.MURMUR_STATE_DIR;
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-private-tmux-"));
  const store = openStore();
  try {
    store.claimAgent({
      location: {
        server,
        session: asSessionId("$0"),
        window: asWindowId("@0"),
        pane,
        session_name: "private-live",
        window_name: null,
      },
      owner_pid: process.pid,
      meta: {
        agent_name: "private",
        pi_session: null,
        workstream: null,
        role: null,
        cli: "pi",
        driver: "human",
      },
    });

    const snapshot = store.buildLocalSnapshot(
      { host_id: "HOST", display_name: "host" },
      { server, panes: tmux.livePanes(server) },
    );
    expect(snapshot.panes.map((entry) => entry.pane)).toEqual([pane]);
  } finally {
    store.close();
    rmSync(process.env.MURMUR_STATE_DIR, { recursive: true, force: true });
    if (previous === undefined) delete process.env.MURMUR_STATE_DIR;
    else process.env.MURMUR_STATE_DIR = previous;
    rig("kill-session", "-t", exactSession("private-live"));
  }
});

test("the option target needs a trailing colon and the client target must not have one", () => {
  rig("new-session", "-d", "-s", "keep", "sleep 300");

  // set-option -t takes a target-PANE, not a target-session: `=name` fails
  // outright with "no such session", and the exact form is `=name:` -- the
  // empty window/pane part resolving to the session's current pane.
  expect(rigFails("set-option", "-t", exactSession("keep"), "status", "off")).toBe(true);
  expect(rigFails("set-option", "-t", exactPaneTarget("keep"), "status", "off")).toBe(false);
  expect(rig("show-options", "-t", exactPaneTarget("keep"), "status")).toBe("status off");

  // switch-client -t takes a target-SESSION, where the pane form is wrong.
  // With no client attached both fail, so assert on the ERROR rather than the
  // exit status: "no current client" means the target parsed and there was
  // simply no client, which is what we are pinning.
  const noClient = (target: string) => {
    try {
      rig("switch-client", "-t", target);
      return "";
    } catch (error) {
      return String((error as { stderr?: Buffer }).stderr ?? "");
    }
  };
  expect(noClient(exactSession("keep"))).toContain("no current client");
  expect(noClient(exactPaneTarget("keep"))).toContain("no current client");
});

test("an exact target does not match a longer session by prefix", () => {
  // The silent one. A bare name matches by PREFIX, so a wrapper session for
  // host `bub` would set options on a session called `bubba` -- succeeding
  // against the wrong session rather than failing. Only the `=` prefix is safe,
  // and murmur names wrapper sessions after peers, so collisions are ordinary.
  rig("new-session", "-d", "-s", "bubba~", "sleep 300");
  rig("set-option", "-t", exactPaneTarget("bubba~"), "status", "on");

  // No session named `bub` exists; the bare form finds `bubba~` anyway.
  expect(rigFails("set-option", "-t", "bub:", "status", "off")).toBe(false);
  expect(rig("show-options", "-t", exactPaneTarget("bubba~"), "status")).toBe("status off");

  // The exact form refuses, which is the behaviour murmur depends on.
  rig("set-option", "-t", exactPaneTarget("bubba~"), "status", "on");
  expect(rigFails("set-option", "-t", exactPaneTarget("bub"), "status", "off")).toBe(true);
  expect(rig("show-options", "-t", exactPaneTarget("bubba~"), "status")).toBe("status on");
});

test("a moved pane outlives the window it left, so only list-panes can see it", () => {
  // The tmux fact the jump path got wrong twice, pinned against a real server
  // because no fake can establish it. Every other assertion about liveness is
  // made against a stubbed Mux, so if this premise is wrong they all agree with
  // each other and with nothing else.
  rig("new-session", "-d", "-s", "moved", "sleep 300");
  const from = rig("list-panes", "-t", "moved", "-F", "#{pane_id} #{window_id}").split(" ");
  const pane = from[0] as string;
  const window = from[1] as string;
  rig("new-window", "-t", "moved", "sleep 300");
  const target = rig("list-panes", "-a", "-F", "#{pane_id} #{window_id}")
    .split("\n")
    .map((line) => line.split(" "))
    .find((fields) => fields[1] !== window && fields[1] !== undefined)?.[0] as string;

  rig("move-pane", "-s", pane, "-t", target);

  const panes = rig("list-panes", "-a", "-F", "#{pane_id}").split("\n");
  const windows = rig("list-windows", "-a", "-F", "#{window_id}").split("\n");

  // The pane is alive and jumpable; the window on its last recorded event is
  // simply not there any more. Deciding liveness from `windows` therefore
  // condemns a healthy agent -- and the jump used to DELETE it on that basis.
  expect(panes).toContain(pane);
  expect(windows).not.toContain(window);

  // And the stale window id is not even usable as a target, which is why the
  // question has to be asked about the pane rather than papered over at attach
  // time.
  expect(rigFails("select-window", "-t", window)).toBe(true);

  rig("kill-session", "-t", exactSession("moved"));
});

test("a bare target cannot address a session whose name starts with a sigil", () => {
  // Why remoteSessionName strips `@`, `$` and `%`. The old per-host WINDOW was
  // named `@<host>`, harmless for a window name because names are not targets.
  // As a SESSION name, a bare `-t @host` parses as a window id and fails.
  rig("new-session", "-d", "-s", "@sigil", "sleep 300");

  expect(rigFails("set-option", "-t", "@sigil", "status", "off")).toBe(true);
  expect(rigFails("set-option", "-t", exactSession("@sigil"), "status", "off")).toBe(true);

  // The pane form does rescue it, so the two defences are independent: the
  // trailing colon makes even a sigil name addressable. Stripping the sigil is
  // still worth doing -- a session called `@bubba` is a trap for every tmux
  // command a human types at it by hand, not just for murmur's own calls.
  expect(rigFails("set-option", "-t", exactPaneTarget("@sigil"), "status", "off")).toBe(false);
});

test("a colon anywhere in a session name breaks targeting, which is why the whole name is sanitised", () => {
  // Reported by review, reproduced here against a real server. `:` separates
  // session from window in a target, so the name is addressable only up to the
  // colon. Stripping leading sigils did not help: the colon is not at the front.
  //
  // The live consequence was worse than a failed jump. `newSession` succeeded,
  // then `switch-client` could not find it, so the jump returned attach_failed
  // and left an orphan session with `status` on and the local prefix live --
  // which `sessionNamed` then matched on every later attempt, taking the reuse
  // branch and failing identically. Permanent until killed by hand.
  rig("new-session", "-d", "-s", "colon:name", "sleep 300");

  // `switch-client` is the call the jump actually makes, and it is the one that
  // cannot resolve the name: the target splits at the colon, so it looks for a
  // session called `colon`. `exactSession` does NOT rescue it -- unlike the
  // leading-sigil case, where the `=` prefix is enough -- because the split
  // happens inside the name rather than at its first character.
  expect(rigFails("switch-client", "-t", exactSession("colon:name"))).toBe(true);
  // `has-session` fails too, and differently: it reads `name` as a window.
  // Measured, and worth pinning -- two calls, two error messages, neither
  // mentioning that the NAME is the problem.
  expect(rigFails("has-session", "-t", "colon:name")).toBe(true);

  // Killing it needs the session ID, since every name-based form fails. That is
  // the "recoverable only by hand" part of the report.
  const id = rig("display-message", "-p", "-F", "#{session_id}", "-t", exactPaneTarget("colon"));
  rig("kill-session", "-t", id ?? exactSession("colon"));

  // remoteSessionName's output has no reserved character left, so the same
  // operations succeed. This is the invariant: no character tmux's target
  // grammar reserves, anywhere in the name.
  const safe = remoteSessionName("colon:name");
  expect(safe).toBe("colon-name~");
  rig("new-session", "-d", "-s", safe, "sleep 300");
  expect(rigFails("set-option", "-t", safe, "status", "off")).toBe(false);
  rig("kill-session", "-t", exactSession(safe));
});

test("a pane id as a switch-client target selects the pane, not just its window", () => {
  // The address in this model is the PANE, and `switch-client -t %pane` is what
  // makes that true at attach time: it resolves session, window and pane in one
  // call. The two-step it replaced -- switch-client to the session, then
  // select-window -- moved the client to the right WINDOW and left whichever
  // pane that window last had active as the active one. In a window holding an
  // agent beside a shell, pressing enter on the agent row landed on the shell.
  //
  // A real server, because this is a claim about what tmux does with a target,
  // and a fake mux asserting on argv would only restate the implementation.
  rig("new-session", "-d", "-s", "picked", "sleep 600");
  const window = rig("display-message", "-t", "picked", "-p", "#{window_id}");
  const first = rig("display-message", "-t", "picked", "-p", "#{pane_id}");
  const second = rig("split-window", "-t", window, "-P", "-F", "#{pane_id}", "sleep 600");

  // The split leaves the NEW pane active, so `first` is the non-active pane in
  // its own window -- the case that used to be unreachable.
  expect(rig("display-message", "-t", window, "-p", "#{pane_id}")).toBe(second);

  // No client is attached to this server, so switch-client cannot move one and
  // `select-pane` is the assertable half of what the target resolves to. The
  // claim under test is that a bare pane id is a valid, precise target.
  rig("select-pane", "-t", first);
  expect(rig("display-message", "-t", window, "-p", "#{pane_id}")).toBe(first);

  // And the window-level target is genuinely ambiguous about panes: addressing
  // the window says nothing about which pane becomes active, which is why the
  // old two-step could not express "this pane".
  rig("select-pane", "-t", second);
  expect(rig("display-message", "-t", window, "-p", "#{pane_id}")).toBe(second);

  rig("kill-session", "-t", exactSession("picked"));
});

test("the dash and jump markers are server-global options a later command can read", () => {
  // A real server, because the claim is about tmux's option scoping and the
  // spelling of the calls that read it. `--goto` runs in a DIFFERENT pane and
  // session from the dash, so a session- or window-scoped option would be
  // invisible exactly where it is needed -- and `show-options -gqv` returning
  // empty (rather than failing) for an unset option is what makes "no dash
  // running" expressible at all.
  rig("new-session", "-d", "-s", "opts", "sleep 300");
  const pane = rig("display-message", "-t", "opts", "-p", "#{pane_id}");

  expect(rig("show-options", "-gqv", DASH_PANE_OPTION)).toBe("");
  rig("set-option", "-gq", DASH_PANE_OPTION, pane);

  // Read from a second window, which is the cross-session case in miniature.
  rig("new-window", "-t", "opts", "sleep 300");
  expect(rig("show-options", "-gqv", DASH_PANE_OPTION)).toBe(pane);

  // And the dash's own cleanup path empties it rather than leaving "".
  rig("set-option", "-gqu", DASH_PANE_OPTION);
  expect(rig("show-options", "-gqv", DASH_PANE_OPTION)).toBe("");

  rig("kill-session", "-t", exactSession("opts"));
});

test("the armed jump hook marks exactly one attaching client and then removes itself", () => {
  // The invariant the whole remote branch rests on: murmur's own attach is
  // marked, and the NEXT client -- an ordinary human `tmux attach` to the same
  // machine -- is not. Only a real server can establish it, since the mechanism
  // is tmux firing a hook and expanding `#{client_name}` at that moment.
  //
  // Two extra tmux servers act as terminals, because a client needs a tty and
  // `attach` from a test process has none.
  const outer = `${SOCKET}-outer`;
  const second = `${SOCKET}-second`;
  const outerTmux = (...args: string[]) =>
    execFileSync("tmux", ["-L", outer, "-f", "/dev/null", ...args], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const secondTmux = (...args: string[]) =>
    execFileSync("tmux", ["-L", second, "-f", "/dev/null", ...args], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  try {
    rig("new-session", "-d", "-s", "marked", "sleep 300");
    // The exact string the jump appends to its probe, run the way the remote
    // side runs it: through a SHELL, as arguments to `tmux`. That is the seam
    // worth pinning -- the quoting has to survive a shell before tmux parses
    // it. Not `run-shell` (which takes a shell command, so the tmux command
    // fails) and not an argv array (which would skip the shell the real path
    // goes through).
    execFileSync("zsh", ["-c", `tmux ${TMUX.join(" ")} ${tmux.armJumpMarkerCommand()}`], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(rig("show-options", "-gqv", JUMP_CLIENT_OPTION)).toBe("");

    outerTmux("new-session", "-d", `tmux -L ${SOCKET} -f /dev/null attach -t marked`);
    // A client attach is not synchronous with the command that starts it.
    const settle = (predicate: () => boolean) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        execFileSync("sleep", ["0.1"]);
      }
      return false;
    };
    expect(settle(() => rig("list-clients", "-F", "#{client_name}") !== "")).toBe(true);
    expect(settle(() => rig("show-options", "-gqv", JUMP_CLIENT_OPTION) !== "")).toBe(true);

    const marker = rig("show-options", "-gqv", JUMP_CLIENT_OPTION);
    const client = rig("list-clients", "-F", "#{client_name} #{client_created}");
    // `name created`, matching gotoDecision's comparison exactly. The creation
    // time is in the marker because a tty path is recycled by the OS.
    expect(marker).toBe(client);

    // The hook is gone, so a SECOND client attaching does not get marked --
    // the ordinary-remote-login case. Proven by clearing the option and
    // checking nothing rewrites it.
    rig("set-option", "-gqu", JUMP_CLIENT_OPTION);
    secondTmux("new-session", "-d", `tmux -L ${SOCKET} -f /dev/null attach -t marked`);
    expect(settle(() => rig("list-clients", "-F", "#{client_name}").split("\n").length === 2)).toBe(
      true,
    );
    expect(rig("show-options", "-gqv", JUMP_CLIENT_OPTION)).toBe("");
  } finally {
    for (const socket of [outer, second]) {
      try {
        execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore", timeout: 5_000 });
      } catch {
        // Never started, or already gone.
      }
    }
  }
});
