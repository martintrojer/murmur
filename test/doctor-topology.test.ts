import { expect, test } from "vitest";
import type { Channel } from "../src/channel.js";
import { renderTopology } from "../src/cli/doctor.js";
import {
  bestHub,
  buildTopology,
  hubCandidates,
  isNameResolutionFailure,
  probeReach,
  reachableFromHere,
  type SurveyResult,
  TOPOLOGY_DEADLINE_MS,
  type Topology,
  type TopologyNode,
} from "../src/doctor.js";

/**
 * The reachability phase. Every dial is injected, so the matrix under test is
 * stated rather than sampled -- which matters more here than anywhere else in
 * this feature, because the real fleet's matrix changes when a laptop sleeps.
 */

function node(name: string, over: Partial<TopologyNode> = {}): TopologyNode {
  return { name, target: name, self: false, ...over };
}

/** This node, plus peers, in the order the command builds them. */
function fleet(...names: string[]): TopologyNode[] {
  const [self, ...peers] = names;
  return [node(self as string, { self: true }), ...peers.map((name) => node(name))];
}

/**
 * A Channel driven by an explicit edge set, written as "A>B" for a dial that
 * succeeds. Anything absent fails, so a test lists only what works.
 */
function dialsOf(reaches: readonly string[], log: string[] = []): Channel {
  const allowed = new Set(reaches);
  return {
    exec: async (target, argv) => {
      // The local row is a bare `true` against the target; a remote row is an
      // inner ssh. Both are recorded so a test can assert the argv shape.
      const inner = argv[argv.length - 2];
      const from = argv[0] === "true" ? "SELF" : target;
      const to = argv[0] === "true" ? target : (inner as string);
      log.push(`${from}>${to}`);
      if (allowed.has(`${from}>${to}`)) return "";
      throw new Error(
        `Command failed: ssh ${target}\nssh: connect to host ${to} port 22: No route to host`,
      );
    },
  };
}

function surveys(...upTargets: string[]): SurveyResult[] {
  return upTargets.map((target) => ({
    ok: true,
    target,
    host_id: target.toUpperCase(),
    display_name: target,
    murmur_version: "0.2.1",
    roster: [],
  }));
}

function down(target: string): SurveyResult {
  return { ok: false, target, reason: "identity-unavailable", detail: `${target}: unreachable` };
}

function reachOf(topology: Topology, from: string, to: string): string {
  const edge = topology.edges.find((candidate) => candidate.from === from && candidate.to === to);
  if (!edge) throw new Error(`no edge ${from} -> ${to}`);
  return edge.reach;
}

test("the probe asks a bare true through an inner ssh, never murmur", async () => {
  const log: string[] = [];
  const channel: Channel = {
    exec: async (target, argv) => {
      log.push(`${target} :: ${argv.join(" ")}`);
      return "";
    },
  };
  await probeReach(channel, node("macmini"), node("gardenpc"));
  // One thing measured: can macmini open an ssh session to gardenpc. Asking
  // macmini to run `murmur export` against gardenpc would conflate transport
  // with installation, and those have different fixes.
  expect(log).toEqual(["macmini :: ssh -o BatchMode=yes -o ConnectTimeout=1 gardenpc true"]);
  expect(log[0]).not.toContain("murmur");
  // BatchMode on the INNER ssh is not optional: without it the far side can
  // block on a password prompt with no terminal attached, and the dial hangs
  // instead of failing.
  expect(log[0]).toContain("BatchMode=yes");
  expect(log[0]).toContain("ConnectTimeout=1");
  // Our own ControlPath is a local socket and names a file that does not exist
  // on the far host.
  expect(log[0]).not.toContain("ControlPath");
});

test("this node's own row is dialled locally, not through an ssh to itself", async () => {
  const log: string[] = [];
  const channel: Channel = {
    exec: async (target, argv) => {
      log.push(`${target} :: ${argv.join(" ")}`);
      return "";
    },
  };
  await probeReach(channel, node("mtrojer-mac", { self: true }), node("gardenpc"));
  // Probing ourselves through ourselves would measure a loopback no other node
  // uses. The payload is still `true`, so every row means the same thing.
  expect(log).toEqual(["gardenpc :: true"]);
});

