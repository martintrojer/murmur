import { Command } from "commander";
import { expect, test } from "vitest";
import { registerDash } from "../src/cli/dash.js";

test("registers the dash command", () => {
  const program = new Command();
  registerDash(program);

  const command = program.commands.find((candidate) => candidate.name() === "dash");
  expect(command?.description()).toBe("Watch agents and glance at their panes");
});
