import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { SUPPORTED_SCHEMA_VERSION, WORLD_SCHEMA_BOUNDARIES } from "../../src/world/schema-versions.js";

// The registry guards the mechanism that keeps an older build from damaging a newer world
// (issue 2815): a repeated number, or a boundary above what this build supports, would let the
// wrong build open a world or make this one refuse its own.
const packages = fileURLToPath(new URL("../../../", import.meta.url));
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
const files = [...sources(join(packages, "coordinator", "src")), ...sources(join(packages, "contracts", "src"))];
// The world package's format numbers its own files, not world.json.
const NOT_WORLD = new Set([join(packages, "contracts", "src", "world-package.ts")]);

it("gives every world boundary its own number, and supports the highest", () => {
  const values = Object.values(WORLD_SCHEMA_BOUNDARIES);
  const repeated = values.filter((value, index) => values.indexOf(value) !== index);
  assert.deepEqual(repeated, [], "a number allocated twice");
  assert.equal(SUPPORTED_SCHEMA_VERSION, Math.max(...values));
});

it("lists every schema-version boundary the coordinator and contracts declare", () => {
  const listed: Record<string, number> = WORLD_SCHEMA_BOUNDARIES;
  let declared = 0;
  for (const file of files) {
    if (NOT_WORLD.has(file)) continue;
    for (const [, name, value] of readFileSync(file, "utf8").matchAll(/^export const ([A-Z_]*SCHEMA_VERSION) = (\d+);/gm)) {
      declared++;
      assert.equal(listed[name!], Number(value), `${name} is in WORLD_SCHEMA_BOUNDARIES at its own value`);
    }
  }
  assert.equal(declared, Object.keys(listed).length, "nothing listed that no module declares");
});

it("raises a world past a named boundary, never a bare number", () => {
  const bare = files.flatMap(file => readFileSync(file, "utf8").match(/ensureSchemaVersion\(\s*\d/g) ? [file] : []);
  assert.deepEqual(bare, []);
});
