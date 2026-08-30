import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import {
  agentLabel,
  agentLocation,
  type JumpResult,
  jumpToAgent,
  terminalText,
} from "../agents.js";
import { ssh } from "../channel.js";
import { glance } from "../glance.js";
import { type Mux, tmux } from "../mux.js";
import { status, statusWithCollect } from "../status.js";
import { openStore, type Store } from "../store.js";
import {
  age,
  NEEDS_HUMAN,
  type PaneView,
  RENDER_PRIORITY,
  type RenderState,
  renderState,
} from "../view.js";
import { requireIdentity } from "./identity-guard.js";

type PickOptions = { all?: boolean };

/**
 * The two effects `runPick` has on the world: it runs fzf, and it jumps.
 *
 * Injectable because everything interesting about the picker happens BETWEEN
 * those two calls -- which id fzf returns, and which agent that id resolves
 * to -- and with both hard-wired that stretch had no coverage at all. The crew
 * rows revealed by alt-a looked selectable but could not be jumped to for
 * exactly as long as this seam did not exist.
 */
type PickDeps = {
  fzf?: (args: string[], input: string, env: NodeJS.ProcessEnv) => string;
  jump?: (store: Store, agent: PaneView) => JumpResult;
  /**
   * The mux the pre-read collect reconciles against.
   *
   * Injectable because collect deletes any agent whose pane the mux does not
   * list, and that is the right behaviour in production and fatal in a test: a
   * test that claims `%9` in a temp database was reconciled against the REAL
   * tmux server of whoever ran it. `npm run check` then passed on a machine
   * with no tmux -- `livePanes()` returns null, which is a no-op -- and failed
   * inside tmux, where the fixture pane genuinely does not exist.
   */
  mux?: Mux;
};

const spawnFzf: NonNullable<PickDeps["fzf"]> = (args, input, env) =>
  spawnSync("fzf", args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
    env,
  }).stdout ?? "";

const PREVIEW_MESSAGE_MAX = 300;

// Same glyphs the tmux status bar and window labels use, so one symbol means
// one thing in every surface. Ported from the dotfiles' _tmux_common.
const GLYPH: Record<string, string> = {
  crashed: "\u2717", // ✗
  blocked: "!",
  done: "\u2713", // ✓
  running: "\u25b6", // ▶
  idle: "\u00b7", // ·
};

