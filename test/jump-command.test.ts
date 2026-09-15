import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { asPaneId } from "../src/ids.js";
import {
  defaultJumpCommand,
  renderJumpCommand,
  suggestedJumpCommand,
  tmuxAttachCommand,
} from "../src/jump-command.js";

test("the default gives the remote tmux client a UTF-8 locale", () => {
  expect(
    renderJumpCommand(defaultJumpCommand("p"), {
      server: { kind: "default" },
      pane: asPaneId("%9"),
    }),
  ).toBe("ssh -t 'p' env LC_CTYPE=C.UTF-8 'tmux attach -t '\\''%9'\\'''");
});

test("a custom jump command substitutes the pane id", () => {
  expect(
    renderJumpCommand('x2ssh -et dev -c "tmux attach -t {pane}"', {
      server: { kind: "default" },
      pane: asPaneId("%42"),
    }),
  ).toBe('x2ssh -et dev -c "tmux attach -t %42"');
});

test.each([
  [{ kind: "default" } as const, "tmux attach -t '%9'"],
  [
    { kind: "label", value: "co'op; echo BAD" } as const,
    "tmux -L 'co'\\''op; echo BAD' attach -t '%9'",
  ],
  [
    { kind: "path", value: "/tmp/a b'$(echo BAD).sock" } as const,
    "tmux -S '/tmp/a b'\\''$(echo BAD).sock' attach -t '%9'",
  ],
])("builds a shell-safe attach command for $kind servers", (server, expected) => {
  expect(tmuxAttachCommand({ server, pane: asPaneId("%9") })).toBe(expected);
});

test("the quoted attach command executes hostile values as argv, not shell syntax", () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-attach-"));
  const output = join(dir, "argv");
  const tmux = join(dir, "tmux");
  writeFileSync(tmux, `#!/bin/sh\nprintf '%s\\n' "$@" > "$OUTPUT"\n`);
  chmodSync(tmux, 0o755);
  const command = renderJumpCommand("sh -c {attach}", {
    server: { kind: "path", value: "/tmp/a b'$(touch PWNED).sock" },
    pane: asPaneId("%9; touch PWNED"),
  });

  execFileSync("sh", ["-c", command], {
    cwd: dir,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, OUTPUT: output },
  });

  expect(readFileSync(output, "utf8")).toBe(
    "-S\n/tmp/a b'$(touch PWNED).sock\nattach\n-t\n%9; touch PWNED\n",
  );
  expect(() => readFileSync(join(dir, "PWNED"))).toThrow();
});

test("the migration suggestion preserves a custom transport", () => {
  expect(suggestedJumpCommand("x2ssh -et dev -c 'tmux attach -t {pane}'", "dev")).toBe(
    "x2ssh -et dev -c {attach}",
  );
});

test("{attach} is one quoted argument in an opaque transport template", () => {
  expect(
    renderJumpCommand("transport --command {attach}", {
      server: { kind: "label", value: "co'op; echo BAD" },
      pane: asPaneId("%9; echo BAD"),
    }),
  ).toBe(
    "transport --command 'tmux -L '\\''co'\\''\\'\\'''\\''op; echo BAD'\\'' attach -t '\\''%9; echo BAD'\\'''",
  );
});
