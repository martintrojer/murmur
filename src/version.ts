import { createRequire } from "node:module";

/**
 * This node's murmur version, read from the manifest.
 *
 * Read rather than restated, for the reason index.ts already gives: two copies
 * of one fact drift, and npm bumps the manifest. It lives in its own module
 * because THREE bundles need it and they sit at different depths --
 * `dist/index.js`, `dist/cli.js` and `dist/extension/store.js` -- so a single
 * hardcoded `"../package.json"` resolves in two of them and throws in the third.
 *
 * That is not hypothetical. `openStore` moved into the extension bundle during
 * the current-state rewrite, and its `../package.json` became
 * `dist/package.json`, which does not exist. The extension catches every store
 * failure and degrades to silence, so the symptom was an agent that reported
 * nothing at all, with no error anywhere -- exactly the failure mode the
 * three-state store handle exists to make survivable, hiding a hard one.
 *
 * Hence both candidates, tried in order, and a throw if neither works: a version
 * this node cannot state belongs in a snapshot even less than a wrong one does.
 */
function readVersion(): string {
  const require = createRequire(import.meta.url);
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      return (require(candidate) as { version: string }).version;
    } catch {
      // Wrong depth for this bundle; try the next.
    }
  }
  throw new Error("cannot locate package.json to read the murmur version");
}

export const MURMUR_VERSION: string = readVersion();
