import { expect, test } from "vitest";
import { chosenWindowName, pidAlive, tmuxBadgeState } from "../src/mux.js";

test("pidAlive is true for self and false for an unused pid", () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(2 ** 22)).toBe(false);
});

test("tmux badges preserve the established working token", () => {
  expect(tmuxBadgeState("running")).toBe("working");
  expect(tmuxBadgeState("blocked")).toBe("blocked");
});

// The picker's `agent` column showed `Python`, `node` and `zsh` for three real
// pi agents. All three are tmux's `automatic-rename` reporting the foreground
// process, and `agentLabel` prefers a window name over a session name -- so the
// process name shadowed `hacking/murmur`, the string a reader searches on.
test("a window tmux is auto-renaming contributes no name", () => {
  // The exact triple this bug produced: pi's interpreter, in a window tmux owns.
  expect(chosenWindowName("Python", "1")).toBe(null);
  expect(chosenWindowName("node", "1")).toBe(null);
  expect(chosenWindowName("zsh", "1")).toBe(null);
});

test("a window a human named keeps its name", () => {
  // The whole point of the rule: `automatic-rename` off means someone chose
  // this, whether by `rename-window`, a tmuxinator config, or mu.
  expect(chosenWindowName("reviewer", "0")).toBe("reviewer");
  // Even when what they chose LOOKS like a process name. The flag is the only
  // signal that carries intent; the string cannot.
  expect(chosenWindowName("Python", "0")).toBe("Python");
});

test("a name is absent, not empty, when tmux says nothing", () => {
  // Three spellings of "no answer", because the field is read out of a
  // tab-split and a missing trailing field arrives as undefined while a present
  // but empty one arrives as "". Both must reach the store as null: an empty
  // string is truthy enough for `??` to select it, so `agentLabel` would return
  // one and print a blank cell instead of falling through to the session name.
  expect(chosenWindowName("", "0")).toBe(null);
  expect(chosenWindowName(undefined, "0")).toBe(null);
  expect(chosenWindowName(undefined, undefined)).toBe(null);
});

test("an unparseable automatic-rename flag keeps the name", () => {
  // Fails toward the old behaviour. Only a literal "1" -- what
  // `#{?automatic-rename,1,0}` emits -- suppresses a name, so a tmux that
  // answers differently, or a format string that stops resolving, costs a
  // cosmetic column rather than every agent's name at once.
  expect(chosenWindowName("reviewer", "")).toBe("reviewer");
  expect(chosenWindowName("reviewer", "yes")).toBe("reviewer");
});
