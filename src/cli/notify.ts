import type { Command } from "commander";
import { loadIdentity } from "../identity.js";
import { asPaneId } from "../ids.js";
import { type Location, type Mux, tmux } from "../mux.js";
import { openStore, type Store } from "../store.js";

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
export type NotifyInput = {
  source?: string;
  title?: string;
  eventType?: string;
  message?: string;
};

export type NotifyPayload = Record<string, unknown>;

/**
 * Resolve the four fields, flags beating the stdin payload.
 *
 * Flags win so the codex hook line behaves identically whether or not something
 * also arrives on stdin -- the legacy script's documented rule, kept.
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
 * Record `blocked` for a pane on behalf of a harness that cannot report itself.
 *
 * WHY THIS EXISTS. pi reports from inside itself, through the extension. codex
 * and opencode have no such hook -- they can only run a command when something
 * happens. `murmur notify` is that command, and it is the whole reason the
 * legacy agent-attention script cannot simply be deleted: without it those two
 * harnesses never show `blocked` again, and because the status bar keeps working
 * for pi agents, nothing looks broken.
 *
 * THE OWNERSHIP EXCEPTION, and why it does not reopen the hole 3281cff closed.
 *
 * That fix established that only a pane's owner may report for it, because six
 * pids had each written `working` to one row: the extension is linked globally,
 * so every short-lived pi launched inside an agent pane loaded it, read the
 * inherited $TMUX_PANE, claimed the parent's agent_id and wrote events. The
 * parent's row then folded off a dead child's pid.
 *
 * Notify is a deliberate exception, and it is a different act:
 *
 *   - A nested pi CLAIMS TO BE the agent in the pane. It writes `working` with
 *     its own pid, so the row now describes a process that is not the agent and
 *     will die while the agent runs on. That is the corruption.
 *   - A notifier SPEAKS ABOUT the agent in the pane, on the agent's behalf, and
 *     says one thing: someone is wanted here. It writes `blocked`, which
 *     carries no pid at all.
 *
 * `pid: null` is what makes the exception safe rather than merely narrow. The
 * pid field is the crash-detection probe -- `fold` turns `working` into
 * `crashed` when the recorded pid is gone -- so a row with no pid makes no claim
 * about any process's liveness and cannot be mistaken for one. There is nothing
 * for a dying notifier to corrupt, because it never asserted it was the agent.
 *
 * The exception is also narrow in what it can say. `blocked` only, hard-coded:
 * an external process has no way to know that an agent started, finished or
 * crashed, so those states stay the owner's alone. A harness can request
 * attention and nothing else.
 *
 * And the pane comes from the harness's own environment. The codex and opencode
 * hooks run as children of the agent process, in its pane, so $TMUX_PANE names
 * exactly the pane whose agent wants attention -- the same resolution the
 * legacy script used. `--pane` overrides it for a notifier that runs elsewhere,
 * which is the honest way to name a pane you are not in, rather than inheriting
 * one by accident.
 */
export function runNotify(
  store: Store,
  input: NotifyInput & { pane?: string },
  payload: NotifyPayload = {},
  mux: Mux = tmux,
): boolean {
  const identity = loadIdentity();
  const location = resolveLocation(input.pane, mux);
  // No tmux, no pane, or no identity yet. Silent and successful, because this
  // runs from another program's notification hook: a harness used outside tmux
  // must not have its own exit code broken by murmur having nothing to record.
  if (!identity || !location) return false;

  const { source, message } = notifyFields(input, payload);
  store.append({
    // `host:pane`, the same identity the extension builds. A bare pane id would
    // be a SECOND agent for the pane a pi is already reporting for, so a codex
    // notification would not clear when its window was looked at.
    agent_id: `${identity.host_id}:${location.pane}`,
    session: location.session,
    window: location.window,
    pane: location.pane,
    session_name: location.session_name,
    window_name: location.window_name,
    agent_name: null,
    pi_session: null,
    workstream: null,
    role: null,
    // The harness name goes HERE, not in `driver`, and that is the answer to
    // whether notify needs a third driver value: it does not.
    //
    // `driver` answers "who is waiting on this agent" -- a human, or a
    // supervisor that consumes the result. It is what makes the picker hide
    // busy crew and what splits the status counts. A codex agent driven by a
    // human is `human` on exactly that question, and calling it anything else
    // would hide it from the picker or count it as crew, both wrong.
    //
    // `cli` already answers "which harness" -- the extension sets `cli: "pi"`
    // for the same purpose. `--source codex` belongs there. It is a free-text
    // string on the wire, so a new harness needs no schema change, whereas a
    // third `Driver` value would be an enum change every reader must learn.
    cli: source,
    driver: "human",
    kind: "state",
    state: "blocked",
    message,
    // See the ownership note above: no pid, because this row makes no claim
    // about a process. It is what keeps an external writer from being mistaken
    // for the agent.
    pid: null,
    synthetic: false,
    reason: "notify",
    extra: {},
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
 * attention. Same resolution the legacy script used.
 *
 * `--pane` is kept because the legacy interface had it and this verb exists to
 * be a drop-in, but it is deliberately implemented WITHOUT adding a
 * pane-to-session lookup to the Mux interface. `currentWindow` already resolves
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
export const STDIN_DEADLINE_MS = 250;

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
      process.stdin.unref();
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
