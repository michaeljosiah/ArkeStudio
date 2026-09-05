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

  it("names the loaded Geist Sans family exactly", () => {
    const typography = readFileSync(join(TOKENS_DIR, "typography.css"), "utf8");
    assert.match(typography, /--font-sans:\s*"Geist Sans"/);
    assert.doesNotMatch(typography, /--font-sans:\s*"Geist"[;,]/);
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

  /*
   * The .dark scope overrides the semantic tokens only — the --neutral-* ramp is deliberately
   * left alone, so a ramp value used as a *surface* keeps its light-mode colour on a near-black
   * page. That has produced the same bug four times: a setup bar whose track and fill landed
   * 1.03:1 apart, a switch whose off and on states landed 1.15:1 apart, and two image plates that
   * flashed white on a dark dialog.
   *
   * A fill therefore either resolves through a semantic token, or keeps the ramp and states its
   * dark counterpart explicitly. Dots are exempt: a ramp-coloured mark inverts emphasis in dark
   * but stays perfectly legible, which is a judgement call rather than a defect.
   *
   * Only the light end of the ramp is checked. The failure is specifically a light surface that
   * never darkens; the dark end is used deliberately for the plates behind creator artwork, which
   * hold their colour in both themes on purpose — the same reason --media-overlay-bg does.
   */
  it("paints no surface from the ramp without saying what it becomes in dark (R-11)", () => {
    const offenders: string[] = [];
    for (const path of walk(SRC)) {
      if (path.startsWith(TOKENS_DIR + sep) || !path.endsWith(".css")) continue;
      // Comments come out first. Left in, a comment above a rule is swallowed into the selector
      // capture — which quietly exempted every rule that carried an explanation, i.e. exactly the
      // ones most likely to be doing something subtle.
      const text = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "\n");
      // Selector(s) immediately preceding a light-ramp `background` declaration.
      const rule = /(^|[}\n])\s*([^{}@]+?)\s*\{[^{}]*?background:\s*var\(--neutral-(?:50|100|200|300)\)/gms;
      for (const match of text.matchAll(rule)) {
        const selector = match[2]!.trim().replace(/\s+/g, " ");
        if (selector === "" || selector.startsWith(".dark")) continue;
        // A mark, not a surface.
        if (/dot/i.test(selector)) continue;
        // A swatch depicts a theme rather than wearing one: the light card has to stay light in
        // dark mode, or the pair stops being a comparison.
        if (/swatch/i.test(selector)) continue;
        // Paired with an explicit dark counterpart somewhere in the same file.
        if (!text.includes(`.dark ${selector}`)) offenders.push(`${relative(SRC, path)}: ${selector}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `ramp used as a surface with no .dark counterpart:\n  ${offenders.join("\n  ")}`,
    );
  });

  it("styles queue toasts from tokens and inherits the global reduced-motion policy", () => {
    const toast = readFileSync(join(SRC, "components", "toast.css"), "utf8");
    const globals = readFileSync(join(SRC, "theme", "globals.css"), "utf8");
    assert.ok(toast.includes("var(--card)") && toast.includes("var(--border)"));
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(toast));
    assert.match(globals, /prefers-reduced-motion:\s*reduce/);
  });

  it("locks the canonical Cast ledger geometry", () => {
    const css = readFileSync(join(SRC, "screens", "fidelity.css"), "utf8");
    for (const declaration of [
      "--cast-gutter: 96px",
      "--cast-feature: 400px",
      "--cast-gap: 60px",
      "--cast-portrait-width: 380px",
      "--cast-portrait-height: 440px",
      "padding: 7px 14px",
    ]) {
      assert.ok(css.includes(declaration), `Cast geometry includes ${declaration}`);
    }
    assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.fy-content--cast \.fy-split \{ flex-direction: column/);
  });

  it("keeps Cast on the shared world menu positioning", () => {
    const css = readFileSync(join(SRC, "screens", "fidelity.css"), "utf8");
    assert.doesNotMatch(css, /\.fy-content--cast \.fy-pillnav/, "Cast must not override the shared menu");
    assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.fy-pillnav \{ overflow-x: auto;/);
  });

  it("lets scene rows answer to centre width and keeps their menus out of layout", () => {
    const css = readFileSync(join(SRC, "screens", "fidelity.css"), "utf8");
    const imageActions = readFileSync(join(SRC, "components", "image-actions.css"), "utf8");
    const rows = readFileSync(join(SRC, "screens", "scene-workspace", "rows.tsx"), "utf8");
    const brief = readFileSync(join(SRC, "components", "bench-brief.tsx"), "utf8");
    assert.match(css, /\.fy-sw__centre\s*\{[^}]*container-type:\s*inline-size/);
    assert.match(css, /@container\s*\(max-width:\s*700px\)[\s\S]*?\.fy-swrow__band\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    assert.match(css, /\.fy-swrow__menu,\s*\.fy-swrow__confirm\s*\{[^}]*position:\s*fixed/);
    assert.match(rows, /createPortal\([\s\S]*?document\.body/);
    assert.match(brief, /createPortal\([\s\S]*?document\.body/);
    assert.match(rows, /target\?\.focus\(\)/, "opening a row menu moves focus into it");
    assert.match(rows, /event\.key === "ArrowDown"/, "row menus implement keyboard traversal");
    assert.match(rows, /role=\{confirmDelete \? "alertdialog" : "menu"\}/);
    assert.match(css, /@media \(pointer: coarse\)[\s\S]*?\.fy-swrow__frameactions button \{ min-width: 44px; min-height: 44px;/);
    assert.match(css, /\.fy-swrow__preview\s*\{[^}]*width: 44px; height: 44px/);
    assert.match(css, /@media \(pointer: coarse\)[\s\S]*?\.fy-swrow__generate, \.fy-swedit, \.fy-swrow__slot button,[\s\S]*?\.fy-swrow__menu button, \.fy-swrow__confirm button, \.fy-swpreview__retry \{ min-width: 44px; min-height: 44px;/);
    assert.match(css, /\.fy-swpreview__filmstrip\s*\{[^}]*overflow-x:\s*auto/);
    const coarse = /@media \(pointer: coarse\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    const coarseTargets = [...coarse.matchAll(/([^{}]+)\{ min-width: 44px; min-height: 44px; \}/g)]
      .flatMap((match) => match[1]!.split(",").map((selector) => selector.trim()));
    for (const selector of [
      ".fy-swstage__step",
      ".fy-swstage__play",
      ".fy-swstage__keytools button",
      ".fy-swstage__nudge button",
      ".fy-swstage__modes button",
      ".fy-swstage__ghost",
      ".fy-swstage__chips button",
      ".fy-swstage__set input",
      ".fy-swstage__set-head button",
    ]) {
      assert.ok(coarseTargets.includes(selector), `${selector} keeps a 44px coarse-pointer target`);
    }
    assert.match(imageActions, /@media \(pointer: coarse\)[\s\S]*?\.fy-imgdl\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/);
    assert.match(css, /\.fy-swalt:focus-within\s*\{[^}]*clip-path:\s*none/, "focused edge words escape the visually-hidden clipping box");
  });

  it("keeps credential material out of the client (R-10; SPEC-008 R-5, R-6)", () => {
    // Key ENTRY is legitimate since SPEC-008 (write-only: the value goes up once, no frame
    // carries one back). What must never appear client-side: decryption, persistence, or
    // direct provider auth — a key the client could read back would break R-6.
    const suspicious =
      /(safeStorage|decryptString|localStorage|sessionStorage|api_key|secretKey|Authorization: Bearer|xi-api-key|x-api-key)/i;
    const offenders: string[] = [];
    for (const path of walk(SRC)) {
      if (!/\.(tsx?)$/.test(path)) continue;
      const sourcePath = relative(SRC, path);
      const source = readFileSync(path, "utf8");
      // Browser development keeps only the coordinator capability in tab storage. Provider
      // credentials remain forbidden here and everywhere else in the client.
      const inspected = sourcePath === join("lib", "dev-session.ts")
        ? source.replaceAll("sessionStorage", "")
        : sourcePath === join("components", "character-voice-sample.tsx")
          // This panel persists only a schema-validated preparation UUID for restart recovery.
          // Strip that storage vocabulary only; provider keys, auth and decryption still fail.
          ? source.replaceAll("localStorage", "")
          : source;
      if (suspicious.test(inspected)) offenders.push(sourcePath);
    }
    assert.deepEqual(offenders, [], `credential-handling code found in: ${offenders.join(", ")}`);
  });
});
