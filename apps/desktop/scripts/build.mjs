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

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  // The coordinator and its dependencies publish ESM; prefer it, fall back to main.
  mainFields: ["module", "main"],
  // Electron supplies these at runtime — bundling them would break the native bindings.
  external: ["electron", "electron-updater"],
  outdir: join(root, "dist"),
  outExtension: { ".js": ".cjs" },
};

/*
 * `import.meta.url` has to survive the ESM→CJS flattening, or the app does not start.
 *
 * There is no `import.meta` in CJS, so esbuild emits `var import_meta = {}` and every
 * `import.meta.url` in a bundled ESM dependency silently becomes `undefined`. Dependencies that
 * only read it lazily get away with it for years — this bundle already contained one, inside a
 * function nothing calls on the happy path. The Anthropic SDK does it at MODULE SCOPE:
 * `createRequire(import.meta.url)` runs the moment main.cjs is required, and `createRequire(undefined)`
 * throws ERR_INVALID_ARG_VALUE. The whole main process dies before the first window, with a stack
 * pointing into minified vendor code and nothing naming the real cause.
 *
 * Nothing catches this short of loading the built bundle: tsx runs the TypeScript as ESM where
 * `import.meta.url` is real, so tests, typecheck and dev are all green while the packaged app is
 * dead on arrival.
 *
 * Applied to main only. preload has no `import.meta` in it, and a sandboxed preload gets a
 * restricted `require` that does not necessarily serve `node:url` — so the shim goes where it is
 * needed and nowhere else.
 */
await build({
  ...shared,
  entryPoints: [join(root, "src/main.ts")],
  banner: { js: 'var import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
  define: { __APP_VERSION__: JSON.stringify(version), "import.meta.url": "import_meta_url" },
});

await build({
  ...shared,
  entryPoints: [join(root, "src/preload.ts")],
  define: { __APP_VERSION__: JSON.stringify(version) },
});

console.log(`[build] main.cjs + preload.cjs at ${version}`);
