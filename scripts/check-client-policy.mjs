import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The client's source policies (SPEC-001 R-10, R-11): the token files are the approved baseline
// byte for byte, no component hard-codes a colour, a light-ramp surface says what it becomes in
// dark, and no credential material is handled client-side. These used to be a test file
// (client/test/tokens.test.ts) and ran in one CI shard among six thousand cases; they are rules
// about the text of the source, not about what the program does, so they belong here with the
// other source checks, where a failure names the rule rather than a test.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "packages", "client", "src");
const TOKENS_DIR = join(SRC, "theme", "tokens");
const DS_TOKENS = join(root, "design-system", "_ds", "specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e", "tokens");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}
const read = (path) => readFileSync(path, "utf8");
const failures = [];
const fail = (rule, detail) => failures.push(`${rule}\n  ${detail}`);

// The token files are ported verbatim from the approved baseline.
for (const file of ["colors.css", "typography.css", "spacing.css", "effects.css"]) {
  const ported = read(join(TOKENS_DIR, file)).replace(/\r\n/g, "\n");
  const source = read(join(DS_TOKENS, file)).replace(/\r\n/g, "\n");
  if (ported !== source) fail(`tokens/${file} must match the design-system baseline byte for byte`, join(DS_TOKENS, file));
}

// The .dark scope re-themes the whole client without a component change, and the loaded family
// is named exactly (a "Geist" alias falls back to the system font in Electron).
const colors = read(join(TOKENS_DIR, "colors.css"));
if (!colors.includes(".dark")) fail("colors.css must define the .dark theme scope", join(TOKENS_DIR, "colors.css"));
const typography = read(join(TOKENS_DIR, "typography.css"));
if (!/--font-sans:\s*"Geist Sans"/.test(typography) || /--font-sans:\s*"Geist"[;,]/.test(typography)) {
  fail('typography.css must name --font-sans "Geist Sans" exactly', join(TOKENS_DIR, "typography.css"));
}

// Every stylesheet closes what it opens. Vite serves each file as its own <style> in
// development, where the parser closes an unfinished block or comment at end-of-file and the
// page looks right; the production bundle concatenates the imports, so a block — or a comment
// — left open in one file swallows every stylesheet after it. The shot page and the Activity
// panel shipped unstyled that way (issue 1113). Nothing else can see it: the tests render
// without CSS and the dev app cannot fail. One pass in the tokenizer's order — a string is a
// string before a comment can start inside it, a comment is a comment before a brace can count
// inside it — with the line kept so a failure names where the open thing began.
{
  const offenders = [];
  for (const path of walk(SRC)) {
    if (!path.endsWith(".css")) continue;
    const text = read(path);
    const file = relative(SRC, path);
    const open = [];
    let line = 1;
    let stray = null;
    let comment = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\n") { line += 1; continue; }
      if (ch === '"' || ch === "'") {
        // To the closing quote; a backslash escapes the next character; a bare newline ends
        // the string as the tokenizer does (a bad string), so a stray quote cannot hide a file.
        for (i += 1; i < text.length && text[i] !== ch && text[i] !== "\n"; i++) if (text[i] === "\\") i += 1;
        if (text[i] === "\n") line += 1;
        continue;
      }
      if (ch === "/" && text[i + 1] === "*") {
        const close = text.indexOf("*/", i + 2);
        if (close === -1) { comment = line; break; }
        for (let j = i; j < close; j++) if (text[j] === "\n") line += 1;
        i = close + 1;
        continue;
      }
      if (ch === "{") open.push(line);
      else if (ch === "}" && open.pop() === undefined && stray === null) stray = line;
    }
    if (comment !== null) offenders.push(`${file}:${comment} opens a comment that never closes`);
    if (stray !== null) offenders.push(`${file}:${stray} closes a block nothing opened`);
    if (open.length > 0) offenders.push(`${file}:${open[open.length - 1]} opens a block that never closes`);
  }
  if (offenders.length > 0) fail("a stylesheet must close every block and comment it opens — the bundle nests every later stylesheet inside an open one", offenders.join("; "));
}

