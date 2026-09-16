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

test("the effort vocabulary is spelled once", () => {
  // A closed protocol vocabulary written out more than once drifts, and this
  // repo has already paid for that: `SNAPSHOT_VERSION` existed as four literals
  // and the copy in `peer.ts` made `peer list` report every correctly upgraded
  // peer as incompatible.
  //
  // `effort` had the same shape -- the type, the wire validator, the producer's
  // filter and the SQLite CHECK each listed the seven levels independently.
  // Drift there is worse than cosmetic: the producer would silently drop a valid
  // pi report, or the validator would reject an otherwise good peer snapshot,
  // and the three failures look nothing alike.
  //
  // Checked by counting the LITERALS rather than by comparing lists: a
  // comparison would pass while four identical copies sat in four files, which
  // is the state this guards against.
  const offenders = sourceFiles()
    .filter((path) => {
      const source = readFileSync(path, "utf8");
      // `xhigh` is the distinctive member: it appears in no other vocabulary in
      // this codebase, so a file containing it is spelling the effort list.
      return /["']xhigh["']/.test(source);
    })
    .sort();

  // ONE spelling now. The schema's CHECK clause is generated from the same
  // tuple, so SQL being unable to import costs a template interpolation rather
  // than a second list to keep in step.
  expect(offenders).toEqual([join("src", "types.ts")]);
});

test("only the ansi module decides what escape sequences survive", () => {
  // The dash now consumes arbitrary terminal bytes (`capture-pane -e`), and the
  // allow-list that keeps a preview from painting outside its box is worth
  // exactly as much as its being the ONLY such decision in the tree. A second
  // hand-rolled escape regex somewhere else is how the two drift and one of
  // them stops refusing OSC 52.
  //
  // Two known owners predate the allow-list and are named rather than matched
  // around: `paint.ts` builds its own SGR pattern to measure and clip picker
  // cells, and `dash-mouse.ts` parses the terminal's SGR mouse reports on the
  // way IN. Listing them is what makes a THIRD one fail this test.
  const owners = [join("src", "ansi.ts"), join("src", "paint.ts"), join("src", "dash-mouse.ts")];
  const offenders = sourceFiles()
    .filter((path) => !owners.includes(path))
    .filter((path) => {
      const source = readFileSync(path, "utf8");
      // Prose is excluded by requiring the ESC byte itself, not the word --
      // either spelled in a literal, or constructed. `String.fromCharCode(27)`
      // plus `new RegExp` is how this repo already writes such a pattern (a
      // bare \u001b in a regex trips biome's noControlCharactersInRegex), so a
      // scanner that only looked for regex literals could not see the two
      // hand-rolled ones it exists to find.
      return (
        /\/[^\n/]*(?:\\u001b|\\x1b|\\e)[^\n/]*\/[gimsuy]*/.test(source) ||
        /String\.fromCharCode\(\s*27\s*\)/.test(source) ||
        /new RegExp\([^\n)]*(?:\\u001b|\\x1b|\\e)/.test(source)
      );
    });

  expect(offenders).toEqual([]);
});
