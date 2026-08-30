import type { Channel } from "./channel.js";
import {
  type Envelope,
  eventFromWire,
  reapDeadAgents,
  SCHEMA_VERSION,
  synthesizeCrashes,
} from "./export.js";
import type { Store } from "./store.js";
import type { Event } from "./types.js";

/**
 * How long a peer may go unfetched before it renders stale.
 *
 * Not derived from a collect interval, because murmur has no scheduler: there
 * is no timer here, and `collect` runs only when a command asks for it. In
 * practice the cadence is the operator's tmux `status-interval`, since
 * `murmur status` collects and tmux re-runs it on a tick.
 *
 * So this is a judgement about the operator's setup, not arithmetic on a
 * constant murmur controls. Sixty seconds is comfortably above a default 15s
 * status bar -- a peer needs to miss several ticks before it is called out,
 * which keeps one slow fetch from flickering the HUD. A status bar slower than
 * this will show every peer permanently stale; that is the number to change if
 * so.
 */
export const STALENESS_MS = 60_000;

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

// The cap alone does not bound the collect, which is what an earlier version of
// this comment got wrong. The per-peer ssh timeout applies once per wave, so
// nine unreachable peers cost two waves and seventeen cost three: the pool
// serialises the timeouts it is there to limit. At a 5s status-interval that is
// exactly the tick overlap the concurrency work set out to remove, just moved
// to a longer peer list.
//
// So the whole collect gets its own deadline, independent of peer count. Peers
// still in flight when it expires are abandoned and render stale, which is
// already the designed outcome for a host that did not answer in time.
//
// Four seconds: under a 5s tick, and above one full wave (a 3s exec ceiling
// plus overhead) so a single wave is never cut short by the deadline itself.
export const COLLECT_DEADLINE_MS = 4_000;

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
 */
