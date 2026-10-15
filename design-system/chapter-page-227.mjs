// Turn 227 · the chapter page, full width. Writes the review page and, unless --preview, places the
// turn in the design master and registers its frames with build-review.
//   node design-system/chapter-page-227.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './chapter-page-227.view.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const STYLE = '<link rel="stylesheet" href="chapter-page-227.css">';

const frames = FRAMES.map(([letter, title, width, height, kind, draw]) => ({ id: '227' + letter, title, width, height, kind, markup: draw() }));

write('chapter-page-227.review.html', `<!doctype html><html lang="en" class="dark" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chapter page · Turn 227</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLE}
<style>body{margin:0;background:#131313;color:#ededed;font-family:var(--font-sans)}html:not(.dark) body{background:#EFEEEB;color:#1a1a1a}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(255,255,255,.08);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #555;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 227 · the chapter page, full width</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t227" style="color:inherit">Design master</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${esc(f.title)}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote chapter-page-227.review.html: ${frames.length} frames.`); process.exit(0); }

export const rules = [
  ['Review status', '15 October 2026. Revision 1, drawn for review. Not approved; nothing is built. The drawings use Na love or Juju’s public design assets; the prose is written for the drawing.'],
  ['Full width', 'The chapter page fills the centre column like Dashboard, Chapters and Audiobook. Remove the 940 px cap on the head and body in the Manuscript view (chapter-responsive.css, --content-max-chapter). Width goes to the hero, the margins and Notes — never to the line: the prose keeps a fixed measure of 660 px (about 70 characters at --text-lg), 600 on a Fold, 700 at 2000 px and wider.'],
  ['One scroll', 'The page scrolls as one: hero, cast, view row, manuscript. No inner manuscript box at any width. The view row sticks under the titlebar; once the hero has scrolled away it becomes the compact bar: picture thumbnail, chapter number and title, the three views, the margin toggles, Notes and Listen (227c).'],
  ['Hero picture', 'The hero shows the chapter’s picture fading into the page from the left and the bottom (mask, not a scrim). Choose, in order: a picture the author set for the chapter; else the first picture in the chapter’s audiobook in reading order; else none, and the hero is type only (227h). Never a world image or a portrait standing in for a chapter picture. Setting the chapter picture is a new per-chapter field and a “Use as chapter picture” action on a passage picture.'],
  ['The book strip', 'The book strip replaces “CHAPTER 01 OF 18” and the side column’s “The book” card: one segment a chapter in order, its length the chapter’s words, the open chapter solid, planned chapters outlined. Pressing a segment opens that chapter; the arrows open the previous and next. The strip is 300 px at desktop, 420 at ultrawide and the content width on a phone.'],
  ['Hero contents', 'The hero holds, in order: the book strip, the title (--text-5xl; --text-4xl on a Fold; --text-3xl on a phone), the synopsis clamped to two lines, one meta line (point of view as a face chip that opens the picker, when, words, status), then the actions: Listen with the chapter’s duration when a read exists, else Read the chapter; Review; and ⋯ (Voiced read and the rest of Read’s menu). A chapter with no words offers Draft with Arke and ⋯ only, and shows no cast row (227h). Saved state, version and “overview moved” do not sit in the hero.'],
  ['The cast', 'The cast row replaces the Voices section: the narrator, then each speaker in order of first line, as a face (the character’s main photo, 44 × 54) ringed in its book speaker colour (--voice-1…6), first name and line count. A speaker without a photo shows initials on its colour. Paragraphs still to cast show once at the row’s end with Cast again; no other count or warning sits in the row.'],
  ['A face opens its voice', 'Pressing a face opens its voice card (227b), a popover anchored under the face on desktop and a sheet on a phone (227g): portrait, full name, lines in this chapter, the voice with a sample and Change, Direction (the sheet’s narration), This book only (the book override, which reveals its own field when on) and Open character. While the card is open, that speaker’s paragraphs are tinted in its colour. “Effective character direction” is not shown; it is a derived value, available from the field’s tooltip.'],
  ['People left, pictures right', 'In the Manuscript view the left margin carries the speaker of each spoken paragraph: a 26 px face in its colour, with the first name on the first paragraph of a run and a quiet 22 px face after it. Narration carries no mark. The right margin carries each passage picture beside its passage, 240 px wide (360 at ultrawide), spanning the following paragraphs rather than pushing them apart. Two toggles in the view row hide each margin; both default on and are remembered per book.'],
  ['Narrower widths', 'From 600 to 1099 the faces stay in a 44 px left margin without names and pictures sit inside the column after their passage at 16:9 (227e). Below 600 a spoken paragraph carries a 2 px rule in its speaker colour instead of a face; pictures sit inside the column (227f).'],
  ['Notes', 'Everything else from the side column lives in Notes: a 360 column on desktop that pushes the manuscript left rather than covering it, with the passage pictures moving inside the column while it is open (227c); docked as a 340 column at 2000 px and wider (227d), a sheet on a phone. In order: overview moved (only when true, as one row with Open), the book (a bar a chapter, total words), After this chapter with Derive again, Draws on, Versions. A dot on the Notes button says overview moved.'],
  ['Ultrawide', 'At 2000 px and wider the hero is 420 tall, the gutter 64, the measure 700, margin pictures 360 and Notes docked (227d). Arke’s dock keeps its 331 column. Nothing else changes; the page does not add columns of its own.'],
  ['Foot', 'The foot keeps Saved · v<version> and the Markdown source toggle. Words move to the hero’s meta line.'],
  ['Other views', 'Audiobook and Audio Studio keep their approved designs (turns 194–209, 226). They share the hero and cast; Audio Studio opens with the compact bar, since it needs the height.'],
  ['Phone', 'On a phone the chapter picture is a full-bleed 300 px header with back and ⋯ over it; the title block overlaps its fade. The cast is a row of 52 px round faces. Listen (or Read the chapter) and Notes are held at the foot (turn 173).'],
];

