import { expect, test } from "vitest";
import {
  diagnose,
  type Finding,
  type LocalNode,
  type LocalPeer,
  type RosterEntry,
  type SurveyResult,
} from "../src/doctor.js";

/**
 * The diagnosis core. Pure in, pure out: no Channel, no store, no ssh, so every
 * fleet shape the spec names is one object literal away.
 *
 * The fixtures below carry a host_id for every host on purpose. Identity is
 * host_id and never a name, so a test that leaned on names would agree with a
 * broken implementation.
 */

const SELF = "SELF-HOST-ID";

function localNode(peers: LocalPeer[], over: Partial<LocalNode> = {}): LocalNode {
  return { host_id: SELF, display_name: "mtrojer-mac", peers, ...over };
}

function peer(over: Partial<LocalPeer> & { name: string }): LocalPeer {
  return {
    target: over.name,
    host_id: null,
    display_name: null,
    murmur_version: "0.2.1",
    snapshot_version: 1,
    // Defaults describing a HEALTHY peer, so a test opts in to the never-worked
    // shape rather than inheriting it: most fixtures here are about other
    // checks and must not accidentally raise this finding.
    snapshot: {} as never,
    last_attempt_at: 1_000,
    last_error: null,
    ...over,
  };
}

function surveyed(
  over: Partial<Extract<SurveyResult, { ok: true }>> & { target: string; host_id: string },
): SurveyResult {
  return {
    ok: true,
    display_name: over.target,
    murmur_version: "0.2.1",
    roster: [],
    ...over,
  };
}

/** A roster row as a peer that HAS heard from the host would print it. */
function row(name: string, hostname: string | null, target = name): RosterEntry {
  return { name, target, hostname };
}

function kinds(findings: Finding[]): string[] {
  return findings.map((finding) => finding.kind);
}

function only(findings: Finding[], kind: Finding["kind"]): Finding {
  const matching = findings.filter((finding) => finding.kind === kind);
  expect(matching).toHaveLength(1);
  return matching[0] as Finding;
}

test("a mutual fleet produces no findings at all", () => {
  const findings = diagnose(
    localNode([
      peer({ name: "bubba", host_id: "BUBBA" }),
      peer({ name: "macmini", host_id: "MACMINI" }),
    ]),
    [
      surveyed({ target: "bubba", host_id: "BUBBA", roster: [row("mtrojer-mac", "mtrojer-mac")] }),
      surveyed({
        target: "macmini",
        host_id: "MACMINI",
        roster: [row("mtrojer-mac", "mtrojer-mac")],
      }),
    ],
  );
  expect(findings).toEqual([]);
});

test("a peer that does not peer this node is an asymmetry observation naming the consequence", () => {
  const findings = diagnose(localNode([peer({ name: "bubba", host_id: "BUBBA" })]), [
    surveyed({ target: "bubba", host_id: "BUBBA", roster: [row("gardenpc", "gardenpc")] }),
  ]);
  const asymmetry = only(findings, "asymmetry");
  expect(asymmetry.severity).toBe("observation");
  expect(asymmetry.subject).toBe("bubba");
  expect(asymmetry.message).toBe(
    "bubba does not peer this node (mtrojer-mac), so its picker cannot see this node's agents",
  );
  expect(asymmetry.remedy).toBe("ssh bubba murmur peer add mtrojer-mac");
});

test("asymmetry is never a problem, so a one-directional fleet still exits clean", () => {
  const findings = diagnose(
    localNode([
      peer({ name: "bubba", host_id: "BUBBA" }),
      peer({ name: "macmini", host_id: "MACMINI" }),
      peer({ name: "gardenpc", host_id: "GARDENPC" }),
    ]),
    [
      surveyed({ target: "bubba", host_id: "BUBBA" }),
      surveyed({ target: "macmini", host_id: "MACMINI" }),
      surveyed({ target: "gardenpc", host_id: "GARDENPC" }),
    ],
  );
  // The author's own fleet: four configured here, zero configured anywhere else.
  expect(findings.filter((finding) => finding.severity === "problem")).toEqual([]);
  expect(kinds(findings).filter((kind) => kind === "asymmetry")).toHaveLength(3);
});

