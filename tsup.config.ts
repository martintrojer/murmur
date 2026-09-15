import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    "extension/murmur-pi": "src/extension/murmur-pi.ts",
    "extension/store": "src/extension/store.ts",
  },
  format: ["esm"],
  dts: {
    entry: { index: "src/index.ts" },
    compilerOptions: { ignoreDeprecations: "6.0" },
  },
  clean: true,
  target: "node20",
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
  // Required for the lazy dash import to survive the bundle. With splitting
  // off, esbuild inlines `await import("./dash.js")` back into the single
  // chunk, so ink is statically imported again and every `murmur status` --
  // which the tmux status bar runs on a loop -- pays ~0.22s to load a TUI it
  // never renders. See src/cli/dash-register.ts.
  splitting: true,
  sourcemap: true,
  outDir: "dist",
  shims: false,
});
