import { expect, test, vi } from "vitest";
import { DASH_PANE_OPTION } from "../src/goto.js";
import { asPaneId, asWindowId } from "../src/ids.js";
import {
  chosenWindowName,
  conventionalTmuxDirectory,
  deriveTmuxServer,
  pidAlive,
  tmux,
  tmuxArgs,
  tmuxBadgeState,
} from "../src/mux.js";

const tmuxCalls = vi.hoisted(() => [] as string[][]);
// Queued answers, because a call that DEPENDS on what tmux said cannot be
// asserted against a fake that only ever says "".
const tmuxReplies = vi.hoisted(() => [] as string[]);
vi.mock("node:child_process", () => ({
  execFileSync: (_file: string, args: string[]) => {
    tmuxCalls.push(args);
    return tmuxReplies.shift() ?? "";
  },
}));

test.each([
  ["/tmp/tmux-501/default", { kind: "default" }],
  ["/tmp/tmux-501/coop", { kind: "label", value: "coop" }],
  ["/var/run/private.sock", { kind: "path", value: "/var/run/private.sock" }],
  ["/var/run/private,one.sock", { kind: "path", value: "/var/run/private,one.sock" }],
])("derives the tmux server from socket path %s", (socketPath, expected) => {
  expect(deriveTmuxServer(socketPath, "/tmp/tmux-501")).toEqual(expected);
});

test("tmux argv selects default, label, and path servers without a shell", () => {
  expect(tmuxArgs({ kind: "default" }, ["list-panes", "-a"])).toEqual(["list-panes", "-a"]);
  expect(tmuxArgs({ kind: "label", value: "coop" }, ["list-panes", "-a"])).toEqual([
    "-L",
    "coop",
    "list-panes",
    "-a",
  ]);
  expect(tmuxArgs({ kind: "path", value: "/tmp/a,b.sock" }, ["list-panes", "-a"])).toEqual([
    "-S",
    "/tmp/a,b.sock",
    "list-panes",
    "-a",
  ]);
});

test("currentWindow records the socket-derived server", () => {
  const socket = `${conventionalTmuxDirectory()}/coop`;
  tmuxReplies.push(`$1\t@2\twork\treviewer\t0\t${socket}`);
  process.env.TMUX_PANE = "%34";
  try {
    expect(tmux.currentWindow()).toMatchObject({
      pane: "%34",
      server: { kind: "label", value: "coop" },
    });
  } finally {
    delete process.env.TMUX_PANE;
  }
});

test("pidAlive is true for self and false for an unused pid", () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(2 ** 22)).toBe(false);
});

test("tmux badges preserve the established working token", () => {
  expect(tmuxBadgeState("running")).toBe("working");
  expect(tmuxBadgeState("blocked")).toBe("blocked");
});

test("retracting a window badge clears both agent options", () => {
  tmuxCalls.length = 0;

  tmux.setWindowBadge(asWindowId("@7"), null);

  expect(tmuxCalls).toEqual([
    ["set-window-option", "-qu", "-t", "@7", "@agent_state"],
    ["set-window-option", "-qu", "-t", "@7", "@pane_agent"],
    ["refresh-client", "-S"],
  ]);
});

test("badge reads and writes select the location's private server", () => {
  tmuxCalls.length = 0;
  tmuxReplies.length = 0;
  tmuxReplies.push("%34");

  expect(tmux.panesInWindow(asWindowId("@7"), { kind: "label", value: "coop" })).toEqual(["%34"]);
  tmux.setWindowBadge(asWindowId("@7"), "done", { kind: "label", value: "coop" });

  expect(tmuxCalls).toEqual([
    ["-L", "coop", "list-panes", "-t", "@7", "-F", "#{pane_id}"],
    ["-L", "coop", "set-window-option", "-q", "-t", "@7", "@agent_state", "done"],
    ["-L", "coop", "set-window-option", "-q", "-t", "@7", "@pane_agent", "1"],
    ["-L", "coop", "refresh-client", "-S"],
  ]);
});

// The picker's `agent` column showed `Python`, `node` and `zsh` for three real
// pi agents. All three are tmux's `automatic-rename` reporting the foreground
// process, and `agentLabel` prefers a window name over a session name -- so the
// process name shadowed `hacking/murmur`, the string a reader searches on.
test("a dash clears only the marker that names its own pane", () => {
  // Two dashes on one tmux server: the second overwrites the first's marker,
  // and an unconditional unset on exit would leave PREFIX G reporting "no
  // murmur dash is running" while a dash is on screen. The marker is a single
  // server-global option, so the only way the older dash can tell is to read it
  // back and compare before clearing.
  tmuxCalls.length = 0;
  tmuxReplies.length = 0;

  // A newer dash owns the marker: read it, change nothing.
  tmuxReplies.push("%9");
  tmux.unmarkDashPane(asPaneId("%7"));
  expect(tmuxCalls).toEqual([["show-options", "-gqv", DASH_PANE_OPTION]]);

  // The marker is our own: clear it.
  tmuxCalls.length = 0;
  tmuxReplies.push("%7");
  tmux.unmarkDashPane(asPaneId("%7"));
  expect(tmuxCalls).toEqual([
    ["show-options", "-gqv", DASH_PANE_OPTION],
    ["set-option", "-gqu", DASH_PANE_OPTION],
  ]);

  // Already unset, or a tmux that would not answer. Nothing to clear and
  // nothing to guess about.
  tmuxCalls.length = 0;
  tmux.unmarkDashPane(asPaneId("%7"));
  expect(tmuxCalls).toEqual([["show-options", "-gqv", DASH_PANE_OPTION]]);
});

test("a window tmux is auto-renaming contributes no name", () => {
  // The exact triple this bug produced: pi's interpreter, in a window tmux owns.
  expect(chosenWindowName("Python", "1")).toBe(null);
  expect(chosenWindowName("node", "1")).toBe(null);
  expect(chosenWindowName("zsh", "1")).toBe(null);
});

test("a window a human named keeps its name", () => {
  // The whole point of the rule: `automatic-rename` off means someone chose
  // this, whether by `rename-window`, a tmuxinator config, or mu.
  expect(chosenWindowName("reviewer", "0")).toBe("reviewer");
  // Even when what they chose LOOKS like a process name. The flag is the only
  // signal that carries intent; the string cannot.
  expect(chosenWindowName("Python", "0")).toBe("Python");
});

test("a name is absent, not empty, when tmux says nothing", () => {
  // Three spellings of "no answer", because the field is read out of a
  // tab-split and a missing trailing field arrives as undefined while a present
  // but empty one arrives as "". Both must reach the store as null: an empty
  // string is truthy enough for `??` to select it, so `agentLabel` would return
  // one and print a blank cell instead of falling through to the session name.
  expect(chosenWindowName("", "0")).toBe(null);
  expect(chosenWindowName(undefined, "0")).toBe(null);
  expect(chosenWindowName(undefined, undefined)).toBe(null);
});

test("an unparseable automatic-rename flag keeps the name", () => {
  // Fails toward the old behaviour. Only a literal "1" -- what
  // `#{?automatic-rename,1,0}` emits -- suppresses a name, so a tmux that
  // answers differently, or a format string that stops resolving, costs a
  // cosmetic column rather than every agent's name at once.
  expect(chosenWindowName("reviewer", "")).toBe("reviewer");
  expect(chosenWindowName("reviewer", "yes")).toBe("reviewer");
});
