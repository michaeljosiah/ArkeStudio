// Turn 278 · Clean up (SPEC-066, issue 3044). Writes the review page and, unless --preview, places
// the turn in the design master and registers its frames with build-review.
//   node design-system/world-cleanup-278.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES, esc } from './world-cleanup-278.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
// The turn draws over turn 239's page and inside its Studio assistant, so its review page carries
// 239's styles; the storage reply is the shipped studio-assistant.css; then the turn's own.
const SHELL = ['global-chat-224.css', 'chapter-page-227.css', '../packages/client/src/components/model-chip.css', 'global-chat-239.reference.css', 'global-chat-239.css'];
const SHIPPED = '<link rel="stylesheet" href="../packages/client/src/components/studio-assistant.css">';
const STYLE = '<link rel="stylesheet" href="world-cleanup-278.css">';
const frames = FRAMES.map(([letter, title, width, height, kind, draw]) => ({ id: '278' + letter, title, width, height, kind, markup: draw() }));
for (const f of frames) if (!f.markup.startsWith('<div class="g239-scene ch227 cu278')) throw new Error(`${f.id}: frame root is not .cu278`);
// Every frame sits in one master document, so an id a frame's picture defines must be its own.
const ids = frames.flatMap(f => [...f.markup.matchAll(/ id="([^"]+)"/g)].map(m => m[1]));
const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
if (twice.length) throw new Error(`ids drawn twice: ${[...new Set(twice)].join(', ')}`);
// From turn 139 a frame sets type through the tokens only.
for (const f of frames) if (/\bfont(?:-size)?\s*:\s*(?:[0-9]{3}\s+)?[0-9]+(?:\.[0-9]+)?px/.test(f.markup)) throw new Error(`${f.id}: a raw font size`);

write('world-cleanup-278.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clean up · Turn 278</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${SHELL.map(n => `<link rel="stylesheet" href="${n}">`).join('')}${SHIPPED}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv>header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv>header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 278 · drawn for approval · Clean up</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t278" style="color:inherit">Design master</a><a href="world-cleanup-278.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${esc(f.title)}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote world-cleanup-278.review.html: ${frames.length} frames.`); process.exit(0); }

const { rules, next } = await import('./world-cleanup-278.rules.mjs');

const turn = `<section class="dv-turn" id="t278"><div class="dv-thd"><a class="dv-tid" href="#t278">278</a><span class="dv-tname">Clean up &#183; a reviewed plan that frees a world&#8217;s disk: the way in from Studio Storage, the plan, its classes and problems, the confirm, the run, the result, held plans, the refusals, and a paired phone (SPEC-066, issue 3044)</span></div><p class="dv-next">13 November 2026 · Drawn for the owner’s approval, SPEC-066 §2.7 · ${frames.length} HTML drawings. <a href="world-cleanup-278.review.html">Review page</a> · <a href="world-cleanup-278.notes.md">Notes</a></p><div class="dv-opts">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${esc(f.title)}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: ${esc(next)}</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t278">');
if (start >= 0) {
  const after = master.indexOf('<section class="dv-turn"', start + 1);
  if (after < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(after);
} else {
  // Newest first: place above the first turn numbered below 278, never above a newer one.
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 278);
  if (!below) throw new Error('No turn below 278 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
for (const link of [SHIPPED, STYLE]) if (!master.includes(link)) master = master.replace('<helmet>', '<helmet>\n' + link);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN WORLD CLEANUP 278[\s\S]*?  \/\/ END WORLD CLEANUP 278(?:\r?\n)*/g, '\n');
const route = f => f.id === '278a' ? 'App chrome / Studio assistant / Storage' : 'App chrome / Studio assistant / Storage / Clean up';
const entries = frames.map(f => `  { group: "Clean up · turn 278", screen: ${JSON.stringify(f.title)}, frame: "${f.id}", route: "${route(f)}", status: "drawn", checked: "2026-11-13", controls: [], notes: ["Drawn 13 November 2026 for SPEC-066 (issue 3044). Awaiting the owner. Not built."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN WORLD CLEANUP 278\n' + entries.join('\n') + '\n  // END WORLD CLEANUP 278\n');
const pageEntry = '{ file: "world-cleanup-278.review.html", what: "Turn 278: Clean up. Studio Storage gains Held and Clean up world; the sheet shows a plan of eight classes with their sizes now and after hold, problems apart with Put back on shelf, the confirm, the run with Stop, the result measured on the drive, held plans with Restore and Empty now, the refusals, and a paired phone that shows and does not run.", state: "proposed; owner design review pending (SPEC-066, issue 3044)" }';
if (build.includes('file: "world-cleanup-278.review.html"')) build = build.replace(/\{ file: "world-cleanup-278\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
for (const link of [SHIPPED, STYLE]) if (!build.includes(link)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', link + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 278: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
