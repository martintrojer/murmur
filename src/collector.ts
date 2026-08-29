import type { Channel } from "./channel.js";
import { type Envelope, eventFromWire, SCHEMA_VERSION } from "./export.js";
import type { Store } from "./store.js";
import type { Event } from "./types.js";

export const COLLECT_INTERVAL_MS = 30_000;
export const STALENESS_MS = 2 * COLLECT_INTERVAL_MS;

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

export async function collect(
  store: Store,
  channel: Channel,
  now = Date.now(),
): Promise<CollectResult[]> {
  const results: CollectResult[] = [];
  try {
    for (const peer of store.peers()) {
      try {
        const output = await channel.exec(peer.target, [
          "murmur",
          "export",
          "--since",
          String(peer.watermark),
        ]);
        const { envelope, events } = parseJsonl(output);
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
