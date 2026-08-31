import type { Channel } from "./channel.js";
import { versionCell } from "./cli/peer.js";
import { describeFailure, MAX_CONCURRENT_PEERS, mapSettled } from "./collector.js";
import { parseSnapshot } from "./snapshot.js";
import type { PeerRecord } from "./types.js";

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

/**
 * Whether a finding is an operator task or just a fact about the fleet.
 *
 * The line is the one `collect` already draws between unreachable (expected,
 * exit 0) and reachable-but-broken (exit 1): a problem is something murmur can
 * say is definitely wrong, an observation is something only a human can judge.
 * Asymmetry is deliberately on the observation side -- see `diagnose`.
 */
export type Severity = "observation" | "problem";

export type FindingKind =
  | "duplicate-host-id"
  | "snapshot-skew"
  | "asymmetry"
  | "island"
  | "naming-drift"
  | "unsurveyable";

export type Finding = {
  kind: FindingKind;
  severity: Severity;
  /**
   * The handle the operator would type: a peer's local name, or this node's
   * display_name for a finding about this node. Never a host_id -- that is how
   * findings are computed, not how they are read.
   */
  subject: string;
  /** One sentence, complete on its own, so a renderer never has to compose. */
  message: string;
  /** A command to run, or null when there is nothing safe to suggest. */
  remedy: string | null;
};

/**
 * This node's peers, as `store.peers()` already returns them.
 *
 * A structural subset of PeerRecord rather than a new shape, so the caller
 * hands over what it has and the compiler checks the overlap: a renamed column
 * breaks here rather than silently reading undefined.
 */
export type LocalPeer = Pick<
  PeerRecord,
  "name" | "target" | "host_id" | "display_name" | "murmur_version" | "snapshot_version"
>;

/** This node: who it is, and who it has configured. */
export type LocalNode = {
  host_id: string;
  display_name: string;
  peers: LocalPeer[];
};

/** One host this node can name, with the identity every check compares on. */
type KnownHost = {
  host_id: string;
  /** The host's OWN self-report, from a snapshot. The only cross-node label. */
  display_name: string | null;
  /** What this node calls it. `null` for this node itself. */
  localName: string | null;
  /** The ssh target this node uses, for a remedy that can be copied. */
  target: string | null;
};

/**
 * `describeFailure` prefixes the target, which reads twice once a finding has
 * already named the peer. Dropped here rather than in the survey, because the
 * prefix is right for a `peer list` error line and wrong inside a sentence.
 */
function withoutTargetPrefix(target: string, detail: string): string {
  return detail.startsWith(`${target}: `) ? detail.slice(target.length + 2) : detail;
}

/**
 * Whether one row of a peer's roster is about `host`.
 *
 * The hard part of the whole diagnosis, because `peer list --json` carries no
 * host_id: a roster row is a local handle, an ssh target and -- only if that
 * peer has ever actually heard from the host -- the name the host published for
 * itself. So the match is made on that self-report, `display_name`, which both
 * sides got from the same `export` document. That is not the same thing as
 * trusting `hostname` as an identity: it is never used to tell two hosts apart,
 * only to recognise a host that already named itself the same way to two nodes.
 *
 * When the row has no self-report at all, that peer has never reached the host,
 * and the local handle is the only thing left. It is a weak match and it is used
 * only in that case, since a name is local: comparing rosters by name in general
 * reports naming drift as asymmetry and misses genuine duplicates.
 */
function rowIsAbout(row: RosterEntry, host: KnownHost): boolean {
  if (host.display_name === null) return false;
  if (row.hostname !== null) return row.hostname === host.display_name;
  return row.name === host.display_name || row.target === host.display_name;
}

