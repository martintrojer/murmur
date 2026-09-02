import { type Channel, hasWarmSocket } from "./channel.js";
import { type Mux, tmux } from "./mux.js";
import { parseSnapshot, SnapshotInvalidError } from "./snapshot.js";
import type { Store } from "./store.js";
import type { PeerRecord } from "./types.js";
import { STALENESS_MS } from "./view.js";

export { STALENESS_MS };

// Sized for the UNREACHABLE peers. A reachable one costs milliseconds warm, a
// couple hundred cold; a sleeping one holds a forked ssh process for the full
// ConnectTimeout, and unbounded fan-out keeps every such process resident at
// once. Eight leaves a realistic fleet fully parallel.
export const MAX_CONCURRENT_PEERS = 8;

// The cap alone does not bound the collect: the per-peer ssh timeout applies
// once per wave, so nine dead peers cost two waves and the pool serialises the
// timeouts it exists to limit. Peers still in flight at the deadline are
// abandoned and render stale, the designed outcome for a host that did not
// answer. Four seconds is under a 5s tick and above one full wave (3s exec
// ceiling plus overhead), so a wave is never cut short by the deadline itself.
const COLLECT_DEADLINE_MS = 4_000;

/**
 * How recently a peer may have been attempted before an ambient collect skips
 * it.
 *
 * Without it, fetch rate is tied to REDRAW rate: the status bar re-runs
 * `murmur status` per tick per attached client, and a mesh is quadratic --
 * N nodes fetching N-1 peers is N*(N-1) ssh processes per tick. The payload was
 * never the problem (~400 bytes per pane); the forked ssh process is.
 *
 * Thirty seconds must stay under STALENESS_MS, or the floor itself would drive
 * a reachable peer into `stale` and the HUD would flap. At half the window a
 * peer must miss two consecutive attempts to read stale.
 *
 * A constant, not a knob: a wrong value costs a release, not a broken setup.
 */
export const COLLECT_FLOOR_MS = 30_000;

/**
 * Width of the window the floor is drawn from, centred on COLLECT_FLOOR_MS, so
 * a peer is due somewhere in [20s, 40s].
 *
 * A bare floor is a SYNCHRONISER: every node waits the same interval and the
 * collect that answers them all resets their clocks together, so a fleet
 * converges on hitting one hub in the same instant, stickily. Simulated over 20
 * spokes, peak simultaneous fetches per tick: 20/20 with no jitter, 14-18 with
 * a fixed per-peer offset, 8-10 with this.
 *
 * FRESH randomness per cycle, not a fixed per-peer offset hashed from a host
 * id. Peers are only tested when the status bar runs, so an effective period is
 * (floor + offset) rounded up to a tick, and a fixed offset collapses into a
 * handful of periods (measured: 3 for 20 spokes at +/-15s) whose members then
 * collide forever. Fixed jitter re-partitions a herd rather than breaking it.
 *
 * Symmetric, so the MEAN stays at the floor; a one-sided window would stretch
 * the average period to 45s and make every peer's data older for the same
 * spread. Uniform, not normal: a bell curve concentrates mass at the mean,
 * which is the opposite of spreading, and its tails would need clamping.
 *
 * The load-bearing constraint: COLLECT_FLOOR_MS + COLLECT_JITTER_MS / 2 must
 * stay under STALENESS_MS, or an unlucky draw pushes a reachable peer over the
 * line and the HUD flaps. 30s + 10s leaves 20s of headroom.
 */
export const COLLECT_JITTER_MS = 20_000;

/**
 * What one pool slot did: settled either way, claimed but unfinished
 * (`pending`), or -- as `undefined` -- never claimed at all.
 *
 * The distinction is load-bearing rather than descriptive. Only `undefined`
 * means murmur asked a host nothing, and only then must it record nothing:
 * `last_attempt_at` gates the collect floor and `last_error` gates the picker's
 * glance, so a made-up attempt defers a peer and a made-up error silences it.
 */
export type PoolResult<R> = PromiseSettledResult<R> | { status: "pending" };

/**
 * Runs `task` over `items` with at most `limit` in flight, preserving input
 * order in the output. Workers pull from a shared cursor rather than running
 * fixed batches, so one slow peer occupies a single slot instead of holding a
 * batch boundary.
 *
 * `deadline` bounds the whole run, not each task. Past it, workers stop
 * claiming items. In-flight tasks are not cancelled (there is no cancelling a
 * forked ssh) but stop holding the collect open, because the deadline races the
 * pool rather than joining it.
 *
 * Three outcomes, not two, and the third is why `pending` exists. A slot that
 * was CLAIMED and did not finish and one that was never claimed at all both
 * used to read as `undefined`, and a caller cannot tell those apart -- so
 * `collect` charged a peer it never dialled with a failed fetch. `pending` is
 * written at claim time and overwritten on settle, which makes "we asked" a
 * fact the pool reports rather than one the caller has to infer.
 *
 * Exported for `doctor`, which fans out over the same peers: a private copy
 * there would be a second answer to "how many ssh processes may be in flight".
 * The deadline stays the caller's, being the one thing the two disagree about.
 */