test("a target that is up and unreachable is a real negative", async () => {
  const nodes = fleet("mtrojer-mac", "bubba", "gardenpc");
  // Everything answered the survey, so every target is demonstrably up.
  const topology = await buildTopology(
    dialsOf(["SELF>bubba", "SELF>gardenpc"]),
    nodes,
    reachableFromHere(surveys("bubba", "gardenpc")),
  );
  // bubba was dialled and failed, against a target known up. That is a fact
  // about the pair.
  expect(reachOf(topology, "bubba", "gardenpc")).toBe("unreachable");
  expect(reachOf(topology, "mtrojer-mac", "bubba")).toBe("reaches");
});

test("a target that is down reports unknown, never unreachable", async () => {
  const nodes = fleet("mtrojer-mac", "macmini", "linuxpc");
  // linuxpc did not answer the survey: it is switched off. Every dial to it
  // fails, and none of those failures is evidence about the pair.
  const topology = await buildTopology(
    dialsOf(["SELF>macmini"]),
    nodes,
    reachableFromHere([...surveys("macmini"), down("linuxpc")]),
  );
  expect(reachOf(topology, "macmini", "linuxpc")).toBe("unknown");
  expect(reachOf(topology, "mtrojer-mac", "linuxpc")).toBe("unknown");
  // The distinction is the whole point: calling a sleeping laptop a firewall
  // makes hub advice flip between runs as machines sleep.
  expect(reachOf(topology, "macmini", "linuxpc")).not.toBe("unreachable");
  // And the reverse direction, where the SOURCE is down, is unknown too --
  // without spending an ssh timeout to learn nothing.
  expect(reachOf(topology, "linuxpc", "macmini")).toBe("unknown");
});

test("a pair whose source is down is never dialled at all", async () => {
  const log: string[] = [];
  const nodes = fleet("mtrojer-mac", "macmini", "linuxpc");
  await buildTopology(
    dialsOf(["SELF>macmini"], log),
    nodes,
    reachableFromHere([...surveys("macmini"), down("linuxpc")]),
  );
  // Six ordered pairs, but linuxpc's two outbound dials are skipped: asking a
  // host that is off about its reachability costs a full timeout to learn
  // nothing.
  expect(log.filter((entry) => entry.startsWith("linuxpc>"))).toEqual([]);
  expect(log).toHaveLength(4);
});

test("asymmetric reachability is recorded in both directions independently", async () => {
  const nodes = fleet("mtrojer-mac", "macmini", "gardenpc");
  // The measured case: macmini reaches gardenpc, gardenpc does not reach back.
  const topology = await buildTopology(
    dialsOf(["SELF>macmini", "SELF>gardenpc", "macmini>gardenpc"]),
    nodes,
    reachableFromHere(surveys("macmini", "gardenpc")),
  );
  expect(reachOf(topology, "macmini", "gardenpc")).toBe("reaches");
  expect(reachOf(topology, "gardenpc", "macmini")).toBe("unreachable");
  // A one-directional edge is not a star: the hub must reach the spoke AND the
  // spoke reach the hub, because each collects from the other.
  const macmini = hubCandidates(topology).find((candidate) => candidate.node === "macmini");
  expect(macmini?.reaches).toContain("gardenpc");
  expect(macmini?.star).toEqual(["macmini"]);
});

test("a viable whole-fleet hub is computed and named", async () => {
  const nodes = fleet("mtrojer-mac", "bubba", "gardenpc");
  // Every pair reaches, so any node could hub; the fleet is fully connected.
  const topology = await buildTopology(
    dialsOf([
      "SELF>bubba",
      "SELF>gardenpc",
      "bubba>mtrojer-mac",
      "bubba>gardenpc",
      "gardenpc>mtrojer-mac",
      "gardenpc>bubba",
    ]),
    nodes,
    reachableFromHere(surveys("bubba", "gardenpc")),
  );
  const hub = bestHub(hubCandidates(topology));
  expect(hub?.star).toHaveLength(3);
  const output = renderTopology(topology);
  expect(output).toContain(
    "A star hubbed at mtrojer-mac is possible, and would serve the whole fleet.",
  );
  expect(output).toContain("  ssh bubba murmur peer add mtrojer-mac\n");
  expect(output).toContain("  ssh gardenpc murmur peer add mtrojer-mac\n");
});

