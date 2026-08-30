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
 */
export function fakeMux(over: Partial<Mux> = {}): Mux {
  return {
    currentWindow: () => null,
    liveWindows: () => new Set<string>(),
    livePanes: () => new Set<string>(),
    setState: () => {},
    attach: () => true,
    capture: () => null,
    windowNames: () => new Map(),
    windowForPane: () => null,
    panesInWindow: () => [],
    windowNamed: () => null,
    selectWindow: () => true,
    newWindow: () => true,
    clientName: () => null,
    currentTarget: () => null,
    sessionNamed: () => false,
    newSession: () => true,
    setSessionOption: () => {},
    switchClient: () => true,
    ...over,
  };
}
