import { expect, test } from "vitest";
import { pidAlive } from "../src/mux.js";

test("pidAlive is true for self and false for an unused pid", () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(2 ** 22)).toBe(false);
});
