import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { afterAll, expect, test } from "vitest";
import { exactPane, exactSession } from "../src/mux.js";

// A private tmux server, so nothing here can touch the developer's session.
// Every call carries -L; a bare `tmux` would hit whatever server is running.
//
// -L rather than -S so tmux applies its own socket directory and permissions,
// and pid-suffixed so concurrent runs cannot collide.
const SOCKET = `murmur-targets-${process.pid}`;

function rig(...args: string[]): string {
  return execFileSync("tmux", ["-L", SOCKET, ...args], {
    encoding: "utf8",
    timeout: 5000,
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
  expect(rigFails("set-option", "-t", exactPane("keep"), "status", "off")).toBe(false);
  expect(rig("show-options", "-t", exactPane("keep"), "status")).toBe("status off");

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
  expect(noClient(exactPane("keep"))).toContain("no current client");
});

test("an exact target does not match a longer session by prefix", () => {
  // The silent one. A bare name matches by PREFIX, so a wrapper session for
  // host `bub` would set options on a session called `bubba` -- succeeding
  // against the wrong session rather than failing. Only the `=` prefix is safe,
  // and murmur names wrapper sessions after peers, so collisions are ordinary.
  rig("new-session", "-d", "-s", "bubba~", "sleep 300");
  rig("set-option", "-t", exactPane("bubba~"), "status", "on");

  // No session named `bub` exists; the bare form finds `bubba~` anyway.
  expect(rigFails("set-option", "-t", "bub:", "status", "off")).toBe(false);
  expect(rig("show-options", "-t", exactPane("bubba~"), "status")).toBe("status off");

  // The exact form refuses, which is the behaviour murmur depends on.
  rig("set-option", "-t", exactPane("bubba~"), "status", "on");
  expect(rigFails("set-option", "-t", exactPane("bub"), "status", "off")).toBe(true);
  expect(rig("show-options", "-t", exactPane("bubba~"), "status")).toBe("status on");
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
  expect(rigFails("set-option", "-t", exactPane("@sigil"), "status", "off")).toBe(false);
});
