import type { Command } from "commander";
import type { Channel } from "../channel.js";
import { ssh } from "../channel.js";
import { MAX_CONCURRENT_PEERS, mapSettled } from "../collector.js";
import {
  bestHub,
  buildTopology,
  DOCTOR_DEADLINE_MS,
  diagnose,
  type Finding,
  hubCandidates,
  isNameResolutionFailure,
  type LocalNode,
  reachableFromHere,
  type SurveyResult,
  surveyPeer,
  type Topology,
  type TopologyNode,
} from "../doctor.js";
import { openStore } from "../store.js";
import type { PeerRecord } from "../types.js";
import { requireIdentity } from "./identity-guard.js";

/**
 * Survey every configured peer, concurrently and under one deadline.
 *
 * Reuses the collector's pool rather than growing a second one: both surfaces
 * ssh to the same hosts, so one answer to "how many at once" is the only way
 * they cannot disagree. What is NOT reused is the deadline --
 * `DOCTOR_DEADLINE_MS` is fifteen seconds against the collector's four, because
 * the collector's budget is sized to the tmux tick and doctor overlaps nothing.
 *
 * A peer the deadline never reached is reported as a peer that did not answer,
 * not omitted: an omission would silently shrink the denominator in "surveyed N
 * peers", which is the one number telling the operator how much of the fleet
 * this report actually covers.
 */
