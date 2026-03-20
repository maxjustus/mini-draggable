import * as esbuild from "esbuild";
import { execSync } from "child_process";

const entryPoints = [
  "src/sortable.ts",
  "src/alpine-sortable.ts",
  "src/hooks-sortable.ts",
];

// ESM (.mjs)
await esbuild.build({
  entryPoints,
  outdir: "dist",
  format: "esm",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  external: ["./sortable.js"],
});

// Plain JS (readable ESM, the "copy-paste" file)
await esbuild.build({
  entryPoints,
  outdir: "dist",
  format: "esm",
  bundle: true,
  external: ["./sortable.js"],
});

// Minified IIFE (for <script> tags)
await esbuild.build({
  entryPoints: ["src/sortable.ts"],
  outfile: "dist/sortable.min.js",
  format: "iife",
  globalName: "miniSortable",
  bundle: true,
  minify: true,
});

// Type declarations via tsc
execSync("npx tsc", { stdio: "inherit" });

console.log("Build complete.");