/**
 * Findings from this node's configuration plus what its peers said. Pure.
 *
 * SEVERITY IS NOT A FEELING. Only two things are problems: one machine
 * configured twice on this node, and a peer whose snapshot version this node
 * rejects. Both are cases where murmur's own behaviour is provably wrong --
 * double the ssh work for one host, or state that cannot flow at all.
 *
 * Everything else is an observation, and asymmetry most of all. ARCHITECTURE.md
 * makes reachability deliberately one-directional -- "a laptop reaches a server,
 * and the server does not reach a laptop behind NAT" -- so a doctor that called
 * every asymmetry a fault would cry wolf on the normal case and teach the
 * operator to ignore the command. It is still reported, because the consequence
 * (that peer's picker cannot see this node's agents) is invisible on every other
 * surface.
 *
 * Version skew is delegated to `versionCell`, never recomputed. `peer list`
 * already decides what an incompatible pairing is and already prints it; a
 * second definition is how this repository got NEEDS_HUMAN as two literals in
 * two files, and a doctor that disagreed with `peer list` about one peer would
 * be worse than no doctor.
 */
export function diagnose(local: LocalNode, surveys: SurveyResult[]): Finding[] {
  const findings: Finding[] = [];
  const answered = surveys.filter((survey): survey is { ok: true } & PeerSurvey => survey.ok);
  const byTarget = new Map(answered.map((survey) => [survey.target, survey]));
  const nameOf = (target: string) =>
    local.peers.find((peer) => peer.target === target)?.name ?? target;

  // This node plus every peer it has an identity for. A survey beats the cache:
  // it was taken just now, and a peer added while unreachable has no cached
  // identity at all until the first collect.
  const self: KnownHost = {
    host_id: local.host_id,
    display_name: local.display_name,
    localName: null,
    target: null,
  };
  const hosts: KnownHost[] = [self];
  for (const peer of local.peers) {
    const survey = byTarget.get(peer.target);
    const host_id = survey?.host_id ?? peer.host_id;
    if (host_id === null) continue;
    hosts.push({
      host_id,
      display_name: survey?.display_name ?? peer.display_name,
      localName: peer.name,
      target: peer.target,
    });
  }

  // Duplicate host_id -- PROBLEM. Compared on host_id and nothing else: two
  // names for one machine means every command pays two ssh round trips for one
  // host, and nothing looks wrong until you notice the doubled work.
  // `peerAddDecision` catches this at add time, but only for a peer whose
  // identity was known then, so a peer added while asleep gets here first.
  const seen = new Map<string, KnownHost>();
  for (const host of hosts) {
    if (host.localName === null) continue;
    const first = seen.get(host.host_id);
    if (first === undefined) {
      seen.set(host.host_id, host);
      continue;
    }
    const label = host.display_name ?? host.host_id;
    findings.push({
      kind: "duplicate-host-id",
      severity: "problem",
      subject: host.localName,
      message:
        `${first.localName} and ${host.localName} are the same machine (${label}), ` +
        `so every command reaches it twice`,
      remedy: `murmur peer remove ${host.localName}`,
    });
  }

  // Snapshot skew -- PROBLEM, and entirely `versionCell`'s answer, including the
  // text. Reproducing either the rule or the wording here is what the spec
  // forbids.
  for (const peer of local.peers) {
    const cell = versionCell(peer);
    if (!cell.incompatible) continue;
    findings.push({
      kind: "snapshot-skew",
      severity: "problem",
      subject: peer.name,
      message:
        `${peer.name} speaks an incompatible snapshot version (${cell.text}); ` +
        `state will not sync until murmur versions match`,
      remedy: `ssh ${peer.target} npm i -g @martintrojer/murmur`,
    });
  }

  const peersThisNode = answered.filter((survey) =>
    survey.roster.some((row) => rowIsAbout(row, self)),
  );

  // Asymmetry -- OBSERVATION. Only a surveyed peer can be asked, so a peer that
  // did not answer is absent from this check rather than assumed either way.
  for (const survey of answered) {
    if (peersThisNode.includes(survey)) continue;
    const name = nameOf(survey.target);
    findings.push({
      kind: "asymmetry",
      severity: "observation",
      subject: name,
      message: `${name} does not peer this node (${local.display_name}), so its picker cannot see this node's agents`,
      // display_name is what the operator would type, but it is not guaranteed
      // to resolve from THAT host's ssh config, which murmur cannot see. So it
      // is a command to check, and `peer add` tolerates a target that does not
      // answer.
      remedy: `ssh ${survey.target} murmur peer add ${local.display_name}`,
    });
  }

  // Island -- OBSERVATION, and SCOPED TO ONE HOP. The wording is the finding:
  // `doctor` asks this node's peers for their rosters and stops there, so it
  // knows nothing about machines it never contacted. "No peer that this node
  // surveyed peers this host" is exactly what was measured; "nobody in the
  // fleet" would be a claim about hosts that were never asked.
  //
  // Requires at least one answer: with nothing surveyed there is no evidence of
  // isolation, only absence of evidence.
  if (answered.length > 0 && peersThisNode.length === 0) {
    findings.push({
      kind: "island",
      severity: "observation",
      subject: local.display_name,
      message:
        `no peer that this node surveyed peers this host (${local.display_name}); ` +
        `${answered.length} of ${answered.length} surveyed peers cannot see this node's agents`,
      remedy: null,
    });
  }

  // Naming drift -- OBSERVATION. One host_id wearing different local handles on
  // different nodes. Harmless to murmur and confusing to humans, which is
  // exactly what an observation is for: the operator reading "gardenpc" in one
  // picker and "garden" in another has no way to know it is one machine.
  for (const host of hosts) {
    const names = new Map<string, string[]>();
    const record = (name: string, where: string) => {
      const nodes = names.get(name);
      if (nodes) nodes.push(where);
      else names.set(name, [where]);
    };
    if (host.localName !== null) record(host.localName, "here");
    for (const survey of answered) {
      // A node does not name itself in its own roster, and its own handle for a
      // host it is not is what we are collecting.
      if (survey.host_id === host.host_id) continue;
      for (const row of survey.roster) {
        if (rowIsAbout(row, host)) record(row.name, nameOf(survey.target));
      }
    }
    if (names.size < 2) continue;
    const label = host.display_name ?? host.host_id;
    const spelled = [...names]
      .map(([name, nodes]) => `"${name}" on ${nodes.join(", ")}`)
      .join("; ");
    findings.push({
      kind: "naming-drift",
      severity: "observation",
      subject: host.localName ?? local.display_name,
      message: `one machine (${label}) is configured under different names: ${spelled}`,
      remedy: null,
    });
  }

  // Unsurveyable -- OBSERVATION, always. A fleet normally has a laptop asleep
  // and a box switched off, and a diagnostic that called that a failure would be
  // wrong on most runs. Reported per FAILED CALL, because that is what decides
  // the action: an old murmur needs an upgrade, an unreachable host needs the
  // network, and those must not read alike.
  for (const survey of surveys) {
    if (survey.ok) continue;
    const name = nameOf(survey.target);
    const detail = withoutTargetPrefix(survey.target, survey.detail);
    findings.push({
      kind: "unsurveyable",
      severity: "observation",
      subject: name,
      message:
        survey.reason === "roster-unsupported"
          ? `${name} runs a murmur too old to report its roster, so it could not be checked -- upgrade that host`
          : `${name} could not be surveyed -- ${detail}`,
      remedy:
        survey.reason === "roster-unsupported"
          ? `ssh ${survey.target} npm i -g @martintrojer/murmur`
          : null,
    });
  }

  // Returned in the order they were appended, which is already problems first
  // and then the operator's own peer order. There is no sort: a comparator here
  // would be a second, weaker statement of an ordering the check order above
  // already makes, and one that no longer failed if the checks were reordered.
  // The order is pinned by a test instead.
  return findings;
}

