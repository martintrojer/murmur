import type { Driver } from "../types.js";

/**
 * The environment variable a pi marks its own descendants with.
 *
 * Not a pi mechanism, because pi has none. `PI_CODING_AGENT=true` and
 * `AI_AGENT=pi` are set unconditionally at cli.js:12, BEFORE main() runs, so a
 * nested pi sees exactly what a top-level pi sees and neither marker can tell
 * them apart. Confirmed by reading the shipped cli.js, then by launching a pi
 * inside a pi and printing both.
 *
 * The value is the claim -- `<pane>:<pid>` of the owner -- rather than a bare
 * "1". Both components are load-bearing: the pane lets a marker that outlived
 * its pane be recognised as irrelevant rather than silencing a fresh agent, and
 * the pid lets a process recognise its OWN claim when pi re-runs the extension
 * factory on /reload. See ownsPane.
 */
export const OWNER_ENV = "MURMUR_PANE_OWNER";

/**
 * THE THREE-EVENT DECISION TABLE. Read this before touching either function.
 *
 * pi fires three events murmur turns into state, and it fires them in a fixed
 * order that was verified at runtime against the shipped pi (0.84.3), not read
 * off the .d.ts:
 *
 *   agent_start    a run begins
 *   agent_end      that run's loop ended
 *   agent_settled  no retry, compaction or queued continuation will follow
 *
 * agent_end is NOT per turn -- `turn_start`/`turn_end` are. A three-tool-call
 * prompt fires one agent_start, three turn_end, one agent_end, one settled.
 * But agent_end CAN fire more than once per settle, because pi re-enters the
 * loop for a retry, a compaction, or a message queued by an agent_end handler,
 * and each re-entry emits its own agent_start first. Observed:
 *
 *   start, end, start, end, settled          (a queued continuation)
 *
 * So agent_start/agent_end always pair, and settled arrives exactly once, last,
 * ~60ms after the final agent_end.
 *
 * Both handlers append, and the fold takes the newest row it recognises, so the
 * LAST WRITER WINS. The extension's own promise queue serialises the handlers,
 * which is what makes "last" deterministic rather than a race. The table:
 *
 *   pane      driver         agent_start  agent_end  agent_settled  folds to
 *   --------  -------------  -----------  ---------  -------------  --------
 *   focused   human          working      cleared    (nothing)      idle
 *   unfocused human          working      done       blocked        blocked
 *   focused   orchestrated   working      cleared    (nothing)      idle
 *   unfocused orchestrated   working      cleared    (nothing)      idle
 *
 * Why each "nothing":
 *
 * FOCUSED. There is nothing to request -- the user is already looking at the
 * pane. agent_end has already written `cleared`, and re-asserting attention at
 * a human who is watching is the badge-that-outlives-its-cause bug.
 *
 * ORCHESTRATED. A crew agent settling is not a human's problem: mu placed the
 * work and mu consumes the result, which is why endState collapses it to
 * `cleared`. Emitting blocked here would put every finishing worker into the
 * status bar, which counts orchestrated `blocked` deliberately (status.ts) and
 * un-hides those rows in the picker. Orchestrated blocked stays reserved for an
 * outside notifier -- mu's own needs_input, or the `notify` verb.
 *
 * Why settled cannot clobber `working`, the cbcd9c4 failure mode: settled only
 * fires after a run ends, and a new run's agent_start is enqueued after it, so
 * `working` is always the later write. The queue, not luck, guarantees that.
 */

export function endState(focused: boolean, muManaged: boolean): "cleared" | "done" {
  if (muManaged) return "cleared";
  return focused ? "cleared" : "done";
}

/**
 * What `agent_settled` reports, or null for "say nothing".
 *
 * Unfocused plus settled is the one thing murmur exists to deliver: the agent
 * is genuinely finished and waiting on a human, and the human is not looking.
 * That is `blocked` -- the state that has been in the enum, the CLEARABLE
 * whitelist, the status counts and the picker filters since the beginning while
 * nothing in production ever produced it.
 *
 * Null rather than "cleared" for the two silent rows. agent_end has already
 * written the right thing for both, and a second append would only add a
 * redundant row whose timestamp becomes the agent's "last said something" age.
 */
export function settledState(focused: boolean, muManaged: boolean): "blocked" | null {
  if (muManaged) return null;
  return focused ? null : "blocked";
}

export function driverFromEnv(env: NodeJS.ProcessEnv): Driver {
  return env.MU_MANAGED_AGENT === "1" || env.MU_AGENT_NAME ? "orchestrated" : "human";
}

