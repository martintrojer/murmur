import { spawn, spawnSync } from "node:child_process";
import type { Command } from "commander";
import { type JumpResult, jumpToAgent } from "../agents.js";
import { hasWarmSocket } from "../channel.js";
import type { GlanceRunner } from "../glance.js";
import { renderJumpCommand } from "../jump-command.js";
import { type Mux, tmux } from "../mux.js";
import {
  COLOUR,
  DIM,
  GLYPH,
  glancePlacement,
  glanceShare,
  headerRow,
  isVisible,
  pickerRow,
  previewText,
  RESET,
  sessionNotice,
} from "../paint.js";
import { status, statusWithCollect } from "../status.js";
import { openStore, type Store } from "../store.js";
import { type PaneView, RENDER_PRIORITY, type RenderState, renderState } from "../view.js";

export { headerRow, isVisible, pickerRow, previewText, sessionNotice } from "../paint.js";

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
  mux?: Mux;
  warm?: (target: string) => boolean;
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

/**
 * Marks the picker as showing orchestrated agents, at the front of the prompt.
 *
 * Doubles as the toggle's state: fzf exposes the prompt to a binding through
 * $FZF_PROMPT and nothing else is mutable, so this is both the label a human
 * reads and the flag the alt-a transform branches on.
 */
const CREW_MARK = "crew ";

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
  const localMux = deps.mux ?? tmux;
  const warm = deps.warm ?? hasWarmSocket;
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
  const view = status(store, identity, Date.now(), warm, undefined, { mux: localMux });
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
  const placement = glancePlacement(width);
  const share = glanceShare(placement, 0.58);
  const previewLayout =
    placement === "bottom"
      ? `bottom:${Math.round(share * 100)}%,border-top,wrap`
      : `right:${Math.round(share * 100)}%,border-left,wrap`;
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
        `${DIM}enter focus/jump   M-enter attach again   ^r refresh   ^p preview   ^u clear${RESET}`,
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
      "--expect",
      "alt-enter",
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

  const output = stdout.trim().split("\n");
  const attachAgain = output[0] === "alt-enter";
  const selection = attachAgain ? (output[1] ?? "") : (output.at(-1) ?? "");
  const [selectedHost, selected] = selection.split("\t");
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
  const latest = status(store, identity, Date.now(), warm, undefined, { mux: localMux });
  const agent = latest.panes.find(
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
  if (agent.attached_pane && !attachAgain) {
    if (!localMux.attach(agent.attached_pane)) {
      process.stderr.write(`could not focus local attachment ${agent.attached_pane}.\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (!agent.local) {
    const peer = store.peers().find((candidate) => candidate.host_id === agent.host_id);
    const needsTap = latest.peers.find((candidate) => candidate.name === agent.host)?.needs_session;
    if (peer && needsTap) {
      const command = renderJumpCommand(peer.jump_command, agent.pane);
      const confirmed = fzf(
        [
          "--ansi",
          "--layout",
          "reverse",
          "--prompt",
          "tap required> ",
          "--header",
          `This jump may prompt for a hardware token tap.\n${command}\nenter jump   esc cancel`,
          "--no-multi",
        ],
        "jump\tcontinue",
        process.env,
      );
      if (confirmed.trim().split("\t")[0] !== "jump") return;
    }
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
