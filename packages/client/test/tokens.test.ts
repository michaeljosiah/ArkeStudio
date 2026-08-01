import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The design-system adherence tests (SPEC-001 R-11): tokens are ported verbatim and no
 * component code hard-codes a colour; the `.dark` scope re-themes without component change.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "../src");
const TOKENS_DIR = join(SRC, "theme", "tokens");
const DS_TOKENS = join(
  here,
  "../../../design-system/_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens",
);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

describe("design tokens", () => {
  it("ports colors/typography/spacing/effects verbatim from the approved baseline", () => {
    for (const file of ["colors.css", "typography.css", "spacing.css", "effects.css"]) {
      const ported = readFileSync(join(TOKENS_DIR, file), "utf8").replace(/\r\n/g, "\n");
      const source = readFileSync(join(DS_TOKENS, file), "utf8").replace(/\r\n/g, "\n");
      assert.equal(ported, source, `${file} must match the approved baseline byte-for-byte`);
    }
  });

  it("carries the .dark scope so the whole client re-themes without a component change", () => {
    const colors = readFileSync(join(TOKENS_DIR, "colors.css"), "utf8");
    assert.ok(colors.includes(".dark"), "colors.css must define the .dark theme scope");
  });

  it("hard-codes no colour outside the token files (R-11)", () => {
    const offenders: string[] = [];
    const hex = /#[0-9a-fA-F]{3,8}\b/;
    const fn = /\b(?:rgb|rgba|hsl|hsla|oklch)\(/;
    for (const path of walk(SRC)) {
      if (path.startsWith(TOKENS_DIR + sep)) continue;
      if (!/\.(tsx?|css)$/.test(path)) continue;
      const text = readFileSync(path, "utf8");
      if (hex.test(text) || fn.test(text)) offenders.push(relative(SRC, path));
    }
    assert.deepEqual(offenders, [], `hard-coded colours found in: ${offenders.join(", ")}`);
  });

  it("keeps credential material out of the client (R-10; SPEC-008 R-5, R-6)", () => {
    // Key ENTRY is legitimate since SPEC-008 (write-only: the value goes up once, no frame
    // carries one back). What must never appear client-side: decryption, persistence, or
    // direct provider auth — a key the client could read back would break R-6.
    const suspicious = /(safeStorage|decryptString|localStorage|sessionStorage|api_key|secretKey|Authorization: Bearer|xi-api-key|x-api-key)/i;
    const offenders: string[] = [];
    for (const path of walk(SRC)) {
      if (!/\.(tsx?)$/.test(path)) continue;
      if (suspicious.test(readFileSync(path, "utf8"))) offenders.push(relative(SRC, path));
    }
    assert.deepEqual(offenders, [], `credential-handling code found in: ${offenders.join(", ")}`);
  });
});