test("island wording is one-hop scoped and claims nothing about the wider fleet", () => {
  const findings = diagnose(
    localNode([
      peer({ name: "bubba", host_id: "BUBBA" }),
      peer({ name: "macmini", host_id: "MACMINI" }),
    ]),
    [
      surveyed({ target: "bubba", host_id: "BUBBA" }),
      surveyed({ target: "macmini", host_id: "MACMINI" }),
    ],
  );
  const island = only(findings, "island");
  expect(island.severity).toBe("observation");
  // Pinned exactly, so a future transitive survey cannot quietly widen the claim.
  expect(island.message).toBe(
    "no peer that this node surveyed peers this host (mtrojer-mac); " +
      "2 of 2 surveyed peers cannot see this node's agents",
  );
  // The forbidden claim, stated in the shapes a rewrite would reach for. Not a
  // substring check on the sentence above: "surveyed" contains no fleet claim,
  // and asserting absence is the whole point.
  expect(island.message).not.toContain("fleet");
  expect(island.message).not.toContain("no node");
  expect(island.message).not.toContain("nobody");
  expect(island.message).toContain("surveyed");
});

test("one peer that does peer this node means no island, even when others do not", () => {
  const findings = diagnose(
    localNode([
      peer({ name: "bubba", host_id: "BUBBA" }),
      peer({ name: "macmini", host_id: "MACMINI" }),
    ]),
    [
      surveyed({ target: "bubba", host_id: "BUBBA", roster: [row("mtrojer-mac", "mtrojer-mac")] }),
      surveyed({ target: "macmini", host_id: "MACMINI" }),
    ],
  );
  expect(kinds(findings)).toEqual(["asymmetry"]);
});

test("no peer answered means no island: absence of evidence is not isolation", () => {
  const findings = diagnose(localNode([peer({ name: "linuxpc", host_id: "LINUXPC" })]), [
    {
      ok: false,
      target: "linuxpc",
      reason: "identity-unavailable",
      detail: "linuxpc: unreachable (No route to host)",
    },
  ]);
  expect(kinds(findings)).toEqual(["unsurveyable"]);
});

test("an empty fleet produces no findings", () => {
  expect(diagnose(localNode([]), [])).toEqual([]);
});

test("one machine configured twice on this node is a problem, matched on host_id not name", () => {
  const findings = diagnose(
    localNode([
      peer({
        name: "garden",
        target: "gardenpc.local",
        host_id: "GARDENPC",
        display_name: "gardenpc",
      }),
      peer({ name: "gardenpc", host_id: "GARDENPC", display_name: "gardenpc" }),
    ]),
    [
      surveyed({
        target: "gardenpc.local",
        host_id: "GARDENPC",
        display_name: "gardenpc",
        roster: [row("mtrojer-mac", "mtrojer-mac")],
      }),
      surveyed({
        target: "gardenpc",
        host_id: "GARDENPC",
        display_name: "gardenpc",
        roster: [row("mtrojer-mac", "mtrojer-mac")],
      }),
    ],
  );
  const duplicate = only(findings, "duplicate-host-id");
  expect(duplicate.severity).toBe("problem");
  expect(duplicate.subject).toBe("gardenpc");
  expect(duplicate.message).toBe(
    "garden and gardenpc are the same machine (gardenpc), so every command reaches it twice",
  );
  expect(duplicate.remedy).toBe("murmur peer remove gardenpc");
});

test("two different machines under two names are not a duplicate", () => {
  const findings = diagnose(
    localNode([
      peer({ name: "garden", host_id: "GARDENPC" }),
      peer({ name: "bubba", host_id: "BUBBA" }),
    ]),
    [],
  );
  expect(kinds(findings)).toEqual([]);
});

