import type { PaneId } from "../../src/ids.js";
import type { Mux } from "../../src/mux.js";

/**
 * A Mux that answers every method with a harmless default.
 *
 * Five separate hand-rolled fakes used to spell this out, so adding one method
 * to the interface broke four unrelated test files. Each test overrides only
 * the methods whose behaviour it is actually asserting on, which also makes the
 * override list a readable statement of what the test is about.
 *
 * The defaults are chosen so a test that forgets an override fails rather than
 * passes: no windows, no sessions, no client.
 *
 * ONE DEFAULT BREAKS THAT PROMISE, deliberately and with a cost worth knowing.
 * `panesInWindow: () => []` describes a state real tmux cannot return: if
 * `windowForPane` just resolved a pane's window, that window contains at least
 * that pane. Two badge tests combined a resolved window with the empty default
 * and passed for years, asserting against an impossible world -- they only
 * surfaced when `notify` started recomputing the badge from the window's panes
 * and suddenly needed the fixture to be coherent.
 *
 * Left as `[]` rather than made to throw, because plenty of tests legitimately
 * never touch it and a throwing default would force noise into all of them. So:
 * IF YOUR TEST RESOLVES A WINDOW, STUB THIS TOO. A passing badge assertion
 * against the default is not evidence.
 */
export function fakeMux(over: Partial<Mux> = {}): Mux {
  return {
    currentWindow: () => null,
    livePanes: () => new Set<PaneId>(),
    localPaneProcesses: () => [],
    setWindowBadge: () => {},
    attach: () => true,
    capture: () => null,
    windowForPane: () => null,
    panesInWindow: () => [],
    clientName: () => null,
    currentTarget: () => null,
    sessionNamed: () => false,
    newSession: () => true,
    setSessionOption: () => {},
    switchClient: () => true,
    ...over,
  };
}