/**
 * Bound for the reachability phase, and deliberately larger than
 * `DOCTOR_DEADLINE_MS`.
 *
 * The survey is one call per peer; this is one dial per ORDERED PAIR, so the
 * work is O(N^2) where the survey is O(N). Reusing the survey's fifteen seconds
 * would mean the phase that costs the most is bounded by a budget sized for the
 * phase that costs the least -- and a deadline that a correct run routinely hits
 * reports a healthy fleet as unknown, which is the one answer this command must
 * not invent.
 *
 * Thirty seconds, measured on the real fleet: a probe to a live target is ~165ms
 * warm and a probe to a target that is switched off is ~480ms. Each dial is
 * additionally capped by the channel's own exec timeout, so sixteen dials at
 * eight-way concurrency is two waves and a worst case near six seconds. The
 * budget is therefore several times the worst case rather than close to it,
 * because the cost of being wrong is a false "unknown".
 *
 * A constant, not a flag, per the zero-configuration rule.
 */
export const TOPOLOGY_DEADLINE_MS = 30_000;

/**
 * Whether one node can open an ssh session to another.
 *
 * Three values and not two, which is the whole discipline of this phase. A
 * probe measures "could not connect, just now", and that has two very different
 * causes: the target refused or was unroutable (a firewall, a missing key, a
 * name that does not resolve there) or the target was simply switched off. Only
 * the first is a fact about the PAIR; the second is a fact about the target, and
 * calling it a fact about the pair is how hub advice flips between runs as
 * machines sleep.
 *
 * - `reaches`: proven. The dial succeeded.
 * - `unreachable`: a real negative. The dial failed AND this node can itself
 *   reach the target, so the target is demonstrably up and the failure is about
 *   this pair.
 * - `unknown`: the dial failed or was never attempted, and the target (or the
 *   source) was not demonstrably up. Not evidence of anything.
 */
