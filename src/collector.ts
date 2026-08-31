import type { Channel } from "./channel.js";
import { type Mux, tmux } from "./mux.js";
import { parseSnapshot, SnapshotInvalidError } from "./snapshot.js";
import type { Store } from "./store.js";
import type { PeerRecord } from "./types.js";
import { STALENESS_MS } from "./view.js";

export { STALENESS_MS };

// A reachable peer is cheap — milliseconds on a warm control socket, still
// only a couple hundred cold. The cap is not about those.
//
// It is about the unreachable ones. Each in-flight peer is a forked ssh client
// process, and a peer that is asleep or off the VPN holds that process for the
// full ConnectTimeout. Unbounded fan-out over a long list puts every one of
// them resident at once, which is process churn and file descriptors spent on
// hosts that were never going to answer.
//
// Eight keeps the realistic fleet fully parallel while bounding that.
export const MAX_CONCURRENT_PEERS = 8;

// The cap alone does not bound the collect. The per-peer ssh timeout applies
// once per wave, so nine unreachable peers cost two waves: the pool serialises
// the timeouts it exists to limit. So the whole collect gets its own deadline,
// independent of peer count. Peers still in flight when it expires are
// abandoned and render stale, which is already the designed outcome for a host
// that did not answer in time.
//
// Four seconds: under a 5s tick, and above one full wave (a 3s exec ceiling
// plus overhead) so a single wave is never cut short by the deadline itself.
const COLLECT_DEADLINE_MS = 4_000;

/**
 * How recently a peer may have been attempted before an ambient collect skips
 * it.
 *
 * Collection is driven by the tmux status bar re-running `murmur status`, and
 * every run fetched every peer. That ties fetch rate to REDRAW rate, which is a
 * category error: the status bar's job is to repaint, not to decide how often to
 * reach a machine. It is also quadratic in a mesh -- N nodes each fetching N-1
 * peers is N*(N-1) ssh processes per tick, fleet-wide -- and it multiplies by
 * attached tmux clients, since `status-interval` fires per client. The payload
 * was never the problem (measured: ~400 bytes per pane); the forked ssh process
 * per peer per tick is.
 *
 * Thirty seconds, and the ceiling is not arbitrary: it must stay safely under
 * STALENESS_MS, or the floor itself would drive a REACHABLE peer into `stale`
 * and the HUD would flap. At half the staleness window a peer has to miss two
 * consecutive attempts before it reads stale, which is the same belt-and-braces
 * relationship CONNECT_TIMEOUT_S has with EXEC_TIMEOUT_MS.
 *
 * A constant rather than a knob, per the zero-configuration rule: a wrong value
 * here costs a release, not a silently broken user setup.
 */
export const COLLECT_FLOOR_MS = 30_000;

/**
 * Width of the window the floor is drawn from, centred on COLLECT_FLOOR_MS.
 * Twenty seconds, so a peer is due somewhere in [20s, 40s].
 *
 * A bare floor is a SYNCHRONISER, which is worse than no floor at a hub. Every
 * node fetches, waits exactly the same interval, and fetches again, so a fleet
 * converges on hitting one machine in the same instant forever -- and the
 * convergence is sticky, because the collect that answers them all is also what
 * resets all their clocks together.
 *
 * Simulated, 20 spokes against one hub, peak simultaneous fetches per tick:
 *
 *   no jitter                 20 / 20
 *   fixed per-peer offset      14-18 / 20
 *   this (uniform +/-10s)       8-10 / 20
 *
 * A FIXED offset per peer -- hashed from a host id, say -- barely helps, and the
 * reason is the tick grid. A peer is only tested when the status bar runs, every
 * `status-interval`, so its effective period is (floor + offset) rounded up to a
 * multiple of the tick. A fixed offset collapses into a handful of distinct
 * periods (measured: 3 periods for 20 spokes at +/-15s), and peers sharing a
 * period then collide on every cycle forever. Fixed jitter does not break a
 * herd, it re-partitions it into smaller permanent herds. Fresh randomness
 * re-draws the period every cycle, so a group that collides once scatters next
 * time.
 *
 * Symmetric rather than added on top, so the MEAN stays at the floor -- a
 * one-sided [floor, floor+span] window would quietly stretch the average period
 * to 45s and make every peer's data older to buy the same spread.
 *
 * Uniform rather than normal: a bell curve concentrates mass near the mean,
 * which is precisely the opposite of spreading, and its unbounded tails would
 * need clamping -- which piles probability exactly on the bound.
 *
 * The span is capped by staleness, and this is the load-bearing constraint:
 * COLLECT_FLOOR_MS + COLLECT_JITTER_MS / 2 must stay under STALENESS_MS, or an
 * unlucky draw pushes a REACHABLE peer over the staleness line and the HUD
 * flaps between fresh and stale. 30s + 10s = 40s leaves 20s of headroom.
 */
