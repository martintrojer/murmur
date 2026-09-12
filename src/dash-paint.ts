import type { RenderState } from "./view.js";

// Dash-only vocabulary: do not leak these maps into paint.ts or pick.
// All glyphs are classic Nerd Font `nf-fa-*` (Font Awesome 4) codepoints —
// single cell, stable across NF versions. Avoid `nf-md-*`: those PUA slots
// move between releases and render as the wrong icon (e.g. idle looked like
// a red shield under md-sleep).
export const DASH_GLYPH: Record<RenderState, string> = {
  crashed: "\uf057", // nf-fa-times_circle
  blocked: "\uf075", // nf-fa-comment
  done: "\uf058", // nf-fa-check_circle
  running: "\uf013", // nf-fa-cog
  idle: "\uf186", // nf-fa-moon_o
};

export const DASH_COLOR: Record<RenderState, string> = {
  crashed: "#f38ba8",
  blocked: "#fab387",
  done: "#94e2d5",
  running: "#a6adc8",
  idle: "#6c7086",
};

export const DASH_CHROME = {
  robot: "\uf17b", // nf-fa-android
  here: "\uf015", // nf-fa-home
  remote: "\uf233", // nf-fa-server
  crew: "\uf0c0", // nf-fa-users
  stale: "\uf017", // nf-fa-clock_o
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
