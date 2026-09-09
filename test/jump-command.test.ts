import { expect, test } from "vitest";
import { defaultJumpCommand, renderJumpCommand } from "../src/jump-command.js";

test("the default renders the existing ssh attach command byte for byte", () => {
  expect(renderJumpCommand(defaultJumpCommand("p"), "%9")).toBe(
    "ssh -t 'p' tmux attach -t ''\\''%9'\\'''",
  );
});

test("a custom jump command substitutes the pane id", () => {
  expect(renderJumpCommand('x2ssh -et dev -c "tmux attach -t {pane}"', "%42")).toBe(
    'x2ssh -et dev -c "tmux attach -t %42"',
  );
});