// Mirrors the window-glyph colours: red needs you now, peach needs you soon,
// teal is finished-unseen, grey is busy or idle and carries no signal.
const COLOUR: Record<string, string> = {
  crashed: "\u001b[31m",
  blocked: "\u001b[33m",
  done: "\u001b[36m",
  running: "\u001b[37m",
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

// The order the prompt COUNTS appear in: RENDER_PRIORITY, imported rather than
// restated, so this file and status.ts cannot disagree about whether `crashed`
// or `blocked` leads.

/**
 * Marks the picker as showing orchestrated agents, at the front of the prompt.
 *
 * Doubles as the toggle's state: fzf exposes the prompt to a binding through
 * $FZF_PROMPT and nothing else is mutable, so this is both the label a human
 * reads and the flag the alt-a transform branches on.
 */
const CREW_MARK = "crew ";

/**
 * Whether an agent belongs in the default list.
 *
 * Orchestrated agents are hidden because their supervisor consumes the result:
 * a `done` worker needs no acknowledgement from you, and a `working` one asks
 * for nothing. `--all` shows them.
 *
 * The exceptions are `NEEDS_HUMAN` in view.ts, shared with the status bar's
 * count rule so the two surfaces cannot disagree about which crew rows matter.
 * Hiding those behind a flag meant the rows that needed a human were the ones a
 * human could not see.
 */
export function isVisible(agent: PaneView): boolean {
  return agent.driver === "human" || NEEDS_HUMAN.some((kind) => agent.attention.includes(kind));
}

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
 * State filters, as [key, query]. An axis kept separate from the text query, so
 * a filter shows blocked panes rather than searching for the word "blocked",
 * which would also match a pane merely *named* that.
 *
 *
 * Alt chords, not ctrl. `ctrl-b` was the filter for `blocked` and it could
 * never work: `C-b` is tmux's DEFAULT prefix, and tmux consumes the prefix
 * before delivering to any pane -- including the display-popup the picker runs
 * in. So the one filter a user reaches for most was dead on a stock tmux, which
 * is the configuration the README tells people to set up.
 *
 * The general problem is that murmur cannot know a user's prefix, so any single
 * ctrl-letter is a gamble. Alt chords are never prefix candidates: tmux's
 * `prefix` option takes a ctrl key by convention and nobody binds M-x at the
 * root table for this purpose. Verified against fzf in a real terminal.
 *
 * Ctrl aliases are kept for the three that do not collide with the default
 * prefix, so existing muscle memory still works. `ctrl-b` is deliberately not
 * among them: binding a key that silently does nothing is worse than not
 * binding it.
 *
 * There is no "clear the filter" key here. fzf already clears the query with
 * ctrl-u, a standard readline binding that needs no --bind, so one existed --
 * and binding a second spelling of it cost the word "all", which this picker
 * needs for something else. See the alt-a toggle below.
 *
 * Every query is a `RenderState`, because that is the word the row prints. The
 * `working` filter outlived the state it searched for: activity and attention
 * are separate facts now and a busy pane paints `running`, so `alt-w working`
 * narrowed the list to nothing and read exactly like "nothing is busy".
 */
export const FILTER_KEYS: [key: string, query: RenderState][] = [
  ["alt-x", "crashed"],
  ["alt-b", "blocked"],
  ["alt-d", "done"],
  ["alt-w", "running"],
];

/** Ctrl aliases that are safe against tmux's default `C-b` prefix. */
export const FILTER_ALIASES: [key: string, query: RenderState][] = [
  ["ctrl-x", "crashed"],
  ["ctrl-d", "done"],
  ["ctrl-w", "running"],
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
 * Are we running inside a `display-popup` rather than a pane?
 *
 * tmux exports $TMUX to a popup but not $TMUX_PANE, because a popup is not a
 * pane. Outside tmux neither is set, so the three cases stay distinguishable
 * with no tmux call.
 */
export function isPopup(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.TMUX) && !env.TMUX_PANE;
}

/**
 * One fzf row: a hidden key column, a hidden filter column, then the label.
 *
 * The key is `agent_id`, not a tmux target: a target only means something on
 * the agent's own host, so resolving it is `jumpToAgent`'s job once a selection
 * comes back.
 */
export function pickerRow(
  agent: PaneView,
  showHost: boolean,
  current: boolean,
  local = agent.local,
): string {
  // One derivation, shared with the status bar: attention first, then activity.
  const state = renderState(agent);
  const colour = COLOUR[state] ?? "";
  const glyph = GLYPH[state] ?? "?";
  const marker = current ? `${BOLD}\u25c6${RESET}` : " "; // ◆ you are here
  // Richest name first: mu names its agents, pi names its sessions, tmux names
  // windows. All three travel in the snapshot, recorded by the node that owns
  // the pane, so this reads the same for a local and a remote agent.
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
  // pi whose window is named `Python` was unfindable by typing `murmur`. A
  // session without an agent still has no place in this list.
  const group = agent.workstream ?? agent.session_name;
  // Never the same string twice in one row. Both columns fall back to the tmux
  // session name, so an unnamed pi -- no mu agent name, no `/name`, a window
  // name tmux is auto-renaming -- printed `hacking/murmur  hacking/murmur` and
  // spent thirteen columns saying nothing. A blank cell is the honest answer:
  // the name column already carries the only fact there is.
  const workstream = group && group !== name ? `${DIM}${terminalText(group)}${RESET}` : "";
  // Two ages, and the one worth showing is how old the AGENT'S news is, not
  // how recently we reached its host. A peer we polled a second ago can be
  // serving a snapshot from three hours back — which read as fresh until this
  // column existed. `unreachable` is the other axis: the cache itself is old.
  // Both attention and activity, simultaneously. A running agent with `blocked`
  // attention is a real and expected state, and the row has room to say so
  // rather than picking one word and hiding the other.
  const extra = agent.attention.filter((kind) => kind !== state);
  const flags = [
    agent.driver === "orchestrated" ? "crew" : "",
    // Freshness is a property of the NODE, and it is stated explicitly rather
    // than inferred from an age: a stale node keeps its last-known fields, and
    // the reader has to be told those fields are old.
    agent.freshness === "stale" ? "stale host" : "",
    ...extra,
    agent.activity === "running" && state !== "running" ? "running" : "",
    age(agent.updated_at === null ? null : Date.now() - agent.updated_at),
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
  // Keyed on the PANE, not on an agent id. The pane is the address, it is what
  // jumps, and an attention-only pane has no agent id at all -- so keying on one
  // would make exactly the rows that need a human unselectable.
  return `${agent.host_id}\t${agent.pane}\t${label}`;
}

function previewText(store: Store, agent: PaneView): string {
  const state = renderState(agent);
  const colour = COLOUR[state] ?? "";
  const head = [
    `${colour}${GLYPH[state] ?? "?"} ${state}${RESET}  ${BOLD}${agent.agent_name ? terminalText(agent.agent_name) : agentLabel(agent)}${RESET}`,
    // Says where, and whether "where" is this machine. The glance below is a
    // local capture-pane or an ssh depending on this one fact, so it belongs in
    // the header rather than being inferred from a hostname.
    agent.local
      ? `${DIM}here  ${agentLocation(agent)}${RESET}`
      : `${REMOTE}\u2192 ${terminalText(agent.host)}${RESET}  ${DIM}${agentLocation(agent)}${RESET}`,
  ];
  // The three facts, each named, because they are independent and a reader has
  // to be able to see all three at once. `activity` is what the pane's own
  // process said; `attention` is who is wanted; `freshness` is how recently we
  // reached the node that said either.
  const facts = [
    `activity ${agent.activity ?? "none (attention only)"}`,
    agent.attention.length ? `wants    ${agent.attention.join(", ")}` : "",
    agent.workstream ? `stream   ${terminalText(agent.workstream)}` : "",
    agent.role ? `role     ${terminalText(agent.role)}` : "",
    agent.pi_session ? `session  ${terminalText(agent.pi_session)}` : "",
    agent.cli ? `cli      ${terminalText(agent.cli)}` : "",
    agent.driver === "orchestrated" ? "driver   orchestrated (crew)" : "",
    // Two ages, never one. A node polled a second ago can be serving a
    // three-hour-old fact, and collapsing them is how that read as fresh.
    agent.updated_at === null ? "" : `said     ${timestamp(agent.updated_at)}`,
    agent.local
      ? ""
      : `fetched  ${agent.fetched_at === null ? "never" : timestamp(agent.fetched_at)}`,
    agent.freshness === "stale" ? `${DIM}host is stale: fields below are last-known${RESET}` : "",
  ].filter(Boolean);

  // The glance is the point of the preview: what is the agent actually doing.
  // There is no history section any more, because there is no history -- the
  // store holds current state only, which is the accepted limitation this
  // rewrite takes in exchange for a model where one writer owns each fact.
  const pane = glance(store, agent);
  const live = pane?.trimEnd()
    ? [
        `${DIM}\u2500\u2500 pane \u2500\u2500${RESET}`,
        pane.trimEnd().slice(-PREVIEW_MESSAGE_MAX * 20),
      ]
    : [
        `${DIM}\u2500\u2500 pane \u2500\u2500${RESET}`,
        `${DIM}unavailable (host unreachable, or pane gone)${RESET}`,
      ];

  return [...head, "", ...facts, "", ...live].join("\n");
}

/**
 * Emit the preview body for one pane. `murmur pick` re-invokes itself here so
 * fzf's `--preview` has a per-row command, rather than the picker precomputing
 * every preview up front — which would mean an ssh round-trip per remote pane
 * before the list even paints.
 */
export function runPreview(store: Store, paneId: string, hostId?: string): void {
  const identity = requireIdentity();
  if (!identity) return;
  // Runs as a child of a picker that has just collected, so it reads the store
  // directly rather than syncing again.
  //
  // Keyed on HOST AND PANE, which is the whole address. A pane id is unique per
  // node and nothing more, so two machines routinely hold a `%1`; fzf hands both
  // columns back for exactly this reason. Matching on the pane alone previewed
  // whichever row the sort happened to put first, and for a local hit that meant
  // a local `capture-pane` standing in for a remote agent.
  const agent = status(store, identity).panes.find(
    (candidate) =>
      candidate.pane === paneId && (hostId === undefined || candidate.host_id === hostId),
  );
  // A miss is worth saying. This process's entire output is the preview, so
  // printing nothing is indistinguishable from a broken preview command -- and
  // the row can genuinely vanish between the collect and the keypress.
  process.stdout.write(
    agent ? `${previewText(store, agent)}\n` : `${DIM}${paneId} is no longer here.${RESET}\n`,
  );
}

export async function runPick(
  store: Store,
  options: PickOptions = {},
  deps: PickDeps = {},
): Promise<void> {
  const fzf = deps.fzf ?? spawnFzf;
  const jumpTo = deps.jump ?? jumpToAgent;
  const identity = requireIdentity();
  if (!identity) return;
  const view = await statusWithCollect(store, identity, Date.now(), ssh, deps.mux ?? tmux);
  const agents = view.panes.filter((agent) => options.all || isVisible(agent));
  const hidden = view.panes.length - agents.length;

  if (agents.length === 0) {
    process.stdout.write(
      hidden ? `No human agents  (+${hidden} crew — rerun with --all)\n` : "No agents\n",
    );
    return;
  }

  const showHost = agents.some((agent) => !agent.local);
  const currentPane = process.env.TMUX_PANE ?? "";
  const input = agents
    .map((agent) => pickerRow(agent, showHost, agent.pane === currentPane))
    .join("\n");

  const counts = new Map<string, number>();
  for (const agent of agents) {
    const state = renderState(agent);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const prompt = RENDER_PRIORITY.filter((state) => counts.get(state))
    .map((state) => `${COLOUR[state]}${GLYPH[state]}${counts.get(state)}${RESET}`)
    .join(" ");
  const basePrompt = `${prompt}${prompt ? "  " : ""}`;

  const self = process.argv[1] ?? "murmur";
  const allFlag = options.all ? " --all" : "";
  const inPopup = isPopup(process.env);
  // A preview beside the list needs room for both. Below ~150 columns the
  // 58% split squeezes the host and flags columns off the end, so start
  // stacked and let ctrl-p cycle from there.
  const width = process.stdout.columns ?? 0;
  const previewLayout =
    width > 0 && width < 150 ? "bottom:60%,border-top,wrap" : "right:58%,border-left,wrap";
  // Keyed on the pane, which is the address, and on the host so the preview can
  // tell a local pane from a remote one with the same pane id.
  const preview = `${process.execPath} ${self} pick --preview {2} --host {1}`;
  // Narrow on the hidden state column with an exact-prefix query, then restore
  // the real query. ctrl-a clears it.
  const filterBinds = [
    ...FILTER_KEYS.map(([key, query]) => [key, query] as const),
    ...FILTER_ALIASES,
  ].flatMap(([key, query]) => [
    "--bind",
    query ? `${key}:change-query(${query})` : `${key}:change-query()`,
  ]);

  const stdout = fzf(
    [
      "--delimiter",
      "\t",
      "--with-nth",
      "3..",
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
      // empty-query fallback and preserves the attention order `viewSort`
      // produced, which is the whole point of the list.
      "--tiebreak",
      "begin,index",
      "--layout",
      "reverse",
      // `display-popup` draws its own border, so fzf's is a second one a
      // character inside the first. A popup is the normal way to run this, via
      // the prefix+a binding, so the doubled frame was what you saw most.
      //
      // Detected by $TMUX set with $TMUX_PANE unset: tmux exports TMUX to a
      // popup but not TMUX_PANE, since a popup is not a pane. Outside tmux
      // neither is set, so the three cases stay distinguishable.
      "--border",
      inPopup ? "none" : "rounded",
      "--info",
      "inline",
      "--prompt",
      `${options.all ? CREW_MARK : ""}${basePrompt}`,
      "--header",
      [
        // No `del forget`. There is no replica to evict: a reader holds one
        // snapshot per peer, and the next fetch replaces it whole -- so a delete
        // key could only remove a row the next collect would put straight back,
        // while looking like it had done something.
        `enter jump   ^r refresh   ^p preview   ^u clear`,
        // "toggle crew", not "show crew": the header is built once and the
        // binding flips per keypress, so a directional label would be wrong
        // half the time. The prompt's `crew` marker says which way it is
        // currently set.
        `filter: ${FILTER_KEYS.map(([key, query]) => `${key.replace("alt-", "M-")} ${query}`).join(
          " ",
        )}   M-a toggle crew`,
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
      // M-a toggles the POPULATION, which is what "all" means everywhere else in
      // murmur: the --all flag, and the "crew hidden (--all)" notice.
      //
      // It used to be the "clear the filter" key, labelled "all", which is the
      // collision that made it look broken: pressing it emptied the query
      // instead of revealing the hidden crew rows named two lines below, and
      // nothing said why. One word, two meanings, and the wrong one bound to
      // the key people reach for. Clearing is fzf's own ctrl-u, which needed no
      // binding at all.
      //
      // `transform` rather than a fixed reload, because a bind string is built
      // once at launch and cannot know it has already fired: binding
      // `--rows --all` meant the second press re-ran the same thing and the
      // toggle only worked one way. transform runs a shell snippet per
      // keypress, so it can branch on the current state.
      //
      // The state lives in the prompt, which is the only mutable string fzf
      // exposes to a binding. CREW_MARK is carried at the front of it: visible
      // as a label, and readable back through $FZF_PROMPT.
      "--bind",
      `alt-a:transform:[[ $FZF_PROMPT == "${CREW_MARK}"* ]] && echo "reload(${process.execPath} ${self} pick --rows)+change-prompt(${basePrompt})" || echo "reload(${process.execPath} ${self} pick --rows --all)+change-prompt(${CREW_MARK}${basePrompt})"`,
      ...filterBinds,
      "--no-select-1",
      "--no-exit-0",
    ],
    input,
    // FZF_DEFAULT_OPTS can carry a conflicting layout or bindings from the
    // user's shell; the old picker stripped it for the same reason.
    Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("FZF_DEFAULT_OPTS")),
    ),
  );

  const [selectedHost, selected] = stdout.trim().split("\t");
  if (!selected) return;
  // Resolved against the UNFILTERED list, not `agents`. `agents` is what this
  // process printed at launch; alt-a reloads the rows from a SUBPROCESS, so a
  // crew row revealed that way was never in the parent's array. fzf returned
  // its key, find() returned undefined, and enter did nothing — the reveal
  // shipped able to show rows it could not select. Filtering is a presentation
  // concern and must not gate the action; the key fzf hands back is
  // authoritative.
  // The WHOLE address, host and pane. A pane id is unique per node and nothing
  // more, so two machines routinely hold a `%1`; matching on the pane alone
  // jumped to whichever one the sort happened to put first, which turns an ssh
  // into a local window switch.
  const agent = view.panes.find(
    (candidate) => candidate.pane === selected && candidate.host_id === selectedHost,
  );
  // So a miss here means the pane is genuinely gone between the collect and
  // the keypress, and that is worth saying. Same argument as the jump.ok
  // branch below: in a popup, a silent return is indistinguishable from a dead
  // key.
  if (!agent) {
    process.stderr.write(`${selected} is no longer here.\n`);
    process.exitCode = 1;
    return;
  }
  const jump = jumpTo(store, agent);
  // A popup closes the moment this returns, so a bare failure looked exactly
  // like "enter did nothing". Say what happened and fail loudly.
  if (!jump.ok) {
    process.stderr.write(`${jump.message}\n`);
    process.exitCode = 1;
  }
}

/** Print the row list only, for fzf's `reload` binding. */
async function runRows(store: Store, options: PickOptions = {}): Promise<void> {
  const identity = requireIdentity();
  if (!identity) return;
  const view = await statusWithCollect(store, identity);
  const agents = view.panes.filter((agent) => options.all || isVisible(agent));
  const showHost = agents.some((agent) => !agent.local);
  const currentPane = process.env.TMUX_PANE ?? "";
  for (const agent of agents) {
    process.stdout.write(`${pickerRow(agent, showHost, agent.pane === currentPane)}\n`);
  }
}

export function registerPick(program: Command): void {
  program
    .command("pick")
    .description("Pick an agent and jump to it")
    .option("--all", "include orchestrated agents")
    .option("--preview <pane>", "render the preview pane for one pane (internal)")
    .option("--host <host-id>", "host of the pane being previewed (internal)")
    .option("--rows", "print picker rows only (internal, for reload)")
    .action(async (options: PickOptions & { preview?: string; host?: string; rows?: boolean }) => {
      const store = openStore();
      try {
        if (options.preview) runPreview(store, options.preview, options.host);
        else if (options.rows) await runRows(store, options);
        else await runPick(store, options);
      } finally {
        store.close();
      }
    });
}
