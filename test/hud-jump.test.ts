import { expect, test } from "vitest";
import { shellQuote } from "../src/agents.js";

test("shellQuote protects a tmux target from the remote shell", () => {
  // ssh hands its arguments to a shell on the far side, and a tmux session id
  // is always $N. Unquoted, the remote shell expands it and the attach fails
  // with "can't find session" naming whatever $0 was. Found live against a
  // real second machine.
  expect(shellQuote("$0:@0")).toBe("'$0:@0'");
  expect(shellQuote("$12:@7")).toBe("'$12:@7'");
});

test("shellQuote survives a single quote in the value", () => {
  expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
});

test("the remote command survives both shell layers", () => {
  // Two layers eat a tmux session id, and each needs its own quoting:
  //   1. `tmux new-window <cmd>` runs cmd through a LOCAL shell
  //   2. ssh joins its args and hands them to a shell on the FAR side
  // Unprotected, `$1:@1` reached bubba as `:@1` (layer 1) or as whatever $1
  // held (layer 2), and the attach failed with "can't find session".
  const target = shellQuote("$1:@1");
  const command = `ssh -t ${shellQuote("bubba")} tmux attach -t ${shellQuote(target)}`;
  // What the local shell will hand to ssh, after one round of unquoting.
  expect(command).toContain("'$1:@1'");
  expect(command).not.toContain("$1:@1 ");
});
