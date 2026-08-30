import type { Channel } from "./channel.js";
import { tmux } from "./mux.js";
import { parseSnapshot, SnapshotInvalidError } from "./snapshot.js";
import type { Store } from "./store.js";
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
    store.reconcileLocal({ panes: tmux.livePanes(), now });
  } catch {
    // Housekeeping must not fail a command, and it must not report either.
  }
  return results;
}
