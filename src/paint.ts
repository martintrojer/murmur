import { agentLabel, agentLocation, terminalText } from "./agents.js";
import { warmSocketCommand } from "./channel.js";
import { type GlanceRunner, glance } from "./glance.js";
import type { Status } from "./status.js";
import type { Store } from "./store.js";
import { age, NEEDS_HUMAN, type PaneView, renderState, wants } from "./view.js";

export const SIDE_PREVIEW_MIN_COLUMNS = 150;

export type GlancePlacement = "right" | "bottom";

export function glancePlacement(columns: number): GlancePlacement {
  return columns > 0 && columns < SIDE_PREVIEW_MIN_COLUMNS ? "bottom" : "right";
}

export function glanceShare(placement: GlancePlacement, preview = 0.75): number {
  return placement === "bottom" ? 0.6 : preview;
}

const PREVIEW_MESSAGE_MAX = 300;

// Same glyphs the tmux status bar and window labels use, so one symbol means
// one thing in every surface. Ported from the dotfiles' _tmux_common.
export const GLYPH: Record<string, string> = {
  crashed: "\u2717", // ✗
  blocked: "!",
  done: "\u2713", // ✓
  running: "\u25b6", // ▶
  idle: "\u00b7", // ·
};

// Mirrors the window-glyph colours: red needs you now, peach needs you soon,
// teal is finished-unseen, grey is busy or idle and carries no signal.
export const COLOUR: Record<string, string> = {
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
export const DIM = "\u001b[2m";
// For the column header only, so the grid's labels read as attached to the grid
// rather than as another line of preamble. Dim would have put them in the same
// register as the key legend, which is the confusion this exists to end.
const UNDERLINE = "\u001b[4m";
export const RESET = "\u001b[0m";

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
  return agent.driver === "human" || NEEDS_HUMAN.some((kind) => wants(agent, kind));
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
  // The remedy is `warmSocketCommand`, not a hand-written `ssh <host>`. The
  // shorter form shipped once and could not be relied on: OpenSSH defaults to
  // `ControlMaster no` and `ControlPath none`, so on a machine with no
  // ssh_config of its own a plain `ssh` leaves no socket where murmur looks --
  // the reader ran it, murmur still could not collect, and the notice kept
  // telling them to do the thing that had just failed. Built from the same
  // constant as `ControlPath`, so the suggestion cannot drift from where murmur
  // looks.
  //
  // Keyed on TARGET, not name: `peer add <name> [target]` takes them separately,
  // so a command built from the name is not guaranteed to run.
  const oldestTarget = oldest?.target ?? named[0] ?? "";
  return (
    `${attention}! ${named.join(", ")}: re-auth needed${RESET}` +
    `${COLOUR.blocked ?? ""} (last seen ${seen}) \u2014 ${BOLD}${warmSocketCommand(oldestTarget)}${RESET}`
  );
}

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
  const extra = agent.attention.map((entry) => entry.kind).filter((kind) => kind !== state);
  const flags = [
    agent.driver === "orchestrated" ? "crew" : "",
    // Freshness belongs to the NODE, stated rather than inferred from an age: a
    // stale node keeps its last-known fields, and the reader must be told so.
    agent.freshness === "stale" ? "stale host" : "",
    agent.attached_pane ? `attached here ${agent.attached_pane}` : "",
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

export function previewText(
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
    agent.attention.length
      ? `wants    ${agent.attention.map((entry) => entry.kind).join(", ")}`
      : "",
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
