import type { Command } from "commander";
import { asPaneId } from "../ids.js";
import { type Mux, tmux } from "../mux.js";
import { openStore, type Store } from "../store.js";
import type { Location } from "../types.js";

/**
 * The fields a harness may send, as flags or as a JSON object on stdin.
 *
 * Both forms exist because the consumers differ: the codex hook line passes
 * flags, opencode's plugin pipes JSON. Same four fields either way.
 *
 * The spelling mismatch is not ours to fix -- the payload says `type`, the flag
 * is `--event-type`. Both consumers are already written against those names.
 */
type NotifyInput = {
  source?: string;
  title?: string;
  eventType?: string;
  message?: string;
};

type NotifyPayload = Record<string, unknown>;

/**
 * Resolve the four fields, flags beating the stdin payload.
 *
 * Flags win so the codex hook line behaves identically whether or not something
 * also arrives on stdin.
 *
 * `message` falls back through title then event type before a generic
 * "attention": a bare placeholder is worse than whatever the harness did say.
 */
export function notifyFields(
  input: NotifyInput,
  payload: NotifyPayload = {},
): { source: string; message: string } {
  const field = (key: string, flag: string | undefined): string => {
    if (flag) return clean(flag);
    const value = payload[key];
    return typeof value === "string" ? clean(value) : "";
  };

  const source = field("source", input.source) || "agent";
  const title = field("title", input.title);
  const eventType = field("type", input.eventType);
  const message = field("message", input.message) || title || eventType || "attention";
  return { source, message };
}

/**
 * Strip control characters and collapse whitespace.
 *
 * This text comes from another program's event payload and reaches a tmux status
 * line and a picker row, either of which an embedded newline or escape sequence
 * would corrupt. `terminalText` in agents.ts is the read side of this rule.
 */
function clean(value: string): string {
  // Char codes, not a character class: biome's noControlCharactersInRegex fired
  // here and is right that an invisible byte in a pattern is a hazard.
  //
  // Replaced with a space rather than dropped, so "line one\nline two" does not
  // become "line oneline two"; the collapse below tidies the run.
  const flattened = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      const control = code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
      return control ? " " : character;
    })
    .join("");
  return flattened.replace(/\s+/g, " ").trim();
}

/** Read a JSON object from stdin, or nothing. */
export function parsePayload(raw: string): NotifyPayload {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    // An array or scalar is not a payload. Ignored rather than rejected: the
    // flags may carry everything needed, so the row should still appear.
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as NotifyPayload)
      : {};
  } catch {
    return {};
  }
}

/**
 * Request `blocked` attention for a pane, on behalf of a harness that cannot
 * report itself.
 *
 * pi reports from inside itself through the extension. codex and opencode have
 * no such hook -- they can only run a command when something happens, and this
 * is that command. Without it those harnesses never show `blocked`, and since
 * the status bar keeps working for pi agents, nothing looks broken.
 *
 * STRUCTURALLY BOUNDED. The only thing it may write is an `AttentionRequest`,
 * which has no field for an agent_id, owner_pid, activity or any owner
 * metadata: `attention` is keyed on (pane, kind) and no statement on this path
 * touches the agents table, so a notifier corrupting a live agent's row is
 * unsayable rather than merely guarded against.
 *
 * `blocked` only, hard-coded, because an external process cannot know that an
 * agent started, finished or crashed. Those stay the owner's alone.
 *
 * Needs no identity, which follows from the model rather than being an
 * exemption: attention is addressed by pane, and a pane needs no host_id. So
 * this cannot fail for want of `murmur init`.
 *
 * The pane comes from the harness's own environment -- both hooks run as
 * children of the agent process, in its pane, so $TMUX_PANE names exactly the
 * right one. `--pane` overrides it for a notifier that runs elsewhere.
 */
export function runNotify(
  store: Store,
  input: NotifyInput & { pane?: string },
  payload: NotifyPayload = {},
  mux: Mux = tmux,
): boolean {
  const location = resolveLocation(input.pane, mux);
  // No tmux and no pane. Silent and successful, because this runs from another
  // program's notification hook: a harness used outside tmux must not have its
  // own exit code broken by murmur having nothing to record.
  if (!location) return false;

  const { source, message } = notifyFields(input, payload);
  store.requestAttention({
    kind: "blocked",
    location,
    message,
    // The harness name, not `driver`. `driver` answers "who is waiting on this
    // agent", and a codex agent driven by a human is `human` on that question.
    // `source` answers "who asked" and is free text, so a new harness needs no
    // schema change.
    source,
  });

  // The badge, so the status bar reflects it without waiting for a collect.
  mux.setWindowBadge(location.window, "blocked");
  return true;
}

