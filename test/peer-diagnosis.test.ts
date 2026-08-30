import { expect, test } from "vitest";
import { describeFailure } from "../src/collector.js";
import { parseSnapshot, SnapshotInvalidError } from "../src/snapshot.js";

/**
 * What an operator is told when a peer is broken.
 *
 * `last_error` and the one line `murmur collect` prints are the WHOLE
 * diagnostic for a machine the operator is not sitting at. Every other surface
 * reduces a failed peer to `stale`, so a message that does not name the problem
 * sends them to read code on the other host.
 *
 * This file exists because the two-node smoke test found both assertions below
 * failing against real hosts, and neither was covered: `collector.test.ts`
 * asserts `describeFailure` on hand-written strings that happen to omit the
 * `Command failed:` prefix every real `execFile` rejection carries, and
 * `snapshot.test.ts` asserts only the CLASS of a parse failure, never the text.
 */

/**
 * A real `execFileAsync` rejection, verbatim from `ssh bubba murmur export`
 * against a node where the binary is missing. The prefix and the ssh option
 * list are Node's and murmur's own; the actionable part is the last line.
 */
const COMMAND_FAILED =
  "Command failed: ssh -o BatchMode=yes -o ControlMaster=no " +
  "-o ControlPath=~/.ssh/control/%r@%h:%p -o ConnectTimeout=1 bubba murmur export\n" +
  "murmur: command not found\n";

test("a reachable peer's diagnosis leads with the problem, not with murmur's own ssh flags", () => {
  // MEASURED against a real second node: the shipped line was 160 characters of
  // ssh options truncated at "murmur: command not f..." -- the truncation
  // landing exactly on the only actionable word in it. `Host is down` was
  // already handled, so the covered case looked fine while the uncovered one
  // (reachable, broken) printed the reverse of what it should.
  const line = describeFailure("bubba", COMMAND_FAILED);

  expect(line).toBe("bubba: murmur: command not found");
  // The invocation is murmur's, not the operator's, and they cannot act on it.
  expect(line).not.toContain("BatchMode");
  expect(line).not.toContain("ControlPath");
  expect(line).not.toContain("Command failed");
});

test("a truncated diagnosis keeps its head, because that is where the reason is", () => {
  // A long tail is bounded, but the bound must never cost the first line. This
  // is the property the shipped truncation violated.
  const noisy = `Command failed: ssh ${"-o Option=x ".repeat(40)}host murmur export\nreal reason here\n`;

  const line = describeFailure("host", noisy);

  expect(line).toBe("host: real reason here");
});

test("an unadorned message is passed through unchanged", () => {
  // Not every failure arrives wrapped: a SnapshotInvalidError's message is the
  // diagnosis already, and stripping must not eat it.
  expect(describeFailure("dev", "panes[3].attention[0].kind: expected one of done")).toBe(
    "dev: panes[3].attention[0].kind: expected one of done",
  );
});

test("a document-level snapshot failure does not report an empty field name", () => {
  // MEASURED: a peer serving anything but JSON produced `bubba: : not JSON`.
  // The empty path is the DOCUMENT, and `SnapshotInvalidError` joined it with a
  // colon regardless, so the one message an operator sees for the most common
  // remote misconfiguration led with punctuation.
  const error = (() => {
    try {
      parseSnapshot("murmur: command not found");
      return null;
    } catch (thrown) {
      return thrown as SnapshotInvalidError;
    }
  })();

  expect(error).toBeInstanceOf(SnapshotInvalidError);
  expect(error?.message.startsWith(":")).toBe(false);
  expect(error?.message).toMatch(/^not JSON/);
  // `path` itself stays the empty string: it means "the document", and a caller
  // testing it must not have to know a sentinel.
  expect(error?.path).toBe("");
  expect(describeFailure("bubba", error?.message ?? "")).toMatch(/^bubba: not JSON/);
});

test("a field-level snapshot failure still names its path first", () => {
  // The other half of the same join: a real path must be prefixed exactly as
  // before, or the fix for the empty case would cost every useful message.
  const bad = JSON.stringify({
    murmur_snapshot: 1,
    host_id: "H",
    display_name: "d",
    murmur_version: "0.1.0",
    generated_at: 1,
    panes: [
      {
        pane: "%1",
        session: "$0",
        window: "@1",
        session_name: null,
        window_name: null,
        agent: null,
        attention: [{ kind: "working", message: "", source: "x", requested_at: 1 }],
      },
    ],
  });

  expect(() => parseSnapshot(bad)).toThrow(
    "panes[0].attention[0].kind: expected one of done, blocked, crashed",
  );
});

test("the printed line and the machine-readable flag agree about one failure", async () => {
  // Two consumers, one classification. `unreachable` gates whether a caller
  // stays quiet (an asleep laptop is the normal state of a fleet) and
  // describeFailure decides what it says when it does not. Normalising the text
  // differently in the two places would let a peer be quiet-and-unreachable in
  // JSON while printing "reachable but broken", about the same fetch.
  const { collect } = await import("../src/collector.js");
  const { openStore } = await import("../src/store.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-diagnosis-"));
  const store = openStore();
  try {
    // Each is a real ssh failure wrapped the way execFile wraps it, which is the
    // shape the hand-written strings in collector.test.ts happen to omit.
    const cases: [name: string, message: string, unreachable: boolean][] = [
      [
        "asleep",
        "Command failed: ssh -o BatchMode=yes host murmur export\nssh: connect to host host port 22: Host is down\n",
        true,
      ],
      [
        "missing",
        "Command failed: ssh -o BatchMode=yes host murmur export\nmurmur: command not found\n",
        false,
      ],
      [
        "authfail",
        "Command failed: ssh -o BatchMode=yes host murmur export\nhost: Permission denied (publickey).\n",
        false,
      ],
      // The case that makes this a real test rather than a restatement. For
      // most inputs the stripped text is a suffix of the raw one and both
      // classify alike, so normalising in only one place is invisible. Here the
      // marker `ssh:` is in the TARGET -- `murmur peer add box ssh://box`, an
      // ordinary typo -- so it appears on the invocation line and nowhere else.
      // Classify the raw message and this peer is "asleep, probably", forever,
      // while the printed line correctly says the binary is missing.
      [
        "ssh://urltyped",
        "Command failed: ssh -o BatchMode=yes ssh://urltyped murmur export\nmurmur: command not found\n",
        false,
      ],
    ];
    for (const [name] of cases) store.addPeer(name, name);

    const byName = new Map(cases.map(([name, message]) => [name, message]));
    const results = await collect(
      store,
      {
        exec: async (target) => {
          throw new Error(byName.get(target) ?? "unexpected");
        },
      },
      1_000,
    );

    for (const [name, message, unreachable] of cases) {
      const result = results.find((entry) => entry.peer === name);
      expect(result?.unreachable, name).toBe(unreachable);
      // The printed line's verdict must match the flag's, for every case.
      expect(describeFailure(name, message).includes("unreachable"), name).toBe(unreachable);
    }
  } finally {
    store.close();
  }
});
