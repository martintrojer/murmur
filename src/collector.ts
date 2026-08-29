import type { Channel } from "./channel.js";
import { type Envelope, eventFromWire, SCHEMA_VERSION } from "./export.js";
import type { Store } from "./store.js";
import type { Event } from "./types.js";

export const COLLECT_INTERVAL_MS = 30_000;
export const STALENESS_MS = 2 * COLLECT_INTERVAL_MS;

// A reachable peer is cheap — milliseconds on a warm control socket, still
// only a couple hundred cold. The cap is not about those.
//
// It is about the unreachable ones. Each in-flight peer is a forked ssh client
// process, and a peer that is asleep or off the VPN holds that process for the
// full ConnectTimeout. Unbounded fan-out over a long list puts every one of
// them resident at once, which is process churn and file descriptors spent on
// hosts that were never going to answer.
//
// Eight keeps the realistic fleet fully parallel while bounding that. Worst
// case becomes ceil(peers / 8) ssh timeouts instead of one, still inside the
// HUD tick for any plausible list.
export const MAX_CONCURRENT_PEERS = 8;

/**
 * Runs `task` over `items` with at most `limit` in flight, preserving input
 * order in the output. Workers pull from a shared cursor rather than running
 * fixed batches, so one slow peer occupies a single slot instead of holding a
 * batch boundary.
 */
async function mapSettled<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await task(items[index] as T) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
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
 * sum — capped at MAX_CONCURRENT_PEERS in flight.
 *
 * Applied serially, in peer order, because better-sqlite3 is synchronous: there
 * is nothing to win by interleaving writes, and keeping the order stable keeps
 * the result list aligned with `store.peers()`.
 */
export async function collect(
  store: Store,
  channel: Channel,
  now = Date.now(),
): Promise<CollectResult[]> {
  const results: CollectResult[] = [];
  try {
    const peers = store.peers();
    // Settled, not raw: a peer that fails while we are still applying an
    // earlier one would otherwise be an unhandled rejection for as long as it
    // sits in the queue, which Node reports and future Node kills the process
    // over.
    const fetches = await mapSettled(peers, MAX_CONCURRENT_PEERS, async (peer) =>
      parseJsonl(
        await channel.exec(peer.target, ["murmur", "export", "--since", String(peer.watermark)]),
      ),
    );
    for (const [index, peer] of peers.entries()) {
      const fetch = fetches[index];
      try {
        if (!fetch) throw new Error("no result for peer");
        if (fetch.status === "rejected") throw fetch.reason;
        const { envelope, events } = fetch.value;
        const ingested = store.ingest(events);
        const watermark = events
          .filter((event) => event.host_id === envelope.host_id)
          .reduce((highest, event) => Math.max(highest, event.seq), peer.watermark);
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
          tmux_down_at: ingested > 0 ? null : peer.tmux_down_at,
        });
        store.prune();
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
  }
  return results;
}
