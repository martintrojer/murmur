import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

/**
 * Boundaries ARCHITECTURE.md asserts, checked rather than trusted.
 *
 * Each of these was true when written and true when a sweep looked for
 * violations -- and nothing would have failed if it stopped being true. A
 * boundary stated only in prose is a boundary that drifts on the first patch
 * that finds it inconvenient.
 */

function sourceFiles(dir = "src"): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

test("only the store owns SQL", () => {
  // ARCHITECTURE.md § The units: the store is the only module that speaks SQL,
  // which is what makes "one writer per fact" checkable by reading one file.
  // A direct database import anywhere else would have passed the whole suite.
  const offenders = sourceFiles()
    .filter((path) => path !== join("src", "store.ts"))
    .filter((path) => {
      const source = readFileSync(path, "utf8");
      // Import of the driver, or a statement built outside the store. Matched
      // on code shapes rather than the bare words, since the words appear in
      // prose comments across the tree -- collector.ts explains better-sqlite3's
      // synchronous behaviour without using it.
      return (
        /from\s+["']better-sqlite3["']/.test(source) ||
        /\b(?:prepare|exec)\(\s*[`"']\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE)\b/i.test(source)
      );
    });

  expect(offenders).toEqual([]);
});

test("no source file writes crashed attention outside the store", () => {
  // `crashed` is reconciliation's conclusion: it asserts an owning process died
  // without saying so, which only the node that probed that pid may decide.
  // `RequestableKind` enforces this in the type system, and this catches the
  // other route -- a literal reaching the column some other way.
  const offenders = sourceFiles()
    .filter((path) => path !== join("src", "store.ts"))
    .filter((path) => {
      // Comment lines stripped first. The docblock on `RequestableKind` quotes
      // the forbidden call to explain why it is forbidden, and a scanner that
      // cannot tell code from prose reports the explanation as the violation.
      const code = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
        .join("\n");
      return /kind:\s*["']crashed["']/.test(code);
    });

  expect(offenders).toEqual([]);
});
