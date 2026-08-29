import type { Channel } from "./channel.js";
import { type Envelope, eventFromWire, SCHEMA_VERSION } from "./export.js";
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
};

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
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`murmur: collect: peer ${peer.name}: ${message}\n`);
        results.push({ peer: peer.name, ok: false, ingested: 0, error: message });
      }
    }
  } catch (error) {
    process.stderr.write(
      `murmur: collect: ${error instanceof Error ? error.message : String(error)}\n`,
    );
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
  } catch (error) {
    process.stderr.write(
      `murmur: collect: prune: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  return results;
}