test("when no hub exists it recommends nothing and says so", async () => {
  const nodes = fleet("mtrojer-mac", "bubba", "gardenpc");
  // This node reaches both peers; neither peer reaches anything. The spec's
  // measured case, and the one the naive design got wrong.
  const topology = await buildTopology(
    dialsOf(["SELF>bubba", "SELF>gardenpc"]),
    nodes,
    reachableFromHere(surveys("bubba", "gardenpc")),
  );
  expect(bestHub(hubCandidates(topology))).toBeNull();
  const output = renderTopology(topology);
  expect(output).toContain("No node can serve as a hub for this fleet, and none is recommended.");
  // RECOMMENDS NOTHING: no build instructions and no node named as a hub.
  expect(output).not.toContain("To build it:");
  expect(output).not.toContain("murmur peer add");
  // The partition is reported instead, which is the true and useful half.
  expect(output).toContain("bubba        reaches nothing");
  expect(output).toContain("gardenpc     reaches nothing");
  expect(output).toContain("mtrojer-mac  reaches all 2");
});

test("bubba reaching nothing is never named as a hub", async () => {
  const nodes = fleet("mtrojer-mac", "bubba", "gardenpc", "linuxpc");
  // The exact failure the measured matrix killed: bubba reaches nothing, so
  // "make bubba the hub" would build a fleet of permanently stale spokes.
  const topology = await buildTopology(
    dialsOf([
      "SELF>bubba",
      "SELF>gardenpc",
      "SELF>linuxpc",
      "gardenpc>mtrojer-mac",
      "gardenpc>linuxpc",
      "linuxpc>mtrojer-mac",
      "linuxpc>gardenpc",
    ]),
    nodes,
    reachableFromHere(surveys("bubba", "gardenpc", "linuxpc")),
  );
  const bubba = hubCandidates(topology).find((candidate) => candidate.node === "bubba");
  expect(bubba?.reaches).toEqual([]);
  expect(bubba?.star).toEqual(["bubba"]);
  const hub = bestHub(hubCandidates(topology));
  expect(hub?.node).not.toBe("bubba");
  // The best available star excludes bubba rather than pretending it fits.
  expect(hub?.star).not.toContain("bubba");
  expect(renderTopology(topology)).toContain("which leaves out bubba");
});

test("the largest workable subset is named along with what it leaves out", async () => {
  const nodes = fleet("mtrojer-mac", "macmini", "gardenpc", "linuxpc");
  const topology = await buildTopology(
    dialsOf([
      "SELF>macmini",
      "SELF>gardenpc",
      "SELF>linuxpc",
      "macmini>mtrojer-mac",
      "macmini>gardenpc",
      "gardenpc>mtrojer-mac",
      "gardenpc>macmini",
    ]),
    nodes,
    reachableFromHere(surveys("macmini", "gardenpc", "linuxpc")),
  );
  const output = renderTopology(topology);
  expect(output).toContain("No single node can hub this whole fleet.");
  expect(output).toContain("mtrojer-mac serving {mtrojer-mac, macmini, gardenpc}");
  expect(output).toContain("which leaves out linuxpc");
  // Only the spokes that are actually served get a command.
  expect(output).toContain("  ssh macmini murmur peer add mtrojer-mac\n");
  expect(output).not.toContain("ssh linuxpc murmur peer add");
});

test("the cost of a star is always stated when a star is recommended", async () => {
  const nodes = fleet("mtrojer-mac", "bubba");
  const topology = await buildTopology(
    dialsOf(["SELF>bubba", "bubba>mtrojer-mac"]),
    nodes,
    reachableFromHere(surveys("bubba")),
  );
  const output = renderTopology(topology);
  // The one thing an operator adopting a star is most likely to assume wrongly.
  expect(output).toContain("SPOKES WOULD NOT SEE EACH OTHER");
  // And the mechanism, so it reads as a consequence rather than a rule.
  expect(output).toContain("publishes a node's own panes only");
  expect(output).toContain("a hub cannot re-serve what it learned");
  expect(output).toContain("A star is not a mesh, and choosing one is choosing that.");
});

