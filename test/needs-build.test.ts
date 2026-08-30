import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { builtArtifact } from "./helpers/built.js";

/**
 * The suite must not depend on state outside the checkout.
 *
 * Second instance of that class. The first was the shell environment
 * (MURMUR_STORE_MODULE, fixed in 84334d7); this is the build directory. A
 * peer-version test passed in one workspace and failed on main with
 * byte-identical source because that checkout's `dist/` was stale, and the
 * failure read as a formatting bug in the code under test:
 *
 *   expected NAME TARGET HOSTNAME LAST SEEN SSH… to contain VERSION
 *
 * Two layers, because they cover different populations. `npm test` builds first,
 * which REMOVES the failure mode for anyone using the documented command.
 * `builtArtifact` catches `npx vitest run` and editor runners, which bypass the
 * npm script and cannot be made to build.
 */

test("npm test builds before running, so the documented path cannot be stale", () => {
  // The wiring, asserted on the manifest rather than by running it: a nested
  // `npm test` inside a test is a recursive suite. If someone reverts this to a
  // bare `vitest run`, the whole first layer is gone silently, and the guard
  // below would become the only thing standing between a stale dist and a
  // confusing diff.
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(manifest.scripts.test).toContain("npm run build");
  expect(manifest.scripts.test).toContain("vitest run");
  // `check` runs tests through the same script, so it inherits the build.
  expect(manifest.scripts.check).toContain("npm run test");
  // And an escape hatch that does NOT build, for iterating on a test without
  // paying the build each time. Named so it cannot be mistaken for the default.
  expect(manifest.scripts["test:only"]).toBe("vitest run");
});

test("builtArtifact rejects a stale build by name, instead of an assertion diff", () => {
  // The message is the deliverable here, so it is what gets asserted. The old
  // failure named a table header; this names the file, the newer source, and the
  // command to run.
  //
  // Staleness is simulated in a SCRATCH TREE, not by touching the real dist/.
  // My first version did the latter -- utimes dist/cli.js back to epoch 0,
  // assert, restore -- and it made the suite intermittently fail about one run
  // in four, in an unrelated file ("link pi re-exports the install"). vitest
  // runs test FILES IN PARALLEL, so for the few milliseconds dist/cli.js was
  // backdated, any other file calling builtArtifact() correctly reported a stale
  // build. The test was not wrong about the code; it was corrupting shared state
  // that other tests legitimately read. Caught it by running `npm test` in a
  // loop rather than accepting a single green.
  const root = mkdtempSync(join(tmpdir(), "murmur-stale-"));
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "dist", "cli.js"), "");
  writeFileSync(join(root, "src", "thing.ts"), "");

  const old = new Date(0);
  utimesSync(join(root, "dist", "cli.js"), old, old);

  const cwd = process.cwd();
  try {
    process.chdir(root);
    expect(() => builtArtifact("cli.js")).toThrow(/is STALE/);
    expect(() => builtArtifact("cli.js")).toThrow(/Run: npm run build/);
    // Names WHICH source is newer, so the reader can see why.
    expect(() => builtArtifact("cli.js")).toThrow(/src[/\\]thing\.ts/);

    // And the converse, in the same scratch tree: a build newer than src passes.
    const now = new Date();
    utimesSync(join(root, "dist", "cli.js"), now, now);
    expect(() => builtArtifact("cli.js")).not.toThrow();
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }

  // Deliberately NOT asserting anything about the real dist/ here. It would be
  // asserting the developer ran a build, which is the very ambient dependency
  // this task removes -- and it failed exactly that way when verifying the fix
  // (touch src, skip the build, run vitest directly): every other failure
  // correctly said "run npm run build" while this line said "expected not to
  // throw", making my own guard look broken. The scratch tree above is the whole
  // subject; the real tree is other tests' business.
});

test("builtArtifact rejects a missing build by name", () => {
  // The fresh-clone case: dist/ is gitignored, so a new checkout has none at
  // all. Names a path that cannot exist rather than deleting the real one, for
  // the parallelism reason above.
  expect(() => builtArtifact("does-not-exist.js")).toThrow(/is missing/);
  expect(() => builtArtifact("does-not-exist.js")).toThrow(/Run: npm run build/);
});

test("every test that executes dist/ goes through the guard", () => {
  // The drift guard, and the reason this is worth a test rather than a comment.
  // A new test that shells out to dist/cli.js directly reintroduces the exact
  // ten-minute debugging session this task exists to prevent, and it would look
  // completely normal in review.
  //
  // Scoped to test/, which is small and bounded. Allows the helper itself, which
  // is where the one legitimate `dist` path lives.
  const offenders: string[] = [];
  const files = execFileSync("git", ["ls-files", "test"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((path) => path.endsWith(".ts") && path !== join("test", "helpers", "built.ts"));

  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      // A dist path constructed for execution, not a mention in prose. Comment
      // lines are excluded so the explanations above do not trip this.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      if (/["'`]dist["'`]|dist\/cli\.js|dist\/index\.js/.test(line)) {
        offenders.push(`${file}: ${line.trim()}`);
      }
    }
  }

  expect(offenders, "use builtArtifact()/runBuiltCli() from test/helpers/built.ts").toEqual([]);
  // The scan found files at all, so an empty glob cannot pass this.
  expect(files.length).toBeGreaterThan(5);
});
