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

/**
 * The dash must not load React's DEVELOPMENT reconciler.
 *
 * `react-reconciler/index.js` chooses its build from `NODE_ENV` at require
 * time, and a CLI is normally launched with it unset. The dev build
 * instruments every render with `performance.measure()`, and Node retains user
 * timing entries for the life of the process with no default buffer limit --
 * so a dash that re-renders on a timer leaks until the heap is gone. Measured
 * on the real dash at ~1,400 retained entries per minute and ~87MB/hour of
 * post-GC growth, which reached the 4GB cap and aborted at 38.5 hours.
 *
 * Asserted on the OBSERVABLE consequence -- does the timeline fill up? -- in a
 * child process running the real reconciler. A test on `process.env.NODE_ENV`
 * alone would have passed while the leak continued, since what matters is
 * which build got required and when.
 */
test("the dash renders without filling the performance timeline", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");

  const repo = new URL("..", import.meta.url).pathname;
  // At the repo root for the same reason the ink probe is: node resolves bare
  // specifiers from the importing file's location.
  const dir = mkdtempSync(join(repo, ".murmur-perf-probe-"));
  const probe = join(dir, "probe.mts");
  const lines = [
    `import { registerDash } from ${JSON.stringify(join(repo, "src/cli/dash-register.ts"))};`,
    'import { Command } from "commander";',
    'import { performance } from "node:perf_hooks";',
    // Run the action, which is where NODE_ENV is defaulted and which must
    // happen before react is resolved. Invoked directly rather than through
    // `parseAsync`, because the action's own `import("./dash.js")` cannot
    // resolve under --experimental-strip-types; the rejection is caught and
    // discarded, since everything asserted here happens before that import.
    "const program = new Command();",
    "registerDash(program);",
    'const dash = program.commands.find((c) => c.name() === "dash");',
    "await Promise.resolve(dash._actionHandler([{ goto: true }])).catch(() => {});",
    // react is imported AFTER the action, exactly as the real dash's dynamic
    // import is, so the build choice is already made.
    'const { render, Box, Text } = await import("ink");',
    'const React = (await import("react")).default;',
    "const stdout = { columns: 80, rows: 24, write() {}, on() {}, off() {}, removeListener() {}, isTTY: true };",
    'const app = render(React.createElement(Box, null, React.createElement(Text, null, "x")), { stdout, patchConsole: false });',
    "for (let i = 0; i < 40; i++) {",
    '  app.rerender(React.createElement(Box, null, React.createElement(Text, null, "tick " + i)));',
    "}",
    "app.unmount();",
    'const measures = performance.getEntriesByType("measure").length;',
    "console.log(JSON.stringify({ measures, nodeEnv: process.env.NODE_ENV }));",
  ];
  writeFileSync(probe, lines.join("\n"));
  try {
    // NODE_ENV deliberately UNSET, which is how a CLI is really launched and
    // the only condition under which the dev build gets picked. vitest sets it
    // to "test" for this process, and inheriting that would have tested a case
    // that never happens in production.
    const { NODE_ENV: _drop, ...env } = process.env;
    const out = execFileSync(process.execPath, ["--experimental-strip-types", probe], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const result = JSON.parse(out.trim());
    expect(result.nodeEnv).toBe("production");
    // Forty renders produced hundreds of retained entries before the fix.
    expect(result.measures).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
