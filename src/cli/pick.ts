import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import {
  type Agent,
  agentLabel,
  agentLocation,
  forgetOneAgent,
  jumpToAgent,
  terminalText,
} from "../agents.js";
import { glance } from "../glance.js";
import { loadIdentity } from "../identity.js";
import { status, statusWithCollect } from "../status.js";
import { openStore, type Store } from "../store.js";

type PickOptions = { all?: boolean };

const PREVIEW_EVENTS = 8;
const PREVIEW_MESSAGE_MAX = 300;

// Same glyphs the tmux status bar and window labels use, so one symbol means
// one thing in every surface. Ported from the dotfiles' _tmux_common.
const GLYPH: Record<string, string> = {
  crashed: "\u2717", // ✗
  blocked: "!",
  done: "\u2713", // ✓
  working: "\u25b6", // ▶
  idle: "\u00b7", // ·
};

// Mirrors the window-glyph colours: red needs you now, peach needs you soon,
// teal is finished-unseen, grey is busy or idle and carries no signal.
const COLOUR: Record<string, string> = {
  crashed: "\u001b[31m",
  blocked: "\u001b[33m",
  done: "\u001b[36m",
  working: "\u001b[37m",
  idle: "\u001b[90m",
};
// Built from a char class rather than written literally: a bare \u001b in a
// regex trips biome's noControlCharactersInRegex, and the rule is right that
// an invisible byte in a pattern is a hazard.
const ANSI_PATTERN = `${String.fromCharCode(27)}\\[[0-9;]*m`;
const ANSI_ESCAPE = new RegExp(ANSI_PATTERN, "g");
// Non-global twin for anchored single matches: `exec` on a /g/ regex carries
// lastIndex between calls, so reusing ANSI_ESCAPE inside a loop silently skips
// sequences.
const ANSI_AT_START = new RegExp(`^${ANSI_PATTERN}`);
const ANSI_AT_END = new RegExp(`(?:${ANSI_PATTERN})+$`);
// Remote rows get a colour of their own: cyan reads as "elsewhere" without
// competing with the state colours, which own red/peach/teal.
const REMOTE = "\u001b[36m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

// Attention order, and the order the prompt counts appear in.
const URGENCY = ["crashed", "blocked", "done", "working", "idle"] as const;

/**
 * Column widths, in one place because the header and the rows must agree. They
 * were duplicated as literals in two functions and had already drifted by a
 * column once.
 */
const COLUMNS = {
  glyph: 3, // marker + state glyph
  state: 8,
  name: 30,
  stream: 13,
  streamWide: 18, // when no host column is shown
  host: 14,
} as const;

/**
 * The column header fzf pins above the list.
 *
 * Built from COLUMNS so it cannot drift from the rows, and dim so it reads as
 * furniture rather than as an agent.
 */
