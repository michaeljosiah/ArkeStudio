// Turn 248 · A graphic novel's comic style (SPEC-064). Writes the review page and, unless --preview,
// places the turn in the design master and registers its frames with build-review.
//   node design-system/comic-style-248.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './comic-style-248.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const STYLE = '<link rel="stylesheet" href="graphic-novel-247.css"><link rel="stylesheet" href="comic-style-248.css">';
const STATUS = 'approved';
const frames = FRAMES.map(([letter, title, width, height, draw]) => ({ id: '248' + letter, title, width, height, markup: draw() }));
for (const f of frames) if (!f.markup.startsWith('<div class="gn247 gn248"')) throw new Error(`${f.id}: frame root is not .gn248`);

write('comic-style-248.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Comic style · Turn 248</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 248 · ${STATUS} · A graphic novel&#8217;s comic style</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t248" style="color:inherit">Design master</a><a href="comic-style-248.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${f.title}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote comic-style-248.review.html: ${frames.length} frames.`); process.exit(0); }

export const rules = [
  ['Review status', '29 October 2026. Approved by the owner the same day (“approved”), calls 1 – 5 as drawn. Asked by the owner: “In the UI do we allow users to select a comic style and does the UI show the comic style image for selection to make it easy for users to identify? If not you are permitted to use the bench and CHATGPT Image generation to create the comic style images.” Nothing here is built. Today a graphic novel’s pages take the world’s art direction and nothing else.'],
  ['A style is picked by its page', 'Style is ten cards and Your own (248a). Every card is the same page — Low Water’s page 3, Maren on the flooded pier, “Where are you?”, the empty water and “Hsssh” — drawn in that style, so the cards differ only in how a page is drawn. The pictures are made once by ChatGPT Image and ship with the app; nothing is generated when the cards are shown.'],
  ['World look first', 'World look is the first card and the default: the world’s art direction, as pages are made today, shown by the world’s key art. A book that never picks a style is made exactly as it is now.'],
  ['The words are the record', 'Picking a card seeds the words under the cards, as the art-direction picker does (turn 38): SEEDED BY MANGA, then EDITED once changed. Only the words are kept. They ride every page’s brief as its style, after the world’s art direction, and every person’s picture still rides for likeness. Your own empties the words.'],
  ['Picked when the book is made, changed in Pages', 'Style sits under Name and Adapt from when a graphic novel is made (248a), and beside Reading in Pages, showing the style’s page and its name (248b). It opens the same cards and words in a sheet.'],
  ['A change is for the pages made next', 'Use style changes what is made from then on (248b). Pages already made, and their accepted takes, keep the style they were made in; the sheet counts them. Make again on such a page makes it in the new style.'],
  ['Calls for the owner', '1 · Ten styles and Your own, with World look first and the default. 2 · Each card is the same sample page drawn in its style, made once and shipped. 3 · The words are the record; the card only seeds them. 4 · Style is picked when the book is made and changed in Pages. 5 · A change applies to pages made next; made pages are not remade.'],
  ['Sizes and copy', 'Six cards a row at 2:3, 880 wide in the door; the words box below them. Labels only: Style, World look, Manga, Superhero, Clean line, Noir, Webtoon, Painted, Watercolour, Ink and wash, Vintage print, Your own, Words for this style, Use style, Cancel. The card lines (Black and white, screentone …) and counts are data.'],
  ['Implementation boundary', 'Spec: SPEC-064 R-16 (the page brief), R-3 (the book’s settings). New with approval: a `style` in the book’s settings (its words and the card that seeded them), its place in the page brief, the picker in Tell a story and in Pages, and the ten pictures in the app. Reused: the art-direction picker’s seed-then-edit rule (turn 38) and 247’s Pages and door.'],
];

const turn = `<section class="dv-turn" id="t248"><div class="dv-thd"><a class="dv-tid" href="#t248">248</a><span class="dv-tname">A graphic novel&#8217;s comic style &#183; picked by its page, ten ways and your own (SPEC-064; extends <a class="dv-oid" href="#t247">247</a>, <a class="dv-oid" href="#t38">38</a>)</span></div><p class="dv-next">29 October 2026 · Approved 29 October · ${frames.length} HTML drawings. <a href="comic-style-248.review.html">Review page</a> · <a href="comic-style-248.notes.md">Notes</a></p><div class="dv-opts">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${f.title}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: “a style per chapter” · “style on a phone”</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t248">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(next);
} else {
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 248);
  if (!below) throw new Error('No turn below 248 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
const LINK = '<link rel="stylesheet" href="comic-style-248.css">';
if (!master.includes(LINK)) master = master.replace('<helmet>', '<helmet>\n' + LINK);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN COMIC STYLE 248[\s\S]*?  \/\/ END COMIC STYLE 248(?:\r?\n)*/g, '\n');
const plain = title => title.replaceAll('&#8217;', '’').replaceAll('&#183;', '·');
const entries = frames.map(f => `  { group: "Comic style · turn 248", screen: ${JSON.stringify(plain(f.title))}, frame: "${f.id}", route: "Graphic novel / Pages", status: "drawn", checked: "2026-10-29", controls: [], notes: ["Approved 29 October 2026."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN COMIC STYLE 248\n' + entries.join('\n') + '\n  // END COMIC STYLE 248\n');
const pageEntry = '{ file: "comic-style-248.review.html", what: "Turn 248: a graphic novel’s comic style — ten styles and your own, each shown as the same page drawn in it, picked in Tell a story and changed in Pages.", state: "approved 29 October 2026; not built" }';
if (build.includes('file: "comic-style-248.review.html"')) build = build.replace(/\{ file: "comic-style-248\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(LINK)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', LINK + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 248: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
