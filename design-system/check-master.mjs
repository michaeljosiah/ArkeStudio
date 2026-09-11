// Checks over design-system/Arke Studio.dc.html, the design master (issue 1097).
//
//   node design-system/check-master.mjs            static checks only
//   node design-system/check-master.mjs --render   also render in headless Chrome and prove the
//                                                  product's face loaded (needs Chrome and, for
//                                                  the master, network for the dc runtime's React)
//
// Static: from turn 139 on, a frame sets type through the tokens only — a raw `font-size: 11px`
// or `font: 500 12px …` inside a turn fails. Earlier turns are dated record and keep what they
// drew, but their count may not grow. A turn from 139 on is approved from HTML, never from a
// bitmap, so a card whose only content is an <img> fails there too. Every `#anchor` resolves.
//
// Render: the master painted in Segoe UI for months because nothing resolved to the loaded face
// (Google served "Geist", the tokens named "Geist Sans"). The fonts are vendored now; this proves
// it every time, by asking the browser rather than trusting the stylesheet.
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MASTER = join(here, "Arke Studio.dc.html");
const REVIEW = join(here, "design-review.html");

// Turn 139 restated the scale as a rule; everything before it is record.
const TOKENS_FROM_TURN = 139;
// What the record holds today. A frame added to an old turn still has to use the tokens, so the
// number may fall and may not rise. Recount with --count when a legacy frame is deliberately cut.
const LEGACY_RAW_SIZES = 12513;
const LEGACY_BITMAP_FRAMES = 1; // 138a, kept as evidence beside 139a

const RAW_SIZE = /\bfont(?:-size)?\s*:\s*(?:[0-9]{3}\s+)?[0-9]+(?:\.[0-9]+)?px/g;

const failures = [];
const fail = (message) => failures.push(message);

const html = readFileSync(MASTER, "utf8");

/** Split the master into turns: each block runs to the next `dv-turn` start, since frames may hold a stray </section>. */
function turns(source) {
  const starts = [...source.matchAll(/<section class="dv-turn" id="t(\d+)"/g)];
  return starts.map((m, i) => ({
    turn: Number(m[1]),
    body: source.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : undefined),
  }));
}

const sections = turns(html);
if (sections.length === 0) fail("no dv-turn sections found — is this the master?");

// 1. Raw sizes.
let legacyRaw = 0;
for (const { turn, body } of sections) {
  if (turn === 0) continue; // the document's own header, not a frame
  const hits = body.match(RAW_SIZE) ?? [];
  if (turn >= TOKENS_FROM_TURN) {
    if (hits.length) fail(`turn ${turn}: ${hits.length} raw font size(s) — frames set type through var(--text-*) / var(--type-*) only: ${[...new Set(hits)].slice(0, 6).join(", ")}`);
  } else {
    legacyRaw += hits.length;
  }
}
if (process.argv.includes("--count")) {
  console.log(`legacy raw sizes: ${legacyRaw}`);
}
if (legacyRaw > LEGACY_RAW_SIZES) fail(`legacy turns hold ${legacyRaw} raw font sizes, up from ${LEGACY_RAW_SIZES} — new drawing in an old turn still uses the tokens`);

// 2. Bitmap-only cards. A card is the `dv-card` element; its content is what sits between the
//    opening tag and the first nested element of substance.
let legacyBitmaps = 0;
for (const { turn, body } of sections) {
  const cards = body.split(/<div class="dv-card"[^>]*>/).slice(1);
  for (const card of cards) {
    const head = card.slice(0, 600).replace(/\s+/g, " ");
    const bitmapOnly = /^\s*<img\b[^>]*>\s*<\/div>/.test(head);
    if (!bitmapOnly) continue;
    if (turn >= TOKENS_FROM_TURN) fail(`turn ${turn}: a card that is only an <img> — a turn is approved from HTML; a bitmap may sit beside a frame as evidence, never replace it`);
    else legacyBitmaps += 1;
  }
}
if (legacyBitmaps > LEGACY_BITMAP_FRAMES) fail(`legacy turns hold ${legacyBitmaps} bitmap-only cards, up from ${LEGACY_BITMAP_FRAMES}`);

// 3. Anchors and ids.
const ids = new Map();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.set(m[1], (ids.get(m[1]) ?? 0) + 1);
for (const [id, n] of ids) if (n > 1 && /^(t\d+|\d+[a-z])$/.test(id)) fail(`id "${id}" appears ${n} times`);
// Turn 121 says it replaces a 120e that was later cut from turn 120; the sentence is record.
const KNOWN_DANGLING = new Set(["120e"]);
const missing = new Set();
for (const m of html.matchAll(/href="#([^"]+)"/g)) if (!ids.has(m[1]) && !KNOWN_DANGLING.has(m[1])) missing.add(m[1]);
if (missing.size) fail(`anchors with no target: ${[...missing].slice(0, 12).join(", ")}${missing.size > 12 ? " …" : ""}`);

