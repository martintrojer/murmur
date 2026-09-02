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
  type FindingKind,
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
import { formatTable } from "./peer.js";

/**
 * Survey every configured peer, concurrently and under one deadline.
 *
 * Reuses the collector's pool rather than growing a second one: both surfaces ssh
 * to the same hosts, so one answer to "how many at once" is the only way they
 * cannot disagree. The DEADLINE is not reused -- see DOCTOR_DEADLINE_MS.
 *
 * A peer the deadline never reached is reported as one that did not answer,
 * never omitted: omission would shrink the denominator in "surveyed N peers",
 * the one number saying how much of the fleet this report covers.
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
      // it rather than a fact about the peer.
      if (result?.status === "fulfilled") return result.value;
      // Never claimed and claimed-but-unfinished are ONE case here, unlike in
      // `collect`. The difference matters only to a writer -- an invented
      // attempt defers a peer behind the floor -- and doctor writes nothing. It
      // reports, and "not surveyed within the deadline" is equally true of both.
      const detail =
        result === undefined || result.status === "pending"
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
 * TABLES, not prose. The first version printed a sentence per finding, which on
 * a four-peer fleet was four 106-column lines each repeating the subject they
 * were aligned under and an identical consequence. A report is scanned before it
 * is read, and prose cannot be scanned.
 *
 * So: grouped by kind, one table per group with the consequence stated once in
 * the heading, every command collected under one actions block. `peer list`
 * prints errors below its table for the same reason.
 */
// Dim, so a group's shared consequence and the caveats read as annotation rather
// than as another finding. Same escape the picker uses.
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

/** Two spaces on every line, so a table sits under its heading. */
function indent(block: string): string {
  return block
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");
}

/**
 * What a group of findings of one kind is called, and the consequence they share.
 *
 * The consequence lives here, once per group, rather than in each row. Four rows
 * of "so its picker cannot see this node's agents" is the same clause four times;
 * stated once above the table it is read once and applies to every row.
 */
const GROUP: Record<FindingKind, { heading: string; because: string | null }> = {
  "duplicate-host-id": {
    heading: "Duplicate peers",
    because: "One machine configured twice. Every command reaches it twice.",
  },
  "snapshot-skew": {
    heading: "Incompatible versions",
    because: "State will not sync with these until murmur versions match.",
  },
  island: {
    heading: "Not visible to the fleet",
    because: null,
  },
  asymmetry: {
    heading: "One-way peering",
    because: "These do not peer this node, so their pickers cannot see its agents.",
  },
  "never-worked": {
    heading: "Never answered",
    because:
      "Contacted and never once successful, so murmur holds no state for these. Usually a wrong target, no remote murmur, or an auth wall -- none of which resolve by waiting.",
  },
  "naming-drift": {
    heading: "Naming drift",
    because: "Harmless to murmur, confusing to read: one machine, several names.",
  },
  unsurveyable: {
    heading: "Could not be surveyed",
    because: "Normal for a sleeping laptop or a box switched off.",
  },
};

/** The order groups appear in: problems first, then observations. */
/**
 * Every kind, in the order the report prints them.
 *
 * Derived from `GROUP`'s keys rather than restated, which is what makes it
 * complete by construction. `GROUP` is a `Record<FindingKind, ...>`, so the
 * compiler already demands an entry for every kind; taking the order from it
 * means a new kind cannot be computed, carried in `--json`, and then silently
 * never rendered. That is exactly what happened to `never-worked` -- the
 * heading was type-checked, the order was a hand-written array, and only a
 * real-fleet run showed the section missing.
 *
 * The cost is that print order is now declaration order in `GROUP`, so that
 * object is ordered deliberately: worst first, cosmetic last.
 */
const GROUP_ORDER = Object.keys(GROUP) as FindingKind[];