async function mapSettled<T, R>(
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

export type CollectResult = {
  peer: string;
  ok: boolean;
  ingested: number;
  error?: string;
  /**
   * True when the peer could not be reached at all, as opposed to answering
   * with something wrong.
   *
   * A fleet normally has nodes that are asleep or switched off, so this is the
   * expected outcome rather than a fault, and callers use it to stay quiet
   * about the ordinary case while still reporting a peer that is reachable but
   * broken -- a bad schema version, a missing binary, a corrupt export.
   */
  unreachable?: boolean;
};

/**
 * Whether an error means "could not reach the host".
 *
 * ssh exits 255 for its own failures and prints a recognisable line, and the
 * exec wrapper puts both in the message. Matching on the text is unpleasant but
 * it is the only signal available: the channel seam returns an Error, not an
 * exit status, and widening it to carry one would push ssh's exit conventions
 * into every future channel.
 */
function isUnreachable(message: string): boolean {
  return (
    /Host is down|No route to host|Connection refused|Connection timed out|Connection closed|Operation timed out|Network is unreachable|Name or service not known|Could not resolve hostname|Permission denied|timed out after/i.test(
      message,
    ) || /\bssh:/.test(message)
  );
}

/**
 * A peer failure in one line a human can act on.
 *
 * The raw error was the whole ssh invocation plus ssh's own message -- over 200
 * characters, of which the actionable part was the host name. It also leaked
 * every ssh option murmur passes, which a user cannot do anything about.
 */
export function describeFailure(peer: string, message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (isUnreachable(collapsed)) {
    const reason = /ssh: (?:connect to host \S+ port \d+: )?(.+?)(?: \(|$)/i.exec(collapsed);
    return `${peer}: unreachable (${(reason?.[1] ?? "ssh failed").trim()})`;
  }
  // Reachable but wrong: keep the message, since it is the diagnosis, but bound
  // it so a corrupt export cannot print a screenful.
  const detail = collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed;
  return `${peer}: ${detail}`;
}

function parseJsonl(output: string): { envelope: Envelope; events: Event[] } {
  const lines = output.trim().split("\n");
  const envelope = JSON.parse(lines.shift() ?? "") as Envelope;
  if (envelope.schema_version > SCHEMA_VERSION) {
    throw new Error(
      `unsupported schema version ${envelope.schema_version} (supports ${SCHEMA_VERSION})`,
    );
  }
  return {
    envelope,
    events: lines.map((line) => eventFromWire(JSON.parse(line) as Record<string, unknown>)),
  };
}

/**
 * Peers are fetched concurrently and applied serially.
 *
 * Concurrent because an unreachable peer costs the full ssh timeout, and a
 * serial loop charged that to every other peer behind it: three asleep laptops
 * made `murmur status` hang for thirty seconds and let the HUD tick overlap
 * itself. Fanning out makes the whole collect cost the slowest peer, not the
 * sum — capped at MAX_CONCURRENT_PEERS in flight and bounded overall by
 * COLLECT_DEADLINE_MS.
 *
 * Applied serially, in peer order, because better-sqlite3 is synchronous: there
 * is nothing to win by interleaving writes, and keeping the order stable keeps
 * the result list aligned with `store.peers()`.
 */
export async function collect(
  store: Store,
  channel: Channel,
  now = Date.now(),
  deadline?: Promise<void>,
): Promise<CollectResult[]> {
  const results: CollectResult[] = [];
  let timer: NodeJS.Timeout | undefined;
  try {
    const peers = store.peers();
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
    // sits in the queue, which Node reports and future Node kills the process
    // over.
    const fetches = await mapSettled(
      peers,
      MAX_CONCURRENT_PEERS,
      async (peer) =>
        parseJsonl(
          await channel.exec(peer.target, ["murmur", "export", "--since", String(peer.watermark)]),
        ),
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
        const { envelope, events } = fetch.value;
        const ingested = store.ingest(events);
        const origin = events.filter((event) => event.host_id === envelope.host_id);
        const watermark = origin.reduce(
          (highest, event) => Math.max(highest, event.seq),
          peer.watermark,
        );
        store.upsertPeer({
          name: peer.name,
          target: peer.target,
          host_id: envelope.host_id,
          display_name: envelope.display_name,
          watermark,
          fetched_at: now,
          // New events mean the node is authoring again, so whatever a jump
          // observed about its tmux is out of date. Only clear on actual new
          // events: an export that returns nothing proves the binary ran, not
          // that tmux is back, which is the distinction that let a dead host
          // look healthy for three hours.
          //
          // Keyed on the watermark advancing, not on ingest's insert count.
          // Two reasons the count was wrong. Ingest is INSERT OR IGNORE, so a
          // retry after a partial apply re-sees the same events and reports
          // zero -- leaving a recovered host marked down until it happened to
          // author again. And the count includes rows from other origins that
          // this peer merely relayed, which say nothing about whether this
          // peer's tmux is back.
          tmux_down_at: watermark > peer.watermark ? null : peer.tmux_down_at,
        });
        results.push({ peer: peer.name, ok: true, ingested });
      } catch (error) {
        // Reported through the return value, never printed here. `collect` runs
        // from `murmur status` on every status-bar tick, and from `pick` inside
        // a display-popup, so a single sleeping laptop wrote to stderr forever
        // and corrupted both. Only the `collect` command -- which a human ran
        // on purpose -- prints. See registerCollect.
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          peer: peer.name,
          ok: false,
          ingested: 0,
          error: message,
          unreachable: isUnreachable(message.replace(/\s+/g, " ")),
        });
      }
    }
  } catch (error) {
    // The whole collect failed rather than one peer -- a broken peer table, say.
    // Still not printed: the caller decides. Recorded against no peer so a
    // caller that reports failures has something to report.
    results.push({
      peer: "",
      ok: false,
      ingested: 0,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }

  // Once per collect, outside the peer loop and outside its try, for two
  // reasons.
  //
  // It used to run per successful peer, so four peers meant four DELETEs with a
  // window function over the whole table on every status-bar tick, to enforce a
  // horizon measured in days. Idempotent work, repeated.
  //
  // And it ran only when a peer succeeded, so the single-machine case -- no
  // peers at all, the everyday path -- pruned never and grew local events
  // forever. The horizon is a property of the log, not of federation.
  //
  // Retention must not be able to fail a command, hence its own try.
  try {
    store.prune();
    // Reap this host's agents whose tmux pane is gone and whose last word was
    // `cleared`. Housekeeping, alongside retention, and for the same reason it
    // lives here: this runs once per invocation including with zero peers, so
    // the single-machine case is covered.
    //
    // It could not live in `export` alone, which is where reconcileDeadAgents was
    // called from -- export runs when a PEER asks over ssh, so a node with no
    // peers never reaped, and four dead crew rows sat in the author's picker
    // indefinitely. Only the owning host can do this: `live` is its own tmux.
    reapDeadAgents(store);
    // Same argument, same reason it is here rather than on export: only the
    // authoring host can tell that one of ITS pids is gone. A reader folds a
    // remote `working` row with `() => true`, so a peer can never derive
    // `crashed` for this host -- if this node does not write the row, no node
    // ever learns it, and the replica shows `working` forever.
    //
    // After reapDeadAgents, not before: reaping drops agents whose pane is gone
    // and whose last word was already `cleared`, which are rows synthesis has
    // no business resurrecting a `crashed` for.
    synthesizeCrashes(store);
  } catch {
    // Retention is housekeeping: it must not fail a command, and it must not
    // report either. A failed prune costs disk, which the next collect retries.
  }
  return results;
}