// 4. The tokens name the face the app registers, and the face is vendored.
const typography = readFileSync(join(here, "_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens/typography.css"), "utf8");
if (!/--font-sans:\s*"Geist Sans"/.test(typography)) fail('typography.css: --font-sans must start with "Geist Sans", the family @fontsource registers');
for (const w of [400, 500, 600, 700]) {
  if (!existsSync(join(here, `_ds/fonts/geist-sans-latin-${w}-normal.woff2`))) fail(`_ds/fonts/geist-sans-latin-${w}-normal.woff2 is missing`);
}

// ---- render check ---------------------------------------------------------------------------

function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Render one page in headless Chrome and report which Geist faces loaded and what a node paints in. */
async function renderCheck(chrome, file, { needsRuntime }) {
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), "dc-check-"));
  const proc = spawn(chrome, [
    "--headless=new", "--window-size=1500,1100", `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank",
  ], { stdio: "ignore" });
  const cleanup = () => { try { proc.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
  try {
    let target = null;
    for (let i = 0; i < 50 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
      } catch { /* not up yet */ }
      if (!target) await new Promise((r) => setTimeout(r, 300));
    }
    if (!target) throw new Error("Chrome did not expose a debugging target");
    const ws = new WebSocket(target);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("websocket failed")); });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    };
    const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "evaluate failed");
      return r.result.value;
    };
    await send("Page.enable");
    await send("Runtime.enable");
    await send("DOM.enable");
    await send("CSS.enable");
    await send("Page.navigate", { url: pathToFileURL(file).href });
    // The master renders through the dc runtime, which fetches React first; give it time and
    // then insist on cards, so an unrendered page reads as a failure rather than "no Geist".
    const deadline = Date.now() + 60_000;
    const enough = needsRuntime ? 200 : 1;
    let cards = 0;
    while (Date.now() < deadline) {
      cards = await evaluate("document.querySelectorAll('[data-screen-label]').length").catch(() => 0);
      if (cards >= enough) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    // A stalled or truncated runtime leaves a handful of cards; one of them painting in Geist
    // would prove nothing about the document, so a partial render fails here.
    if (cards < enough) throw new Error(`${file}: ${cards} card(s) rendered in 60s, expected at least ${enough}`);
    await evaluate("document.fonts.ready.then(() => true)");
    const faces = await evaluate(`[...document.fonts].filter(f => /^Geist/.test(f.family)).map(f => f.family + ' ' + f.weight + ' ' + f.status)`);
    const loaded = faces.filter((f) => f.endsWith(" loaded"));
    // What actually painted: the platform font behind a run of text inside a card. A node with
    // no text of its own reports no fonts, so the probe is the first element that carries some.
    await evaluate(`(() => {
      const cards = document.querySelectorAll('[data-screen-label]');
      for (const card of cards) for (const el of card.querySelectorAll('span, div, p, b, strong')) {
        const own = [...el.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim().length > 3);
        if (own && getComputedStyle(el).fontFamily.includes('Geist')) { el.setAttribute('data-dc-check-probe', ''); el.scrollIntoView(); return true; }
      }
      return false;
    })()`);
    // Platform fonts are read off the paint, so the probe scrolls into view and the page gets a
    // frame — sometimes several, on the master, before the runtime has painted that card.
    let fonts = [];
    for (let attempt = 0; attempt < 8 && fonts.length === 0; attempt++) {
      await evaluate("new Promise(r => requestAnimationFrame(() => setTimeout(r, 400)))");
      const { root } = await send("DOM.getDocument", { depth: 0 });
      const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "[data-dc-check-probe]" });
      if (nodeId) fonts = (await send("CSS.getPlatformFontsForNode", { nodeId })).fonts;
    }
    ws.close();
    return { cards, faces, loaded, platform: fonts.map((f) => `${f.familyName}${f.isCustomFont ? "" : " (system)"}`) };
  } finally {
    cleanup();
  }
}

if (process.argv.includes("--render")) {
  const chrome = chromePath();
  if (!chrome) {
    fail("--render needs Chrome; set CHROME=<path to chrome binary>");
  } else {
    const pages = [{ file: MASTER, needsRuntime: true }];
    if (existsSync(REVIEW)) pages.push({ file: REVIEW, needsRuntime: false });
    for (const page of pages) {
      try {
        const r = await renderCheck(chrome, page.file, page);
        const name = page.file.slice(here.length + 1);
        console.log(`${name}: ${r.cards} cards · Geist faces loaded ${r.loaded.length}/${r.faces.length} (${r.faces.join("; ")}) · paints in ${r.platform.join(", ") || "?"}`);
        if (r.loaded.length === 0) fail(`${name}: no Geist face loaded (${r.faces.slice(0, 4).join("; ") || "none declared"})`);
        if (!r.platform.some((p) => /^Geist/.test(p))) fail(`${name}: card text paints in ${r.platform.join(", ")}, not Geist`);
      } catch (error) {
        fail(String(error?.message ?? error));
      }
    }
  }
}

if (failures.length) {
  console.error(`design master: ${failures.length} problem(s)`);
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log(`design master: ${sections.length - 1} turns, legacy raw sizes ${legacyRaw}/${LEGACY_RAW_SIZES}, anchors resolve`);
