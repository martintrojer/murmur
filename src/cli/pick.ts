import { spawn, spawnSync } from "node:child_process";
import type { Command } from "commander";
import {
  agentLabel,
  agentLocation,
  type JumpResult,
  jumpToAgent,
  terminalText,
} from "../agents.js";
import { warmSocketCommand } from "../channel.js";
import { type GlanceRunner, glance } from "../glance.js";
import { type Status, status, statusWithCollect } from "../status.js";
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
   * Warm the cache for next time. Injectable so a test does not fork ssh at the
   * real fleet, and so "was a refresh started at all" is assertable -- the
   * production one is detached and deliberately reports nothing.
   */
  collect?: (self: string) => void;
};

const spawnFzf: NonNullable<PickDeps["fzf"]> = (args, input, env) =>
  spawnSync("fzf", args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
    env,
  }).stdout ?? "";

/**
 * Refresh the cache in the background, for the NEXT invocation.
 *
 * Fire and forget, deliberately. The picker paints from cache and the fetch
 * cannot be shown without discarding what is on screen, so this exists to make
 * the cache warm rather than to update this list. One keypress of staleness, and
 * `^r` is there for a human who wants the fetch now.
 *
 * `detached` plus `unref` plus fully ignored stdio, all three load-bearing. The
 * picker normally runs in a `display-popup`, which is modal: a child sharing its
 * process group dies when the popup closes, and a child holding the popup's
 * stdio paints ssh diagnostics over the list. Detaching makes it a session
 * leader so it survives; ignoring stdio means it has nothing to draw on.
 *
 * Floored, unlike `^r`. This runs unattended on every launch, so an operator
 * flicking the picker open repeatedly would otherwise fan out ssh on every
 * keystroke -- which is the quadratic-in-a-mesh problem COLLECT_FLOOR_MS exists
 * to bound.
 */
