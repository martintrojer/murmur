import type { Channel } from "./channel.js";
import { describeFailure } from "./collector.js";
import { parseSnapshot } from "./snapshot.js";

/**
 * Bound for a whole doctor run, and deliberately NOT COLLECT_DEADLINE_MS.
 *
 * That 4s is sized against the tmux tick -- `murmur status` collects on every
 * repaint, and a collect that outlives its tick is a collect overlapping
 * itself, which tmux gives no way to cancel. Nothing in that reasoning applies
 * here: `murmur doctor` is typed by a person who is sitting there waiting, runs
 * once, and overlaps nothing. Inheriting the tick's budget would abandon
 * peers that were about to answer in order to protect a tick that does not
 * exist.
 *
 * Fifteen seconds, measured on the real fleet: ~300ms per warm peer for both
 * calls, and 1040ms for the unreachable one -- the connect timeout plus fork
 * overhead. So the budget is over an order of magnitude above a healthy fleet,
 * and still covers several serialised waves of dead hosts. It is high enough
 * that hitting it is itself information: the fan-out is what it bounds, not the
 * peer.
 *
 * A constant rather than a flag, per the zero-configuration rule: a wrong value
 * costs a release, not a silently broken user setup.
 */
export const DOCTOR_DEADLINE_MS = 15_000;

/** One row of a peer's `murmur peer list --json`, reduced to what doctor uses. */
export type RosterEntry = {
  /** The handle that peer types to reach the host. Local to that node. */
  name: string;
  /** The ssh target behind the name. */
  target: string;
  /**
   * What the host called itself, when that peer has ever heard from it.
   *
   * Carried but never compared: a peer added as `linuxpc` can report a
   * container id, so this is display material only. `host_id` is the only
   * comparable identity, and `peer list` does not carry one.
   */
  hostname: string | null;
};

/** A peer that answered both questions. */
export type PeerSurvey = {
  /** The ssh target we asked, so a result survives being moved around. */
  target: string;
  /** The only comparable identity in the fleet. From `export`, the sole source. */
  host_id: string;
  display_name: string;
  murmur_version: string;
  /** That peer's own view of the fleet. Empty is a valid answer. */
  roster: RosterEntry[];
};

/**
 * Why a peer could not be surveyed.
 *
 * Named per FAILED CALL rather than per underlying cause, because that is what
 * decides what the reader can still conclude: a peer with an identity but no
 * roster can still be checked for presence in everyone else's roster, while one
 * that never named itself cannot be reasoned about at all.
 *
 * - `identity-unavailable`: `murmur export` did not produce a snapshot. Asleep,
 *   off the VPN, no murmur installed, or a corrupt document -- all one
 *   observation here, since none of them yields a host_id.
 * - `roster-unavailable`: identity is known, `peer list --json` failed.
 * - `roster-unsupported`: the peer's murmur is too old to have `peer list
 *   --json`. Version skew, which is an upgrade, not a fault -- and must not be
 *   reported as a broken node.
 * - `roster-invalid`: the peer answered with something that is not a roster.
 */
export type SurveyFailureReason =
  | "identity-unavailable"
  | "roster-unavailable"
  | "roster-unsupported"
  | "roster-invalid";

export type SurveyFailure = {
  ok: false;
  target: string;
  reason: SurveyFailureReason;
  /**
   * One line a human can act on, already stripped of murmur's own ssh
   * invocation.
   */
  detail: string;
};

export type SurveyResult = ({ ok: true } & PeerSurvey) | SurveyFailure;

/**
 * Commander's answer to a flag or subcommand it does not have.
 *
 * This is the "too old" signal, and it is a real case rather than a defensive
 * one: `peer list --json` is newer than `export`, so a fleet mid-upgrade has
 * nodes that answer the first call perfectly and refuse the second. Told apart
 * from a corrupt roster on purpose -- the action is `npm i -g` on that host,
 * and calling it invalid output would send the operator looking for a bug.
 */
const OUTDATED = /\berror: unknown (?:option|command)\b/i;

