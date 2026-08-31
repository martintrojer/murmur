import { expect, test } from "vitest";
import type { Channel } from "../src/channel.js";
import { DOCTOR_DEADLINE_MS, surveyPeer } from "../src/doctor.js";

/**
 * The survey seam, exercised with an injected Channel exactly as the collector
 * is: no ssh binary, no second machine, and every failure shape a real fleet
 * produces reachable from a test.
 */

/** A document, as a peer's `murmur export` prints it. */
function wire(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    murmur_snapshot: 1,
    host_id: "REMOTE-HOST-ID",
    display_name: "bubba",
    murmur_version: "0.2.1",
    generated_at: 1_000,
    panes: [],
    ...over,
  });
}

/**
 * A Channel that answers per argv, so a test states only the call it cares
 * about and any unexpected call is a loud failure rather than a silent
 * fallback.
 */
function channelOf(answers: {
  export?: () => Promise<string>;
  peerList?: () => Promise<string>;
}): Channel {
  return {
    exec: async (_target, argv) => {
      const command = argv.join(" ");
      if (command === "murmur export") {
        if (!answers.export) throw new Error(`unexpected call: ${command}`);
        return answers.export();
      }
      if (command === "murmur peer list --json") {
        if (!answers.peerList) throw new Error(`unexpected call: ${command}`);
        return answers.peerList();
      }
      throw new Error(`unexpected call: ${command}`);
    },
  };
}

/**
 * A real `execFileAsync` rejection, in the shape every channel failure arrives
 * in: Node's `Command failed:` line, murmur's own ssh options, then the one
 * line that matters.
 */
function commandFailed(detail: string, argv: string): string {
  return (
    `Command failed: ssh -o BatchMode=yes -o ControlMaster=no ` +
    `-o ControlPath=~/.ssh/control/%r@%h:%p -o ConnectTimeout=1 bubba ${argv}\n${detail}\n`
  );
}

test("a doctor run gets its own deadline, not the tick-sized one a collect uses", () => {
  // A literal, not a comparison against the collector's constant: asserting
  // `!==` would pass if someone set both to 4s. The point is the VALUE, chosen
  // because a human typed `murmur doctor` and is waiting, against a measured
  // ~300ms per warm peer and ~1s per dead one.
  expect(DOCTOR_DEADLINE_MS).toBe(15_000);
});

test("a healthy peer answers both questions: identity from export, roster from peer list", async () => {
  const calls: string[][] = [];
  const channel: Channel = {
    exec: async (target, argv) => {
      expect(target).toBe("bubba");
      calls.push(argv);
      return argv.includes("export")
        ? wire()
        : JSON.stringify([
            // Extra keys on purpose: this document is printed by whatever
            // murmur that peer runs, so a newer column must not break doctor
            // against a node we did not upgrade.
            { name: "here", target: "here.example", hostname: "here", peer: true, ssh: "warm" },
            { name: "laptop", target: "laptop.example", hostname: null, peer: true },
          ]);
    },
  };

  const result = await surveyPeer(channel, "bubba");

  expect(result).toEqual({
    ok: true,
    target: "bubba",
    host_id: "REMOTE-HOST-ID",
    display_name: "bubba",
    murmur_version: "0.2.1",
    roster: [
      { name: "here", target: "here.example", hostname: "here" },
      { name: "laptop", target: "laptop.example", hostname: null },
    ],
  });
  // Both calls, in this order, and no third. `export` cannot carry a roster and
  // `peer list` carries no host_id, so a survey that made one call would be
  // answering half the question.
  expect(calls).toEqual([
    ["murmur", "export"],
    ["murmur", "peer", "list", "--json"],
  ]);
});

test("a peer with an empty roster is surveyed, not failed", async () => {
  // A single-machine node is a normal member of a fleet, and zero peers is its
  // honest answer. Treating an empty array as "no roster" would report the one
  // node that is configured correctly as broken.
  const result = await surveyPeer(
    channelOf({ export: async () => wire(), peerList: async () => "[]" }),
    "bubba",
  );

  expect(result).toMatchObject({ ok: true, roster: [] });
});

test("a peer that cannot name itself is unsurveyable, and the roster is never asked for", async () => {
  // No `peerList` answer configured: if the survey asks anyway, the channel
  // throws `unexpected call` and this test fails. A second forked ssh for an
  // answer that gets discarded is the thing being prevented.
  const result = await surveyPeer(
    channelOf({
      export: async () => {
        throw new Error(
          commandFailed("ssh: connect to host bubba port 22: Host is down", "murmur export"),
        );
      },
    }),
    "bubba",
  );

  expect(result).toEqual({
    ok: false,
    target: "bubba",
    reason: "identity-unavailable",
    detail: "bubba: unreachable (Host is down)",
  });
});

