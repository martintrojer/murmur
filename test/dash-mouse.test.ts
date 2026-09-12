import { expect, test } from "vitest";
import {
  clampGlanceScroll,
  classifyClick,
  parseMouseEvents,
  pointInRect,
} from "../src/dash-mouse.js";

test("parseMouseEvents reads SGR press, release, and wheel", () => {
  const { events, rest } = parseMouseEvents("\x1b[<0;10;5M\x1b[<0;10;5m\x1b[<64;3;3M");
  expect(rest).toBe("");
  expect(events).toEqual([
    { kind: "press", button: "left", x: 9, y: 4 },
    { kind: "release", button: "left", x: 9, y: 4 },
    { kind: "wheel", button: "up", x: 2, y: 2 },
  ]);
});

test("parseMouseEvents keeps an incomplete CSI for the next chunk", () => {
  const first = parseMouseEvents("hello\x1b[<0;1;");
  expect(first.events).toEqual([]);
  expect(first.rest).toBe("\x1b[<0;1;");
  const second = parseMouseEvents(`${first.rest}2M`);
  expect(second.events).toEqual([{ kind: "press", button: "left", x: 0, y: 1 }]);
});

test("pointInRect is half-open on the far edges", () => {
  const rect = { x: 2, y: 3, width: 4, height: 2 };
  expect(pointInRect(2, 3, rect)).toBe(true);
  expect(pointInRect(5, 4, rect)).toBe(true);
  expect(pointInRect(6, 3, rect)).toBe(false);
  expect(pointInRect(2, 5, rect)).toBe(false);
});

test("classifyClick treats a second hit on the same key as a double", () => {
  const first = classifyClick(null, "a", 1000);
  expect(first.double).toBe(false);
  const second = classifyClick(first.next, "a", 1200);
  expect(second.double).toBe(true);
  const other = classifyClick(first.next, "b", 1200);
  expect(other.double).toBe(false);
  const late = classifyClick(first.next, "a", 1500);
  expect(late.double).toBe(false);
});

test("clampGlanceScroll stays in range", () => {
  expect(clampGlanceScroll(-3, 10, 4)).toBe(0);
  expect(clampGlanceScroll(100, 10, 4)).toBe(6);
  expect(clampGlanceScroll(2, 3, 10)).toBe(0);
});
