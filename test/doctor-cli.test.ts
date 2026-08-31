import { expect, test } from "vitest";
import type { Channel } from "../src/channel.js";
import { exitCodeFor, jsonReport, render, surveyFleet } from "../src/cli/doctor.js";
import { MAX_CONCURRENT_PEERS } from "../src/collector.js";
import { diagnose, type Finding, type LocalNode, type SurveyResult } from "../src/doctor.js";
import type { PeerRecord } from "../src/types.js";

/**
 * The command's own three jobs -- fan out, render, decide the exit code --
 * exercised without an ssh binary, a store or a captured stdout. The diagnosis
 * itself is covered in doctor-diagnose.test.ts; what is asserted here is that a
 * human reading the output learns the right things from it.
 */

function peerRecord(over: Partial<PeerRecord> & { name: string }): PeerRecord {
  return {
    target: over.name,
    host_id: null,
    display_name: null,
    snapshot: null,
    snapshot_at: null,
    fetched_at: null,
    last_attempt_at: null,
    last_error: null,
    murmur_version: "0.2.1",
    snapshot_version: 1,
    ...over,
  };
}

function localNode(over: Partial<LocalNode> = {}): LocalNode {
  return { host_id: "SELF", display_name: "mtrojer-mac", peers: [], ...over };
}

/** A peer that answered, with an empty roster: the shape most render tests want. */
function survey(target: string, hostId: string): SurveyResult {
  return {
    ok: true,
    target,
    host_id: hostId,
    display_name: target,
    murmur_version: "0.2.1",
    roster: [],
  };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    kind: "asymmetry",
    severity: "observation",
    subject: "bubba",
    message: "bubba does not peer this node (mtrojer-mac)",
    detail: "does not peer mtrojer-mac",
    remedy: null,
    ...over,
  };
}

/** A snapshot document, as a peer's `murmur export` prints it. */
function wire(host_id: string, display_name: string): string {
  return JSON.stringify({
    murmur_snapshot: 1,
    host_id,
    display_name,
    murmur_version: "0.2.1",
    generated_at: 1_000,
    panes: [],
  });
}

/** A Channel that answers per target, and records the order calls arrive in. */
function channelOf(
  hosts: Record<string, { host_id?: string; roster?: unknown[]; fail?: string }>,
  log: string[] = [],
): Channel {
  return {
    exec: async (target, argv) => {
      log.push(`${target}: ${argv.join(" ")}`);
      const host = hosts[target];
      if (!host) throw new Error(`unexpected target: ${target}`);
      if (host.fail) throw new Error(host.fail);
      if (argv.join(" ") === "murmur export") return wire(host.host_id ?? target, target);
      return JSON.stringify(host.roster ?? []);
    },
  };
}

test("every configured peer is surveyed, and results come back in peer order", async () => {
  const log: string[] = [];
  const surveys = await surveyFleet(
    channelOf(
      {
        bubba: { host_id: "BUBBA" },
        gardenpc: { host_id: "GARDENPC" },
        macmini: { host_id: "MACMINI" },
      },
      log,
    ),
    [
      peerRecord({ name: "bubba" }),
      peerRecord({ name: "gardenpc" }),
      peerRecord({ name: "macmini" }),
    ],
  );
  expect(surveys.map((survey) => survey.target)).toEqual(["bubba", "gardenpc", "macmini"]);
  expect(surveys.every((survey) => survey.ok)).toBe(true);
  // Two calls per peer, because neither export nor peer list alone is enough.
  expect(log.filter((entry) => entry.endsWith("murmur export"))).toHaveLength(3);
  expect(log.filter((entry) => entry.endsWith("peer list --json"))).toHaveLength(3);
});

test("a peer the deadline never reached is reported as unsurveyed, not dropped", async () => {
  // An already-passed deadline: no peer is ever claimed, so every row is the
  // undefined case. Dropping them would shrink the "surveyed N peers"
  // denominator and overstate how much of the fleet the report covers.
  const surveys = await surveyFleet(
    channelOf({ bubba: {}, gardenpc: {} }),
    [peerRecord({ name: "bubba" }), peerRecord({ name: "gardenpc" })],
    Promise.resolve(),
  );
  expect(surveys).toHaveLength(2);
  expect(surveys.map((survey) => survey.ok)).toEqual([false, false]);
  expect(surveys[0]).toMatchObject({
    ok: false,
    target: "bubba",
    reason: "identity-unavailable",
    detail: "not surveyed within 15s",
  });
});