export function headerRow(showHost: boolean): string {
  return [
    " ".repeat(COLUMNS.glyph),
    pad("state", COLUMNS.state),
    pad("agent", COLUMNS.name),
    pad("stream", showHost ? COLUMNS.stream : COLUMNS.streamWide),
    showHost ? pad("host", COLUMNS.host) : "",
    "age / flags",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * State filter keys — an axis kept separate from the text query, so ctrl-b
 * shows blocked agents rather than searching for the word "blocked" (which
 * would also match an agent merely *named* that). Inherited wholesale from the
 * old picker, including the choice to shadow fzf defaults: the query here is a
 * word or two, so home/left/bspace still cover the editing jobs.
 */
const FILTER_KEYS: [string, string][] = [
  ["ctrl-a", ""],
  ["ctrl-x", "crashed"],
  ["ctrl-b", "blocked"],
  ["ctrl-d", "done"],
  ["ctrl-w", "working"],
];

function timestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Human age. Blank under a minute: a row that just changed does not need a
 * column saying so, and "0s" on every live agent is noise that hides the one
 * row reading "3h".
 */
function age(ms: number | null): string {
  if (ms === null || ms < 60_000) return "";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

/**
 * Fit a cell to exactly `width` visible columns, padding or truncating.
 *
 * Both halves are needed. Padding counts VISIBLE length, because a value
 * wrapped in bold plus reset carries nine escape bytes and `padEnd` counts
 * them, which pads nine short and shears every column to its right.
 *
 * Truncating is what was missing: `pad` only ever grew a string, so one long
 * agent name ("Gchatui 2026 Rebaseline Finalization", 36 chars in a 30-wide
 * column) pushed the host and flags columns right and broke the grid for that
 * row only. Long pi session names are the normal case, not an edge one.
 *
 * The truncation walks the string and copies escape sequences through without
 * counting them, so a cut never lands inside one. Cutting mid-sequence would
 * leak the colour into the rest of the line and drop the reset that ends it.
 */
function pad(value: string, width: number): string {
  const visible = [...value.replace(ANSI_ESCAPE, "")].length;
  if (visible <= width) return value + " ".repeat(width - visible);

  // Room for the ellipsis, which is one column wide.
  const budget = Math.max(0, width - 1);
  let out = "";
  let shown = 0;
  let index = 0;
  while (index < value.length && shown < budget) {
    const sequence = ANSI_AT_START.exec(value.slice(index));
    if (sequence) {
      out += sequence[0];
      index += sequence[0].length;
      continue;
    }
    out += value[index];
    index += 1;
    shown += 1;
  }
  // Copy any trailing escapes (the reset) so the cell closes its own styling.
  const tail = value.slice(index).match(ANSI_AT_END);
  return `${out}\u2026${tail?.[0] ?? ""}${" ".repeat(Math.max(0, width - budget - 1))}`;
}

/**
 * One fzf row: a hidden key column, a hidden filter column, then the label.
 *
 * The key is `agent_id`, not a tmux target: a target only means something on
 * the agent's own host, so resolving it is `jumpToAgent`'s job once a selection
 * comes back.
 */
export function pickerRow(agent: Agent, showHost: boolean, current: boolean, local = true): string {
  const state = agent.state ?? "idle";
  const colour = COLOUR[state] ?? "";
  const glyph = GLYPH[state] ?? "?";
  const marker = current ? `${BOLD}\u25c6${RESET}` : " "; // ◆ you are here
  // Richest name first: mu names its agents, pi names its sessions, tmux names
  // windows. All three travel on the event, recorded by the node that owns the
  // pane, so this reads the same for a local and a remote agent.
  const name = agent.agent_name ?? agent.pi_session ?? agentLabel(agent);
  // Local and remote must be tellable apart at a glance. Two hostnames in one
  // dim column means you have to know your own machine's name to read the list
  // — and the difference is not cosmetic: a local row is a keystroke away, a
  // remote one costs an ssh and a nested tmux.
  //
  // "here" rather than the local hostname, because the reader already knows
  // which machine they are on; what they need is which rows are not it. Remote
  // hosts keep their name and get an arrow, so the column scans as "here /
  // elsewhere" before you read any words.
  // Both forms start in the same column: a leading space where the arrow would
  // be, so "here" and "→ bubba" line up and the arrows form a single vertical
  // run you can scan without reading a word.
  const host = showHost
    ? local
      ? `${DIM}  here${RESET}`
      : `${REMOTE}\u2192 ${terminalText(agent.host)}${RESET}`
    : "";
  // Workstream if mu set one, otherwise the tmux session name. Both answer
  // "which piece of work is this", and only mu-spawned agents have a
  // workstream, so the column was empty for most human agents.
  //
  // The session name is also what the tms picker shows and what you have
  // trained yourself to search on: a session called `hacking/murmur` holding a
  // pi whose window is named `Python` was unfindable by typing `murmur`. This
  // is the one thing tms had that murmur did not, and folding whole sessions
  // into this list was the wrong way to get it -- a session without an agent
  // has no place here.
  const group = agent.workstream ?? agent.session_name;
  const workstream = group ? `${DIM}${terminalText(group)}${RESET}` : "";
  // Two ages, and the one worth showing is how old the AGENT'S news is, not
  // how recently we reached its host. A peer we polled a second ago can be
  // serving events from three hours back — which read as fresh until this
  // column existed. `unreachable` is the other axis: the replica itself is old.
  const flags = [
    agent.driver === "orchestrated" ? "crew" : "",
    agent.stale ? "unreachable" : "",
    // A jump already proved this one dead. Say so plainly rather than leaving
    // the row looking merely old, and sort it last.
    agent.tmux_down ? "no tmux" : "",
    age(agent.event_age_ms),
  ]
    .filter(Boolean)
    .join(" ");
  // The state word is IN the label, not a hidden column. fzf's --with-nth
  // re-indexes fields, so any --nth that excluded the label broke plain
  // name matching (typing "glance" returned 0/4). Keeping state visible costs
  // eight columns and makes both the ctrl-key filters and text search work on
  // one field set — and the word is worth reading anyway.
  const label = [
    `${marker} ${colour}${glyph}${RESET}`,
    `${colour}${pad(state, COLUMNS.state)}${RESET}`,
    pad(`${BOLD}${terminalText(name)}${RESET}`, COLUMNS.name),
    pad(workstream, showHost ? COLUMNS.stream : COLUMNS.streamWide),
    showHost ? pad(host, COLUMNS.host) : "",
    flags ? `${DIM}${flags}${RESET}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `${agent.agent_id}\t${label}`;
}

function previewText(store: Store, agent: Agent): string {
  const state = agent.state ?? "idle";
  const colour = COLOUR[state] ?? "";
  const head = [
    `${colour}${GLYPH[state] ?? "?"} ${state}${RESET}  ${BOLD}${agent.agent_name ? terminalText(agent.agent_name) : agentLabel(agent)}${RESET}`,
    // Says where, and whether "where" is this machine. The glance below is a
    // local capture-pane or an ssh depending on this one fact, so it belongs in
    // the header rather than being inferred from a hostname.
    agent.host_id === loadIdentity()?.host_id
      ? `${DIM}here  ${agentLocation(agent)}${RESET}`
      : `${REMOTE}\u2192 ${terminalText(agent.host)}${RESET}  ${DIM}${agentLocation(agent)}${RESET}`,
  ];
  const facts = [
    agent.workstream ? `stream   ${terminalText(agent.workstream)}` : "",
    agent.role ? `role     ${terminalText(agent.role)}` : "",
    agent.pi_session ? `session  ${terminalText(agent.pi_session)}` : "",
    agent.driver === "orchestrated" ? "driver   orchestrated (crew)" : "",
    agent.stale ? `fetched  ${age(agent.age_ms)} ago` : "",
  ].filter(Boolean);

  // The glance is the point of the preview: what is the agent actually doing.
  // Events are history and answer a different question, so they go underneath
  // and stay short.
  const pane = glance(store, agent);
  const live = pane?.trimEnd()
    ? [`${DIM}── pane ──${RESET}`, pane.trimEnd()]
    : [`${DIM}── pane ──${RESET}`, `${DIM}unavailable (host unreachable, or pane gone)${RESET}`];

  const events = store
    .allEvents()
    .filter((event) => event.agent_id === agent.agent_id)
    .slice(-PREVIEW_EVENTS);
  const history = events.length
    ? events.map((event) => {
        let message = terminalText(event.message);
        if (message.length > PREVIEW_MESSAGE_MAX) {
          message = `${message.slice(0, PREVIEW_MESSAGE_MAX)}…`;
        }
        const detail = message && message !== event.state ? `  ${message}` : "";
        return `${DIM}${timestamp(event.ts)}${RESET}  ${terminalText(event.state).padEnd(8)}${detail}`;
      })
    : [`${DIM}no recorded events${RESET}`];

  return [...head, "", ...facts, "", ...live, "", `${DIM}── history ──${RESET}`, ...history].join(
    "\n",
  );
}

/**
 * Emit the preview body for one agent. `murmur pick` re-invokes itself here so
 * fzf's `--preview` has a per-row command, rather than the picker precomputing
 * every preview up front — which would mean an ssh round-trip per remote agent
 * before the list even paints.
 */
export function runPreview(store: Store, agentId: string): void {
  // Runs as a child of a picker that has just collected, so it reads the store
  // directly rather than syncing again.
  const agent = status(store).agents.find((candidate) => candidate.agent_id === agentId);
  if (!agent) return;
  process.stdout.write(`${previewText(store, agent)}\n`);
}

export async function runPick(store: Store, options: PickOptions = {}): Promise<void> {
  const identity = loadIdentity();
  const view = await statusWithCollect(store);
  const agents = view.agents.filter((agent) => options.all || agent.driver === "human");
  const hidden = view.agents.length - agents.length;

  if (agents.length === 0) {
    process.stdout.write(
      hidden ? `No human agents  (+${hidden} crew — rerun with --all)\n` : "No agents\n",
    );
    return;
  }

  const showHost = agents.some((agent) => agent.host_id !== identity?.host_id);
  const currentPane = process.env.TMUX_PANE ?? "";
  const input = agents
    .map((agent) =>
      pickerRow(agent, showHost, agent.pane === currentPane, agent.host_id === identity?.host_id),
    )
    .join("\n");

  const counts = new Map<string, number>();
  for (const agent of agents) {
    const state = agent.state ?? "idle";
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const prompt = URGENCY.filter((state) => counts.get(state))
    .map((state) => `${COLOUR[state]}${GLYPH[state]}${counts.get(state)}${RESET}`)
    .join(" ");

  const self = process.argv[1] ?? "murmur";
  const allFlag = options.all ? " --all" : "";
  // A preview beside the list needs room for both. Below ~150 columns the
  // 58% split squeezes the host and flags columns off the end, so start
  // stacked and let ctrl-p cycle from there.
  const width = process.stdout.columns ?? 0;
  const previewLayout =
    width > 0 && width < 150 ? "bottom:60%,border-top,wrap" : "right:58%,border-left,wrap";
  const preview = `${process.execPath} ${self} pick --preview {1}`;
  // Narrow on the hidden state column with an exact-prefix query, then restore
  // the real query. ctrl-a clears it.
  const filterBinds = FILTER_KEYS.flatMap(([key, state]) => [
    "--bind",
    state ? `${key}:change-query(${state})` : `${key}:change-query()`,
  ]);

  const result = spawnSync(
    "fzf",
    [
      "--delimiter",
      "\t",
      "--with-nth",
      "2..",
      "--ansi",
      // Literal substring matching, and matching only the visible columns.
      // Default fuzzy scatters query characters across the row: `re` matched
      // "Fix Murmur Pick Fzf Filter" as well as "recovered". A query here is a
      // word or two of an agent or workstream name, so substring is what the
      // fingers expect. Prefix a token with ' to opt back into fuzzy.
      // Same choice as the tms session picker, for consistency across the two.
      "--exact",
      // `begin` ranks earlier match positions higher, so `scratch` puts the
      // scratch workstream above a row that merely mentions it. `index` is the
      // empty-query fallback and preserves the attention order the fold
      // produced, which is the whole point of the list.
      "--tiebreak",
      "begin,index",
      "--layout",
      "reverse",
      "--border",
      "--info",
      "inline",
      "--prompt",
      `${prompt}${prompt ? "  " : ""}`,
      "--header",
      [
        `enter jump   ^r refresh   ^p preview   del forget   filter: ${FILTER_KEYS.map(
          ([key, state]) => `${key.replace("ctrl-", "^")} ${state || "all"}`,
        ).join(" ")}`,
        hidden ? `${hidden} crew hidden (--all)` : "",
        headerRow(showHost),
      ]
        .filter(Boolean)
        .join("\n"),
      "--preview",
      preview,
      // Narrow terminals cannot show both the columns and a 58% preview, and
      // the columns are the point of the list. ctrl-p cycles right / bottom /
      // hidden, so every column is reachable on a small viewport without
      // giving up the glance entirely.
      "--preview-window",
      previewLayout,
      "--bind",
      "ctrl-p:change-preview-window(bottom:60%,border-top,wrap|hidden|right:58%,border-left,wrap)",
      "--bind",
      `ctrl-r:reload(${process.execPath} ${self} pick --rows${allFlag})`,
      // Manual dismissal for a row nothing else will clear.
      //
      // The delete key, not a ctrl chord. ctrl-shift-d does not exist -- a
      // terminal sends the same bytes as ctrl-d -- and ctrl-alt-d, while it
      // does dispatch distinctly, sits one modifier away from ctrl-d in a
      // header that lists both. One is a filter and the other destroys a row,
      // so a near-miss is a deleted agent. `delete` is the key that already
      // means remove this, and it collides with no filter letter.
      "--bind",
      `delete:reload(${process.execPath} ${self} pick --forget {1}${allFlag})`,
      ...filterBinds,
      "--no-select-1",
      "--no-exit-0",
    ],
    {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
      // FZF_DEFAULT_OPTS can carry a conflicting layout or bindings from the
      // user's shell; the old picker stripped it for the same reason.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("FZF_DEFAULT_OPTS")),
      ),
    },
  );

  const selected = result.stdout?.trim().split("\t")[0];
  if (!selected) return;
  const agent = agents.find((candidate) => candidate.agent_id === selected);
  if (!agent) return;
  const jump = jumpToAgent(store, agent);
  // A popup closes the moment this returns, so a bare failure looked exactly
  // like "enter did nothing". Say what happened and fail loudly.
  if (!jump.ok) {
    process.stderr.write(`${jump.message}\n`);
    process.exitCode = 1;
  }
}

/**
 * Delete one agent, then print the remaining rows.
 *
 * One command rather than two because fzf's `reload` replaces the list with a
 * command's stdout: doing the delete and the reprint separately would race the
 * reload against the delete and redraw the row it had just removed.
 */
export async function runForget(
  store: Store,
  agentId: string,
  options: PickOptions = {},
): Promise<void> {
  const view = status(store);
  const agent = view.agents.find((candidate) => candidate.agent_id === agentId);
  if (agent) forgetOneAgent(store, agent);
  await runRows(store, options);
}

/** Print the row list only, for fzf's `reload` binding. */
export async function runRows(store: Store, options: PickOptions = {}): Promise<void> {
  const identity = loadIdentity();
  const view = await statusWithCollect(store);
  const agents = view.agents.filter((agent) => options.all || agent.driver === "human");
  const showHost = agents.some((agent) => agent.host_id !== identity?.host_id);
  const currentPane = process.env.TMUX_PANE ?? "";
  for (const agent of agents) {
    process.stdout.write(
      `${pickerRow(agent, showHost, agent.pane === currentPane, agent.host_id === identity?.host_id)}\n`,
    );
  }
}

export function registerPick(program: Command): void {
  program
    .command("pick")
    .description("Pick an agent and jump to it")
    .option("--all", "include orchestrated agents")
    .option("--preview <agent-id>", "render the preview pane for one agent (internal)")
    .option("--rows", "print picker rows only (internal, for reload)")
    .option("--forget <agent-id>", "drop one agent, then print rows (internal)")
    .action(
      async (options: PickOptions & { preview?: string; rows?: boolean; forget?: string }) => {
        const store = openStore();
        try {
          if (options.preview) runPreview(store, options.preview);
          else if (options.forget) await runForget(store, options.forget, options);
          else if (options.rows) await runRows(store, options);
          else await runPick(store, options);
        } finally {
          store.close();
        }
      },
    );
}
