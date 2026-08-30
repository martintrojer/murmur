import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The path to a built artifact, checked to be present and newer than `src/`.
 *
 * Some tests must run the real shipped thing: `link pi` writes a shim that
 * re-exports the install, and the concurrency test needs separate PROCESSES to
 * contend for a SQLite lock at all. Those cannot be driven in-process, so they
 * execute `dist/`.
 *
 * That makes the suite depend on state outside the checkout, and it cost a
 * maintainer ten minutes: a peer-version test passed in one workspace and failed
 * on main with byte-identical source, because that checkout's `dist/` was stale.
 * The failure read
 *
 *   expected NAME TARGET HOSTNAME LAST SEEN SSH… to contain VERSION
 *
 * which looks exactly like a formatting bug in the code under test and says
 * nothing about the build. A stale build is the dangerous case, not a missing
 * one: missing fails loudly, stale passes while testing code you did not write.
 *
 * `npm test` now builds first, so the normal path cannot hit this. This exists
 * for `npx vitest run` and for editor test-runners, which bypass the npm script
 * — and it FAILS rather than skipping, because a silent skip is how a stale
 * artifact goes unnoticed.
 */
export function builtArtifact(...parts: string[]): string {
  const path = join(process.cwd(), "dist", ...parts);
  let built: number;
  try {
    built = statSync(path).mtimeMs;
  } catch {
    throw new Error(
      `${join("dist", ...parts)} is missing. Run: npm run build\n` +
        "(npm test builds automatically; this path is only hit when vitest is run directly.)",
    );
  }

  const { path: newest, mtime } = newestSource();
  if (mtime > built) {
    throw new Error(
      `${join("dist", ...parts)} is STALE: ${newest} is newer.\n` +
        "This test executes the built artifact, so it would be testing the previous build.\n" +
        "Run: npm run build\n" +
        "(npm test builds automatically; this path is only hit when vitest is run directly.)",
    );
  }
  return path;
}

/** The most recently modified file under `src/`, by mtime. */
function newestSource(dir = "src"): { path: string; mtime: number } {
  let newest = { path: dir, mtime: 0 };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const candidate = entry.isDirectory()
      ? newestSource(path)
      : { path, mtime: statSync(path).mtimeMs };
    if (candidate.mtime > newest.mtime) newest = candidate;
  }
  return newest;
}

/** Run the built CLI, with the staleness check applied first. */
export function runBuiltCli(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(process.execPath, [builtArtifact("cli.js"), ...args], {
    env,
    encoding: "utf8",
  });
}