test("an unreachable peer does not stop the others being surveyed", async () => {
  const surveys = await surveyFleet(
    channelOf({
      bubba: { host_id: "BUBBA" },
      linuxpc: { fail: "ssh: connect to host linuxpc port 22: No route to host" },
    }),
    [peerRecord({ name: "bubba" }), peerRecord({ name: "linuxpc" })],
  );
  expect(surveys[0]?.ok).toBe(true);
  expect(surveys[1]).toMatchObject({ ok: false, reason: "identity-unavailable" });
});

test("no peers means no survey and no ssh at all", async () => {
  const log: string[] = [];
  const surveys = await surveyFleet(channelOf({}, log), []);
  expect(surveys).toEqual([]);
  expect(log).toEqual([]);
});

test("the report opens with the denominator, so every finding can be discounted", () => {
  const surveys: SurveyResult[] = [
    {
      ok: true,
      target: "bubba",
      host_id: "BUBBA",
      display_name: "bubba",
      murmur_version: "0.2.1",
      roster: [],
    },
    {
      ok: false,
      target: "linuxpc",
      reason: "identity-unavailable",
      detail: "linuxpc: unreachable (No route to host)",
    },
  ];
  const output = render(localNode(), surveys, [finding()]);
  expect(output.split("\n")[0]).toBe("Surveyed 2 peers, 1 answered.");
});

test("a single peer is not pluralised", () => {
  const surveys: SurveyResult[] = [
    {
      ok: true,
      target: "bubba",
      host_id: "BUBBA",
      display_name: "bubba",
      murmur_version: "0.2.1",
      roster: [],
    },
  ];
  expect(render(localNode(), surveys, []).split("\n")[0]).toBe("Surveyed 1 peer, 1 answered.");
});

test("a mutual fleet says so rather than printing nothing", () => {
  const surveys: SurveyResult[] = [
    {
      ok: true,
      target: "bubba",
      host_id: "BUBBA",
      display_name: "bubba",
      murmur_version: "0.2.1",
      roster: [],
    },
  ];
  expect(render(localNode(), surveys, [])).toBe(
    "Surveyed 1 peer, 1 answered.\n\nNo problems found.\n",
  );
});

test("no peers configured says that, and does not claim a clean bill of health", () => {
  const output = render(localNode(), [], []);
  expect(output).toBe("No peers configured, so there is nothing to survey.\n");
  // "No problems found" over zero peers would be a conclusion drawn from no
  // evidence at all.
  expect(output).not.toContain("No problems found");
});

test("a problem is marked in its own row, not merely counted somewhere else", () => {
  const output = render(
    localNode(),
    [
      {
        ok: true,
        target: "gardenpc",
        host_id: "G",
        display_name: "gardenpc",
        murmur_version: "0.2.1",
        roster: [],
      },
    ],
    [
      finding({ subject: "bubba", message: "bubba does not peer this node (mtrojer-mac)" }),
      finding({
        kind: "duplicate-host-id",
        severity: "problem",
        subject: "garden",
        message:
          "gardenpc and garden are the same machine (gardenpc), so every command reaches it twice",
        detail: "same machine as gardenpc",
        remedy: "murmur peer remove garden",
      }),
    ],
  );
  // The problem row carries the mark and the observation row does not, so a
  // reader scanning a long report can tell them apart without counting.
  expect(output).toMatch(/! {2}garden\s+same machine as gardenpc/);
  // The two kinds are in separate groups now, so the mark cannot be confused
  // for alignment: only the group containing a problem has the column at all.
  expect(output).toMatch(/^ {2}bubba\s+does not peer mtrojer-mac/m);
});

test("findings of one kind are grouped, with the shared consequence stated once", () => {
  // The report was one full sentence per finding, and on a four-peer fleet that
  // was four 106-column lines that each repeated the subject they were aligned
  // under AND repeated an identical consequence. A report is scanned before it is
  // read. So: group by kind, state the consequence once in the heading, and let
  // each row carry only what differs.
  const output = render(
    localNode(),
    [survey("bubba", "B")],
    [
      finding({ subject: "bubba", detail: "does not peer mtrojer-mac" }),
      finding({ subject: "macmini", detail: "does not peer mtrojer-mac" }),
    ],
  );
  // The heading names the kind; the consequence appears ONCE, not per row.
  expect(output).toContain("One-way peering");
  expect(output.match(/pickers cannot see/g)).toHaveLength(1);
  // Rows carry the subject and the short detail, aligned. "macnini" is widest.
  expect(output).toMatch(/bubba\s+does not peer mtrojer-mac/);
  expect(output).toMatch(/macmini\s+does not peer mtrojer-mac/);
  // And the long standalone sentence is NOT what a row prints.
  expect(output).not.toContain("so its picker cannot see this node's agents");
});