export type Reach = "reaches" | "unreachable" | "unknown";

/** One node in the reachability matrix. */
export type TopologyNode = {
  /** The handle the operator types. This node's display_name, or a peer's name. */
  name: string;
  /**
   * The ssh target used when probing TO this node from elsewhere.
   *
   * For a peer this is this node's configured target, and for this node it is
   * its `display_name` -- which is what the operator would type, and which is
   * NOT guaranteed to resolve from another machine. Measured on the author's
   * fleet: `macmini` cannot resolve `mtrojer-mac` at all. That is a real
   * negative about the NAME rather than the network, so the detail is kept.
   */
  target: string;
  /** True for the node running the command. Its outbound row is dialled locally. */
  self: boolean;
};

/** One ordered pair, and what was learned about it. */
export type ReachEdge = {
  from: string;
  to: string;
  reach: Reach;
  /**
   * The failure, when there was one. Kept because negatives are not
   * interchangeable: "no route to host" is a network problem and "could not
   * resolve hostname" is a naming one, and they have different fixes.
   */
  detail: string | null;
};

export type Topology = {
  nodes: readonly TopologyNode[];
  edges: readonly ReachEdge[];
  /**
   * Dials that actually came back, so the output can state what it cost without
   * overstating it. Lower than the pair count whenever a source was skipped as
   * down, or the deadline cut the run short.
   */
  probes: number;
};

/** ssh's own words for a name that does not resolve, in either ssh's phrasing. */
const UNRESOLVED = /could not resolve hostname|name or service not known|nodename nor servname/i;

/** Whether a negative is about the name used rather than the network. */
export function isNameResolutionFailure(detail: string | null): boolean {
  return detail !== null && UNRESOLVED.test(detail);
}

/**
 * Ask `from` whether it can open an ssh session to `to`.
 *
 * A bare `true` on the far side, deliberately. It measures exactly one thing --
 * can A open an ssh session to B -- with no dependency on murmur existing on B.
 * Asking A to run `murmur export` against B would conflate transport with
 * installation, and those have different fixes: "unreachable" is a network or
 * key problem, "reachable but murmur missing" is an install. Inferring from A's
 * `~/.ssh/config` would be worse still, since that lists hosts which may not
 * resolve.
 *
 * The inner ssh carries `BatchMode=yes` and its own `ConnectTimeout`, and
 * deliberately NOT this node's ControlMaster options: a control path is a local
 * socket, so passing ours would name a file that does not exist on A. BatchMode
 * is not optional -- without it the inner ssh can block on a password prompt on
 * a machine with no terminal attached, and the dial would hang rather than fail.
 *
 * Returns the raw outcome. Turning a failure into `unreachable` or `unknown`
 * needs to know whether the target is up, which is not knowable from one dial --
 * see `buildTopology`.
 */