export async function surveyFleet(
  channel: Channel,
  peers: readonly PeerRecord[],
  deadline?: Promise<void>,
): Promise<SurveyResult[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // Unref'd, like the collector's: a pending timer must not hold the process
    // open after the command has printed and finished.
    const bounded =
      deadline ??
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DOCTOR_DEADLINE_MS);
        timer.unref?.();
      });
    const settled = await mapSettled(
      peers,
      MAX_CONCURRENT_PEERS,
      async (peer) => surveyPeer(channel, peer.target),
      bounded,
    );
    return peers.map((peer, index) => {
      const result = settled[index];
      // `surveyPeer` catches its own failures, so a rejection here is a bug in
      // it rather than a fact about the peer. Undefined is the deadline: that
      // peer was never claimed, or was still in flight when time ran out.
      if (result?.status === "fulfilled") return result.value;
      const detail =
        result === undefined
          ? `not surveyed within ${DOCTOR_DEADLINE_MS / 1_000}s`
          : result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
      return { ok: false, target: peer.target, reason: "identity-unavailable", detail };
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The whole report, as text. Pure over findings so every line below is testable
 * without an ssh binary, a store or a captured stdout.
 *
 * NO TABLE, deliberately. `peer list` prints its errors below its table rather
 * than in it because a message is a sentence and a column of sentences is not a
 * table; every finding here is that kind of sentence. Peer names ARE padded
 * into a gutter, which is alignment rather than tabulation: one short column of
 * subjects makes the list scannable, and the sentence that follows is prose.
 */
export function render(
  local: LocalNode,
  surveys: readonly SurveyResult[],
  findings: readonly Finding[],
): string {
  const answered = surveys.filter((survey) => survey.ok).length;
  const lines: string[] = [];

  // The denominator first, because it bounds every claim that follows: a report
  // over one answered peer of four is a much weaker statement than one over
  // four, and the reader cannot discount the findings without knowing which.
  lines.push(
    surveys.length === 0
      ? "No peers configured, so there is nothing to survey.\n"
      : `Surveyed ${surveys.length} peer${surveys.length === 1 ? "" : "s"}, ${answered} answered.\n`,
  );

  if (findings.length === 0) {
    if (surveys.length > 0) {
      lines.push("\nNo problems found.\n");
    }
    return lines.join("");
  }

  // Aligned on the subject, which is the handle the operator types. Widths from
  // the findings themselves, so the gutter never depends on a peer that is not
  // being reported about.
  const width = Math.max(...findings.map((finding) => finding.subject.length));
  lines.push("\n");
  for (const finding of findings) {
    // A problem is marked in the row, not just counted at the end. The mark is
    // what a reader scanning a long report sees, and without it a duplicate
    // host_id reads exactly like a sleeping laptop.
    const mark = finding.severity === "problem" ? "!" : " ";
    lines.push(`${mark} ${finding.subject.padEnd(width)}  ${finding.message}\n`);
  }

  const remedies = findings.filter(
    (finding): finding is Finding & { remedy: string } => finding.remedy !== null,
  );
  if (remedies.length > 0) {
    // Whether the suggestions need the caveat depends on what they are: only a
    // `peer add` naming THIS node depends on this node's display_name resolving
    // from the far side. A `peer remove` runs here, and an upgrade names no
    // host at all.
    const namesThisNode = remedies.some((finding) =>
      finding.remedy.includes(`murmur peer add ${local.display_name}`),
    );
    lines.push("\nTo check:\n\n");
    for (const finding of remedies) {
      lines.push(`  ${finding.remedy}\n`);
    }
    if (namesThisNode) {
      // The caveat the output must not hide. `display_name` is what the operator
      // would type HERE; whether the peer can resolve it depends on that peer's
      // ssh config and DNS, which murmur cannot see. So these are commands to
      // check rather than commands that are known to work -- and the reason it
      // is safe to try is stated too, since "peer add tolerates a target that
      // does not answer" is what makes running them low-risk.
      lines.push(
        `\nThese name this node as "${local.display_name}", which is what it calls itself.\n` +
          `Whether a peer can reach it under that name depends on that peer's ssh\n` +
          `config and DNS, which murmur cannot see -- so check each command rather\n` +
          `than trusting it. \`peer add\` accepts a target that does not answer yet,\n` +
          `and discovers identity on the first successful collect.\n`,
      );
    }
  }
  return lines.join("");
}

/**
 * The reachability matrix and what it implies, as text.
 *
 * Pure over a Topology, so every sentence below is testable without a dial.
 */
export function renderTopology(topology: Topology): string {
  const candidates = hubCandidates(topology);
  const hub = bestHub(candidates);
  const lines: string[] = [];

  lines.push(
    `\nProbed ${topology.probes} ordered pair${topology.probes === 1 ? "" : "s"} ` +
      `across ${topology.nodes.length} nodes.\n\n`,
  );

  // Per-node summary rather than an N x N grid. A grid of four nodes is already
  // sixteen cells to read for an answer that is one sentence per row, and it
  // scales worse than the fleet does.
  const width = Math.max(...candidates.map((candidate) => candidate.node.length));
  for (const candidate of candidates) {
    const parts: string[] = [];
    if (candidate.reaches.length === topology.nodes.length - 1) {
      parts.push(`reaches all ${candidate.reaches.length}`);
    } else if (candidate.reaches.length > 0) {
      parts.push(`reaches ${candidate.reaches.join(", ")}`);
    } else {
      parts.push("reaches nothing");
    }
    // Negatives and non-answers are never merged. "cannot reach" is a fact to
    // act on; "unknown" is an absence of information, and an operator who
    // cannot tell them apart will act on the wrong one.
    if (candidate.cannotReach.length > 0) {
      parts.push(`cannot reach ${candidate.cannotReach.join(", ")}`);
    }
    if (candidate.unknown.length > 0) {
      parts.push(`unknown for ${candidate.unknown.join(", ")}`);
    }
    lines.push(`  ${candidate.node.padEnd(width)}  ${parts.join("; ")}\n`);
  }

  // A name that does not resolve from the far side is called out separately,
  // because it looks identical to a network problem in the matrix and has a
  // completely different fix. Measured on the author's own fleet: macmini cannot
  // resolve `mtrojer-mac`, which is this node's display_name.
  const unresolved = topology.edges.filter((edge) => isNameResolutionFailure(edge.detail));
  if (unresolved.length > 0) {
    const targets = [...new Set(unresolved.map((edge) => edge.to))];
    lines.push(
      `\n${targets.join(", ")} could not be resolved by name from ` +
        `${[...new Set(unresolved.map((edge) => edge.from))].join(", ")}. ` +
        `That is a naming\nproblem rather than a network one: the host may well be ` +
        `reachable under an\naddress those nodes can resolve.\n`,
    );
  }

  if (hub === null) {
    // RECOMMEND NOTHING. Not a hedge -- there is genuinely no star to name, and
    // inventing one that cannot work is the exact failure this phase exists to
    // prevent. The partition is reported instead, because that is the true and
    // useful half.
    lines.push(
      "\nNo node can serve as a hub for this fleet, and none is recommended.\n" +
        "A hub must be reachable from every spoke and reach every spoke in turn;\n" +
        "no node here does both for any other.\n",
    );
    return lines.join("");
  }

  const whole = hub.star.length === topology.nodes.length;
  const spokes = hub.star.filter((name) => name !== hub.node);
  if (whole) {
    lines.push(`\nA star hubbed at ${hub.node} is possible, and would serve the whole fleet.\n`);
  } else {
    // The largest workable subset, and explicitly what it leaves out. Naming the
    // reachable subset is the useful half; pretending it is the whole fleet is
    // not.
    const excluded = topology.nodes
      .map((node) => node.name)
      .filter((name) => !hub.star.includes(name));
    lines.push(
      `\nNo single node can hub this whole fleet. The largest star available is\n` +
        `${hub.node} serving {${hub.star.join(", ")}}, which leaves out ` +
        `${excluded.join(", ")}.\n`,
    );
  }

  lines.push(`\nTo build it:\n\n`);
  for (const spoke of spokes) {
    lines.push(`  ssh ${spoke} murmur peer add ${hub.node}\n`);
  }

  // THE COST OF A STAR, always stated when one is named. Spokes see the hub and
  // the hub sees everyone, but spokes DO NOT see each other: `export` publishes
  // local panes only, so a hub cannot re-serve what it learned. This is the one
  // thing an operator adopting a star is most likely to assume wrongly, so it is
  // printed with the recommendation rather than left to be discovered.
  lines.push(
    `\nWhat that star costs: spokes would see ${hub.node}'s agents and ${hub.node}\n` +
      `would see every spoke's, but SPOKES WOULD NOT SEE EACH OTHER. \`murmur export\`\n` +
      `publishes a node's own panes only, so a hub cannot re-serve what it learned\n` +
      `from another node. A star is not a mesh, and choosing one is choosing that.\n`,
  );
  return lines.join("");
}

/**
 * The `--json` document.
 *
 * Carries the survey denominator alongside the findings, because findings alone
 * cannot distinguish "nothing is wrong" from "nothing answered" -- opposite
 * conclusions with an identical empty list. `severity` is the machine-readable
 * field a consumer gates on, and it is already on every finding.
 */
export function jsonReport(
  surveys: readonly SurveyResult[],
  findings: readonly Finding[],
): { surveyed: number; answered: number; findings: readonly Finding[] } {
  return {
    surveyed: surveys.length,
    answered: surveys.filter((survey) => survey.ok).length,
    findings,
  };
}

/** Exit 1 iff something is an operator task. Observations are exit 0. */
export function exitCodeFor(findings: readonly Finding[]): number {
  // The same line `collect` draws: unreachable is expected and exits 0,
  // reachable-but-broken is a task and exits 1. Asymmetry is on the 0 side by
  // design -- ARCHITECTURE.md makes reachability deliberately one-directional,
  // so a doctor that failed the build on every asymmetric fleet would cry wolf
  // on the normal case.
  return findings.some((finding) => finding.severity === "problem") ? 1 : 0;
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    // No --fix, and it is not an omission. Every repair here runs on ANOTHER
    // machine, so a --fix would mean murmur rewriting a remote node's
    // configuration -- a far larger claim than a diagnostic, and one that cuts
    // against membership being local. The commands are printed instead.
    .description("Survey peers over ssh and report what only a fleet-wide view can see")
    .option("--json", "print the finding list")
    // Opt in, because it costs O(N^2) remote dials where the survey costs O(N).
    // Plain `doctor` answers "is my fleet mutual?"; this answers "what fleet
    // shapes are even possible here?", which is a question asked at setup time
    // rather than on every check.
    .option("--topology", "also probe who can reach whom, and compute hub options")
    .action(async (options: { json?: boolean; topology?: boolean }) => {
      const identity = requireIdentity();
      if (!identity) return;
      const store = openStore();
      try {
        const peers = store.peers();
        // Read-only, and this is the whole of it: peers are read, the survey
        // happens, and nothing is written back. A survey is a diagnostic that
        // reaches out, not state murmur caches -- caching it would make
        // `peer list` start reporting facts no collect ever established.
        const surveys = await surveyFleet(ssh, peers);
        const local: LocalNode = {
          host_id: identity.host_id,
          display_name: identity.display_name,
          peers,
        };
        const findings = diagnose(local, surveys);

        // Second phase, and strictly additive: the findings above are computed
        // and reported identically whether or not it runs, so --topology cannot
        // change what plain `doctor` concludes. Only the exit code's inputs
        // matter for that, and topology contributes none.
        let topology: Topology | null = null;
        if (options.topology) {
          const nodes: TopologyNode[] = [
            { name: identity.display_name, target: identity.display_name, self: true },
            ...peers.map((peer) => ({ name: peer.name, target: peer.target, self: false })),
          ];
          // The survey's own answers are what make `unreachable` distinguishable
          // from `unknown`, so the matrix is built from them rather than from a
          // second round of liveness dials.
          topology = await buildTopology(ssh, nodes, reachableFromHere(surveys));
        }

        if (options.json) {
          // The findings, and the survey denominator with them. A consumer that
          // got findings alone could not tell "nothing wrong" from "nothing
          // answered", which are opposite conclusions.
          process.stdout.write(
            `${JSON.stringify({
              ...jsonReport(surveys, findings),
              // Omitted entirely rather than null when the phase did not run: a
              // consumer must not have to tell "no topology" apart from "a
              // topology with nothing in it".
              ...(topology ? { topology, hubs: hubCandidates(topology) } : {}),
            })}\n`,
          );
        } else {
          process.stdout.write(render(local, surveys, findings));
          if (topology) process.stdout.write(renderTopology(topology));
        }
        process.exitCode = exitCodeFor(findings);
      } finally {
        store.close();
      }
    });
}