test("a group with no problem in it spends no width on a severity column", () => {
  // Every kind has a fixed severity today, so a mark column on an
  // all-observation group is three columns of whitespace on every row -- and an
  // empty column reads as a missing value rather than as "nothing to flag".
  const observations = render(
    localNode(),
    [survey("bubba", "B")],
    [finding({ subject: "bubba", detail: "does not peer mtrojer-mac" })],
  );
  expect(observations).toMatch(/^ {2}bubba/m);

  const problem = render(
    localNode(),
    [survey("bubba", "B")],
    [
      finding({
        kind: "duplicate-host-id",
        severity: "problem",
        subject: "garden",
        detail: "same machine as gardenpc",
      }),
    ],
  );
  expect(problem).toMatch(/^ {2}! {2}garden/m);
});

test("suggested commands are printed, and the caveat about this node's name comes with them", () => {
  const output = render(
    localNode(),
    [
      {
        ok: true,
        target: "bubba",
        host_id: "B",
        display_name: "bubba",
        murmur_version: "0.2.1",
        roster: [],
      },
    ],
    [finding({ remedy: "ssh bubba murmur peer add mtrojer-mac" })],
  );
  expect(output).toContain("\nDo this\n  ssh bubba murmur peer add mtrojer-mac\n");
  // The caveat the output must not hide, in full: what the name is, why it may
  // not resolve, and that murmur cannot know.
  expect(output).toContain('These name this node "mtrojer-mac".');
  expect(output).toContain("depends on its own ssh config");
  expect(output).toContain("which murmur cannot see");
  expect(output).toContain("so check, do not");
  // Presented as a check, never as a guarantee.
  expect(output).not.toContain("will work");
  expect(output).not.toContain("Run these");
});

test("the caveat is omitted when no suggestion names this node", () => {
  // A `peer remove` runs here and an upgrade names no host, so neither depends
  // on this node's display_name resolving from the far side. Printing the
  // caveat anyway would train the reader to skip it.
  const output = render(
    localNode(),
    [
      {
        ok: true,
        target: "gardenpc",
        host_id: "G",
        display_name: "gardenpc",
        murmur_version: "0.2.1",
        roster: [],
      },
    ],
    [
      finding({
        kind: "duplicate-host-id",
        severity: "problem",
        subject: "garden",
        message: "gardenpc and garden are the same machine",
        remedy: "murmur peer remove garden",
      }),
    ],
  );
  expect(output).toContain("  murmur peer remove garden\n");
  expect(output).not.toContain("which is what it calls itself");
});

test("a finding with no remedy prints no suggestion block", () => {
  const output = render(
    localNode(),
    [
      {
        ok: true,
        target: "bubba",
        host_id: "B",
        display_name: "bubba",
        murmur_version: "0.2.1",
        roster: [],
      },
    ],
    [
      finding({
        kind: "island",
        subject: "mtrojer-mac",
        message: "no peer that this node surveyed peers this host (mtrojer-mac)",
        detail: "none of the 3 surveyed peers can see this node",
        remedy: null,
      }),
    ],
  );
  expect(output).not.toContain("To check:");
});

test("observations exit 0, so an asymmetric fleet is not a failing command", () => {
  expect(
    exitCodeFor([finding(), finding({ kind: "island" }), finding({ kind: "unsurveyable" })]),
  ).toBe(0);
});

test("one problem among observations exits 1", () => {
  expect(exitCodeFor([finding(), finding({ kind: "snapshot-skew", severity: "problem" })])).toBe(1);
});

test("no findings exits 0", () => {
  expect(exitCodeFor([])).toBe(0);
});

test("end to end: the author's own fleet shape, from channel to rendered report", async () => {
  // The measured state of the real fleet: four peers configured here, none
  // peering back, one down. Asserted as a whole so the seams cannot each be
  // right while the report is wrong.
  const peers = [
    peerRecord({ name: "bubba" }),
    peerRecord({ name: "gardenpc" }),
    peerRecord({ name: "linuxpc" }),
    peerRecord({ name: "macmini" }),
  ];
  const surveys = await surveyFleet(
    channelOf({
      bubba: { host_id: "BUBBA" },
      gardenpc: { host_id: "GARDENPC" },
      linuxpc: { fail: "ssh: connect to host linuxpc port 22: No route to host" },
      macmini: { host_id: "MACMINI" },
    }),
    peers,
  );
  const local = localNode({ peers });
  const findings = diagnose(local, surveys);
  const output = render(local, surveys, findings);

  expect(output.split("\n")[0]).toBe("Surveyed 4 peers, 3 answered.");
  expect(findings.filter((f) => f.kind === "asymmetry")).toHaveLength(3);
  expect(findings.filter((f) => f.kind === "unsurveyable")).toHaveLength(1);
  expect(findings.filter((f) => f.kind === "island")).toHaveLength(1);
  // Nothing here is an operator task: three asymmetries are design, and a host
  // that is switched off is the normal state of a fleet.
  expect(exitCodeFor(findings)).toBe(0);
  // "surveyed" survives the shortening: a one-hop claim, and dropping the word
  // would turn it into a statement about machines never contacted.
  expect(output).toContain("Not visible to the fleet");
  expect(output).toContain("none of the 3 surveyed peers can see this node");
  expect(output).toContain("  ssh bubba murmur peer add mtrojer-mac\n");
  expect(output).toContain("  ssh macmini murmur peer add mtrojer-mac\n");
  // The down host gets no suggestion: there is nothing to run against it.
  expect(output).not.toContain("ssh linuxpc murmur peer add");
});

