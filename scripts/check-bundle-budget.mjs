import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The client's start-up chunk grew 9.4 times between August and November 2026 with nothing to
// flag it (issue 2786). Run after `npm run build`. The script and stylesheet dist/index.html
// loads may sit up to 5% above these numbers; growth past that is a decision, made by raising
// the number here in the same change, and shrinkage is kept by lowering it.
//
// The script is everything start-up runs: the entry and each chunk dist/index.html preloads for
// it. Since screens load on demand (issue 2797) the entry file alone is a fraction of that, and
// code moved into a chunk the entry imports would leave it unchanged while start-up grew.

const BUDGET = { script: 3_506_016, stylesheet: 1_255_621 };
const TOLERANCE = 1.05;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "packages", "client", "dist");
const html = readFileSync(join(dist, "index.html"), "utf8");
const entry = html.match(/<script\b[^>]*\bsrc="\.\/(assets\/[^"]+\.js)"/)?.[1];
const files = {
  script: entry === undefined ? [] : [entry, ...[...html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="\.\/(assets\/[^"]+\.js)"/g)].map((m) => m[1])],
  stylesheet: [html.match(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="\.\/(assets\/[^"]+\.css)"/)?.[1]].filter((file) => file !== undefined),
};
const failures = [];
const sizes = [];
for (const [name, budget] of Object.entries(BUDGET)) {
  if (files[name].length === 0) { failures.push(`dist/index.html loads no ${name}`); continue; }
  const bytes = files[name].reduce((sum, file) => sum + statSync(join(dist, file)).size, 0);
  sizes.push(`${name} ${bytes.toLocaleString("en-GB")} B in ${files[name].length} file(s) of ${budget.toLocaleString("en-GB")}`);
  if (bytes > budget * TOLERANCE) {
    failures.push(`the start-up ${name} is ${bytes.toLocaleString("en-GB")} B, more than 5% over its budget of ${budget.toLocaleString("en-GB")} B: load it on demand, or raise BUDGET.${name} in scripts/check-bundle-budget.mjs`);
  }
}
if (failures.length > 0) {
  console.error(`bundle budget: ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`bundle budget: ${sizes.join(", ")}`);
