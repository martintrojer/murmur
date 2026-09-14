import { Command } from "commander";
import { expect, test } from "vitest";
import { registerDash, requireDashTmux, withDashTerminalSuspended } from "../src/cli/dash.js";

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

test("registers the dash command", () => {
  const program = new Command();
  registerDash(program);

  const command = program.commands.find((candidate) => candidate.name() === "dash");
  expect(command?.description()).toBe("Watch agents and glance at their panes");
});