test("a peer answering export with something that is not a snapshot has no identity either", async () => {
  // Reachable but broken, which reads nothing like a sleeping laptop -- but it
  // still yields no host_id, so doctor can conclude nothing about it. One
  // observation, and the detail is what tells them apart.
  const result = await surveyPeer(
    channelOf({ export: async () => "murmur: command not found\n" }),
    "bubba",
  );

  expect(result).toMatchObject({ ok: false, reason: "identity-unavailable" });
  expect((result as { detail: string }).detail).toContain("not JSON");
});

test("a peer that names itself but cannot list its peers keeps its identity", async () => {
  const result = await surveyPeer(
    channelOf({
      export: async () => wire(),
      peerList: async () => {
        // The realistic shape: the roster call is a SECOND ssh, so it can fail
        // on its own -- a laptop that suspends between the two calls, or a
        // corrupt peer database on the far side.
        throw new Error(
          commandFailed("Error: database disk image is malformed", "murmur peer list --json"),
        );
      },
    }),
    "bubba",
  );

  expect(result).toEqual({
    ok: false,
    target: "bubba",
    reason: "roster-unavailable",
    detail: "bubba: Error: database disk image is malformed",
  });
  // Not the too-old reason: this host has the flag, its database is broken. The
  // action is on that machine, not `npm i -g`.
  expect((result as { reason: string }).reason).not.toBe("roster-unsupported");
});

test("a peer whose murmur predates `peer list --json` is out of date, not broken", async () => {
  // Commander's own words, and the whole reason this reason exists: `peer list
  // --json` is newer than `export`, so a fleet mid-upgrade has nodes that
  // answer the first call perfectly and refuse the second. Reporting version
  // skew as a corrupt roster sends the operator hunting for a bug that is an
  // `npm i -g` away.
  const result = await surveyPeer(
    channelOf({
      export: async () => wire({ murmur_version: "0.1.4" }),
      peerList: async () => {
        throw new Error(commandFailed("error: unknown option '--json'", "murmur peer list --json"));
      },
    }),
    "bubba",
  );

  expect(result).toMatchObject({ ok: false, reason: "roster-unsupported" });
});

test("a murmur so old it has no `peer` command at all is also just out of date", async () => {
  const result = await surveyPeer(
    channelOf({
      export: async () => wire(),
      peerList: async () => {
        throw new Error(commandFailed("error: unknown command 'peer'", "murmur peer list --json"));
      },
    }),
    "bubba",
  );

  expect(result).toMatchObject({ ok: false, reason: "roster-unsupported" });
});

test("a roster that is not JSON is reported as an unparseable roster", async () => {
  const result = await surveyPeer(
    channelOf({
      export: async () => wire(),
      // An older murmur's ASCII table, a login banner, a shell error: the
      // common case is not corrupt JSON, it is not JSON at all.
      peerList: async () => "NAME    TARGET\nhere    here.example\n",
    }),
    "bubba",
  );

  expect(result).toEqual({
    ok: false,
    target: "bubba",
    reason: "roster-invalid",
    detail: "bubba: peer list did not answer with JSON",
  });
});

test("a roster row missing the fields doctor compares is malformed, never silently skipped", async () => {
  // The load-bearing assertion in this file. A dropped row reads downstream as
  // "that peer does not know about this host" -- which is the exact conclusion
  // doctor exists to draw, and it would be drawing it from a parse bug rather
  // than from the fleet.
  const result = await surveyPeer(
    channelOf({
      export: async () => wire(),
      peerList: async () =>
        JSON.stringify([{ name: "here", target: "here.example" }, { hostname: "orphan" }]),
    }),
    "bubba",
  );

  expect(result).toMatchObject({ ok: false, reason: "roster-invalid" });
  // Names the row, so the operator knows which host to look at.
  expect((result as { detail: string }).detail).toContain("[1]");
});

test("a roster that is JSON but not a list of peers is malformed", async () => {
  const result = await surveyPeer(
    channelOf({
      export: async () => wire(),
      // What `status --json` prints. Reaching the wrong command is a plausible
      // mistake, and it must not parse as an empty roster.
      peerList: async () => JSON.stringify({ peers: [] }),
    }),
    "bubba",
  );

  expect(result).toMatchObject({ ok: false, reason: "roster-invalid" });
});
