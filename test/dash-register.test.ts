import { Command } from "commander";
import { afterEach, expect, test } from "vitest";
import { dashGoto, requireDashTmux, withDashTerminalSuspended } from "../src/cli/dash.js";
import { registerDash } from "../src/cli/dash-register.js";
import { asPaneId } from "../src/ids.js";
import { fakeMux } from "./helpers/fake-mux.js";

afterEach(() => {
  process.exitCode = 0;
});

test("dash refuses to start outside tmux but allows a tmux popup", () => {
  const errors: string[] = [];
  expect(requireDashTmux({}, (message) => errors.push(message))).toBe(false);
  expect(errors.join("")).toContain("murmur dash must run inside tmux");
  expect(requireDashTmux({ TMUX: "/tmp/tmux/default,1,0" }, () => undefined)).toBe(true);
});

test("a jump releases and restores the dash terminal around the action", async () => {
  const events: string[] = [];

  await withDashTerminalSuspended(
    async (action) => {
      events.push("suspend");
      await action();
      events.push("resume");
    },
    () => events.push("jump"),
    (enabled) => events.push(enabled ? "mouse on" : "mouse off"),
  );

  expect(events).toEqual(["mouse off", "suspend", "jump", "resume", "mouse on"]);
});

test("registers the dash command and its --goto flag", () => {
  const program = new Command();
  registerDash(program);

  const command = program.commands.find((candidate) => candidate.name() === "dash");
  expect(command?.description()).toBe("Watch agents and glance at their panes");
  // The tmux binding's target. A missing flag would make PREFIX G print
  // commander's usage error into a backgrounded run-shell, where nobody sees it.
  expect(command?.options.some((option) => option.long === "--goto")).toBe(true);
});

test("declaring the CLI does not load ink", async () => {
  // The reason `dash-register.ts` exists. `dash.tsx` imports ink at top
  // level, so a static import of it from `cli.ts` pulled the whole TUI
  // stack into every invocation -- including the `murmur status` the tmux
  // status bar runs on a loop. Importing ink alone measured ~0.22s against
  // ~0.03s for a bare node start.
  //
  // Run in a child process because this suite's own imports would otherwise
  // poison the check, and assert on the real thing (is ink in the module
  // graph?) rather than on source text or a flaky timing.
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");

  const repo = new URL("..", import.meta.url).pathname;
  // At the repo root, not the system tmpdir: node resolves bare specifiers
  // ("commander") from the importing FILE's location, so a probe in /tmp
  // cannot see the package's node_modules. Not under node_modules either --
  // node refuses to strip types there.
  const dir = mkdtempSync(join(repo, ".murmur-ink-probe-"));
  const probe = join(dir, "probe.mts");
  // A file rather than `node -e`: the pattern below must survive nested
  // escaping intact, and embedding it in a template literal mangles it.
  const lines = [
    `import { registerDash } from ${JSON.stringify(join(repo, "src/cli/dash-register.ts"))};`,
    'import { Command } from "commander";',
    "registerDash(new Command());",
    // Anchored on the package directory: a bare "ink" substring would also
    // match NativeModule internal/linkedlist.
    String.raw`const inkLoaded = process.moduleLoadList.some((e) => /node_modules\/(\.pnpm\/)?ink[@\/]/.test(e));`,
    "console.log(JSON.stringify({ inkLoaded, total: process.moduleLoadList.length }));",
  ];
  writeFileSync(probe, lines.join("\n"));
  try {
    const out = execFileSync(process.execPath, ["--experimental-strip-types", probe], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = JSON.parse(out.trim());
    // Guards against a probe that loads nothing and passes vacuously.
    expect(result.total).toBeGreaterThan(50);
    expect(result.inkLoaded).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--goto reports a missing dash on stderr and exits nonzero", () => {
  // `run-shell -b` shows neither, but the run that matters is the one a human
  // does by hand when the key appears to do nothing.
  const errors: string[] = [];
  expect(dashGoto(fakeMux(), { TMUX: "x" }, (message) => errors.push(message))).toBe(false);
  expect(errors.join("")).toContain("no murmur dash is running");
  expect(process.exitCode).toBe(1);
});

test("--goto switches to a live dash and stays silent", () => {
  const dash = asPaneId("%7");
  const errors: string[] = [];
  const attached: string[] = [];
  const ok = dashGoto(
    fakeMux({
      dashPane: () => dash,
      livePanes: () => new Set([dash]),
      attach: (pane) => {
        attached.push(pane);
        return true;
      },
    }),
    { TMUX: "x" },
    (message) => errors.push(message),
  );

  expect(ok).toBe(true);
  expect(attached).toEqual([dash]);
  expect(errors).toEqual([]);
  expect(process.exitCode).toBe(0);
});
