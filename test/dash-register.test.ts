import { Command } from "commander";
import { afterEach, expect, test } from "vitest";
import {
  dashGoto,
  registerDash,
  requireDashTmux,
  withDashTerminalSuspended,
} from "../src/cli/dash.js";
import { asPaneId } from "../src/ids.js";
import { fakeMux } from "./helpers/fake-mux.js";

afterEach(() => {
  process.exitCode = 0;
});

test("dash refuses to start outside tmux but allows a tmux popup", () => {
  const errors: string[] = [];
  expect(requireDashTmux({}, (message) => errors.push(message))).toBe(false);
  expect(errors.join("")).toContain("murmur dash must run inside tmux");
  expect(requireDashTmux({ TMUX: "/tmp/tmux/default,1,0" }, () => undefined)).toBe(true);
});

test("a jump releases and restores the dash terminal around the action", async () => {
  const events: string[] = [];

  await withDashTerminalSuspended(
    async (action) => {
      events.push("suspend");
      await action();
      events.push("resume");
    },
    () => events.push("jump"),
    (enabled) => events.push(enabled ? "mouse on" : "mouse off"),
  );

  expect(events).toEqual(["mouse off", "suspend", "jump", "resume", "mouse on"]);
});

test("registers the dash command and its --goto flag", () => {
  const program = new Command();
  registerDash(program);

  const command = program.commands.find((candidate) => candidate.name() === "dash");
  expect(command?.description()).toBe("Watch agents and glance at their panes");
  // The tmux binding's target. A missing flag would make PREFIX G print
  // commander's usage error into a backgrounded run-shell, where nobody sees it.
  expect(command?.options.some((option) => option.long === "--goto")).toBe(true);
});

test("--goto reports a missing dash on stderr and exits nonzero", () => {
  // `run-shell -b` shows neither, but the run that matters is the one a human
  // does by hand when the key appears to do nothing.
  const errors: string[] = [];
  expect(dashGoto(fakeMux(), { TMUX: "x" }, (message) => errors.push(message))).toBe(false);
  expect(errors.join("")).toContain("no murmur dash is running");
  expect(process.exitCode).toBe(1);
});

test("--goto switches to a live dash and stays silent", () => {
  const dash = asPaneId("%7");
  const errors: string[] = [];
  const attached: string[] = [];
  const ok = dashGoto(
    fakeMux({
      dashPane: () => dash,
      livePanes: () => new Set([dash]),
      attach: (pane) => {
        attached.push(pane);
        return true;
      },
    }),
    { TMUX: "x" },
    (message) => errors.push(message),
  );

  expect(ok).toBe(true);
  expect(attached).toEqual([dash]);
  expect(errors).toEqual([]);
  expect(process.exitCode).toBe(0);
});
