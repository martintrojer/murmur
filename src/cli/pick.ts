import { spawn, spawnSync } from "node:child_process";
import type { Command } from "commander";
import { type JumpResult, jumpToAgent } from "../agents.js";
import { hasWarmSocket } from "../channel.js";
import { renderJumpCommand } from "../jump-command.js";
import { type Mux, tmux } from "../mux.js";
import { COLOUR, GLYPH, headerRow, isVisible, pickerRow, RESET, sessionNotice } from "../paint.js";
import { status, statusWithCollect } from "../status.js";
import { openStore, type Store } from "../store.js";
import { type PaneView, RENDER_PRIORITY, renderState } from "../view.js";

export { headerRow, isVisible, pickerRow, sessionNotice } from "../paint.js";

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
 * the cache warm rather than to update this list. One keypress of staleness is
 * the price; `murmur dash` is where a live view lives.
 *
 * `detached` plus `unref` plus fully ignored stdio, all three load-bearing. The
 * picker normally runs in a `display-popup`, which is modal: a child sharing its
 * process group dies when the popup closes, and a child holding the popup's
 * stdio paints ssh diagnostics over the list. Detaching makes it a session
 * leader so it survives; ignoring stdio means it has nothing to draw on.
 *
 * Floored. This runs unattended on every launch, so an operator
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
 * Are we running inside a `display-popup` rather than a pane?
 *
 * tmux exports $TMUX to a popup but not $TMUX_PANE, since a popup is not a
 * pane. Outside tmux neither is set, so all three cases are distinguishable
 * without a tmux call.
 */
export function isPopup(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.TMUX) && !env.TMUX_PANE;
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
  const inPopup = isPopup(process.env);

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
        // FIRST, and only when it applies: the one header line that asks for an
        // action, so nothing static may precede it.
        sessionNotice(view.peers) ?? "",
        // No key legend. Enter selects and typing narrows in every fzf there is,
        // and three dim lines teaching that were furniture in a popup 60% tall --
        // the notice above had to compete with them. `murmur dash` is the screen
        // for anything richer than a jump.
        headerRow(showHost),
      ]
        .filter(Boolean)
        .join("\n"),
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

  const selection = stdout.trim().split("\n").at(-1) ?? "";
  const [selectedHost, selected] = selection.split("\t");
  if (!selected) return;
  // A fresh read of the FULL list, not `view` and not `agents`. The rows fzf
  // offered can have come from the alt-a reload subprocess, which
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
  if (agent.attached_pane) {
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
  // Unfloored: this backs the alt-a reload, which is a person asking now, and a
  // reveal that skipped the fetch would be a key that silently does nothing.
  // The launch-time background collect is the floored one, in `spawnCollect`.
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
    .option("--rows", "print picker rows only (internal, for the crew toggle's reload)")
    .action(async (options: PickOptions & { rows?: boolean }) => {
      const store = openStore();
      try {
        if (options.rows) await runRows(store, options);
        else await runPick(store, options);
      } finally {
        store.close();
      }
    });
}