/**
 * Does THIS process own the pane it is sitting in, and may it therefore speak
 * for the agent there?
 *
 * The bug this answers: `append` recorded `process.pid`, which is whatever
 * process loaded the extension and NOT the agent that owns the pane. One agent
 * pane accumulated SIX distinct pids that had each written `working`, of which
 * one was alive. Every extra pid was a short-lived pi launched from inside the
 * pane -- the extension is linked globally, so each child loaded it, read the
 * inherited `$TMUX_PANE`, claimed the parent's agent_id, wrote events, and
 * died. The parent's row then folded to `crashed`-then-`cleared` off a dead
 * child's pid, so an agent that was working showed as idle. It also produced
 * five doubled `cleared` pairs 0-1s apart: not a double fire, two processes
 * each correctly firing once.
 *
 * Not exotic. It fires for a subagent, a nested pi, `pi` typed by hand in an
 * agent pane, or any test that launches pi -- and it corrupts the parent row
 * every time.
 *
 * WHY NOT #{pane_pid}, the obvious answer, on three counts measured live.
 *
 * It is not the agent. pane_pid is the pane LEADER: pane %244 reported 61721,
 * the launcher, while the agent pi was 61980, its child. So equality is wrong.
 *
 * Descent does not discriminate either, because a nested pi is ALSO a
 * descendant of pane_pid. The measured chain from a nested pi ran pi -> python
 * -> coreutils -> zsh -> pi -> python(pane_pid) -- straight through the parent
 * agent. Ancestry cannot separate "the agent" from "something the agent
 * spawned", so no amount of walking ps(1) answers this question.
 *
 * And RECORDING pane_pid instead would break crash detection outright. The
 * recorded pid is what fold.ts probes to turn a `working` row into `crashed`,
 * and the pane leader is a shell that outlives the agent: surveying this host,
 * panes sat with a live pane_pid and zero children, agent long gone. A row
 * carrying pane_pid would therefore read `working` forever and no crash would
 * ever be detected. process.pid stays the recorded value precisely because it
 * dies when the agent dies -- it is the right ANSWER to "is the agent alive",
 * and only the wrong answer to "who owns this pane". Those are two questions,
 * and this function exists to stop the second being answered with the first.
 *
 * WHAT DOES WORK: the first pi in a pane claims it in the environment, and
 * every descendant inherits the claim. Then "am I nested" is a read, not an
 * inference -- exactly the distinction that makes it reliable. Verified end to
 * end: outer pi saw the marker unset, and a pi it launched through its own bash
 * tool read back `%244:9852`.
 *
 * THE CLAIM CARRIES THE PANE, and that is what keeps a stale marker harmless.
 * An exported marker could otherwise reach a NEW pane -- `tmux new-window`
 * inherits the environment of the client that ran it -- and a bare "1" would
 * silence the fresh agent there forever. Because the claim names the pane it
 * was made for, a marker from a different pane is not about this pane and is
 * ignored. Checked against real tmux, where the leak did not in fact occur (a
 * new pane came up without it), but the fix does not depend on that: it is one
 * tmux implementation detail away from mattering, and silence-forever is the
 * worst failure this tool has.
 *
 * Silence, not a corrected write, is the right response for a genuine nested
 * run. The nested pi does not own the pane and has nothing true to say about
 * the agent there; the owner is still running and still reporting for itself.
 */
export function ownsPane(env: NodeJS.ProcessEnv, pane: string, pid: number): boolean {
  const claim = env[OWNER_ENV];
  // Unclaimed: this is the first pi in the pane, so it is the owner.
  if (!claim) return true;
  const [claimedPane, claimedPid] = claim.split(":");
  // Claimed for a DIFFERENT pane, so the claim is a stale inherited value and
  // says nothing about this pane. Treat this process as the owner here.
  if (claimedPane !== pane) return true;
  // OUR OWN claim, seen a second time. This is not hypothetical: pi calls the
  // extension factory again on /reload, in the same process, so a check that
  // could not recognise its own mark would silence the real agent on the first
  // /reload -- turning a nested-pi fix into a much worse version of the bug it
  // fixes. The pid in the claim is what makes this answerable, and is the
  // reason the claim is not a bare "1".
  return claimedPid === String(pid);
}

/** The claim a pane's owner publishes to its descendants. */
export function ownerClaim(pane: string, pid: number): string {
  return `${pane}:${pid}`;
}

/**
 * May `pid` speak for an agent whose last recorded pid was `recordedPid`?
 *
 * The floor under ownsPane. Two live processes cannot both be the agent in one
 * pane, so a DIFFERENT pid must not supersede a row whose recorded pid is still
 * alive: whoever is recorded is demonstrably still running, and a second
 * claimant is by elimination not the agent.
 *
 * `recordedPid` must be the last pid the AGENT recorded, not the pid on the
 * newest row. Only `working` carries a pid -- done, blocked and cleared are all
 * null -- so reading the newest row makes this fail open the moment a turn ends,
 * which is most of the time. Measured against the live corrupted database: the
 * newest row was `cleared` with a null pid, and a competing write went straight
 * through. The caller is responsible for that lookup.
 *
 * Kept as a separate check rather than folded into ownsPane because the two
 * fail differently and neither subsumes the other. ownsPane needs the marker to
 * have been exported by a murmur-linked parent -- it is not there for a pi that
 * predates this change, nor for one launched some way that drops the
 * environment. This needs only the store, and it holds against any second
 * writer. Defence in depth on the failure that showed a working agent as idle.
 *
 * A LEGITIMATE RESTART MUST STILL WORK, which is why this asks about liveness
 * and not merely about difference. Pane %89 has two pids for good reason: an
 * agent exits, another starts in the same pane, and the new one is the agent
 * now. Once the old pid is gone the new one takes over immediately -- no
 * grace period, no staleness horizon, nothing to tune.
 *
 * Same pid always passes, which is the overwhelmingly common path: the owner
 * reporting its own next event.
 *
 * FAILS OPEN, deliberately, and the direction matters. `pidAlive` reports death
 * only on ESRCH, so a probe that cannot answer (EPERM) says alive -- which
 * here would REJECT the write. That is the wrong way round for an unknown, so
 * the null case is handled by the caller: no recorded row, or a row with no
 * pid, means there is nothing to protect and the write proceeds.
 */
export function mayReport(
  pid: number,
  recordedPid: number | null,
  isAlive: (pid: number) => boolean,
): boolean {
  if (recordedPid === null || recordedPid <= 0) return true;
  if (recordedPid === pid) return true;
  return !isAlive(recordedPid);
}