test("peers are surveyed concurrently, not one after another", async () => {
  // The reason the collector's pool is reused at all. Serially, an unreachable
  // peer costs the full ssh timeout and charges it to every peer behind it --
  // the exact bug that made `murmur status` hang for thirty seconds on three
  // sleeping laptops. Measured here as overlap rather than as elapsed time, so
  // the test states the property instead of racing a clock.
  let inFlight = 0;
  let maxInFlight = 0;
  const peers = [
    peerRecord({ name: "bubba" }),
    peerRecord({ name: "gardenpc" }),
    peerRecord({ name: "macmini" }),
  ];
  const channel: Channel = {
    exec: async (target, argv) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield, so a concurrent pool has every peer's first call open at once
      // and a serial one cannot.
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return argv.join(" ") === "murmur export" ? wire(target.toUpperCase(), target) : "[]";
    },
  };
  const surveys = await surveyFleet(channel, peers);
  expect(surveys.every((survey) => survey.ok)).toBe(true);
  // All three at once: MAX_CONCURRENT_PEERS is 8, and three peers fit in it.
  // Compared exactly rather than `> 1`, which a pool of two would also pass.
  expect(maxInFlight).toBe(3);
});

test("the pool is bounded, so a large fleet does not fork unboundedly", async () => {
  // Twelve peers against a limit of eight. Asserting the exact ceiling is the
  // point: an unbounded Promise.all would read as "concurrent" to the test
  // above while forking one ssh per peer.
  let inFlight = 0;
  let maxInFlight = 0;
  const peers = Array.from({ length: 12 }, (_, index) => peerRecord({ name: `peer${index}` }));
  const channel: Channel = {
    exec: async (target, argv) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return argv.join(" ") === "murmur export" ? wire(target.toUpperCase(), target) : "[]";
    },
  };
  await surveyFleet(channel, peers);
  expect(maxInFlight).toBe(MAX_CONCURRENT_PEERS);
  expect(MAX_CONCURRENT_PEERS).toBe(8);
});

test("--json carries the denominator, so an empty list is not ambiguous", () => {
  // Findings alone cannot tell "nothing is wrong" from "nothing answered", and
  // those are opposite conclusions with an identical empty array.
  const nothingWrong = jsonReport(
    [
      {
        ok: true,
        target: "bubba",
        host_id: "B",
        display_name: "bubba",
        murmur_version: "0.2.1",
        roster: [],
      },
    ],
    [],
  );
  expect(nothingWrong).toEqual({ surveyed: 1, answered: 1, findings: [] });

  const nothingAnswered = jsonReport(
    [{ ok: false, target: "bubba", reason: "identity-unavailable", detail: "unreachable" }],
    [],
  );
  expect(nothingAnswered.answered).toBe(0);
  expect(nothingAnswered.surveyed).toBe(1);
});

test("--json exposes severity as a machine-readable field on every finding", () => {
  const report = jsonReport(
    [
      {
        ok: true,
        target: "bubba",
        host_id: "B",
        display_name: "bubba",
        murmur_version: "0.2.1",
        roster: [],
      },
    ],
    [finding(), finding({ kind: "snapshot-skew", severity: "problem", subject: "macmini" })],
  );
  // A consumer gates on this and nothing else, so every finding must carry it
  // and the values must be exactly the two the exit code is derived from.
  expect(report.findings.map((f) => f.severity)).toEqual(["observation", "problem"]);
  // Round-trips as plain JSON: no undefined-valued keys silently dropped.
  const parsed = JSON.parse(JSON.stringify(report));
  expect(parsed.findings[0]).toEqual({
    kind: "asymmetry",
    severity: "observation",
    subject: "bubba",
    message: "bubba does not peer this node (mtrojer-mac)",
    detail: "does not peer mtrojer-mac",
    remedy: null,
  });
});