// No colour is hard-coded outside the token files (R-11).
{
  const hex = /#[0-9a-fA-F]{3,8}\b/;
  const fn = /\b(?:rgb|rgba|hsl|hsla|oklch)\(/;
  const offenders = [];
  for (const path of walk(SRC)) {
    if (path.startsWith(TOKENS_DIR + sep) || !/\.(tsx?|css)$/.test(path)) continue;
    const text = read(path);
    if (hex.test(text) || fn.test(text)) offenders.push(relative(SRC, path));
  }
  if (offenders.length > 0) fail("hard-coded colours outside the token files (R-11)", offenders.join(", "));
}

// The .dark scope overrides the semantic tokens only — the --neutral-* ramp is deliberately left
// alone, so a ramp value used as a *surface* keeps its light-mode colour on a near-black page. That
// produced the same bug four times (a setup bar's track and fill 1.03:1 apart, a switch's states
// 1.15:1 apart, two image plates flashing white on a dark dialog). A fill therefore either resolves
// through a semantic token, or keeps the ramp and states its dark counterpart in the same file.
// Dots are exempt (a ramp-coloured mark inverts emphasis in dark but stays legible) and so are
// swatches (a light card depicting the light theme has to stay light). Only the light end of the
// ramp is checked: the dark end is used on purpose for the plates behind creator artwork.
{
  const offenders = [];
  for (const path of walk(SRC)) {
    if (path.startsWith(TOKENS_DIR + sep) || !path.endsWith(".css")) continue;
    // Comments come out first, or a comment above a rule is swallowed into the selector capture —
    // which quietly exempted every rule that carried an explanation.
    const text = read(path).replace(/\/\*[\s\S]*?\*\//g, "\n");
    const rule = /(^|[}\n])\s*([^{}@]+?)\s*\{[^{}]*?background:\s*var\(--neutral-(?:50|100|200|300)\)/gms;
    for (const match of text.matchAll(rule)) {
      const selector = match[2].trim().replace(/\s+/g, " ");
      if (selector === "" || selector.startsWith(".dark") || /dot/i.test(selector) || /swatch/i.test(selector)) continue;
      if (!text.includes(`.dark ${selector}`)) offenders.push(`${relative(SRC, path)}: ${selector}`);
    }
  }
  if (offenders.length > 0) fail("a light-ramp surface with no .dark counterpart (R-11)", offenders.join("\n  "));
}

// Queue toasts draw from tokens and inherit the global reduced-motion policy.
{
  const toast = read(join(SRC, "components", "toast.css"));
  const globals = read(join(SRC, "theme", "globals.css"));
  if (!toast.includes("var(--card)") || !toast.includes("var(--border)")) fail("toast.css must draw from --card and --border", "components/toast.css");
  if (!/prefers-reduced-motion:\s*reduce/.test(globals)) fail("globals.css must carry the reduced-motion policy", "theme/globals.css");
}

// No credential material client-side (R-10; SPEC-008 R-5, R-6). Key ENTRY is legitimate — the
// value goes up once and no frame carries one back. What must never appear here is decryption,
// persistence or direct provider auth: a key the client could read back would break R-6.
{
  const suspicious = /(safeStorage|decryptString|localStorage|sessionStorage|api_key|secretKey|Authorization: Bearer|xi-api-key|x-api-key)/i;
  // Browser development keeps only the coordinator capability in tab storage; continuity keeps only
  // the outline/continuity view choice; the voice-sample panel persists a schema-validated
  // preparation UUID for restart recovery; the storyboard remembers which of two layouts it
  // opens on (turn 145). Each strips that one word; keys, auth and decryption still fail.
  const stripped = new Map([
    [join("lib", "dev-session.ts"), "sessionStorage"],
    [join("lib", "continuity.ts"), "sessionStorage"],
    [join("lib", "storyboard-layout.ts"), "localStorage"],
    [join("components", "character-voice-sample.tsx"), "localStorage"],
  ]);
  const offenders = [];
  for (const path of walk(SRC)) {
    if (!/\.(tsx?)$/.test(path)) continue;
    const sourcePath = relative(SRC, path);
    const word = stripped.get(sourcePath);
    const inspected = word === undefined ? read(path) : read(path).replaceAll(word, "");
    if (suspicious.test(inspected)) offenders.push(sourcePath);
  }
  if (offenders.length > 0) fail("credential-handling code in the client (R-10)", offenders.join(", "));
}

if (failures.length > 0) {
  console.error(`client policy: ${failures.length} rule${failures.length === 1 ? "" : "s"} broken\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("client policy: tokens match the baseline, every stylesheet closes its blocks, no hard-coded colour, ramp surfaces darken, no credential material");