export async function mapSettled<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
  deadline?: Promise<void>,
): Promise<(PoolResult<R> | undefined)[]> {
  const results = new Array<PoolResult<R> | undefined>(items.length);
  let cursor = 0;
  let expired = false;
  const stop = deadline?.then(() => {
    expired = true;
  });
  const worker = async () => {
    while (cursor < items.length && !expired) {
      const index = cursor++;
      // Marked BEFORE the await, so a deadline landing mid-task still leaves
      // evidence that this item was claimed.
      results[index] = { status: "pending" };
      try {
        results[index] = { status: "fulfilled", value: await task(items[index] as T) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  const pool = Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  await (stop ? Promise.race([pool, stop]) : pool);
  return results;
}

/**
 * The optional half of a collect, as a bag rather than four positionals: the
 * call site was already `collect(store, ssh, now, undefined, mux)`, and a fifth
 * bare number next to another is how `now` and `floorMs` get swapped.
 */
export type CollectOptions = {
  /** Bounds the whole run. Injectable so tests need not wait out real time. */
  deadline?: Promise<void>;
  /** The mux reconciliation asks which panes are alive. */
  mux?: Mux;
  /**
   * Skip peers attempted within this many ms. Zero -- the default -- fetches
   * every peer, which is what a deliberate `murmur collect` wants. Only the
   * status bar and the picker's background reload, both on a timer or behind a
   * painted list, pass a floor.
   *
   * Opt IN: a surface that forgets it keeps always-fetch, which is merely
   * wasteful. The opposite default would silently serve stale data.
   */
  floorMs?: number;
  /**
   * Source of the floor's jitter, in [0, 1). Injected for the same reason `now`
   * and `isAlive` are: a test pins both edges of the window by returning 0 and
   * a value approaching 1, rather than sampling and hoping.
   */
  random?: () => number;
  /**
   * Whether a peer has a warm ControlMaster socket to ride.
   *
   * Injected like `random` and `now`, so a test needs no ssh binary and can
   * assert WHICH peers were probed -- the only way to pin the cost control in
   * `duePeers`, since the probe is ~20ms per host on a path that runs per tick.
   */
  warm?: (target: string) => boolean;
};

/**
 * The peers an ambient collect should actually reach this run.
 *
 * Keyed on `last_attempt_at`, not `fetched_at`: the point is to bound how often
 * we ATTEMPT a machine, and an unreachable peer is the expensive case -- it
 * costs a forked ssh that sits until ConnectTimeout. Keying on the successful
 * fetch would exempt exactly the sleeping laptops the floor exists to stop
 * hammering.
 *
 * A peer never attempted (`null`) is always due, so a freshly added peer appears
 * without waiting out a floor.
 *
 * The jitter is drawn PER PEER PER CALL, which is what breaks a herd rather
 * than reshaping it (see COLLECT_JITTER_MS), and only applies under a floor: an
 * unfloored collect is a person asking now, and a random skip there would be a
 * keypress that sometimes does nothing.
 */
function duePeers(
  peers: readonly PeerRecord[],
  now: number,
  floorMs: number,
  random: () => number,
  warm: (target: string) => boolean,
): PeerRecord[] {
  if (floorMs <= 0) return [...peers];
  return peers.filter((peer) => {
    // A peer that needs a human, with no warm socket to ride, is not due -- it
    // is not collectable at all. Skipping costs nothing and records nothing;
    // dialling costs the full auth exchange to fail (~1.5s measured against a
    // real 2FA host) on every status tick and every picker launch, forever, to
    // learn what the cached error already says.
    //
    // AMBIENT ONLY, and structurally so: this function returns above when
    // `floorMs <= 0`, which is how a deliberate `murmur collect` is spelled. A
    // person asking gets the attempt and ssh's own diagnosis.
    //
    // Ordered so the free cached read gates the ~20ms probe. `needsInteractiveAuth`
    // is also what proves contact -- an unreachable host cannot answer
    // `Permission denied` -- so there is no "has it ever worked" test here and
    // deliberately none: requiring one excluded the peer this exists for.
    if (peer.last_error !== null && needsInteractiveAuth(peer.last_error) && !warm(peer.target)) {
      return false;
    }
    if (peer.last_attempt_at === null) return true;
    // Centred on the floor: [-span/2, +span/2).
    const jitter = (random() - 0.5) * COLLECT_JITTER_MS;
    return now - peer.last_attempt_at >= floorMs + jitter;
  });
}

export type CollectResult = {
  peer: string;
  ok: boolean;
  /** Panes in the snapshot we just stored. Zero is a normal, valid answer. */
  panes: number;
  error?: string;
  /**
   * True when the peer could not be reached at all, as opposed to answering
   * with something wrong.
   *
   * A fleet normally has nodes asleep, so this is expected rather than a fault.
   * Callers stay quiet about it while still reporting reachable-but-broken -- a
   * bad snapshot version, a missing binary, an auth problem.
   */
  unreachable?: boolean;
};

/**
 * Whether an error means "could not reach the host".
 *
 * Matching on text is unpleasant and it is the only signal available: the
 * channel seam returns an Error, not an exit status.
 *
 * `Permission denied` is deliberately NOT here. An auth misconfiguration is
 * reachable-but-broken and an operator task; filing it under "asleep, probably"
 * is how a fixable setup error stays invisible for weeks.
 */
function isUnreachable(message: string): boolean {
  return (
    /Host is down|No route to host|Connection refused|Connection timed out|Connection closed|Operation timed out|Network is unreachable|Name or service not known|Could not resolve hostname|timed out after/i.test(
      message,
    ) || /\bssh:/.test(message)
  );
}

/**
 * Whether a failure means "a human must authenticate", rather than "the host
 * could not be reached".
 *
 * The third category, and the two above do not cover it: this is reachable,
 * authenticated as far as it goes, and blocked on a person. A host with
 * two-factor auth answers `publickey` with *partial success* and then demands
 * `keyboard-interactive`, which no cached credential and no agent can satisfy --
 * verified against a real one, where plain `ssh` with none of murmur's options
 * fails identically.
 *
 * Any `Permission denied`, not the 2FA spelling specifically: a publickey-only
 * refusal is the same problem for an operator, and both are fixed the same way,
 * by opening a session by hand so a ControlMaster socket exists to ride.
 *
 * Disjoint from `isUnreachable` BY CONSTRUCTION, not by ordering: that predicate
 * deliberately excludes `Permission denied`, for the reason stated on it -- an
 * auth misconfiguration filed under "asleep, probably" is how a fixable setup
 * error stays invisible for weeks. This is the other half of that decision.
 *
 * Deliberately does NOT match a proxy's `Connection closed by UNKNOWN port N`.
 * That is a failure to establish anything at all, which `isUnreachable` claims
 * correctly, and prompting an operator to re-authenticate at an unreachable
 * host would be advice they cannot act on.
 */
export function needsInteractiveAuth(message: string): boolean {
  return /Permission denied/i.test(message);
}

/**
 * Drop Node's `Command failed: <argv>` first line, keeping the child's output.
 *
 * Every ssh-channel rejection arrives in that shape, so the first ~140
 * characters are the invocation murmur chose -- which the operator cannot act
 * on, and which pushed the line that mattered past the length bound below.
 * Measured against a real second node, a missing remote binary printed
 * `bubba: Command failed: ssh -o BatchMode=yes ... murmur: command not f...`,
 * truncated on the only actionable word in it.
 *
 * Stripped BEFORE newlines are collapsed: the line boundary is the only thing
 * separating the invocation from the diagnosis.
 */
function stripInvocation(message: string): string {
  const firstLine = message.indexOf("\n");
  if (firstLine === -1 || !message.startsWith("Command failed:")) return message;
  const rest = message.slice(firstLine + 1).trim();
  // A bare `Command failed:` line with nothing after it is all we have; saying
  // nothing would be worse than saying too much.
  return rest === "" ? message : rest;
}

/**
 * The one normalisation, so classification and rendering cannot disagree. The
 * `unreachable` flag and `describeFailure` both classify with `isUnreachable`,
 * and differently-normalised text is how one fetch gets reported as
 * reachable-but-broken in JSON and "unreachable" in print.
 */
function normalizeFailure(message: string): string {
  return stripInvocation(message).replace(/\s+/g, " ").trim();
}

/**
 * A peer failure in one line a human can act on. The raw error is the whole ssh
 * invocation plus ssh's message -- 200+ characters whose actionable part is the
 * host name, leaking every ssh option murmur passes.
 */
export function describeFailure(peer: string, message: string): string {
  const collapsed = normalizeFailure(message);
  if (isUnreachable(collapsed)) {
    const reason = /ssh: (?:connect to host \S+ port \d+: )?(.+?)(?: \(|$)/i.exec(collapsed);
    return `${peer}: unreachable (${(reason?.[1] ?? "ssh failed").trim()})`;
  }
  // Reachable but wrong: keep the message, since it is the diagnosis, but bound
  // it so a corrupt snapshot cannot print a screenful.
  const detail = collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed;
  return `${peer}: ${detail}`;
}

/**
 * Fetch every peer's snapshot, validate it, and replace the cache whole.
 *
 * Concurrent because an unreachable peer costs the full ssh timeout and a
 * serial loop charged that to every peer behind it: three asleep laptops hung
 * `murmur status` for thirty seconds. Applied serially in peer order, since
 * better-sqlite3 is synchronous and a stable order keeps the results aligned
 * with `store.peers()`.
 *
 * One round trip per peer, never a second: the document is complete, so what
 * arrives either replaces the cache entirely or does not touch it.
 */
export async function collect(
  store: Store,
  channel: Channel,
  now = Date.now(),
  options: CollectOptions = {},
): Promise<CollectResult[]> {
  const { deadline, mux = tmux, floorMs = 0, random = Math.random, warm = hasWarmSocket } = options;
  const results: CollectResult[] = [];
  let timer: NodeJS.Timeout | undefined;
  try {
    // Only the peers due a fetch are passed to the pool, so a skipped peer costs
    // no ssh, no slot and no result row.
    const peers = duePeers(store.peers(), now, floorMs, random, warm);
    // Default deadline, injectable so tests do not have to wait out real time.
    // Unref'd: a pending timer must not hold the process open after a CLI
    // command has printed its output and finished.
    const bounded =
      deadline ??
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, COLLECT_DEADLINE_MS);
        timer.unref?.();
      });
    // Settled, not raw: a peer that fails while we are still applying an
    // earlier one would otherwise be an unhandled rejection for as long as it
    // sits in the queue.
    const fetches = await mapSettled(
      peers,
      MAX_CONCURRENT_PEERS,
      async (peer) => parseSnapshot(await channel.exec(peer.target, ["murmur", "export"])),
      bounded,
    );
    for (const [index, peer] of peers.entries()) {
      const fetch = fetches[index];
      // Never claimed: the deadline passed with this peer still in the queue, so
      // no ssh was forked and nothing was asked. Writing ANYTHING here is
      // writing a fact we do not have, and both columns it would touch are
      // load-bearing -- `last_attempt_at` defers the peer for another floor, and
      // `last_error` stops `glance` dialling a host that may be perfectly
      // healthy. Absent from `results` too: a report is about hosts we contacted.
      if (!fetch) continue;
      try {
        // Claimed but unfinished. Unlike the case above we DID dial, so the
        // attempt is real and worth recording against the floor; it simply has
        // no answer yet, and `replacePeerSnapshot` leaves fetched_at and the
        // cached document alone, so the peer ages into `stale` on its own.
        if (fetch.status === "pending") {
          throw new Error("collect deadline passed before this peer answered");
        }
        if (fetch.status === "rejected") throw fetch.reason;
        // Every field the cache derives comes out of the document itself, so
        // the cache structurally cannot disagree with the snapshot it holds.
        store.replacePeerSnapshot(peer.name, { ok: true, snapshot: fetch.value, at: now });
        results.push({ peer: peer.name, ok: true, panes: fetch.value.panes.length });
      } catch (error) {
        // Normalised ONCE, before it is stored or returned. `last_error` is read
        // by `peer list`, `status --json` and the SDK, and none of them can undo
        // the mangling -- measured against a real second node, `peer list`
        // printed 140 characters of murmur's own ssh invocation before the four
        // words that mattered. Normalising here means no surface has to
        // remember to strip it.
        const message = normalizeFailure(error instanceof Error ? error.message : String(error));
        store.replacePeerSnapshot(peer.name, { ok: false, error: message, at: now });
        // Returned, never printed. `collect` runs from `murmur status` on every
        // tick and from `pick` inside a display-popup, so one sleeping laptop
        // wrote to stderr forever and corrupted both surfaces. Only the
        // `collect` command, which a human ran on purpose, prints.
        results.push({
          peer: peer.name,
          ok: false,
          panes: 0,
          error: message,
          // A peer that answered with a bad document is reachable but broken,
          // and must be visibly so rather than silently stale.
          unreachable:
            error instanceof SnapshotInvalidError
              ? false
              : isUnreachable(normalizeFailure(message)),
        });
      }
    }
  } catch (error) {
    // The whole collect failed rather than one peer -- a broken peer table, say.
    // Still not printed: the caller decides.
    results.push({
      peer: "",
      ok: false,
      panes: 0,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }

  // Runs once per invocation including with zero peers, which is why it is here
  // rather than on `export` -- that only runs when a peer asks over ssh, so a
  // single-machine node would reconcile never. Idempotent, so
  // `buildLocalSnapshot` calling it too is a cheap repeat, not a second policy.
  try {
    store.reconcileLocal({ panes: mux.livePanes(), now });
  } catch {
    // Housekeeping must not fail a command, and it must not report either.
  }
  return results;
}
