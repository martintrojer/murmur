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
  splitting: false,
  sourcemap: true,
  outDir: "dist",
  shims: false,
});
