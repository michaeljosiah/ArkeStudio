// One build, one version. The __APP_VERSION__ define used to be a literal in the npm script,
// which meant a release bump had to be remembered in two places — and the About box would
// happily claim the old number if it wasn't. It now comes from this package's package.json,
// the same file electron-builder reads, so they cannot disagree.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

await build({
  entryPoints: [join(root, "src/main.ts"), join(root, "src/preload.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  // The coordinator and its dependencies publish ESM; prefer it, fall back to main.
  mainFields: ["module", "main"],
  // Electron supplies these at runtime — bundling them would break the native bindings.
  external: ["electron", "electron-updater"],
  define: { __APP_VERSION__: JSON.stringify(version) },
  outdir: join(root, "dist"),
  outExtension: { ".js": ".cjs" },
});

console.log(`[build] main.cjs + preload.cjs at ${version}`);
