// Turn 285 · the Plan (issue 2302; extends 229 and 231). Writes the review page and, unless
// --preview, places the turn in the design master and registers its frames with build-review.
//   node design-system/location-plan-285.renders.mjs   (only after a change to the sample or the kit: the pictures)
//   node design-system/location-plan-285.capture.mjs   (only after a change to the app's screens: the context)
//   node design-system/location-plan-285.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { receipt } from './location-plan-285.app.mjs';
import { FRAMES, esc } from './location-plan-285.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
// The app's own rules for the screens the turn stands in, then the turn's additions over them.
const APP = '<link rel="stylesheet" href="location-plan-285.app.css">';
const STYLE = '<link rel="stylesheet" href="location-plan-285.css">';
// The root carries data-screen-label: build-review and the shooting drivers find a frame by it.
const frames = FRAMES.map(([letter, title, width, height, markup]) => ({ id: '285' + letter, title, width, height, markup: markup.replace(/^<div class="app285/, `<div data-screen-label="285${letter} ${esc(title)}" class="app285`) }));
for (const f of frames) if (!f.markup.startsWith('<div data-screen-label=')) throw new Error(`${f.id}: frame root is not the app's`);
// Every frame sits in one master document, so an id a frame defines must be its own; the captured
// markup carries none.
for (const f of frames) if (/ id="/.test(f.markup)) throw new Error(`${f.id}: an id in a frame`);
// From turn 139 a frame sets type through the tokens only.
for (const f of frames) { const raw = f.markup.match(/\bfont(?:-size)?\s*:\s*(?:[0-9]{3}\s+)?[0-9]+(?:\.[0-9]+)?px/); if (raw) throw new Error(`${f.id}: a raw font size, ${raw[0]}`); }
// Balance, so no frame can close a tag of the master's.
for (const f of frames) for (const tag of ['div', 'section', 'span', 'button', 'aside', 'main', 'article', 'header', 'nav']) {
  const open = (f.markup.match(new RegExp(`<${tag}\\b`, 'g')) ?? []).length, close = (f.markup.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
  if (open !== close) throw new Error(`${f.id}: ${open} <${tag}> and ${close} </${tag}>`);
}

write('location-plan-285.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Plan · Turn 285</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${APP}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv>header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv>header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 285 · drawn for approval · the Plan</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t285" style="color:inherit">Design master</a><a href="location-plan-285.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${esc(f.title)}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote location-plan-285.review.html: ${frames.length} frames.`); process.exit(0); }

const { rules: rulesAt, next } = await import('./location-plan-285.rules.mjs');
const rules = rulesAt(receipt.commit);

const turn = `<section class="dv-turn" id="t285"><div class="dv-thd"><a class="dv-tid" href="#t285">285</a><span class="dv-tname">The Plan &#183; a place&#8217;s set and camera positions, seen from above, shared by its scenes (extends <a class="dv-oid" href="#t229">229</a> and <a class="dv-oid" href="#t231">231</a>; issue 2302)</span></div><p class="dv-next">20 November 2026 · Drawn for the owner’s approval · issue 2302 · ${frames.length} frames: the app’s own screens, with the Plan drawn into them. <a href="location-plan-285.review.html">Review page</a> · <a href="location-plan-285.notes.md">Notes</a></p><div class="dv-opts" style="margin-top:22px">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${esc(f.title)}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: ${esc(next)}</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t285">');
if (start >= 0) {
  const after = master.indexOf('<section class="dv-turn"', start + 1);
  if (after < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(after);
} else {
  // Newest first: place above the first turn numbered below 285, never above a newer one.
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 285);
  if (!below) throw new Error('No turn below 285 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
// The app's rules before the turn's own: the turn's override them at equal weight.
for (const link of [STYLE, APP]) if (!master.includes(link)) master = master.replace('<helmet>', '<helmet>\n' + link);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN LOCATION PLAN 285[\s\S]*?  \/\/ END LOCATION PLAN 285(?:\r?\n)*/g, '\n');
const route = { a: 'Scene / Plan', b: 'Scene / Plan / a position', c: 'Scene / Plan', d: 'World / Locations / a location / Plan', e: 'Scene / shot / Stage', f: 'Scene / Plan (phone)' };
const entries = frames.map(f => `  { group: "The Plan · turn 285", screen: ${JSON.stringify(f.title)}, frame: "${f.id}", route: "${route[f.id.slice(3)]}", status: "drawn", checked: "2026-11-20", controls: [], notes: ["Drawn 20 November 2026 for issue 2302. Awaiting the owner. Not built."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN LOCATION PLAN 285\n' + entries.join('\n') + '\n  // END LOCATION PLAN 285\n');
const pageEntry = '{ file: "location-plan-285.review.html", what: "Turn 285: the Plan. A place owns its set, its numbered camera positions and each position’s picture; a scene set there sees them from above with its cast on their marks, and each pair’s cameras held to one side of the line between them, a crossing flagged and never refused. On the scene page, on a location’s sheet, on the Stage’s Start from, and on a phone.", state: "proposed; owner design review pending (issue 2302)" }';
if (build.includes('file: "location-plan-285.review.html"')) build = build.replace(/\{ file: "location-plan-285\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
for (const link of [APP, STYLE]) if (!build.includes(link)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', link + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 285: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