export async function probeReach(
  channel: Channel,
  from: TopologyNode,
  to: TopologyNode,
): Promise<{ ok: boolean; detail: string | null }> {
  const inner = ["ssh", "-o", "BatchMode=yes", `-o`, "ConnectTimeout=1", to.target, "true"];
  try {
    // A local dial for this node's own row: probing ourselves through an ssh to
    // ourselves would measure a loopback that no other node uses. `true` is
    // still the payload, so every row of the matrix means the same thing.
    await channel.exec(from.self ? to.target : from.target, from.self ? ["true"] : inner);
    return { ok: true, detail: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: describeFailure(to.name, message) };
  }
}

/**
 * Which nodes this node could itself reach, from the survey already taken.
 *
 * This is what makes `unreachable` distinguishable from `unknown`, and it costs
 * nothing extra: a peer that answered `murmur export` is demonstrably up as of
 * seconds ago. Using the survey rather than a second round of dials also keeps
 * the two phases consistent -- a host cannot be "up" for the matrix and "asleep"
 * for the findings in one run.
 */
export function reachableFromHere(surveys: readonly SurveyResult[]): Set<string> {
  return new Set(surveys.filter((survey) => survey.ok).map((survey) => survey.target));
}

/**
 * Probe every ordered pair and classify each outcome. O(N^2) remote dials.
 *
 * THE DISCIPLINE OF THIS FUNCTION IS THAT A FAILED DIAL IS NOT A NEGATIVE. It
 * becomes `unreachable` only when the target is demonstrably up -- it answered
 * this node's survey moments ago -- so the failure can only be about that pair.
 * When the target never answered, the dial failing tells us nothing we did not
 * already know, and it is `unknown`. `linuxpc` in the spec's sample was simply
 * switched off; reporting that as a firewall would make hub advice flip from run
 * to run as machines sleep, and an operator cannot act on advice that changes
 * when nothing changed.
 *
 * A pair whose SOURCE did not answer is `unknown` for the same reason and is
 * never dialled: asking a host that is off about its reachability costs a full
 * ssh timeout to learn nothing. That is also what keeps the real cost well under
 * the N^2 worst case on a fleet with anything asleep.
 */
export async function buildTopology(
  channel: Channel,
  nodes: readonly TopologyNode[],
  upFromHere: ReadonlySet<string>,
  deadline?: Promise<void>,
): Promise<Topology> {
  const isUp = (node: TopologyNode) => node.self || upFromHere.has(node.target);
  const pairs: { from: TopologyNode; to: TopologyNode }[] = [];
  for (const from of nodes) {
    for (const to of nodes) {
      if (from.name !== to.name) pairs.push({ from, to });
    }
  }
  // Only pairs whose source is known up are worth a dial. The rest are recorded
  // as unknown without spending an ssh timeout on them.
  const dialled = pairs.filter((pair) => isUp(pair.from));

  let timer: NodeJS.Timeout | undefined;
  try {
    const bounded =
      deadline ??
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, TOPOLOGY_DEADLINE_MS);
        timer.unref?.();
      });
    // The same pool the survey and the collector use. One answer to "how many
    // ssh processes may murmur have in flight" across every surface.
    const settled = await mapSettled(
      dialled,
      MAX_CONCURRENT_PEERS,
      async (pair) => probeReach(channel, pair.from, pair.to),
      bounded,
    );

    const outcomes = new Map<string, { ok: boolean; detail: string | null } | undefined>();
    // Counted from what came back, NOT from what was planned. The two differ
    // whenever the deadline cuts the run short, and a report that said "probed
    // 110 pairs" after attempting eight would overstate its own evidence -- in a
    // phase whose entire discipline is not claiming more than it measured.
    let probes = 0;
    for (const [index, pair] of dialled.entries()) {
      const result = settled[index];
      if (result !== undefined) probes += 1;
      outcomes.set(
        `${pair.from.name}\u0000${pair.to.name}`,
        result?.status === "fulfilled" ? result.value : undefined,
      );
    }

    const edges: ReachEdge[] = pairs.map(({ from, to }) => {
      const outcome = outcomes.get(`${from.name}\u0000${to.name}`);
      // Never dialled, or the deadline passed before this pair was claimed.
      if (outcome === undefined) {
        return {
          from: from.name,
          to: to.name,
          reach: "unknown",
          detail: isUp(from) ? "not probed within the deadline" : `${from.name} did not answer`,
        };
      }
      if (outcome.ok) return { from: from.name, to: to.name, reach: "reaches", detail: null };
      // The dial failed. Whether that is a fact about this pair depends entirely
      // on whether the target was up to be reached.
      return {
        from: from.name,
        to: to.name,
        reach: isUp(to) ? "unreachable" : "unknown",
        detail: outcome.detail,
      };
    });
    return { nodes, edges, probes };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** What a star hubbed at one node would actually deliver. */