export function render(
  local: LocalNode,
  surveys: readonly SurveyResult[],
  findings: readonly Finding[],
): string {
  const answered = surveys.filter((survey) => survey.ok).length;
  const out: string[] = [];

  // The denominator first, because it bounds every claim that follows: a report
  // over one answered peer of four is a much weaker statement than one over four,
  // and the reader cannot discount the findings without knowing which.
  if (surveys.length === 0) return "No peers configured, so there is nothing to survey.\n";
  out.push(
    `Surveyed ${surveys.length} peer${surveys.length === 1 ? "" : "s"}, ${answered} answered.\n`,
  );
  if (findings.length === 0) {
    out.push("\nNo problems found.\n");
    return out.join("");
  }

  const problems = findings.filter((finding) => finding.severity === "problem").length;
  // A one-line verdict before any detail, so the reader knows whether to act
  // before deciding how much to read. Problems and observations are counted
  // separately because the whole exit-code contract rests on the difference.
  const counts = [
    problems > 0 ? `${problems} problem${problems === 1 ? "" : "s"}` : "",
    findings.length - problems > 0
      ? `${findings.length - problems} observation${findings.length - problems === 1 ? "" : "s"}`
      : "",
  ].filter(Boolean);
  // The verdict, and it is the line the reader acts on. A count of problems is
  // the whole point of the exit code, so it is stated in words here rather than
  // left to be inferred by counting `!` marks further down.
  out.push(
    problems > 0
      ? `${counts.join(", ")}. See "Do this" below.\n`
      : `${counts.join(", ")}, nothing broken.\n`,
  );

  for (const kind of GROUP_ORDER) {
    const group = findings.filter((finding) => finding.kind === kind);
    if (group.length === 0) continue;
    const { heading, because } = GROUP[kind] ?? { heading: kind, because: null };
    // The severity mark is a column ONLY when a group actually contains a
    // problem. Every kind here has a fixed severity today, so a mark column on an
    // all-observation group is three columns of whitespace on every row -- and an
    // empty column reads as a missing value rather than as "nothing to flag".
    const marked = group.some((finding) => finding.severity === "problem");
    const rows = group.map((finding) =>
      marked
        ? [finding.severity === "problem" ? "!" : " ", finding.subject, finding.detail]
        : [finding.subject, finding.detail],
    );
    out.push(`\n${heading}\n`);
    if (because) out.push(`  ${DIM}${because}${RESET}\n`);
    out.push(indent(formatTable(rows)));
  }

  const remedies = findings.filter(
    (finding): finding is Finding & { remedy: string } => finding.remedy !== null,
  );
  if (remedies.length > 0) {
    // ONE deduplicated block at the end. Commands used to be interleaved with the
    // prose motivating them, so an operator had to read the whole report to
    // collect them, and the same `peer add` could appear under two findings.
    out.push("\nDo this\n");
    const seen = new Set<string>();
    for (const finding of remedies) {
      if (seen.has(finding.remedy)) continue;
      seen.add(finding.remedy);
      out.push(`  ${finding.remedy}\n`);
    }
    // Only a `peer add` naming THIS node depends on our display_name resolving
    // from the far side: a `peer remove` runs here, and an upgrade names no host.
    if (remedies.some((f) => f.remedy.includes(`murmur peer add ${local.display_name}`))) {
      out.push(
        `\n  ${DIM}These name this node "${local.display_name}". Whether a peer resolves that\n` +
          `  depends on its own ssh config, which murmur cannot see -- so check, do not\n` +
          `  trust. \`peer add\` accepts a target that does not answer yet.${RESET}\n`,
      );
    }
  }
  return out.join("");
}

/**
 * The reachability matrix and what it implies, as a table plus a verdict.
 *
 * Pure over a Topology, so every line below is testable without a dial.
 *
 * A per-node table, not an N x N grid: five nodes is twenty-five cells to read
 * for an answer that is one row each, and it scales worse than the fleet does.
 * Three outcomes get three columns because "cannot reach" and "unknown" must
 * never merge -- the first is a fact to act on, the second an absence of
 * information, and an operator who cannot tell them apart acts on the wrong one.
 */
