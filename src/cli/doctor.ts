import type { Command } from "commander";
import type { Channel } from "../channel.js";
import { ssh } from "../channel.js";
import { MAX_CONCURRENT_PEERS, mapSettled } from "../collector.js";
import {
  DOCTOR_DEADLINE_MS,
  diagnose,
  type Finding,
  type LocalNode,
  type SurveyResult,
  surveyPeer,
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
    .action(async (options: { json?: boolean }) => {
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

        if (options.json) {
          // The findings, and the survey denominator with them. A consumer that
          // got findings alone could not tell "nothing wrong" from "nothing
          // answered", which are opposite conclusions.
          process.stdout.write(`${JSON.stringify(jsonReport(surveys, findings))}\n`);
        } else {
          process.stdout.write(render(local, surveys, findings));
        }
        process.exitCode = exitCodeFor(findings);
      } finally {
        store.close();
      }
    });
}