test("a survey identity beats a stale cache, so a peer added while asleep is still deduplicated", () => {
  const findings = diagnose(
    localNode([
      peer({ name: "gardenpc", host_id: "GARDENPC", display_name: "gardenpc" }),
      // Added on the operator's word while unreachable: no cached identity at
      // all, so `peerAddDecision` could not have caught this at add time.
      peer({ name: "garden", target: "gardenpc.local" }),
    ]),
    [surveyed({ target: "gardenpc.local", host_id: "GARDENPC", display_name: "gardenpc" })],
  );
  expect(only(findings, "duplicate-host-id").subject).toBe("garden");
});

test("snapshot skew is a problem and reuses versionCell's text verbatim", () => {
  const findings = diagnose(
    localNode([
      peer({ name: "bubba", host_id: "BUBBA", murmur_version: "0.1.3", snapshot_version: 2 }),
    ]),
    [],
  );
  const skew = only(findings, "snapshot-skew");
  expect(skew.severity).toBe("problem");
  // The parenthetical is versionCell's cell, character for character. If doctor
  // ever grew its own opinion of compatibility this string would drift.
  expect(skew.message).toBe(
    "bubba speaks an incompatible snapshot version (0.1.3 (snapshot 2 \u2260 1)); " +
      "state will not sync until murmur versions match",
  );
});

test("a peer that has never answered is not skew: unknown is not incompatible", () => {
  const findings = diagnose(
    localNode([peer({ name: "bubba", murmur_version: null, snapshot_version: null })]),
    [],
  );
  expect(kinds(findings)).toEqual([]);
});

test("a matching snapshot version is not skew even when murmur versions differ", () => {
  const findings = diagnose(
    localNode([
      peer({ name: "bubba", host_id: "BUBBA", murmur_version: "0.1.3", snapshot_version: 1 }),
    ]),
    [],
  );
  expect(kinds(findings)).toEqual([]);
});

test("one host_id under different names on different nodes is naming drift", () => {
  const findings = diagnose(
    localNode([
      peer({ name: "gardenpc", host_id: "GARDENPC", display_name: "gardenpc" }),
      peer({ name: "bubba", host_id: "BUBBA", display_name: "bubba" }),
    ]),
    [
      surveyed({
        target: "bubba",
        host_id: "BUBBA",
        display_name: "bubba",
        // bubba calls the same machine "garden". Recognised as one host because
        // gardenpc published `gardenpc` to both nodes, not because the names
        // look alike.
        roster: [row("garden", "gardenpc", "gardenpc.local"), row("mtrojer-mac", "mtrojer-mac")],
      }),
    ],
  );
  const drift = only(findings, "naming-drift");
  expect(drift.severity).toBe("observation");
  expect(drift.message).toBe(
    'one machine (gardenpc) is configured under different names: "gardenpc" on here; "garden" on bubba',
  );
  expect(drift.remedy).toBeNull();
});

test("the same name on both nodes is not drift", () => {
  const findings = diagnose(
    localNode([
      peer({ name: "gardenpc", host_id: "GARDENPC", display_name: "gardenpc" }),
      peer({ name: "bubba", host_id: "BUBBA", display_name: "bubba" }),
    ]),
    [
      surveyed({
        target: "bubba",
        host_id: "BUBBA",
        display_name: "bubba",
        roster: [row("gardenpc", "gardenpc"), row("mtrojer-mac", "mtrojer-mac")],
      }),
    ],
  );
  expect(kinds(findings)).toEqual([]);
});

test("a roster row whose hostname is a container id is not matched to this node", () => {
  // The documented trap: a peer added as `linuxpc` reports a container id. The
  // row is about this node by ssh target, but nothing comparable says so, so
  // doctor reports the asymmetry rather than inventing a match.
  const findings = diagnose(localNode([peer({ name: "bubba", host_id: "BUBBA" })]), [
    surveyed({
      target: "bubba",
      host_id: "BUBBA",
      roster: [row("mtrojer-mac", "6f3c1a9b2d44")],
    }),
  ]);
  expect(kinds(findings)).toContain("asymmetry");
});

