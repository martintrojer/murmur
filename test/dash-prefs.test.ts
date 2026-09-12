import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import {
  type DashPrefs,
  DEFAULT_DASH_PREFS,
  loadDashPrefs,
  saveDashPrefs,
} from "../src/dash-prefs.js";

/**
 * The dash's presentation preferences: a file a human edits by hand, read by a
 * surface that must paint something no matter what it finds there.
 *
 * Every case here is a way the file can be wrong -- absent, truncated,
 * hand-edited to a state that no longer exists, a preview split that would
 * leave one pane unreadable. A loader that threw on any of them would take the
 * dash down over a stale config line, so the claim under test is that none of
 * them can: the worst a bad file does is fall back to a default.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "murmur-dash-prefs-"));
});

function write(body: string): void {
  writeFileSync(join(dir, "dash.toml"), body);
}

test("a missing file reads as the defaults", () => {
  expect(loadDashPrefs(join(dir, "nowhere"))).toEqual(DEFAULT_DASH_PREFS);
});

test("every field survives a round trip", () => {
  const prefs: DashPrefs = {
    sort: "age",
    crew: true,
    hide_stale: true,
    hidden_states: ["done", "idle"],
    preview: 0.4,
  };

  saveDashPrefs(prefs, dir);

  expect(loadDashPrefs(dir)).toEqual(prefs);
});

test("saveDashPrefs creates the config directory", () => {
  const nested = join(dir, "a", "b");

  saveDashPrefs(DEFAULT_DASH_PREFS, nested);

  expect(loadDashPrefs(nested)).toEqual(DEFAULT_DASH_PREFS);
});

test("a preview split too large to leave room is clamped on load and on save", () => {
  write("preview = 0.99\n");
  expect(loadDashPrefs(dir).preview).toBe(0.85);

  saveDashPrefs({ ...DEFAULT_DASH_PREFS, preview: 0.99 }, dir);
  expect(loadDashPrefs(dir).preview).toBe(0.85);
});

test("a preview split too small to read is clamped on load and on save", () => {
  write("preview = 0.05\n");
  expect(loadDashPrefs(dir).preview).toBe(0.2);

  saveDashPrefs({ ...DEFAULT_DASH_PREFS, preview: 0.05 }, dir);
  expect(loadDashPrefs(dir).preview).toBe(0.2);
});

test("a non-finite preview uses the default on save", () => {
  saveDashPrefs({ ...DEFAULT_DASH_PREFS, preview: Number.NaN }, dir);

  expect(loadDashPrefs(dir).preview).toBe(DEFAULT_DASH_PREFS.preview);
});

test("a file that is not TOML at all reads as the defaults", () => {
  write("\u0000\u0001 not toml { [ = = =\nsort\n");

  expect(loadDashPrefs(dir)).toEqual(DEFAULT_DASH_PREFS);
});

test("a hidden state that is no longer a render state is dropped", () => {
  // States get renamed. A hand-edited or older file naming one that went away
  // must not hide nothing under a name nothing matches.
  write('hidden_states = ["done", "waiting", "idle"]\n');

  expect(loadDashPrefs(dir).hidden_states).toEqual(["done", "idle"]);
});

test("a key with the wrong type falls back to that key's default alone", () => {
  // One bad line is not grounds for discarding the lines around it.
  write('sort = 7\ncrew = "yes"\nhide_stale = true\npreview = "wide"\n');

  expect(loadDashPrefs(dir)).toEqual({ ...DEFAULT_DASH_PREFS, hide_stale: true });
});

test("comments, blank lines and unknown keys are ignored", () => {
  write("# written by hand\n\n  sort = 'node'  # quoted either way\ncolour = 'green'\n");

  expect(loadDashPrefs(dir)).toEqual({ ...DEFAULT_DASH_PREFS, sort: "node" });
});

test("an unreadable path reads as the defaults", () => {
  // A directory where the file should be: readFileSync throws EISDIR.
  mkdirSync(join(dir, "dash.toml"));

  expect(loadDashPrefs(dir)).toEqual(DEFAULT_DASH_PREFS);
});
