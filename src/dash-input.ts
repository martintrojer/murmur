import { spawn } from "node:child_process";
import { peerForHost, shellQuote } from "./agents.js";
import { SSH_OPTIONS } from "./channel.js";
import type { Store } from "./store.js";
import type { PaneView } from "./view.js";

export type Composer = {
  text: string;
  cursor: number;
};

export type ComposerEdit =
  | { type: "insert"; text: string }
  | { type: "backspace" | "delete" | "left" | "right" | "home" | "end" };

export function emptyComposer(): Composer {
  return { text: "", cursor: 0 };
}

export function editComposer(state: Composer, edit: ComposerEdit): Composer {
  const characters = [...state.text];
  if (edit.type === "insert") {
    characters.splice(state.cursor, 0, ...edit.text);
    return { text: characters.join(""), cursor: state.cursor + [...edit.text].length };
  }
  if (edit.type === "left") return { ...state, cursor: Math.max(0, state.cursor - 1) };
  if (edit.type === "right")
    return { ...state, cursor: Math.min(characters.length, state.cursor + 1) };
  if (edit.type === "home") return { ...state, cursor: 0 };
  if (edit.type === "end") return { ...state, cursor: characters.length };
  if (edit.type === "backspace" && state.cursor > 0) {
    characters.splice(state.cursor - 1, 1);
    return { text: characters.join(""), cursor: state.cursor - 1 };
  }
  if (edit.type === "delete" && state.cursor < characters.length) {
    characters.splice(state.cursor, 1);
    return { text: characters.join(""), cursor: state.cursor };
  }
  return state;
}

/**
 * The dash's transient filter: a query plus whether the reader is typing it.
 *
 * Two fields rather than one nullable composer, because an empty query being
 * EDITED and no query at all are different screens -- the first shows a live
 * prompt the reader is mid-thought in, the second shows nothing.
 */
export type DashFilter = {
  editing: boolean;
  query: Composer;
};

export type DashFilterAction =
  | { type: "open" }
  | { type: "accept" }
  | { type: "cancel" }
  | { type: "edit"; edit: ComposerEdit };

export function emptyFilter(): DashFilter {
  return { editing: false, query: emptyComposer() };
}

/**
 * The `/` state machine, pure so the key bindings are assertable without ink.
 *
 * `open` resumes the existing query rather than clearing it: after Enter the
 * reader is navigating a filtered list, and `/` there almost always means
 * "refine that", not "start over". `accept` keeps the query and stops editing;
 * `cancel` clears it in both modes, so one Escape always gets you back to the
 * full list without having to know which mode you were in. Edits outside
 * editing mode are ignored, which is what lets the dash keep `j`/`k`/`q` as
 * navigation once the prompt is closed.
 */
export function dashFilter(state: DashFilter, action: DashFilterAction): DashFilter {
  if (action.type === "open") return { ...state, editing: true };
  if (action.type === "accept") return { ...state, editing: false };
  if (action.type === "cancel") return emptyFilter();
  if (!state.editing) return state;
  return { ...state, query: editComposer(state.query, action.edit) };
}

export type InputDelivery = {
  command: "tmux" | "ssh";
  args: string[];
  input: string;
};

export type InputResult = { ok: true } | { ok: false; message: string };
export type InputRunner = (delivery: InputDelivery) => Promise<void>;

function tmuxArgs(pane: string, buffer: string): string[] {
  return [
    "load-buffer",
    "-b",
    buffer,
    "-",
    ";",
    "paste-buffer",
    "-b",
    buffer,
    "-t",
    pane,
    "-p",
    "-d",
    ";",
    "send-keys",
    "-t",
    pane,
    "Enter",
  ];
}

export function buildPromptDelivery(
  pane: PaneView,
  text: string,
  target: string | null,
  buffer = `murmur-input-${process.pid}`,
): InputDelivery {
  if (pane.local) return { command: "tmux", args: tmuxArgs(pane.pane, buffer), input: text };
  const args = tmuxArgs(shellQuote(pane.pane), buffer).map((arg) => (arg === ";" ? "\\;" : arg));
  return { command: "ssh", args: [...SSH_OPTIONS, target ?? "", "tmux", ...args], input: text };
}

export function buildEscapeDelivery(pane: PaneView, target: string | null): InputDelivery {
  if (pane.local) {
    return { command: "tmux", args: ["send-keys", "-t", pane.pane, "Escape"], input: "" };
  }
  return {
    command: "ssh",
    args: [
      ...SSH_OPTIONS,
      target ?? "",
      "tmux",
      "send-keys",
      "-t",
      shellQuote(pane.pane),
      "Escape",
    ],
    input: "",
  };
}

const runInput: InputRunner = (delivery) =>
  new Promise((resolve, reject) => {
    const child = spawn(delivery.command, delivery.args, { stdio: ["pipe", "ignore", "pipe"] });
    let error = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      error += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(error.trim() || `${delivery.command} exited ${code ?? "without status"}`));
    });
    child.stdin.end(delivery.input);
  });

function inputTarget(store: Store, pane: PaneView): string | null {
  if (pane.local) return null;
  return peerForHost(store, pane.host_id)?.target ?? null;
}

async function deliver(
  store: Store,
  pane: PaneView,
  makeDelivery: (target: string | null) => InputDelivery,
  run: InputRunner,
): Promise<InputResult> {
  const target = inputTarget(store, pane);
  if (!pane.local && !target) return { ok: false, message: `no peer for ${pane.host}` };
  try {
    await run(makeDelivery(target));
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function sendPrompt(
  store: Store,
  pane: PaneView,
  text: string,
  run: InputRunner = runInput,
): Promise<InputResult> {
  return deliver(store, pane, (target) => buildPromptDelivery(pane, text, target), run);
}

export function sendEscape(
  store: Store,
  pane: PaneView,
  run: InputRunner = runInput,
): Promise<InputResult> {
  return deliver(store, pane, (target) => buildEscapeDelivery(pane, target), run);
}