test("an unreachable peer is an observation carrying the reason once, not twice", () => {
  const findings = diagnose(
    localNode([peer({ name: "linuxpc", target: "linuxpc.local", host_id: "LINUXPC" })]),
    [
      {
        ok: false,
        target: "linuxpc.local",
        reason: "identity-unavailable",
        detail: "linuxpc.local: unreachable (No route to host)",
      },
    ],
  );
  const unsurveyable = only(findings, "unsurveyable");
  expect(unsurveyable.severity).toBe("observation");
  // Named by the handle the operator types, and the target prefix that
  // describeFailure adds is not repeated inside the sentence.
  expect(unsurveyable.message).toBe(
    "linuxpc could not be surveyed -- unreachable (No route to host)",
  );
  expect(unsurveyable.remedy).toBeNull();
});

test("a peer too old for peer list --json reads as an upgrade, not a broken node", () => {
  const findings = diagnose(localNode([peer({ name: "bubba", host_id: "BUBBA" })]), [
    {
      ok: false,
      target: "bubba",
      reason: "roster-unsupported",
      detail: "bubba: error: unknown option '--json'",
    },
  ]);
  const unsurveyable = only(findings, "unsurveyable");
  expect(unsurveyable.severity).toBe("observation");
  expect(unsurveyable.message).toBe(
    "bubba runs a murmur too old to report its roster, so it could not be checked -- upgrade that host",
  );
  expect(unsurveyable.remedy).toBe("ssh bubba npm i -g @martintrojer/murmur");
});

test("an unparseable roster is an observation too, keeping the parse detail", () => {
  const findings = diagnose(localNode([peer({ name: "bubba", host_id: "BUBBA" })]), [
    {
      ok: false,
      target: "bubba",
      reason: "roster-invalid",
      detail: "bubba: peer list did not answer with JSON",
    },
  ]);
  const unsurveyable = only(findings, "unsurveyable");
  expect(unsurveyable.severity).toBe("observation");
  expect(unsurveyable.message).toBe(
    "bubba could not be surveyed -- peer list did not answer with JSON",
  );
});

test("an unsurveyable peer is never counted as failing to peer this node", () => {
  const findings = diagnose(
    localNode([
      peer({ name: "bubba", host_id: "BUBBA" }),
      peer({ name: "linuxpc", host_id: "LINUXPC" }),
    ]),
    [
      surveyed({ target: "bubba", host_id: "BUBBA", roster: [row("mtrojer-mac", "mtrojer-mac")] }),
      {
        ok: false,
        target: "linuxpc",
        reason: "identity-unavailable",
        detail: "linuxpc: unreachable (No route to host)",
      },
    ],
  );
  // linuxpc was never asked, so asserting it does not peer this node would be
  // a claim about a machine that never answered.
  expect(kinds(findings)).toEqual(["unsurveyable"]);
});

test("problems sort ahead of observations", () => {
  const findings = diagnose(
    localNode([
      peer({ name: "bubba", host_id: "BUBBA" }),
      peer({ name: "macmini", host_id: "MACMINI", snapshot_version: 2 }),
    ]),
    [surveyed({ target: "bubba", host_id: "BUBBA" })],
  );
  expect(kinds(findings)).toEqual(["snapshot-skew", "asymmetry", "island"]);
});

