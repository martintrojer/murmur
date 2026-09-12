import { expect, test } from "vitest";
import { DASH_CHROME, DASH_CHROME_COLOR, DASH_COLOR, DASH_GLYPH } from "../src/dash-paint.js";
import { RENDER_PRIORITY } from "../src/view.js";

test("every render state has its single-codepoint Nerd Font glyph", () => {
  expect(DASH_GLYPH).toEqual({
    crashed: "\uf057",
    blocked: "\uf075",
    done: "\uf058",
    running: "\uf013",
    idle: "\u{f0ecd}",
  });
  for (const state of RENDER_PRIORITY) {
    expect([...DASH_GLYPH[state]]).toHaveLength(1);
  }
});

test("dash state colors use the Catppuccin Mocha palette", () => {
  expect(DASH_COLOR).toEqual({
    crashed: "#f38ba8",
    blocked: "#fab387",
    done: "#94e2d5",
    running: "#a6adc8",
    idle: "#6c7086",
  });
});

test("dash chrome uses Nerd Font glyphs and Catppuccin accents", () => {
  expect(DASH_CHROME).toEqual({
    robot: "\u{f06a9}",
    here: "\uf015",
    remote: "\uf233",
    crew: "\uf0c0",
    stale: "\uf017",
  });
  expect(DASH_CHROME_COLOR).toEqual({
    here: "#a6e3a1",
    remote: "#74c7ec",
    stale: "#f9e2af",
    furniture: "#6c7086",
    selectedFallback: "#b4befe",
    accent: "#cba6f7",
    text: "#cdd6f4",
    info: "#89b4fa",
  });
});