export function renderTopology(topology: Topology): string {
  const candidates = hubCandidates(topology);
  const hub = bestHub(candidates);
  const out: string[] = [];
  const all = topology.nodes.length - 1;

  out.push(
    `\nReachability  ${DIM}${topology.probes} ordered pair` +
      `${topology.probes === 1 ? "" : "s"} probed across ${topology.nodes.length} nodes${RESET}\n`,
  );

  // UNKNOWN earns its width only when something is unknown: where every probe
  // answered it was a column of dashes, and an all-placeholder column reads as
  // missing data rather than "none". Same rule as `peer list`'s columns.
  const anyUnknown = candidates.some((candidate) => candidate.unknown.length > 0);
  const rows: string[][] = [["", "REACHES", "CANNOT REACH", ...(anyUnknown ? ["UNKNOWN"] : [])]];
  for (const candidate of candidates) {
    rows.push([
      candidate.node,
      candidate.reaches.length === all && all > 0
        ? `all ${all}`
        : candidate.reaches.length > 0
          ? candidate.reaches.join(" ")
          : "-",
      candidate.cannotReach.length > 0 ? candidate.cannotReach.join(" ") : "-",
      ...(anyUnknown ? [candidate.unknown.length > 0 ? candidate.unknown.join(" ") : "-"] : []),
    ]);
  }
  out.push(indent(formatTable(rows)));

  // A name that does not resolve from the far side is called out separately,
  // because it is indistinguishable from a network problem in the matrix and has
  // a completely different fix. Measured on the author's own fleet: macmini
  // cannot resolve `mtrojer-mac`, which is this node's display_name.
  const unresolved = topology.edges.filter((edge) => isNameResolutionFailure(edge.detail));
  if (unresolved.length > 0) {
    const targets = [...new Set(unresolved.map((edge) => edge.to))];
    const from = [...new Set(unresolved.map((edge) => edge.from))];
    out.push(
      `\n  ${DIM}${targets.join(", ")} is not resolvable by name from ${from.join(", ")} -- ` +
        `a naming\n  problem, not a network one. It may be reachable under another address.${RESET}\n`,
    );
  }

  if (hub === null) {
    // RECOMMEND NOTHING. Not a hedge: there is genuinely no star to name, and
    // inventing one that cannot work is the exact failure this phase exists to
    // prevent. The partition above is the true and useful half.
    out.push(
      `\nHub  ${DIM}none possible${RESET}\n` +
        `  A hub must reach every spoke and be reachable from each in turn.\n` +
        `  No node here does both, so none is recommended.\n`,
    );
    return out.join("");
  }

  const spokes = hub.star.filter((name) => name !== hub.node);
  const excluded = topology.nodes
    .map((node) => node.name)
    .filter((name) => !hub.star.includes(name));
  out.push(
    excluded.length === 0
      ? `\nHub  ${hub.node}  ${DIM}serves the whole fleet${RESET}\n`
      : `\nHub  ${hub.node}  ${DIM}serves {${hub.star.join(", ")}}` +
          `, leaves out ${excluded.join(", ")}${RESET}\n`,
  );

  out.push(`\nTo build that star\n`);
  for (const spoke of spokes) out.push(`  ssh ${spoke} murmur peer add ${hub.node}\n`);

  // THE COST OF A STAR, always printed with the recommendation. Spokes see the
  // hub and the hub sees everyone, but spokes DO NOT see each other: `export`
  // publishes local panes only, so a hub cannot re-serve what it learned. This is
  // the one thing an operator adopting a star is most likely to assume wrongly,
  // so it is not left to be discovered.
  out.push(
    `\n  ${DIM}Cost: spokes would see ${hub.node}'s agents and it would see theirs, but\n` +
      `  SPOKES WOULD NOT SEE EACH OTHER. \`murmur export\` publishes a node's own\n` +
      `  panes only, so a hub cannot re-serve what it learned. A star is not a mesh.${RESET}\n`,
  );
  return out.join("");
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
