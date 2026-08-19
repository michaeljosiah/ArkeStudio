import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The built main bundle has to be able to start.
 *
 * Everything upstream of the bundle runs the same TypeScript through tsx as ESM — tests,
 * typecheck, dev — so an ESM→CJS flattening failure passes every one of them and only appears
 * once someone launches the packaged app. Cheap enough (esbuild is well under a second) that
 * there is no reason for the twenty-minute package run to be the first thing that finds out.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = (script) => execFileSync(process.execPath, [join(root, "scripts", script)], { cwd: root, encoding: "utf8" });

describe("the built main bundle", () => {
  it("loads, with every bundled dependency's module scope run", () => {
    run("build.mjs");
    assert.match(run("smoke-main-bundle.mjs"), /dist\/main\.cjs loads/);
  });

  it("leaves no import.meta.url reading undefined", () => {
    // The specific failure above, asserted at the source so a regression names itself rather than
    // arriving as ERR_INVALID_ARG_VALUE from inside minified vendor code. esbuild warns about this
    // for our own files and stays SILENT for anything under node_modules, which is where the
    // module-scope one that took the app down lived.
    const bundle = readFileSync(join(root, "dist", "main.cjs"), "utf8");
    const unshimmed = bundle.match(/import_meta\d*\.\w+/g) ?? [];
    assert.deepEqual(unshimmed, [], "esbuild's empty import.meta shim survived into the bundle");
  });
});