test("unknown pairs are reported separately from real negatives", async () => {
  const nodes = fleet("mtrojer-mac", "macmini", "linuxpc");
  const topology = await buildTopology(
    dialsOf(["SELF>macmini"]),
    nodes,
    reachableFromHere([...surveys("macmini"), down("linuxpc")]),
  );
  const output = renderTopology(topology);
  // "cannot reach" is a fact to act on; "unknown" is an absence of information.
  // Merging them would have the operator act on the wrong one.
  expect(output).toContain("unknown for linuxpc");
  expect(output).toContain("mtrojer-mac  reaches macmini; unknown for linuxpc");
  // linuxpc never answered, so nothing about it is called a negative.
  expect(output).not.toContain("cannot reach linuxpc");
});

test("a name that does not resolve is called out as naming, not network", async () => {
  const nodes = fleet("mtrojer-mac", "macmini");
  const channel: Channel = {
    exec: async (target, argv) => {
      if (argv[0] === "true") return "";
      throw new Error(
        `Command failed: ssh ${target}\nssh: Could not resolve hostname mtrojer-mac: nodename nor servname provided, or not known`,
      );
    },
  };
  const topology = await buildTopology(channel, nodes, reachableFromHere(surveys("macmini")));
  const output = renderTopology(topology);
  // Measured on the real fleet: macmini cannot resolve this node's
  // display_name. It looks identical to a network fault in the matrix and has a
  // completely different fix.
  expect(output).toContain("mtrojer-mac could not be resolved by name from macmini");
  expect(output).toContain("That is a naming\nproblem rather than a network one");
});

test("name-resolution failures are recognised in ssh's several phrasings", () => {
  expect(isNameResolutionFailure("ssh: Could not resolve hostname bubba")).toBe(true);
  expect(isNameResolutionFailure("ssh: Name or service not known")).toBe(true);
  expect(isNameResolutionFailure("nodename nor servname provided")).toBe(true);
  // A network fault is not a naming fault, and must not be relabelled as one.
  expect(isNameResolutionFailure("ssh: connect to host bubba port 22: No route to host")).toBe(
    false,
  );
  expect(isNameResolutionFailure(null)).toBe(false);
});

test("the probe count reported is the number of dials actually attempted", async () => {
  const nodes = fleet("mtrojer-mac", "macmini", "linuxpc");
  const topology = await buildTopology(
    dialsOf(["SELF>macmini"]),
    nodes,
    reachableFromHere([...surveys("macmini"), down("linuxpc")]),
  );
  // Six ordered pairs across three nodes, minus linuxpc's two outbound dials.
  expect(topology.edges).toHaveLength(6);
  expect(topology.probes).toBe(4);
  expect(renderTopology(topology)).toContain("Probed 4 ordered pairs across 3 nodes.");
});

