import { expect, test } from "vitest";
import { gotoDecision, runGoto } from "../src/goto.js";
import { asPaneId } from "../src/ids.js";
import { fakeMux } from "./helpers/fake-mux.js";

const DASH = asPaneId("%7");

/** Every world this decision reads, with the ordinary local case as the base. */
function world(over: Partial<Parameters<typeof gotoDecision>[0]> = {}) {
  return {
    insideTmux: true,
    client: "/dev/ttys001 100",
    jumpClient: null,
    dashPane: DASH,
    livePanes: new Set([DASH]),
    ...over,
  };
}

test("an ordinary client switches to the marked dash pane", () => {
  expect(gotoDecision(world())).toEqual({ kind: "switch", pane: DASH });
});

test("the client murmur attached for a remote jump detaches instead of switching", () => {
  // The remote server is the one being asked, so "switch to the dash" would
  // move this client to a dash on the REMOTE machine. Detaching hands the
  // originating local client back to the wrapper's restore command, which is
  // what returns the operator to the dash they came from.
  const decision = gotoDecision(
    world({ jumpClient: "/dev/ttys001 100", dashPane: asPaneId("%3") }),
  );
  expect(decision).toEqual({ kind: "detach", client: "/dev/ttys001" });
});

test("an ordinary login to a machine murmur has jumped to still switches", () => {
  // The marker names ONE client. A second, human login to the same remote
  // session is not murmur-controlled, so PREFIX G there means "show me this
  // machine's dash" -- the spec's ordinary-remote-login case.
  expect(gotoDecision(world({ jumpClient: "/dev/ttys999 100" }))).toEqual({
    kind: "switch",
    pane: DASH,
  });
});

test("a marker for the same tty from an earlier client does not detach", () => {
  // Marker carries client_created precisely so a reused tty cannot inherit a
  // dead jump's identity: same name, different creation time, not us.
  expect(gotoDecision(world({ jumpClient: "/dev/ttys001 99" }))).toEqual({
    kind: "switch",
    pane: DASH,
  });
});

test("no dash marker is a clear failure, not a silent no-op", () => {
  const decision = gotoDecision(world({ dashPane: null }));
  expect(decision.kind).toBe("fail");
  expect(decision.kind === "fail" && decision.message).toContain("no murmur dash is running");
});

test("a stale dash marker does not count as a running dash", () => {
  // The dash sets the option and clears it on exit, but a SIGKILL leaves it
  // behind. The pane is the liveness authority, as everywhere else in murmur.
  const decision = gotoDecision(world({ livePanes: new Set([asPaneId("%1")]) }));
  expect(decision.kind).toBe("fail");
  expect(decision.kind === "fail" && decision.message).toContain("no murmur dash is running");
});

test("a pane list tmux could not answer is not evidence the dash is gone", () => {
  // null means "tmux did not answer", which must not be read as "no panes" --
  // the same distinction livePanes() draws for the collector.
  expect(gotoDecision(world({ livePanes: null }))).toEqual({ kind: "switch", pane: DASH });
});

test("outside tmux the command refuses", () => {
  const decision = gotoDecision(world({ insideTmux: false }));
  expect(decision.kind).toBe("fail");
  expect(decision.kind === "fail" && decision.message).toContain("inside tmux");
});

test("a client tmux cannot name can still switch to the dash", () => {
  // No client name means no way to match the jump marker, so the ordinary
  // switch is the honest answer rather than a refusal.
  expect(gotoDecision(world({ client: null, jumpClient: "/dev/ttys001 100" }))).toEqual({
    kind: "switch",
    pane: DASH,
  });
});

test("runGoto switches to the live dash pane", () => {
  const attached: string[] = [];
  const result = runGoto(
    fakeMux({
      dashPane: () => DASH,
      livePanes: () => new Set([DASH]),
      clientIdentity: () => "/dev/ttys001 100",
      attach: (pane) => {
        attached.push(pane);
        return true;
      },
    }),
    { TMUX: "/tmp/tmux-501/default,1,0" },
  );
  expect(result).toEqual({ ok: true });
  expect(attached).toEqual([DASH]);
});

test("runGoto detaches the marked jump client and never attaches", () => {
  const detached: string[] = [];
  const attached: string[] = [];
  const result = runGoto(
    fakeMux({
      dashPane: () => DASH,
      livePanes: () => new Set([DASH]),
      clientIdentity: () => "/dev/ttys001 100",
      jumpClientMarker: () => "/dev/ttys001 100",
      attach: (pane) => {
        attached.push(pane);
        return true;
      },
      detachClient: (client) => {
        detached.push(client);
        return true;
      },
    }),
    { TMUX: "/tmp/tmux-501/default,1,0" },
  );
  expect(result).toEqual({ ok: true });
  expect(detached).toEqual(["/dev/ttys001"]);
  expect(attached).toEqual([]);
});

test("a failed tmux call is reported rather than swallowed", () => {
  const switchFailed = runGoto(
    fakeMux({
      dashPane: () => DASH,
      livePanes: () => new Set([DASH]),
      clientIdentity: () => "/dev/ttys001 100",
      attach: () => false,
    }),
    { TMUX: "x" },
  );
  expect(switchFailed.ok).toBe(false);
  expect(switchFailed.ok === false && switchFailed.message).toContain("switch-client");

  const detachFailed = runGoto(
    fakeMux({
      dashPane: () => DASH,
      livePanes: () => new Set([DASH]),
      clientIdentity: () => "/dev/ttys001 100",
      jumpClientMarker: () => "/dev/ttys001 100",
      detachClient: () => false,
    }),
    { TMUX: "x" },
  );
  expect(detachFailed.ok).toBe(false);
  expect(detachFailed.ok === false && detachFailed.message).toContain("detach-client");
});