function spawnCollect(self: string): void {
  try {
    const child = spawn(process.execPath, [self, "collect", "--quiet", "--floored"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // A warm cache is an optimisation; failing to start one must not fail a jump.
  }
}

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
// For the column header only, so the grid's labels read as attached to the grid
// rather than as another line of preamble. Dim would have put them in the same
// register as the key legend, which is the confusion this exists to end.
const UNDERLINE = "\u001b[4m";
const RESET = "\u001b[0m";

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
 * Built from COLUMNS so it cannot drift from the rows.
 *
 * UNDERLINED, not dim, and that is the whole distinction from the key legend
 * above it. This docstring used to claim it was dim and nothing made it so --
 * neither header line carried an escape code, so fzf painted the column labels
 * and the keybindings in one indistinguishable block. A column header is a
 * label FOR the grid beneath it and belongs visually attached to it; the legend
 * is a different kind of thing and now reads as one.
 *
 * The padding still happens outside the styling: `pad` counts visible columns,
 * but wrapping each cell would put an escape sequence between every column and
 * the grid has to line up with rows that style per cell.
 */
export function headerRow(showHost: boolean): string {
  const labels = [
    " ".repeat(COLUMNS.glyph),
    pad("state", COLUMNS.state),
    pad("agent", COLUMNS.name),
    pad("stream", showHost ? COLUMNS.stream : COLUMNS.streamWide),
    showHost ? pad("host", COLUMNS.host) : "",
    "age / flags",
  ]
    .filter(Boolean)
    .join(" ");
  return `${UNDERLINE}${labels}${RESET}`;
}

/** How many gated peers the header names before it stops. */
const NOTICE_PEERS = 3;

/**
 * The header line for peers that need an interactive session, or null.
 *
 * The header, not the prompt or a row, and each rejection matters: the prompt is
 * where `alt-a` stores the crew-toggle state via `$FZF_PROMPT`, so a
 * variable-length string there would collide with it; a synthetic row would
 * break the invariant that every row is a jumpable pane; and the preview is
 * unreachable when the peer contributes no rows at all -- which is exactly when
 * a lapsed session leaves the reader blind.
 *
 * Sorted oldest-first because that is the peer whose rows are most likely to
 * mislead, and TRIMMED with no counter: a truncated list plus a count is more
 * furniture than one header line can carry, and `murmur doctor` has the full
 * list.
 */
export function sessionNotice(peers: Status["peers"], now = Date.now()): string | null {
  const gated = peers
    .filter((peer) => peer.needs_session)
    // Null sorts first: never-reached is the oldest thing there is.
    .sort((left, right) => (left.fetched_at ?? 0) - (right.fetched_at ?? 0));
  if (gated.length === 0) return null;

  const named = gated.slice(0, NOTICE_PEERS).map((peer) => peer.name);
  const oldest = gated[0];
  // NOT `const age` -- `age` is already imported from view.js at the top of
  // this file, so that would shadow the function called on the next line.
  const seen =
    oldest?.fetched_at === null || oldest?.fetched_at === undefined
      ? "never"
      : // `age()` returns "" under a minute, which would read as "last seen )".
        age(now - oldest.fetched_at) || "just now";

  // BOLD and `blocked`'s yellow, not DIM. This is the one header line that asks
  // the reader to DO something, and DIM is this file's code for furniture -- the
  // keybinding legend and the column header wear it. Rendering an action in the
  // same weight as scenery is how it goes unread, which is the whole failure the
  // notice exists to prevent.
  //
  // Yellow rather than a new colour: COLOUR's documented vocabulary is "red
  // needs you now, peach needs you soon", and a lapsed login is exactly the
  // latter -- nothing is broken and nothing is lost, but the rows below are
  // ageing until you act. Reusing `blocked`'s colour keeps one meaning per hue
  // instead of teaching the reader a fourth.
  //
  // The `!` prefix is `blocked`'s glyph, so the line reads as the same class of
  // thing in the glyph column's own alphabet. The remedy stays undimmed because
  // it is the part meant to be copied.
  const attention = `${BOLD}${COLOUR.blocked ?? ""}`;
  // The remedy is `warmSocketCommand`, not a hand-written `ssh <host>`. That
  // shorter form was WRONG and shipped anyway: a plain `ssh` attaches as a
  // client or leaves a forward-only socket, so the reader ran it, murmur still
  // could not collect, and the notice kept telling them to do the thing that had
  // just failed. Built from the same constant as `ControlPath`, so the suggestion
  // cannot drift from where murmur looks.
  //
  // Keyed on TARGET, not name: `peer add <name> [target]` takes them separately,
  // so a command built from the name is not guaranteed to run.
  const oldestTarget = oldest?.target ?? named[0] ?? "";
  return (
    `${attention}! ${named.join(", ")}: re-auth needed${RESET}` +
    `${COLOUR.blocked ?? ""} (last seen ${seen}) \u2014 ${BOLD}${warmSocketCommand(oldestTarget)}${RESET}`
  );
}

/**
 * State filters, as [key, query]. An axis kept separate from the text query, so
 * a filter shows blocked panes rather than searching for the word "blocked",
 * which would also match a pane merely *named* that.
 *
 * Alt chords, not ctrl. `ctrl-b` was the filter for `blocked` and could never
 * fire: `C-b` is tmux's DEFAULT prefix and tmux consumes it before any pane
 * sees it, including the picker's popup -- so the most-reached-for filter was
 * dead on the setup the README tells people to build. murmur cannot know a
 * user's prefix, so any ctrl-letter is a gamble, while alt chords are never
 * prefix candidates. Verified against fzf in a real terminal.
 *
 * Ctrl aliases stay for the three that do not collide, so muscle memory works.
 * `ctrl-b` is deliberately absent: a key that silently does nothing is worse
 * than no key.
 *
 * No "clear the filter" key. fzf's ctrl-u already does it, and binding a second
 * spelling cost the word "all", which alt-a below needs.
 *
 * Every query is a `RenderState`, the word the row prints. The old `working`
 * filter outlived its state -- a busy pane paints `running` -- so `alt-w
 * working` matched nothing and read as "nothing is busy".
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
 * Fit a cell to exactly `width` visible columns, padding or truncating.
 *
 * Padding counts VISIBLE length: a value wrapped in bold plus reset carries
 * nine escape bytes, and `padEnd` counts them, padding nine short and shearing
 * every column to its right.
 *
 * Truncating bounds the other end. `pad` only ever grew a string, so one long
 * agent name (36 chars in a 30-wide column) pushed host and flags right and
 * broke the grid for that row -- and long pi session names are the normal case.
 * The walk copies escape sequences through without counting them, so a cut
 * never lands inside one, which would leak the colour into the rest of the line
 * and drop the reset that ends it.
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
 * tmux exports $TMUX to a popup but not $TMUX_PANE, since a popup is not a
 * pane. Outside tmux neither is set, so all three cases are distinguishable
 * without a tmux call.
 */
export function isPopup(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.TMUX) && !env.TMUX_PANE;
}

/**
 * One fzf row: two hidden key columns -- host and pane -- then the label.
 *
 * Keyed on host and pane rather than a tmux target, because a target only means
 * something on the agent's own host; resolving it is `jumpToAgent`'s job once a
 * selection comes back. See the return statement for why the pane, not an
 * agent id.
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
  // Richest name first, through the ONE chain in `agentLabel` rather than a copy
  // of its first links: mu names agents, pi names sessions, tmux names windows,
  // and all three travel in the snapshot so a local and a remote row read the
  // same. `agentLabel` shortens a session name to its leaf, so a local copy of
  // the chain would print the full path beside a preview printing the leaf.
  const name = agentLabel(agent);
  // "here" rather than this machine's hostname: the reader knows which machine
  // they are on and needs to see which rows are not it, and the difference is
  // not cosmetic -- a local row is a keystroke away, a remote one costs an ssh
  // and a nested tmux. Both forms start in the same column, so the arrows form a
  // vertical run you can scan without reading a word.
  const host = showHost
    ? local
      ? `${DIM}  here${RESET}`
      : `${REMOTE}\u2192 ${terminalText(agent.host)}${RESET}`
    : "";
  // Workstream if mu set one, otherwise the tmux session name: both answer
  // "which piece of work is this", and only mu-spawned agents have a workstream.
  // The session name is also what tms shows and what fingers search on -- a
  // session `hacking/murmur` holding a pi whose window is named `Python` was
  // unfindable by typing `murmur`.
  const group = agent.workstream ?? agent.session_name;
  // Never the same string twice in one row. Both columns fall back to the
  // session name, so an unnamed pi printed `hacking/murmur  hacking/murmur` and
  // spent thirteen columns saying nothing. Blank is honest: the name column
  // already carries the only fact there is.
  const workstream = group && group !== name ? `${DIM}${terminalText(group)}${RESET}` : "";
  // Attention and activity simultaneously. A running agent with `blocked`
  // attention is expected, and the row has room to say so rather than picking
  // one word and hiding the other.
  const extra = agent.attention.filter((kind) => kind !== state);
  const flags = [
    agent.driver === "orchestrated" ? "crew" : "",
    // Freshness belongs to the NODE, stated rather than inferred from an age: a
    // stale node keeps its last-known fields, and the reader must be told so.
    agent.freshness === "stale" ? "stale host" : "",
    ...extra,
    agent.activity === "running" && state !== "running" ? "running" : "",
    age(agent.updated_at === null ? null : Date.now() - agent.updated_at),
  ]
    .filter(Boolean)
    .join(" ");
  // The state word is IN the label, not a hidden column: fzf's --with-nth
  // re-indexes fields, so any --nth excluding the label broke plain name
  // matching (typing "glance" returned 0/4). Eight columns to make the filters
  // and text search share one field set, and the word is worth reading anyway.
  const label = [
    `${marker} ${colour}${glyph}${RESET}`,
    `${colour}${pad(state, COLUMNS.state)}${RESET}`,
    // No `terminalText` here: `agentLabel` already sanitised it, and wrapping it
    // again implied this value was raw.
    pad(`${BOLD}${name}${RESET}`, COLUMNS.name),
    pad(workstream, showHost ? COLUMNS.stream : COLUMNS.streamWide),
    showHost ? pad(host, COLUMNS.host) : "",
    flags ? `${DIM}${flags}${RESET}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  // Keyed on the PANE, not an agent id: the pane is the address and what jumps,
  // and an attention-only pane has no agent id -- so keying on one would make
  // exactly the rows that need a human unselectable.
  return `${agent.host_id}\t${agent.pane}\t${label}`;
}

function previewText(
  store: Store,
  agent: PaneView,
  // The already-resolved peer list, passed DOWN rather than re-read. `runPreview`
  // has called `status()` once already, and this runs per keypress as the cursor
  // moves, so a second read would double the ~20ms warm-socket probe
  // `needs_session` pays -- on the one path in murmur that cannot afford it.
  peers: Status["peers"],
  run?: GlanceRunner,
): string {
  const state = renderState(agent);
  const colour = COLOUR[state] ?? "";
  const head = [
    // Same one chain the row uses, not a fork whose true branch was what
    // `agentLabel` does first anyway.
    `${colour}${GLYPH[state] ?? "?"} ${state}${RESET}  ${BOLD}${agentLabel(agent)}${RESET}`,
    // Whether "where" is this machine decides if the glance below is a local
    // capture-pane or an ssh, so it is stated rather than inferred.
    agent.local
      ? `${DIM}here  ${agentLocation(agent)}${RESET}`
      : `${REMOTE}\u2192 ${terminalText(agent.host)}${RESET}  ${DIM}${agentLocation(agent)}${RESET}`,
  ];
  // Three independent facts, each named, visible at once: `activity` is what the
  // pane's process said, `attention` is who is wanted, `freshness` is how
  // recently we reached the node that said either.
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

  // The glance is the point of the preview: what the agent is actually doing.
  // No history section, because there is no history -- the store holds current
  // state only, the accepted price of one writer owning each fact.
  const pane = glance(store, agent, undefined, run);
  // Named, not guessed. The generic message is honest when murmur does not know
  // why a capture failed; when it does know, saying so is the difference between
  // a dead end and an action. Matched on `host`, which `paneViews` sets from
  // `peer.name` -- the name the operator typed, and so the name they can ssh.
  const gatedPeer = agent.local
    ? undefined
    : peers.find((peer) => peer.needs_session && peer.name === agent.host);
  const live = pane?.trimEnd()
    ? [
        `${DIM}\u2500\u2500 pane \u2500\u2500${RESET}`,
        pane.trimEnd().slice(-PREVIEW_MESSAGE_MAX * 20),
      ]
    : [
        `${DIM}\u2500\u2500 pane \u2500\u2500${RESET}`,
        gatedPeer
          ? `${DIM}needs an interactive session \u2014 ${warmSocketCommand(gatedPeer.target)}${RESET}`
          : `${DIM}unavailable (host unreachable, or pane gone)${RESET}`,
      ];

  return [...head, "", ...facts, "", ...live].join("\n");
}

/**
 * Emit the preview body for one pane. `murmur pick` re-invokes itself here so
 * fzf's `--preview` has a per-row command, rather than precomputing every
 * preview up front -- an ssh round-trip per remote pane before the list paints.
 */
export function runPreview(
  store: Store,
  paneId: string,
  hostId?: string,
  run?: GlanceRunner,
  // The warm-socket probe, threaded through so a test does not consult the
  // developer's REAL ssh sockets. Without this seam, whether the gated-peer
  // preview test passed depended on whether someone happened to have a session
  // open to that host -- it inverted the moment a master appeared, which is a
  // test asserting the state of the machine rather than the state of the code.
  warm?: (target: string) => boolean,
): void {
  const identity = requireIdentity();
  if (!identity) return;
  // Reads the cache, never collects: this runs per keypress as the cursor moves,
  // and the picker's background reload is what keeps the store current.
  //
  // Keyed on HOST AND PANE, the whole address. A pane id is unique per node and
  // nothing more, so two machines routinely hold a `%1` -- which is why fzf
  // hands both columns back. Matching on the pane alone previewed whichever row
  // the sort put first, so a local `capture-pane` stood in for a remote agent.
  const view = status(store, identity, Date.now(), warm);
  const agent = view.panes.find(
    (candidate) =>
      candidate.pane === paneId && (hostId === undefined || candidate.host_id === hostId),
  );
  // A miss is worth saying: this process's whole output is the preview, so
  // printing nothing is indistinguishable from a broken preview command, and
  // the row can genuinely vanish between the collect and the keypress.
  process.stdout.write(
    agent
      ? `${previewText(store, agent, view.peers, run)}\n`
      : `${DIM}${paneId} is no longer here.${RESET}\n`,
  );
}

export async function runPick(
  store: Store,
  options: PickOptions = {},
  deps: PickDeps = {},
): Promise<void> {
  const fzf = deps.fzf ?? spawnFzf;
  const jumpTo = deps.jump ?? jumpToAgent;
  const startCollect = deps.collect ?? spawnCollect;
  const identity = requireIdentity();
  if (!identity) return;
  // Cache only, and nothing on the launch path may wait for a collect: a peer
  // that is asleep or cannot authenticate costs the full ssh timeout, measured
  // at 1-3s against this fleet. The cached read is ~50ms.
  //
  // The refresh runs in a DETACHED process (see `spawnCollect`), not through an
  // fzf `start:reload`. A reload discards the rows fzf already has the instant
  // it starts -- verified by sampling a real fzf's screen inside tmux, which
  // showed `0/0` and a spinner at t=0.15s for both `reload` and `reload-sync`,
  // against `1/1` and the row with no start binding at all. So the binding that
  // was supposed to paint from cache blanked the list for the whole fetch and
  // moved the stall rather than removing it.
  const view = status(store, identity);
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

  // Started AFTER the rows are built and before fzf takes the terminal, so the
  // fork is never between the reader and the paint.
  startCollect(process.argv[1] ?? "murmur");

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
  // Narrow by putting the state word in the query. fzf's own ctrl-u clears it.
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
      // Literal substring, because default fuzzy scatters query characters
      // across the row: `re` matched "Fix Murmur Pick Fzf Filter" as well as
      // "recovered". A query here is a word or two of a name. Prefix a token
      // with ' to opt back into fuzzy. Same choice as the tms session picker.
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
      // character inside the first -- and the popup, via the prefix+a binding,
      // is the normal way to run this, so the doubled frame was what you saw
      // most. See `isPopup` for the detection.
      "--border",
      inPopup ? "none" : "rounded",
      "--info",
      "inline",
      "--prompt",
      `${options.all ? CREW_MARK : ""}${basePrompt}`,
      "--header",
      [
        // FIRST, above the legend, and only when it applies. It was below the two
        // legend lines, which put the one line asking for action underneath the
        // furniture -- and a warning printed under furniture reads as furniture.
        // Everything after it is static text a reader learns once and then stops
        // seeing, so anything conditional has to come before them to be noticed.
        sessionNotice(view.peers) ?? "",
        // DIM, both of them: these are the lines a reader learns once and then
        // stops seeing, which is what dim is for everywhere else in this file.
        // They carried no styling at all, so fzf painted them in the same plain
        // white as the column header directly below -- three different kinds of
        // line in one indistinguishable block. Keys are furniture, the column
        // labels belong to the grid, and the notice above is an action; each now
        // says which it is.
        //
        // No delete key: a reader holds one snapshot per peer and the next fetch
        // replaces it whole, so it could only remove a row the next collect puts
        // straight back, while looking like it had done something.
        `${DIM}enter jump   ^r refresh   ^p preview   ^u clear${RESET}`,
        // "toggle crew", not "show crew": the header is built once and the bind
        // flips per keypress, so a directional label would be wrong half the
        // time. The prompt's `crew` marker says which way it is set.
        `${DIM}filter: ${FILTER_KEYS.map(
          ([key, query]) => `${key.replace("alt-", "M-")} ${query}`,
        ).join(" ")}   M-a toggle crew${RESET}`,
        headerRow(showHost),
      ]
        .filter(Boolean)
        .join("\n"),
      "--preview",
      preview,
      // Narrow terminals cannot show both the columns and a 58% preview, and the
      // columns are the point. ctrl-p cycles right / bottom / hidden, so every
      // column is reachable without giving up the glance entirely.
      "--preview-window",
      previewLayout,
      "--bind",
      "ctrl-p:change-preview-window(bottom:60%,border-top,wrap|hidden|right:58%,border-left,wrap)",
      "--bind",
      `ctrl-r:reload(${process.execPath} ${self} pick --rows${allFlag})`,
      // M-a toggles the POPULATION, which is what "all" means everywhere else in
      // murmur. It used to be the "clear the query" key, also labelled "all",
      // and that collision is what made it look broken: it emptied the query
      // instead of revealing the crew rows named two lines below. Clearing is
      // fzf's own ctrl-u and needed no binding.
      //
      // `transform`, not a fixed reload: a bind string is built once at launch
      // and cannot know it has already fired, so `--rows --all` made the second
      // press re-run the first and the toggle only worked one way. transform
      // runs per keypress and can branch on the current state -- which lives in
      // the prompt, the only mutable string fzf exposes to a binding. CREW_MARK
      // rides at the front of it: visible as a label, readable via $FZF_PROMPT.
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
  // A fresh read of the FULL list, not `view` and not `agents`. The rows fzf
  // offered can have come from the `^r` or alt-a reload subprocesses, which
  // collect into the same store, so a pane only they discovered is absent from
  // this process's launch snapshot -- and filtering is a presentation concern
  // that must not gate the action. Resolving against either made the freshest
  // rows, exactly the ones a reload exists to reveal, display but not select:
  // fzf returned a key, find() returned undefined, and enter silently did
  // nothing.
  //
  // Matched on the WHOLE address. A pane id is unique per node and nothing more,
  // so two machines routinely hold a `%1`, and matching the pane alone jumped to
  // whichever the sort put first -- turning an ssh into a local window switch.
  const agent = status(store, identity).panes.find(
    (candidate) => candidate.pane === selected && candidate.host_id === selectedHost,
  );
  // So a miss means the pane genuinely went away between the collect and the
  // keypress. Worth saying, for the same reason as the `jump.ok` branch below:
  // in a popup a silent return is indistinguishable from a dead key.
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
  // Unfloored: this backs `^r refresh` and the alt-a reload, both of which are a
  // person asking now, and a refresh that skipped the fetch would be a key that
  // silently does nothing -- the failure `alt-a` and `ctrl-b` were already fixed
  // for. The launch-time background collect is the floored one, in `spawnCollect`.
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