export const COLLECT_JITTER_MS = 20_000;

/**
 * Runs `task` over `items` with at most `limit` in flight, preserving input
 * order in the output. Workers pull from a shared cursor rather than running
 * fixed batches, so one slow peer occupies a single slot instead of holding a
 * batch boundary.
 *
 * `deadline` bounds the whole run, not each task. Once it passes, workers stop
 * claiming new items and anything unstarted is left `undefined` for the caller
 * to treat as "did not answer". Tasks already in flight are not cancelled --
 * there is nothing to cancel a forked ssh with here -- but they no longer hold
 * the collect open, because the deadline races the pool rather than joining it.
 *
 * Exported for `doctor`, which fans out the same way over the same peers and
 * must not grow a second pool: a private copy there would be a second answer to
 * "how many ssh processes may murmur have in flight", and the two would drift.
 * The DEADLINE is the caller's, because that is the one thing the two surfaces
 * genuinely disagree about -- see DOCTOR_DEADLINE_MS.
 */
export async function mapSettled<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
  deadline?: Promise<void>,
): Promise<(PromiseSettledResult<R> | undefined)[]> {
  const results = new Array<PromiseSettledResult<R> | undefined>(items.length);
  let cursor = 0;
  let expired = false;
  const stop = deadline?.then(() => {
    expired = true;
  });
  const worker = async () => {
    while (cursor < items.length && !expired) {
      const index = cursor++;
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
 * The optional half of a collect, as a bag rather than four positional
 * arguments.
 *
 * `collect(store, ssh, now, undefined, mux)` was already the call site before
 * the floor was added, and a fifth positional -- a bare number, next to another
 * bare number -- is how `now` and `floorMs` get silently swapped.
 */
export type CollectOptions = {
  /** Bounds the whole run. Injectable so tests need not wait out real time. */
  deadline?: Promise<void>;
  /** The mux reconciliation asks which panes are alive. */
  mux?: Mux;
  /**
   * Skip peers attempted within this many ms. Zero -- the default -- fetches
   * every peer, which is what a deliberate `murmur collect` and the picker both
   * want. Only the status bar, which repaints on a timer, passes a floor.
   *
   * Opt IN rather than opt out: a surface that forgets this argument keeps the
   * old always-fetch behaviour, which is merely wasteful. The opposite default
   * would mean a new surface silently serves stale data.
   */
  floorMs?: number;
  /**
   * Source of the floor's jitter, in [0, 1). Injected for the same reason `now`
   * and `isAlive` are: a test pins both edges of the window by returning 0 and
   * a value approaching 1, rather than sampling and hoping.
   */
  random?: () => number;
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
 * The jitter is drawn PER PEER PER CALL, which is what breaks a herd rather than
 * merely reshaping it -- see COLLECT_JITTER_MS. It applies only when a floor is
 * set: an unfloored collect is a person asking for the state now, and a random
 * skip there would be a keypress that sometimes silently does nothing.
 */
function duePeers(
  peers: readonly PeerRecord[],
  now: number,
  floorMs: number,
  random: () => number,
): PeerRecord[] {
  if (floorMs <= 0) return [...peers];
  return peers.filter((peer) => {
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
   * A fleet normally has nodes that are asleep or switched off, so this is the
   * expected outcome rather than a fault, and callers use it to stay quiet
   * about the ordinary case while still reporting a peer that is reachable but
   * broken -- a bad snapshot version, a missing binary, an auth problem.
   */
  unreachable?: boolean;
};

/**
 * Whether an error means "could not reach the host".
 *
 * ssh exits 255 for its own failures and prints a recognisable line, and the
 * exec wrapper puts both in the message. Matching on the text is unpleasant but
 * it is the only signal available: the channel seam returns an Error, not an
 * exit status.
 *
 * `Permission denied` is deliberately NOT here. An auth misconfiguration is
 * reachable-but-broken and an operator task; classing it as "asleep, probably"
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
 * Drop Node's `Command failed: <argv>` first line, keeping the child's output.
 *
 * Every rejection from the ssh channel arrives in that shape, so the first ~140
 * characters of every real failure are the invocation murmur chose: `ssh -o
 * BatchMode=yes -o ControlMaster=no -o ControlPath=... -o ConnectTimeout=1
 * <host> murmur export`. The operator cannot act on any of it, and it pushed the
 * one line that mattered past the length bound below -- measured against a real
 * second node, where a missing remote binary printed
 * `bubba: Command failed: ssh -o BatchMode=yes ... murmur: command not f...`,
 * truncated on the only actionable word in it.
 *
 * Stripped BEFORE the newlines are collapsed, because the line boundary is the
 * only thing separating the invocation from the diagnosis.
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
 * The one normalisation, so classification and rendering cannot disagree.
 *
 * `unreachable` (a machine-readable flag on `CollectResult`) and
 * `describeFailure` (the line a human reads) both classify with
 * `isUnreachable`. Feeding them differently-normalised text is how a peer gets
 * reported as reachable-but-broken in JSON and "unreachable" in print, about
 * one fetch -- so both go through here.
 */
function normalizeFailure(message: string): string {
  return stripInvocation(message).replace(/\s+/g, " ").trim();
}

/**
 * A peer failure in one line a human can act on.
 *
 * The raw error was the whole ssh invocation plus ssh's own message -- over 200
 * characters, of which the actionable part was the host name. It also leaked
 * every ssh option murmur passes, which a user cannot do anything about.
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
 * Concurrent because an unreachable peer costs the full ssh timeout, and a
 * serial loop charged that to every peer behind it: three asleep laptops made
 * `murmur status` hang for thirty seconds. Applied serially in peer order,
 * because better-sqlite3 is synchronous and a stable order keeps the result list
 * aligned with `store.peers()`.
 *
 * One round trip per peer, and never a second: the document is complete, so what
 * arrives either replaces the cache entirely or does not touch it.
 */
export async function collect(
  store: Store,
  channel: Channel,
  now = Date.now(),
  options: CollectOptions = {},
): Promise<CollectResult[]> {
  const { deadline, mux = tmux, floorMs = 0, random = Math.random } = options;
  const results: CollectResult[] = [];
  let timer: NodeJS.Timeout | undefined;
  try {
    // Only the peers due a fetch are passed to the pool, so a skipped peer costs
    // no ssh, no slot and no result row.
    const peers = duePeers(store.peers(), now, floorMs, random);
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
      try {
        // Undefined means the deadline passed before this peer was claimed or
        // finished. Not an error about the peer, so it says so plainly and
        // leaves fetched_at alone: the peer goes stale, which is the designed
        // outcome for a host that did not answer in time.
        if (!fetch) throw new Error("collect deadline passed before this peer answered");
        if (fetch.status === "rejected") throw fetch.reason;
        // Every field the cache derives comes out of the document itself, so
        // the cache structurally cannot disagree with the snapshot it holds.
        store.replacePeerSnapshot(peer.name, { ok: true, snapshot: fetch.value, at: now });
        results.push({ peer: peer.name, ok: true, panes: fetch.value.panes.length });
      } catch (error) {
        // Normalised ONCE, here, before it is stored or returned.
        //
        // `last_error` is read by `peer list`, by `status --json` and by
        // anything built on the SDK, and none of them can undo the mangling: a
        // raw `execFile` rejection leads with `Command failed: ssh -o
        // BatchMode=yes -o ControlMaster=no -o ControlPath=... <host> murmur
        // export`, which is murmur's own invocation and nothing an operator can
        // act on. Measured against a real second node, where `peer list`
        // printed 140 characters of ssh options before the four words that
        // mattered. Storing the normalised text means every surface gets the
        // diagnosis without each one having to remember to strip it.
        const message = normalizeFailure(error instanceof Error ? error.message : String(error));
        store.replacePeerSnapshot(peer.name, { ok: false, error: message, at: now });
        // Reported through the return value, never printed here. `collect` runs
        // from `murmur status` on every status-bar tick, and from `pick` inside
        // a display-popup, so a single sleeping laptop wrote to stderr forever
        // and corrupted both. Only the `collect` command -- which a human ran
        // on purpose -- prints.
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

  // The only housekeeping left, and it runs once per invocation including with
  // zero peers -- which is why it is here rather than on `export`, which only
  // runs when a peer asks over ssh. A single-machine node would otherwise
  // reconcile never. Idempotent, so `buildLocalSnapshot` calling it too is a
  // cheap repeat rather than a second policy.
  try {
    store.reconcileLocal({ panes: mux.livePanes(), now });
  } catch {
    // Housekeeping must not fail a command, and it must not report either.
  }
  return results;
}
