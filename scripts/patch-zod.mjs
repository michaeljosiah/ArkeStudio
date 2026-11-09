// Leaves zod 3's schema methods on the prototype (issue 2815). Its ZodType constructor binds 24
// methods onto every schema instance, which was half of contracts' heap: leaving them on the
// prototype measured −30% evaluation time and −28 MB of heap a process, with the same results.
// zod 3.x is frozen at 3.25.76, so the patch is pinned to that version and to the exact text it
// replaces; anything else is refused rather than half-patched. Runs as the root postinstall.
//
// A bound method is only needed when one is called detached, as `xs.map(Schema.parse)`. Nothing
// in this repository does that; packages/contracts/test/zod-unbound.test.ts holds the patch.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const VERSION = "3.25.76";
const MARKER = "/* arke: methods stay on the prototype (issue 2815) */";
const BOUND = ["parse", "safeParse", "parseAsync", "safeParseAsync", "spa", "refine", "refinement", "superRefine",
  "optional", "nullable", "nullish", "array", "promise", "or", "and", "transform", "brand", "default", "catch",
  "describe", "pipe", "readonly", "isNullable", "isOptional"];

let root;
try { root = dirname(createRequire(join(process.cwd(), "package.json")).resolve("zod/package.json")); }
catch { console.log("patch-zod: zod is not installed here; nothing to patch"); process.exit(0); }
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (version !== VERSION) {
  console.error(`patch-zod: zod ${version} is installed, the patch is for ${VERSION}; update or remove scripts/patch-zod.mjs`);
  process.exit(1);
}
for (const file of ["v3/types.js", "v3/types.cjs"]) {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  if (text.includes(MARKER)) continue;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = BOUND.map(name => `        this.${name} = this.${name}.bind(this);`).join(eol);
  if (text.split(block).length !== 2) {
    console.error(`patch-zod: ${file} does not hold the expected bindings; it was not changed`);
    process.exit(1);
  }
  writeFileSync(path, text.replace(block, `        ${MARKER}`));
}
console.log(`patch-zod: zod ${VERSION} leaves its schema methods on the prototype`);
