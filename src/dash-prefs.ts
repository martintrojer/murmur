import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./paths.js";
import type { RenderState } from "./view.js";

export type DashSort = "priority" | "node" | "age";

export type DashPrefs = {
  sort: DashSort;
  crew: boolean;
  hide_stale: boolean;
  hidden_states: RenderState[];
  preview: number;
};

export const DEFAULT_DASH_PREFS: DashPrefs = {
  sort: "priority",
  crew: false,
  hide_stale: false,
  hidden_states: [],
  preview: 0.75,
};

const SORTS = new Set<DashSort>(["priority", "node", "age"]);
const RENDER_STATES = new Set<RenderState>(["crashed", "blocked", "done", "running", "idle"]);

function defaults(): DashPrefs {
  return { ...DEFAULT_DASH_PREFS, hidden_states: [] };
}

function clampPreview(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DASH_PREFS.preview;
  return Math.min(0.85, Math.max(0.2, value));
}

function withoutComment(line: string): string {
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
    } else if (quote === '"' && character === "\\") {
      escaped = true;
    } else if (character === quote) {
      quote = undefined;
    } else if (quote === undefined && (character === '"' || character === "'")) {
      quote = character;
    } else if (quote === undefined && character === "#") {
      return line.slice(0, index);
    }
  }

  return line;
}

function stringValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && !trimmed.slice(1, -1).includes("'")) {
    return trimmed.slice(1, -1);
  }
  return undefined;
}

function stringArray(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  const body = trimmed.slice(1, -1).trim();
  if (body === "") return [];

  const result: string[] = [];
  for (const item of body.split(",")) {
    const parsed = stringValue(item);
    if (parsed === undefined) return undefined;
    result.push(parsed);
  }
  return result;
}

function isDashSort(value: string): value is DashSort {
  return SORTS.has(value as DashSort);
}

function isRenderState(value: string): value is RenderState {
  return RENDER_STATES.has(value as RenderState);
}

export function loadDashPrefs(dir = configDir()): DashPrefs {
  let source: string;
  try {
    source = readFileSync(join(dir, "dash.toml"), "utf8");
  } catch {
    return defaults();
  }

  const prefs = defaults();
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = withoutComment(rawLine).trim();
    if (line === "") continue;

    const assignment = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*)$/u.exec(line);
    if (!assignment) return defaults();
    const key = assignment[1];
    const value = assignment[2];
    if (key === undefined || value === undefined) return defaults();

    if (key === "sort") {
      const parsed = stringValue(value);
      if (parsed !== undefined && isDashSort(parsed)) prefs.sort = parsed;
    } else if (key === "crew" || key === "hide_stale") {
      if (value === "true" || value === "false") prefs[key] = value === "true";
    } else if (key === "hidden_states") {
      const parsed = stringArray(value);
      if (parsed !== undefined) prefs.hidden_states = parsed.filter(isRenderState);
    } else if (key === "preview") {
      const parsed = Number(value);
      if (value.trim() !== "" && Number.isFinite(parsed)) prefs.preview = clampPreview(parsed);
    }
  }

  return prefs;
}

export function saveDashPrefs(prefs: DashPrefs, dir = configDir()): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "dash.toml");
  const temporaryPath = join(dir, `.dash.toml.${process.pid}.${Date.now()}.tmp`);
  const hiddenStates = prefs.hidden_states
    .filter(isRenderState)
    .map((state) => JSON.stringify(state));
  const source = [
    `sort = ${JSON.stringify(isDashSort(prefs.sort) ? prefs.sort : DEFAULT_DASH_PREFS.sort)}`,
    `crew = ${prefs.crew}`,
    `hide_stale = ${prefs.hide_stale}`,
    `hidden_states = [${hiddenStates.join(", ")}]`,
    `preview = ${clampPreview(prefs.preview)}`,
    "",
  ].join("\n");

  try {
    writeFileSync(temporaryPath, source);
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}
