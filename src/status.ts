import { type Channel, hasWarmSocket, ssh } from "./channel.js";
import { type CollectOptions, collect, needsInteractiveAuth } from "./collector.js";
import type { NodeIdentity } from "./identity.js";
import { type Mux, tmux } from "./mux.js";
import type { Store } from "./store.js";
import {
  freshness,
  NEEDS_HUMAN,
  type PaneView,
  paneViews,
  RENDER_PRIORITY,
  type RenderState,
  renderState,
  type SortContext,
  viewSort,
} from "./view.js";

type Counts = Record<RenderState, number>;

type StatusOptions = { mux?: Mux };

function commandNames(command: string): string[] {
  return [...command.matchAll(/(?:^|[\s'"/])([\w.-]+)(?=$|[\s'"])/g)].flatMap((match) => {
    const name = match[1]?.replace(/^-+/, "");
    return name ? [name] : [];
  });
}

/**
 * Whether a local pane's command line is an attachment to `agentName`.
 *
 * Matches the agent NAME as a word in the argv, and nothing else. It used to
 * read `MU_AGENT_NAME=` / `MU_WORKSTREAM=` out of the same string, which cannot
 * work: `ps eww -p <pid> -o command=` returns ARGV ONLY on macOS -- measured
 * against a live attach pane, the whole output was
 * `ssh dev -t tmux attach -t mu-remote-1`, 38 characters, no environment at all.
 * `ps -E` behaves the same and there is no /proc, so an env prefix
 * (`MU_AGENT_NAME=x ssh ...`) is consumed by the shell and never observable.
 * The `e` flag that appends the environment is a Linux ps extension.
 *
 * The agent name IS in the argv for both remote recipes, which is why this
 * works where the env read could not: a direct spawn carries it in the remote
 * command, and the detached-tmux shape carries it in the session name, since mu
 * names the session after the agent. That is a convention rather than a
 * guarantee -- so a miss costs the attachment hint and nothing else, and the
 * word boundary keeps `worker-1` from matching `worker-10`.
 */
function namesTarget(command: string, target: string): boolean {
  if (target === "") return false;
  const escaped = target.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(String.raw`(?:^|[\s'"/=-])${escaped}(?=$|[\s'"/])`).test(command);
}

/**
 * Whether a local pane's argv is an attachment to this remote pane.
 *
 * TWO handles, because the two ways an attachment gets started leave different
 * traces and only one is a name:
 *
 * - the AGENT NAME catches a hand-rolled attach, where mu's recipes put it in
 *   the remote command or in the session name (mu names the session
 *   `mu-<agent>`).
 * - the PANE ID catches a jump through the peer's configured jump command,
 *   which renders `{pane}` and so names the pane and nothing else. Measured with
 *   a real ET jump: argv was `x2ssh -et dev -c tmux attach -t %45`, in which the
 *   agent name appears nowhere -- so the name matcher alone missed exactly the
 *   case the back-reference exists for, since a second attach through the
 *   DEFAULT ssh jump command is what fails on a session-capped host.
 *
 * Either is sufficient. The word boundary is what keeps `%45` from matching
 * `%450` and `worker-1` from matching `worker-10`.
 */
function attachesPane(command: string, agentName: string, pane: string): boolean {
  return namesTarget(command, agentName) || namesTarget(command, pane);
}

export type Status = {
  counts: Counts;
  orchestrated_counts: Counts;
  panes: PaneView[];
  peers: {
    name: string;
    /**
     * The ssh target, which is what a REMEDY must name. `peer add <name>
     * [target]` takes them separately, so a peer called `dev` can point at
     * `user@box.example` -- and a suggested command built from the name would
     * then not run.
     */
    target: string;
    display_name: string | null;
    fetched_at: number | null;
    snapshot_at: number | null;
    last_error: string | null;
    stale: boolean;
    /**
     * The operator must authenticate interactively before this peer can be
     * collected again: it has answered before, its last attempt was refused on
     * auth, and no warm ControlMaster socket exists to ride.
     *
     * Derived, never stored, which is what makes it self-correcting -- `ssh
     * <host>` creates the socket and this clears on the next read, with no
     * successful fetch required and no state anyone has to remember to clean up.
     */
    needs_session: boolean;
  }[];
};

function emptyCounts(): Counts {
  const counts = {} as Counts;
  for (const state of RENDER_PRIORITY) counts[state] = 0;
  return counts;
}

export function tmuxStatus(view: Status): string {
  // Orchestrated agents count only for the states a human can answer: a
  // supervisor consumes a `done` worker's result and `running` asks for nothing.
  // The list is `NEEDS_HUMAN`, shared with the picker's visibility rule so the
  // two surfaces cannot disagree about which crew rows matter.
  const needsHuman = new Set<RenderState>(NEEDS_HUMAN);
  const total = (state: RenderState): number =>
    view.counts[state] + (needsHuman.has(state) ? view.orchestrated_counts[state] : 0);
  return (
    RENDER_PRIORITY.filter((state) => total(state) > 0)
      // The tmux renderer's public vocabulary predates the internal activity
      // rename. Keep that external protocol stable until the renderer is updated.
      .map((state) => `${state === "running" ? "working" : state}\t${total(state)}\n`)
      .join("")
  );
}

/**
 * The current view. Pure with respect to the network: the caller decides whether
 * to collect first (see `statusWithCollect`).
 *
 * `identity` is required rather than resolved here, because every caller is a
 * command that already fails without one.
 */
export function status(
  store: Store,
  identity: NodeIdentity,
  now = Date.now(),
  // Injected for the same reason `Channel` and `Mux` are: a test must not need
  // an ssh binary, and "was this peer probed at all" has to be assertable --
  // which is the only way to pin the cost control below.
  warm: (target: string) => boolean = hasWarmSocket,
  // Where the reader is sitting, which only affects ORDER within a state band.
  // Read from the environment here rather than in `viewSort`, so the pure
  // function stays pure and a test can place the reader anywhere.
  //
  // $TMUX_PANE, never a tmux query: the same rule `mux.currentWindow()` follows.
  // Asking tmux answers for whichever pane the server thinks is active, which is
  // not the pane this process runs in -- and the status bar renders in the tmux
  // server itself, where that would name an unrelated agent.
  context: SortContext = { here: process.env.TMUX_PANE },
  options: StatusOptions = {},
): Status {
  const counts = emptyCounts();
  const orchestratedCounts = emptyCounts();
  const panes = paneViews(store, identity, now);
  const peers = store.peers();
  const commandsByPeer = new Map(
    peers
      .filter((peer): peer is typeof peer & { host_id: string } => peer.host_id !== null)
      .map((peer) => [peer.host_id, new Set(commandNames(peer.jump_command))]),
  );
  // Only remote rows can have a local attachment, and only ones naming an agent:
  // the name is the sole thing the local argv can be matched against.
  const attachable = panes.filter(
    (pane): pane is typeof pane & { agent_name: string } =>
      !pane.local && pane.agent_name !== null && pane.agent_name !== "",
  );
  if (attachable.length > 0) {
    for (const process of (options.mux ?? tmux).localPaneProcesses()) {
      const remote = attachable.find(
        (pane) =>
          commandsByPeer.get(pane.host_id)?.has(process.current_command) &&
          attachesPane(process.arguments, pane.agent_name, pane.pane),
      );
      if (remote) remote.attached_pane = process.pane;
    }
  }
  const sortedPanes = viewSort(panes, { ...context, now });
  for (const pane of sortedPanes) {
    const target = pane.driver === "human" ? counts : orchestratedCounts;
    target[renderState(pane)] += 1;
  }

  return {
    counts,
    orchestrated_counts: orchestratedCounts,
    panes: sortedPanes,
    peers: peers.map((peer) => ({
      name: peer.name,
      target: peer.target,
      display_name: peer.display_name,
      fetched_at: peer.fetched_at,
      // Their clock and ours, separately: a peer polled a second ago can be
      // serving a three-hour-old fact, and one number cannot say both.
      snapshot_at: peer.snapshot_at,
      last_error: peer.last_error,
      // The view's verdict, not a second threshold spelled the same way. A
      // peer we have never reached is stale rather than fresh -- null
      // `fetched_at` means the first collect has not succeeded yet -- and
      // `freshness` is the one place that decides, so this list and the panes
      // the peer contributes cannot disagree about the same host.
      stale: freshness(peer.fetched_at, now) === "stale",
      // Candidates ONLY, and the order is the cost control: everything left of
      // `warm(...)` is a free cached read, so the ~20ms probe runs for a peer
      // that could plausibly need it and for no other. Probing all of them would
      // more than double a picker launch path measured at ~60ms, to answer
      // questions nobody reads.
      //
      // NO "has worked before" condition, deliberately. The first version
      // required `snapshot !== null` and that excluded the exact peer this
      // exists for: a peer row re-added by hand holds only `(name, target)`, so
      // its snapshot is NULL and it has never worked as far as murmur knows.
      // Every test passed, because every test seeds a successful fetch first;
      // only the real fleet showed it.
      //
      // The classifier already carries the fact that test was reaching for.
      // Producing `Permission denied` requires a completed TCP connect, key
      // exchange and auth round, so an unreachable host cannot say it -- the
      // error IS the proof of contact. Which is also why nagging `ssh linuxpc`
      // at a switched-off box cannot happen: it fails with `Operation timed
      // out`, which is not auth-class.
      needs_session:
        peer.last_error !== null && needsInteractiveAuth(peer.last_error) && !warm(peer.target),
    })),
  };
}

/**
 * Collect from peers, then read. This is what every user-facing surface wants:
 * the view reflects the sync that just ran, rather than the one before it.
 *
 * Awaiting matters twice over. A fire-and-forget collect shows data one run
 * stale, and callers close the store in a `finally`, so a collect still in
 * flight lands on a closed handle and reports "The database connection is not
 * open" -- which looks like corruption rather than a race.
 *
 * Sync must never fail a command and on this path must never print either:
 * `status` runs on every tick and the picker's reload runs behind a popup, so
 * one sleeping laptop would write ssh diagnostics to stderr several times a
 * minute forever. `murmur collect`, run deliberately, is the only place that
 * prints.
 *
 * `floorMs` is how a caller says whether it is a TIMER or a PERSON. The status
 * bar passes COLLECT_FLOOR_MS so fetch rate stops tracking redraw rate. The
 * picker's rows path passes nothing: `^r` is a person asking now, and a refresh
 * key that skipped the fetch would be a key that silently does nothing.
 */
export async function statusWithCollect(
  store: Store,
  identity: NodeIdentity,
  now = Date.now(),
  channel: Channel = ssh,
  options: CollectOptions = {},
): Promise<Status> {
  try {
    await collect(store, channel, now, options);
  } catch {
    // Total by construction: a read of whatever the cache already holds is
    // always better than no output, and this path has no one to tell.
  }
  return status(store, identity, now);
}
