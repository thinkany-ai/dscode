import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { "main/index": "src/main/index.ts" },
    format: ["esm"],
    platform: "node",
    outDir: "dist-electron",
    sourcemap: true,
    clean: false,
    external: ["electron"],
    outExtension: () => ({ js: ".mjs" }),
  },
  {
    entry: { "preload/index": "src/preload/index.ts" },
    format: ["cjs"],
    platform: "node",
    outDir: "dist-electron",
    sourcemap: true,
    clean: false,
    external: ["electron"],
    outExtension: () => ({ js: ".cjs" }),
  },
]);
