// Turn 235 · Picture shapes. Writes the review page and, unless --preview, places the turn in the
// design master and registers its frames with build-review.
//   node design-system/picture-shapes-235.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './picture-shapes-235.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const STYLE = '<link rel="stylesheet" href="picture-shapes-235.css">';
// Titles are authored with entities, so they are placed as written rather than escaped again.
const frames = FRAMES.map(([letter, title, width, height, draw]) => ({ id: '235' + letter, title, width, height, markup: draw() }));
for (const f of frames) if (!f.markup.startsWith('<div class="ap235"')) throw new Error(`${f.id}: frame root is not .ap235`);

write('picture-shapes-235.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Picture shapes · Turn 235</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 235 · approved · Picture shapes</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t235" style="color:inherit">Design master</a><a href="picture-shapes-235.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${f.title}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote picture-shapes-235.review.html: ${frames.length} frames.`); process.exit(0); }

export const rules = [
  ['Review status', '23 October 2026. Approved as drawn by the owner the same day, with the three calls in the notes: the shapes named Wide and Tall, Wide alone the default; Size Full, 1280 px or 960 px, Full the default; a Tall from an earlier Wide marked, not removed. Nothing is built. Asked by the owner: let a production choose the shapes its pictures are made in, more than one, so a phone gets a picture made for it and a tablet or desktop keeps the wide one, with a smaller picture size at export to save space (audio quality left for later). The Player’s half is P14 in the Player master (ArkePlayer PR #7): a phone in portrait shows the Tall picture over the whole screen.'],
  ['Shapes are the production’s', 'The audiobook page’s More menu gains Pictures, its data the shapes on (Wide · Tall), opening the Pictures sheet (235a). Two shapes: Wide, 16:9, for desktop and tablet; Tall, 9:16, for a phone. At least one is on, and Wide alone is the default, as every production is today. The sheet counts what is made in each (290 made, 0 made) and names the model and its price. Turning a shape on or off makes and removes nothing.'],
  ['One picture in two shapes', 'The first shape on is made from the prompt; each other shape is made from it, the made picture riding as the reference with the instruction to recompose the same moment. A reader on a phone and one on a tablet see the same faces, room and light. Verified 23 October 2026 on the ChatGPT route (Codex Image): The Undersong’s block p004, 1672 × 941, recomposed as 941 × 1672 kept Maren, the ledger, the lamp and the window; that pair is this turn’s sample.'],
  ['The Tall picture keeps its lower third quiet', 'A phone draws its transport over the lowest third of a Tall picture (P14), and a full-height picture can only be trimmed at its sides, so the focus cannot lift a subject out from under the controls. The Tall instruction therefore asks for the subject in the upper two-thirds and nothing that matters in the lowest third. P14’s sample, made before this rule, puts the open ledger under the scrub bar; the rule is what a Tall made under it fixes.'],
  ['The card shows each shape', 'A block’s picture card (194g, 209) draws its picture once per shape on, Wide 182 × 102 beside Tall 58 × 102, one height so the two read as one picture, each with its name under it and each the press that picks another for that shape (235b). A shape not made is its dashed slot with its ratio (235c). The foot’s press says what it makes: Generate, every shape; Make tall, the one missing; Make again, every shape again, Tall from the new Wide. Each is priced for what it makes; on the ChatGPT plan the press says ChatGPT plan, and the Model fact keeps the whole label, which at 520 wide would push the press past the panel.'],
  ['A Tall from an earlier Wide', 'Picking another Wide, or making the Wide again alone, leaves the Tall made from the old one: the card marks it from an earlier picture with Make tall, and it still plays until it is remade, never silently swapped for a crop.'],
  ['Make the missing shape for the book', 'Make 290 tall (235a) makes the missing shape for every picture without it, each from its current Wide, as one Activity row with its count and Cancel, as Illustrate is. Nothing already made is redone, and stopping keeps what was made.'],
  ['A model that cannot make a shape', 'A model is offered for a shape only if its row says it makes it. One that does not is refused on the card in one clause, `Flux 2 Pro makes no 9:16`, never quietly given another shape. The ChatGPT route takes the shape in its prompt. Fixed with this turn: the direct GPT Image 2 row offers only 1:1, 3:2 and 2:3 (#223) and turns 16:9 into 3:2; fal’s GPT Image 2 sends 9:16 at 720 × 1280 and 2:3 at 854 × 1280, which is not a multiple of 16 as GPT Image 2’s sizes must be.'],
  ['Where each shape goes', 'Arke Player’s package carries every shape made, and the Player shows the one nearest its screen (P14). The vertical video (197) uses a picture’s Tall when it has one, in place of its crop about the focus; the web player and the wide video use Wide.'],
  ['Export picks the picture size', 'Arke Player’s Pictures row counts each shape (290 wide · 290 tall), and a Size row picks the long side every picture ships at: Full, today’s fit to at most 2048, the default; 1280 px; or 960 px (235d). Each choice re-estimates the package, and a picture smaller than the size ships as made, never enlarged. For The Ledger of Nights in both shapes: Full ~505 MB, 1280 ~432 MB, 960 ~387 MB, of which the narration is 325 MB at every size.'],
  ['Sizes and copy', 'The Pictures sheet is 640 wide, the Export sheet 720 (233). Labels only: Pictures, Wide, Tall, Model, Make 290 tall, Make tall, Make again, Generate, Size, Full, 1280 px, 960 px, Done; 16:9 and 9:16, desktop · tablet and phone, counts, sizes and prices as data.'],
  ['Implementation boundary', 'Spec: SPEC-047 (a production’s shapes; a picture made per shape, the second from the first) and SPEC-058 (the listening document names each shape’s picture, with a new key the Player that reads it must ship before any package that carries it). Reused: Illustrate’s run and its Activity row, the card, the reference path that already carries looks, and the export’s picture fitting at a chosen edge. New: the shapes setting, the Tall recomposition instruction, the card’s second slot, the Size row, and the model rows above.'],
];

const turn = `<section class="dv-turn" id="t235"><div class="dv-thd"><a class="dv-tid" href="#t235">235</a><span class="dv-tname">Picture shapes &#183; a picture made Wide and Tall, so a phone has its own, and a smaller picture size at export (extends <a class="dv-oid" href="#t233">233</a>, <a class="dv-oid" href="#t194">194</a>; Player P14)</span></div><p class="dv-next">23 October 2026 · Approved · ${frames.length} HTML drawings. <a href="picture-shapes-235.review.html">Review page</a> · <a href="picture-shapes-235.notes.md">Notes</a></p><div class="dv-opts">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${f.title}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: “shapes chosen per chapter” · “a square for the cover” · “a package per device”</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t235">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(next);
} else {
  // Newest first: place above the first turn numbered below 235, never above a newer one.
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 235);
  if (!below) throw new Error('No turn below 235 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
if (!master.includes(STYLE)) master = master.replace('<helmet>', '<helmet>\n' + STYLE);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN PICTURE SHAPES 235[\s\S]*?  \/\/ END PICTURE SHAPES 235(?:\r?\n)*/g, '\n');
const plain = title => title.replaceAll('&#8217;', '’').replaceAll('&#8594;', '→').replaceAll('&#183;', '·');
const entries = frames.map(f => `  { group: "Picture shapes · turn 235", screen: ${JSON.stringify(plain(f.title))}, frame: "${f.id}", route: "Story / Audiobook", status: "drawn", checked: "2026-10-23", controls: [], notes: ["Approved 23 October 2026 with calls 1–3. Player half: P14 (ArkePlayer PR #7)."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN PICTURE SHAPES 235\n' + entries.join('\n') + '\n  // END PICTURE SHAPES 235\n');
const pageEntry = '{ file: "picture-shapes-235.review.html", what: "Turn 235: Picture shapes — the Pictures sheet (Wide and Tall), a block’s picture in both shapes, Tall not made yet, and Export → Arke Player with both shapes and the picture size.", state: "approved 23 October 2026; not built" }';
if (build.includes('file: "picture-shapes-235.review.html"')) build = build.replace(/\{ file: "picture-shapes-235\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(STYLE)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', STYLE + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 235: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
