import { expect, test } from "vitest";
import { pidAlive, tmuxBadgeState } from "../src/mux.js";

test("pidAlive is true for self and false for an unused pid", () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(2 ** 22)).toBe(false);
});

test("tmux badges preserve the established working token", () => {
  expect(tmuxBadgeState("running")).toBe("working");
  expect(tmuxBadgeState("blocked")).toBe("blocked");
});