test("a node that has itself in its own roster is not naming drift", () => {
  // A real shape, not a defensive one: `peer add` records an unreachable target
  // on the operator's word, so a node can end up listing itself under some
  // other handle. That is one machine with two names, but the second name is
  // the machine's own, and "configured under a different name on another node"
  // is not what happened -- so the remedy would point at nothing.
  const findings = diagnose(
    localNode([
      peer({ name: "bubba", host_id: "BUBBA", display_name: "bubba" }),
      peer({ name: "gardenpc", host_id: "GARDENPC", display_name: "gardenpc" }),
    ]),
    [
      surveyed({
        target: "bubba",
        host_id: "BUBBA",
        display_name: "bubba",
        roster: [
          row("myself", "bubba", "localhost"),
          row("gardenpc", "gardenpc"),
          row("mtrojer-mac", "mtrojer-mac"),
        ],
      }),
    ],
  );
  expect(kinds(findings)).toEqual([]);
});

test("a peer tried and never once successful is reported, as an observation", () => {
  // The fourth category: not "worked and is now unreachable", and not "never
  // even attempted" -- tried, repeatedly, and never once answered. Almost always
  // a setup error a human fixes once: a typo in the target, no remote install,
  // or an auth wall. None of them resolve by waiting, which is why it is worth
  // saying out loud rather than leaving as a blank LAST SEEN column.
  //
  // `observation`, not `problem`. doctor reserves `problem` for two conditions,
  // and a peer whose remote murmur is not installed yet is a normal state during
  // setup -- rating it a fault is how an operator learns to ignore doctor.
  const findings = diagnose(
    localNode([
      peer({ name: "dev", snapshot: null, last_attempt_at: 5_000 }),
      // Has answered before, currently just unreachable. NOT this category.
      peer({ name: "linuxpc", snapshot: {} as never, last_attempt_at: 5_000 }),
      // Never attempted at all -- added seconds ago. Also not this category:
      // there is no evidence either way yet.
      peer({ name: "fresh", snapshot: null, last_attempt_at: null }),
    ]),
    [],
  );

  const never = findings.filter((entry) => entry.kind === "never-worked");
  expect(never).toHaveLength(1);
  expect(never[0]).toMatchObject({ severity: "observation", subject: "dev" });
  expect(never[0]?.remedy).toContain("dev");
});

test("a peer needing interactive auth is an observation, not a problem", () => {
  // Severity is the whole decision here. A 2FA-gated host is correctly
  // configured and unreachable by design -- not a fault. `problem` is reserved
  // for two conditions, and diluting it is how an operator learns to ignore
  // doctor entirely.
  const findings = diagnose(
    localNode([
      peer({ name: "dev", last_error: "dev: Permission denied (publickey,keyboard-interactive)" }),
      // Unreachable rather than refused: an asleep laptop, not an auth wall.
      peer({ name: "linuxpc", last_error: "linuxpc: unreachable (No route to host)" }),
    ]),
    [],
  );

  const finding = only(findings, "needs-session");
  expect(finding).toMatchObject({ severity: "observation", subject: "dev" });
  expect(finding.message).toContain("ssh dev");
  expect(finding.remedy).toBe("ssh dev");
});

test("doctor lists every gated peer, where the picker trims", () => {
  // The division of labour the spec sets: the header is one trimmed line, and
  // this is the full list for anyone who wants it.
  const gated = (name: string) =>
    peer({ name, last_error: `${name}: Permission denied (publickey)` });
  const findings = diagnose(
    localNode([gated("dev"), gated("dev2"), gated("dev3"), gated("dev4")]),
    [],
  );

  expect(findings.filter((entry) => entry.kind === "needs-session")).toHaveLength(4);
});

test("a gated peer that answered the survey just now is not reported", () => {
  // The stored `last_error` is history; an answer seconds ago is the present.
  // doctor's own survey is stronger evidence than the warm-socket probe
  // `status` has to fall back on, and it is already in hand.
  const findings = diagnose(
    localNode([
      peer({ name: "dev", last_error: "dev: Permission denied (publickey)", host_id: "DEV" }),
    ]),
    [surveyed({ target: "dev", host_id: "DEV", roster: [row("mtrojer-mac", "mtrojer-mac")] })],
  );
  expect(kinds(findings)).not.toContain("needs-session");
});
