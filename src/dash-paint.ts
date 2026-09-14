import type { RenderState } from "./view.js";

// The one state vocabulary shared by status, pick and dash. State glyphs are
// classic Nerd Font `nf-fa-*` (Font Awesome 4) codepoints: single cell and
// stable across Nerd Font versions.
export const DASH_GLYPH: Record<RenderState, string> = {
  crashed: "\uf057", // nf-fa-times_circle
  blocked: "\uf075", // nf-fa-comment
  done: "\uf058", // nf-fa-check_circle
  running: "\uf04b", // nf-fa-play
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
  // Deliberate nf-md exception shared with the tmux agent-attention segment:
  // this robot is clearer than nf-fa-android at status-bar size.
  robot: "\u{f06a9}", // nf-md-robot
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