function failure(target: string, reason: SurveyFailureReason, error: unknown): SurveyFailure {
  const message = error instanceof Error ? error.message : String(error);
  // Reuses the collector's normaliser rather than restating it. It is the one
  // place that knows how to turn an ssh rejection into a line about the host --
  // strip the invocation, recognise an unreachable host, bound the length --
  // and a second copy is how doctor and `peer list` end up disagreeing about
  // the same peer.
  return { ok: false, target, reason, detail: describeFailure(target, message) };
}

/**
 * Read a `murmur peer list --json` document.
 *
 * LENIENT where `parseSnapshot` is strict, and the asymmetry is deliberate.
 * This document crosses a version boundary in the direction murmur cannot
 * control: it is printed by whatever murmur that peer happens to run. Rejecting
 * unknown keys the way snapshot validation does would mean any future column
 * added to `peer list` breaks doctor against every not-yet-upgraded node --
 * turning an additive change into a fleet-wide outage of the tool you reach for
 * when the fleet looks wrong.
 *
 * So: the two fields doctor actually needs are required and typed, and
 * everything else is ignored. A row missing them is a malformed document rather
 * than a row to skip, because a roster with a hole in it silently reads as
 * "that peer does not know about the host" -- which is exactly the conclusion
 * doctor exists to draw, and it would be drawing it from a parse bug.
 */
function parseRoster(input: string): RosterEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    // The common shape of this is not corrupt JSON, it is not JSON at all: a
    // shell error, a login banner, or an older murmur's ASCII table. Quoting a
    // JSON.parse offset would bury that, so it says what was expected instead.
    throw new Error("peer list did not answer with JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("peer list: expected an array of peers");
  return parsed.map((row, index) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error(`peer list[${index}]: expected an object`);
    }
    const record = row as Record<string, unknown>;
    const { name, target, hostname } = record;
    if (typeof name !== "string" || name === "") {
      throw new Error(`peer list[${index}]: expected a non-empty name`);
    }
    if (typeof target !== "string" || target === "") {
      throw new Error(`peer list[${index}]: expected a non-empty target`);
    }
    return { name, target, hostname: typeof hostname === "string" ? hostname : null };
  });
}

/**
 * Ask one peer who it is and who it can see.
 *
 * Two calls, because neither alone is enough. `export` carries the host_id --
 * the only identity comparable across the fleet -- and structurally cannot
 * carry a roster: a snapshot is that node's own panes, which is precisely what
 * makes "absent from a snapshot means absent" true. `peer list --json` carries
 * the roster and no host_id.
 *
 * Sequential rather than concurrent, and not for politeness: a peer that cannot
 * name itself is unsurveyable whatever its roster says, so the second ssh would
 * be a forked process spent on an answer that gets discarded. The fan-out
 * across peers is where the concurrency belongs.
 *
 * Takes the Channel rather than reaching for ssh itself, exactly like the
 * collector, so this whole seam is testable without a second machine.
 */
export async function surveyPeer(channel: Channel, target: string): Promise<SurveyResult> {
  let host_id: string;
  let display_name: string;
  let murmur_version: string;
  try {
    // Bare `murmur export`, no options: the document is complete, so there is
    // nothing to ask for. The same call the collector makes, on purpose -- if
    // doctor could reach a peer that a collect cannot, it would be diagnosing a
    // fleet the rest of murmur does not see.
    const snapshot = parseSnapshot(await channel.exec(target, ["murmur", "export"]));
    ({ host_id, display_name, murmur_version } = snapshot);
  } catch (error) {
    return failure(target, "identity-unavailable", error);
  }

  let output: string;
  try {
    output = await channel.exec(target, ["murmur", "peer", "list", "--json"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(
      target,
      OUTDATED.test(message) ? "roster-unsupported" : "roster-unavailable",
      error,
    );
  }

  try {
    return { ok: true, target, host_id, display_name, murmur_version, roster: parseRoster(output) };
  } catch (error) {
    return failure(target, "roster-invalid", error);
  }
}