test("pairs the deadline never reached are unknown, never a false negative", async () => {
  // Enough nodes that the pool cannot claim every pair before the deadline
  // stops it: eleven nodes is 110 ordered pairs against MAX_CONCURRENT_PEERS.
  // A slow fleet must not read as a partitioned one.
  const names = ["mtrojer-mac", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  const nodes = fleet(...names);
  let dials = 0;
  const channel: Channel = {
    exec: async () => {
      dials += 1;
      // Yield, so the deadline is observed between claims rather than after the
      // whole pool has drained synchronously.
      await new Promise((resolve) => setTimeout(resolve, 1));
      return "";
    },
  };
  const topology = await buildTopology(channel, nodes, new Set(names.slice(1)), Promise.resolve());
  expect(topology.edges).toHaveLength(110);
  // Whatever was not learned is unknown. Nothing is asserted as a negative.
  expect(topology.edges.some((edge) => edge.reach === "unreachable")).toBe(false);
  const unknown = topology.edges.filter((edge) => edge.reach === "unknown");
  expect(unknown.length).toBeGreaterThan(100);
  expect(unknown[unknown.length - 1]?.detail).toBe("not probed within the deadline");
  // The cost reported is what came back, not what was planned: claiming 110
  // probes after attempting a handful would overstate the evidence.
  expect(topology.probes).toBeLessThan(20);
  expect(topology.probes).toBeLessThanOrEqual(dials);
  // And with nothing proven, nothing is recommended.
  expect(bestHub(hubCandidates(topology))).toBeNull();
});

test("the topology deadline exceeds the survey's, because the work is O(N squared)", async () => {
  const { DOCTOR_DEADLINE_MS } = await import("../src/doctor.js");
  // Asserted as a literal and as a relation: the literal catches a silent
  // retune, and the relation states why the number is what it is.
  expect(TOPOLOGY_DEADLINE_MS).toBe(30_000);
  expect(TOPOLOGY_DEADLINE_MS).toBeGreaterThan(DOCTOR_DEADLINE_MS);
});

test("a single node fleet probes nothing and recommends nothing", async () => {
  const log: string[] = [];
  const topology = await buildTopology(dialsOf([], log), fleet("mtrojer-mac"), new Set());
  expect(topology.edges).toEqual([]);
  expect(log).toEqual([]);
  expect(bestHub(hubCandidates(topology))).toBeNull();
  // One node is not a star, so there is nothing to name.
  expect(renderTopology(topology)).toContain("No node can serve as a hub");
});

test("the largest star wins when candidates differ in size", async () => {
  const nodes = fleet("mtrojer-mac", "macmini", "gardenpc", "bubba");
  // Two viable hubs of DIFFERENT sizes, so picking the smaller is detectable:
  //   macmini   <-> mtrojer-mac, gardenpc, bubba  => star of 4
  //   gardenpc  <-> mtrojer-mac, macmini           => star of 3
  // A fleet where every viable star is the same size cannot tell "largest" from
  // "first", which is how a best-of selection quietly becomes an arbitrary one.
  const topology = await buildTopology(
    dialsOf([
      "SELF>macmini",
      "SELF>gardenpc",
      "macmini>mtrojer-mac",
      "macmini>gardenpc",
      "macmini>bubba",
      "gardenpc>mtrojer-mac",
      "gardenpc>macmini",
      "bubba>macmini",
    ]),
    nodes,
    reachableFromHere(surveys("macmini", "gardenpc", "bubba")),
  );
  const candidates = hubCandidates(topology);
  const sizes = new Map(candidates.map((candidate) => [candidate.node, candidate.star.length]));
  // The premise of the test, asserted rather than assumed: the candidates really
  // do differ, so "largest" is a meaningful choice here.
  expect(sizes.get("macmini")).toBe(4);
  expect(sizes.get("gardenpc")).toBe(3);
  expect(bestHub(candidates)?.node).toBe("macmini");
});

test("the hub is never told to add itself as a peer", async () => {
  const nodes = fleet("mtrojer-mac", "bubba", "gardenpc");
  const topology = await buildTopology(
    dialsOf([
      "SELF>bubba",
      "SELF>gardenpc",
      "bubba>mtrojer-mac",
      "bubba>gardenpc",
      "gardenpc>mtrojer-mac",
      "gardenpc>bubba",
    ]),
    nodes,
    reachableFromHere(surveys("bubba", "gardenpc")),
  );
  const hub = bestHub(hubCandidates(topology));
  expect(hub?.node).toBe("mtrojer-mac");
  const output = renderTopology(topology);
  // `peer add` refuses to add this node to itself ("is this node; not adding it
  // as a peer"), so suggesting it would print a command that is guaranteed to
  // fail -- in the one block the operator is meant to copy verbatim.
  expect(output).not.toContain("ssh mtrojer-mac murmur peer add mtrojer-mac");
  // Exactly the two spokes get a command, and no more.
  const adds = output.split("\n").filter((line) => line.includes("murmur peer add"));
  expect(adds).toEqual([
    "  ssh bubba murmur peer add mtrojer-mac",
    "  ssh gardenpc murmur peer add mtrojer-mac",
  ]);
});
