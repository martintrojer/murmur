import { expect, test } from "vitest";
import { glancePlacement, glanceShare } from "../src/paint.js";

test.each([
  [80, "bottom"],
  [150, "right"],
  [200, "right"],
  [0, "right"],
] as const)("places the glance at %i columns", (columns, placement) => {
  expect(glancePlacement(columns)).toBe(placement);
});

test("uses the configured right share and a fixed bottom share", () => {
  expect(glanceShare("right", 0.58)).toBe(0.58);
  expect(glanceShare("right")).toBe(0.75);
  expect(glanceShare("bottom", 0.58)).toBe(0.6);
});