export type HubCandidate = {
  node: string;
  /** Nodes this one is proven to reach. */
  reaches: string[];
  /** Demonstrable negatives: the target was up and this node still could not. */
  cannotReach: string[];
  /** Pairs nothing was learned about. Never counted as a negative. */
  unknown: string[];
  /**
   * The nodes a star hubbed here could actually serve, including the hub.
   *
   * BOTH directions must be proven for a spoke to count. The spec's own account
   * of what a star delivers is "spokes see the hub's agents and the hub sees
   * everyone's", and those are different edges: the spoke collects from the hub,
   * so spoke->hub must work, and the hub collects from the spoke, so hub->spoke
   * must work too. Requiring only one direction would name a hub that half the
   * fleet could not use, which is the failure this whole phase exists to
   * prevent.
   */
  star: string[];
};

/**
 * For each node, what it reaches and what a star hubbed there would serve. Pure.
 *
 * This is arithmetic on the matrix, not a preference, which is exactly why it is
 * computed rather than suggested: which node CAN be a hub follows from
 * reachability, and only whether to adopt one is a judgement about how the
 * operator works.
 */
export function hubCandidates(topology: Topology): HubCandidate[] {
  const { nodes, edges } = topology;
  const lookup = new Map(edges.map((edge) => [`${edge.from}\u0000${edge.to}`, edge.reach]));
  const reachOf = (from: string, to: string): Reach =>
    from === to ? "reaches" : (lookup.get(`${from}\u0000${to}`) ?? "unknown");

  return nodes.map((hub) => {
    const others = nodes.filter((node) => node.name !== hub.name);
    const reaches = others.filter((node) => reachOf(hub.name, node.name) === "reaches");
    return {
      node: hub.name,
      reaches: reaches.map((node) => node.name),
      cannotReach: others
        .filter((node) => reachOf(hub.name, node.name) === "unreachable")
        .map((node) => node.name),
      unknown: others
        .filter((node) => reachOf(hub.name, node.name) === "unknown")
        .map((node) => node.name),
      // Proven in both directions, and `unknown` never counts as proven: a star
      // built on a guess is the thing that cannot be allowed to look computed.
      star: [
        hub.name,
        ...reaches
          .filter((node) => reachOf(node.name, hub.name) === "reaches")
          .map((node) => node.name),
      ],
    };
  });
}

/**
 * The best star available, or null when none is better than no star at all.
 *
 * A single node is never a star: `star` always contains the hub itself, so a
 * candidate of size one means "this node can serve nobody", and reporting that
 * as a topology would be inventing a recommendation out of an empty
 * intersection.
 */
export function bestHub(candidates: readonly HubCandidate[]): HubCandidate | null {
  let best: HubCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.star.length < 2) continue;
    // Ties broken by the order nodes were listed, which is this node first and
    // then the operator's own peer order. A stable answer matters more than a
    // clever one: hub advice that reordered between runs would read as the
    // matrix having changed.
    if (best === null || candidate.star.length > best.star.length) best = candidate;
  }
  return best;
}
