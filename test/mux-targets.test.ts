import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { afterAll, expect, test } from "vitest";
import { exactPaneTarget, exactSession } from "../src/mux.js";

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
