import type { RenderState } from "./view.js";

// Dash-only vocabulary: do not leak these maps into paint.ts or pick.
export const DASH_GLYPH: Record<RenderState, string> = {
  crashed: "\uf057",
  blocked: "\uf075",
  done: "\uf058",
  running: "\uf013",
  idle: "\u{f0ecd}",
};

export const DASH_COLOR: Record<RenderState, string> = {
  crashed: "#f38ba8",
  blocked: "#fab387",
  done: "#94e2d5",
  running: "#a6adc8",
  idle: "#6c7086",
};

export const DASH_CHROME = {
  robot: "\u{f06a9}",
  here: "\uf015",
  remote: "\uf233",
  crew: "\uf0c0",
  stale: "\uf017",
};

export const DASH_CHROME_COLOR = {
  here: "#a6e3a1",
  remote: "#74c7ec",
  stale: "#f9e2af",
  furniture: "#6c7086",
  selectedFallback: "#b4befe",
  /** Key chords in the footer / robot in the header. */
  accent: "#cba6f7",
  /** Preference values beside a key. */
  text: "#cdd6f4",
  /** Soft secondary facts in the header (fetched, sort). */
  info: "#89b4fa",
};
