// Turn 277 · Text in the Cut (issue 2990). Writes the review page and, unless --preview, places the
// turn in the design master and registers its frames with build-review.
//   node design-system/cut-text-277.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './cut-text-277.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
// The turn draws inside turn 220's Cut shell, so its review page carries that shell's styles, then its own.
const STYLES = ['air-particles-220.css', 'air-particles-220.native.css'].map(n => `<link rel="stylesheet" href="${n}">`).join('');
const STYLE = '<link rel="stylesheet" href="cut-text-277.css">';
const frames = FRAMES.map(([letter, title, width, height, kind, draw]) => ({ id: '277' + letter, title, width, height, kind, markup: draw() }));
for (const f of frames) if (!f.markup.startsWith('<div class="air220 native220 tx277 ')) throw new Error(`${f.id}: frame root is not .tx277`);
// Every frame sits in one master document, so an id a frame's picture defines must be its own.
const ids = frames.flatMap(f => [...f.markup.matchAll(/ id="([^"]+)"/g)].map(m => m[1]));
const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
if (twice.length) throw new Error(`ids drawn twice: ${[...new Set(twice)].join(', ')}`);

write('cut-text-277.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Text in the Cut · Turn 277</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLES}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv>header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv>header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 277 · drawn for approval · Text in the Cut</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t277" style="color:inherit">Design master</a><a href="cut-text-277.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${esc(f.title)}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote cut-text-277.review.html: ${frames.length} frames.`); process.exit(0); }

const { rules, next } = await import('./cut-text-277.rules.mjs');

const turn = `<section class="dv-turn" id="t277"><div class="dv-thd"><a class="dv-tid" href="#t277">277</a><span class="dv-tname">Text in the Cut &#183; a title typed on the timeline: Add, the clip on its track, the Inspector&#8217;s rows and the typeface menu, on desktop and phone (issue 2990)</span></div><p class="dv-next">12 November 2026 · Drawn for the owner’s approval, issue 2990 · ${frames.length} HTML drawings. <a href="cut-text-277.review.html">Review page</a> · <a href="cut-text-277.notes.md">Notes</a></p><div class="dv-opts">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${esc(f.title)}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: ${esc(next)}</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t277">');
if (start >= 0) {
  const after = master.indexOf('<section class="dv-turn"', start + 1);
  if (after < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(after);
} else {
  // Newest first: place above the first turn numbered below 277, never above a newer one.
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 277);
  if (!below) throw new Error('No turn below 277 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
if (!master.includes(STYLE)) master = master.replace('<helmet>', '<helmet>\n' + STYLE);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN CUT TEXT 277[\s\S]*?  \/\/ END CUT TEXT 277(?:\r?\n)*/g, '\n');
const entries = frames.map(f => `  { group: "Cut · turn 277", screen: ${JSON.stringify(f.title)}, frame: "${f.id}", route: "Production / Cut", status: "drawn", checked: "2026-11-12", controls: [], notes: ["Drawn 12 November 2026 for issue 2990. Awaiting the owner. Not built."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN CUT TEXT 277\n' + entries.join('\n') + '\n  // END CUT TEXT 277\n');
const pageEntry = '{ file: "cut-text-277.review.html", what: "Turn 277: text clips in the Cut. One press adds a title at the playhead; the Inspector holds its words and its look; the clip shows its first line on its track; the typeface menu draws each name in its own face. Desktop and phone.", state: "proposed; owner design review pending (issue 2990)" }';
if (build.includes('file: "cut-text-277.review.html"')) build = build.replace(/\{ file: "cut-text-277\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(STYLE)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', STYLE + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 277: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