/**
 * The pane this notification is about: the flag, else the caller's own pane.
 *
 * The no-flag path is the only one either real consumer uses -- neither the
 * codex hook line nor the opencode plugin passes a pane. Their hooks run as
 * children of the agent process, so `$TMUX_PANE`, which tmux sets for every
 * process in a pane and `currentWindow` reads, names the right one.
 *
 * `--pane` covers a notifier running outside the pane it reports on, and is
 * deliberately implemented WITHOUT adding a pane-to-session lookup to Mux:
 * `currentWindow` already resolves a full location for the caller's own pane,
 * and `--pane` is only meaningful within the same tmux server, so the flag
 * narrows an existing answer rather than fetching a new one:
 *
 *   - your own pane, the common case, resolves identically
 *   - a different pane in the same window keeps that window's location, which is
 *     correct: session and window are exactly what the two panes share
 *   - a pane in another window returns null rather than guessing, since
 *     recording an unverifiable location writes a row nothing can clear
 *
 * The third case is when Mux should grow a lookup -- not before.
 */
function resolveLocation(pane: string | undefined, mux: Mux): Location | null {
  const here = mux.currentWindow();
  if (!pane) return here;
  const target = asPaneId(pane);
  if (here && here.pane === target) return here;
  if (here && mux.panesInWindow(here.window).includes(target)) {
    return { ...here, pane: target };
  }
  return null;
}

export function registerNotify(program: Command): void {
  program
    .command("notify")
    .description("Record an attention request for a harness that cannot report itself")
    .option("--source <name>", "harness name, e.g. codex or opencode")
    .option("--event-type <type>", "why attention is wanted")
    .option("--title <title>", "harness display title")
    .option("--message <message>", "the text to show")
    .option("--pane <pane>", "pane to notify about (default: $TMUX_PANE)")
    .action(
      async (options: {
        source?: string;
        eventType?: string;
        title?: string;
        message?: string;
        pane?: string;
      }) => {
        const payload = parsePayload(await readStdin());
        const store = openStore();
        try {
          runNotify(store, options, payload);
        } finally {
          store.close();
        }
      },
    );
}

/** How long to wait for a piped payload before proceeding on flags alone. */
const STDIN_DEADLINE_MS = 250;

/**
 * Whatever is on stdin, or "" when nothing arrives in time.
 *
 * BOUNDED, as a bug fix rather than caution. `isTTY` catches a notifier run from
 * a terminal but says nothing about a non-TTY stdin that never closes -- an
 * inherited pipe the parent never writes to, the ordinary shape of a plugin host
 * spawning a hook without redirecting stdin. Reading to EOF then waits forever:
 *
 *     sleep 30 | murmur notify --source codex     # hung; exit 124 under timeout
 *
 * A hung hook is a bad failure: it is a child of the agent process, it holds a
 * store handle, a harness that waits on its hook stalls, and its output goes
 * nowhere. The flags suffice for every documented consumer, so the deadline
 * degrades to exactly the flags-only behaviour codex relies on today.
 *
 * Two details stop the deadline becoming a different hang. The `data` listener
 * is removed BY REFERENCE, since a live handler keeps the stream referenced; and
 * the stream is `unref`ed rather than paused, since `pause()` stops the flow but
 * leaves the handle on the event loop -- verified with
 * `process._getActiveHandles()`, which still reported a Socket after a paused
 * read, work done and row written, and the process would not exit. `unref`, not
 * `destroy`: this is declining to wait, not tearing down the parent's pipe.
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  return new Promise<string>((resolve) => {
    const onData = (chunk: Buffer) => chunks.push(chunk);
    const done = () => {
      process.stdin.off("data", onData);
      // Optional because only a PIPE is a Socket. Redirect stdin from a file or
      // /dev/null -- which `sh -lc` does, so it is the codex hook's own path --
      // and `process.stdin` is an fs ReadStream with no `unref`, so calling it
      // unconditionally threw TypeError and took the hook down. Nothing is lost:
      // those reach EOF on their own, and only the endless pipe needed releasing.
      process.stdin.unref?.();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    // Unreffed so the deadline itself cannot be what holds the process open.
    const timer = setTimeout(done, STDIN_DEADLINE_MS);
    timer.unref?.();
    process.stdin.on("data", onData);
    process.stdin.once("end", () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.once("error", () => {
      clearTimeout(timer);
      done();
    });
  });
}
