import type { Command } from "commander";
import { asPaneId } from "../ids.js";
import { type Mux, tmux } from "../mux.js";
import { openStore, type Store } from "../store.js";
import type { Location } from "../types.js";

/**
 * The fields a harness may send, as flags or as a JSON object on stdin.
 *
 * Both forms exist because the two consumers differ: the codex hook line passes
 * flags, opencode's plugin pipes JSON. Same four fields either way.
 *
 * Note the spelling mismatch, which is not ours to fix: the payload calls it
 * `type`, the flag is `--event-type`. Both consumers are already written against
 * those exact names, and this verb exists to keep them working.
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
 * also arrives on stdin, which is what both consumers were written against.
 *
 * `message` falls back through title then event type before the generic
 * "attention": a notification whose text is a bare placeholder is worse than
 * one carrying whatever the harness did manage to say.
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
 * This text reaches a tmux status line and a picker row, and it arrives from
 * another program's event payload. An embedded newline or escape sequence would
 * corrupt both surfaces, and `terminalText` in agents.ts exists for the same
 * reason on the read side -- this is the write side of that rule.
 */
function clean(value: string): string {
  // Char codes, not a character class, and biome's noControlCharactersInRegex is
  // right to insist: an invisible byte in a pattern is a hazard, and the rule
  // fired here. `terminalText` in agents.ts avoids it the same way for the same
  // reason -- that is the read side of this rule, this is the write side.
  //
  // Replaced with a space rather than dropped, so "line one\nline two" does not
  // become "line oneline two"; the collapse below then tidies the run.
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
    // An array or a scalar is not a payload. Ignored rather than rejected: a
    // notifier that pipes something odd should still get its attention row,
    // because the flags may carry everything needed.
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
 * WHY THIS EXISTS. pi reports from inside itself, through the extension. codex
 * and opencode have no such hook -- they can only run a command when something
 * happens. `murmur notify` is that command; without it those two harnesses never
 * show `blocked`, and because the status bar keeps working for pi agents, nothing
 * looks broken.
 *
 * WHAT IT CANNOT DO, structurally. The only thing it may write is an
 * `AttentionRequest`, which has no field for an agent_id, an owner_pid, an
 * activity, or any owner metadata. `attention` is keyed on (pane, kind) and the
 * agents table is untouched by every statement this path runs, so a notifier
 * corrupting a live agent's row is unsayable rather than merely guarded against.
 *
 * `blocked` only, hard-coded: an external process cannot know that an agent
 * started, finished or crashed, so those stay the owner's alone. A harness can
 * request attention and nothing else.
 *
 * NO IDENTITY IS NEEDED, which follows from the model rather than being an
 * exemption: attention is addressed by pane, and a pane needs no host_id to name
 * it. So this cannot fail for want of `murmur init`.
 *
 * And the pane comes from the harness's own environment. The codex and opencode
 * hooks run as children of the agent process, in its pane, so $TMUX_PANE names
 * exactly the pane whose agent wants attention. `--pane` overrides it for a
 * notifier that runs elsewhere.
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
    // The harness name goes here, not in `driver`. `driver` answers "who is
    // waiting on this agent" -- a human, or a supervisor consuming the result --
    // and a codex agent driven by a human is `human` on exactly that question.
    // `source` answers "who asked", which is the free-text field a new harness
    // needs no schema change for.
    source,
  });

  // The badge, so the status bar reflects it without waiting for a collect.
  mux.setWindowBadge(location.window, "blocked");
  return true;
}

/**
 * The pane this notification is about: the flag, else the caller's own pane.
 *
 * The no-flag path is the one both real consumers take, and the only one either
 * has ever used -- checked against the codex hook line and the opencode plugin,
 * neither of which passes a pane. Their hooks run as children of the agent
 * process, so `$TMUX_PANE` -- which `currentWindow` reads, and which tmux sets
 * for every process in a pane -- names exactly the pane whose agent wants
 * attention.
 *
 * `--pane` exists for a notifier that runs outside the pane it is reporting on,
 * and is deliberately implemented WITHOUT adding a pane-to-session lookup to the
 * Mux interface. `currentWindow` already resolves
 * a full location for the caller's own pane, and `--pane` is only meaningful
 * when it names a pane in the same tmux server, so the flag narrows an existing
 * answer rather than fetching a new one:
 *
 *   - naming your own pane is the common case and resolves identically
 *   - naming a DIFFERENT pane in the same window keeps that window's location,
 *     which is correct, since session and window are exactly what the two panes
 *     share
 *   - naming a pane in another window returns null rather than guessing, because
 *     recording a location this process cannot verify is how a row nothing can
 *     clear gets written
 *
 * If a real consumer ever needs the third case, that is when the Mux interface
 * should grow a lookup -- not on speculation.
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
 * BOUNDED, and that is a bug fix rather than caution. `isTTY` catches a notifier
 * run from a terminal, but it says nothing about a non-TTY stdin that never
 * closes -- an inherited pipe the parent created and never writes to, which is
 * the ordinary shape of a plugin host spawning a hook without redirecting
 * stdin. Reading to EOF then waits for an EOF that never comes:
 *
 *     sleep 30 | murmur notify --source codex     # hung; exit 124 under timeout
 *
 * A hung notify hook is a bad failure: it is a child of the agent process, it
 * holds a store handle, a harness that waits on its hook stalls, and its output
 * goes nowhere so nothing says why. The flags are already sufficient for every
 * documented consumer, so a deadline degrades to exactly the flags-only
 * behaviour codex relies on today.
 *
 * Two details stop the deadline becoming a different hang. The `data` listener
 * is removed BY REFERENCE, because a live handler keeps the stream referenced;
 * and the stream is `unref`ed rather than paused, because `pause()` stops the
 * flow while leaving the handle on the event loop. Verified with
 * `process._getActiveHandles()`, which still reported a `Socket` after a paused
 * read -- the work completed, the row was written, and the process still would
 * not exit. `unref` rather than `destroy`: this is declining to wait, not
 * tearing down a pipe the parent owns.
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  return new Promise<string>((resolve) => {
    const onData = (chunk: Buffer) => chunks.push(chunk);
    const done = () => {
      process.stdin.off("data", onData);
      // Optional because only a PIPE is a Socket. Redirect stdin from a file or
      // /dev/null -- which `sh -lc` does, so this is the codex hook's own path --
      // and `process.stdin` is an fs ReadStream with no `unref` at all, so
      // calling it unconditionally threw TypeError and took the whole hook down.
      // Nothing is lost: a file or /dev/null reaches EOF on its own, and it is
      // only the never-ending pipe that needed releasing.
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