const turn = `<section class="dv-turn" id="t227"><div class="dv-thd"><a class="dv-tid" href="#t227">227</a><span class="dv-tname">The chapter page · full width, its people and pictures in the margins</span></div><p class="dv-next">15 October 2026 · Revision 1 · For review · ${frames.length} HTML drawings. <a href="chapter-page-227.review.html">Review page</a> · <a href="chapter-page-227.notes.md">Notes</a></p><div class="dv-opts">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${esc(f.title)}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}</section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t227">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + master.slice(next);
}
const first = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0);
if (!first || Number(first[1]) >= 227 && start < 0) throw new Error(`Top turn is t${first?.[1]}; renumber before inserting`);
master = master.slice(0, first.index) + turn + master.slice(first.index);
if (!master.includes(STYLE)) master = master.replace('<helmet>', '<helmet>\n' + STYLE);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN CHAPTER PAGE 227[\s\S]*?  \/\/ END CHAPTER PAGE 227(?:\r?\n)*/g, '\n');
const entries = frames.map(f => `  { group: "Chapter page · turn 227 · revision 1", screen: ${JSON.stringify(f.title)}, frame: "${f.id}", route: "Story / Chapters / chapter", status: "drawn", checked: "2026-10-15", controls: [], notes: ["For review; not built."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN CHAPTER PAGE 227\n' + entries.join('\n') + '\n  // END CHAPTER PAGE 227\n');
const pageEntry = '{ file: "chapter-page-227.review.html", what: "Turn 227 revision 1: the chapter page at full width, hero picture, book strip, cast faces and voice card, speakers and pictures in the margins, Notes, Fold and phone.", state: "for review" }';
if (build.includes('file: "chapter-page-227.review.html"')) build = build.replace(/\{ file: "chapter-page-227\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(STYLE)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', STYLE + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 227: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
