#!/usr/bin/env node
// Points core.hooksPath at .githooks. Run from `prepare`, so a fresh clone
// gets the pre-commit gate after its first `npm install` without anyone
// remembering to wire it up.
//
// Best-effort by design: a missing git binary, a tarball install with no .git,
// or a CI checkout must not fail the install.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

if (process.env.MURMUR_SKIP_HOOKS === "1" || process.env.CI) process.exit(0);
if (!existsSync(".git")) process.exit(0);

try {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
} catch {
  // No git, or a worktree that refuses config writes. Not worth a warning.
}
