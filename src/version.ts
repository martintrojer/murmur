import { createRequire } from "node:module";

/**
 * This node's murmur version, read from the manifest.
 *
 * Read rather than restated, because two copies of one fact drift and npm bumps
 * the manifest. Its own module because THREE bundles need it at different depths
 * -- `dist/index.js`, `dist/cli.js`, `dist/extension/store.js` -- so one
 * hardcoded `"../package.json"` resolves in two and throws in the third.
 *
 * Not hypothetical: `openStore` moved into the extension bundle during the
 * current-state rewrite and its `../package.json` became `dist/package.json`,
 * which does not exist. The extension degrades every store failure to silence,
 * so the symptom was an agent reporting nothing with no error anywhere.
 *
 * Hence both candidates in order, and a throw if neither works: a version this
 * node cannot state belongs in a snapshot even less than a wrong one.
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
