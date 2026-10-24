// Turn 237 · Picture marks. Writes the review page and, unless --preview, places the turn in the
// design master and registers its frames with build-review.
//   node design-system/picture-marks-237.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './picture-marks-237.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const STYLE = '<link rel="stylesheet" href="picture-marks-237.css">';
// Titles are authored with entities, so they are placed as written rather than escaped again.
const frames = FRAMES.map(([letter, title, width, height, draw]) => ({ id: '237' + letter, title, width, height, markup: draw() }));
for (const f of frames) if (!f.markup.startsWith('<div class="ap237"')) throw new Error(`${f.id}: frame root is not .ap237`);

write('picture-marks-237.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Picture marks · Turn 237</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 237 · drawn · Picture marks</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t237" style="color:inherit">Design master</a><a href="picture-marks-237.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${f.title}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote picture-marks-237.review.html: ${frames.length} frames.`); process.exit(0); }

export const rules = [
  ['Review status', '24 October 2026. Drawn for the owner’s review; nothing is built. Asked by the owner after a listener asked for many more pictures: grouping blocks into beats made the narration smooth, but a picture can only start where a block does, so a beat of two minutes shows one picture throughout and it stops matching the words. Of a second set of picture blocks, more pictures per block, or pictures set on the words, the owner chose the words. Revised the same day at the owner’s word: Illustrate decides from the story how many pictures a chapter needs, under a cap, rather than spacing them to a pace, and the Pace setting first drawn here is gone; then a picture holds until the next one, with no shortest hold, and Wide and Tall are spelled out.'],
  ['A picture is set on the words', 'A picture is set at a mark: the first word of a sentence, kept by its block and that sentence’s words, as a picture already follows its block’s words when a paragraph moves (R-69). It shows from that word until the next mark. Blocks and beats decide only how the narration is read: joining, splitting, grouping and reading again never move, remove or ask about a picture, and 198d’s question that a picture comes off is retired.'],
  ['Where a mark can go', 'At the start of any sentence of any block, never inside a sentence. Hovering a sentence’s start offers + Picture there (237b), drawn as 198’s seams draw Join and Split; on touch the block’s sheet carries it. A mark’s words run from its sentence to the next mark, and they are the moment its brief starts from.'],
  ['Drawn on the words', 'A mark is a short bar before its first word, solid once its picture is made and dotted while proposed (237a). Its chip, the picture and its start, sits at the end of the row the mark is in rather than on the block’s first row; a proposed mark keeps 191b’s dashed chip and short title. A beat’s head counts its pictures.'],
  ['When a picture starts', 'A mark starts at its block’s start plus the moment its first word is spoken in the take, from the take’s word timing (whisper’s word bounds, which the read-along and the word captions already use). Word timing is made on this machine, with no press, for every made take that holds a mark; until it is, the start is the share of the block’s words before the mark at the take’s length, and is shown with ~. A new take keeps its marks and times them again.'],
  ['The panel names the mark', 'Pressing a chip or a mark opens the Picture tab for that mark (237c): Picture at 1:48, its beat, how long it holds and to when; 235’s card with Wide and Tall; Words, the mark’s words; who is in them; Generate. Remove takes the mark off and the picture stays in the world. A mark is moved by dragging it along the words to another sentence’s start, keeping its picture, shapes, look and shot.'],
  ['Illustrate reads the story', 'Illustrate proposes a picture wherever what we would see changes (237d): a new place, someone arriving or leaving, an action, an object that matters, a jump in time, a change of feeling. It looks inside beats as well as at their starts, at the start of a sentence, and never moves a picture already there. Fewer is better than a weak one: a conversation that holds still in one place may get none, so the pictures bunch where the scene moves (Chapter 1 has none between 7:22 and 10:24, the talk at her table). This replaces 191b’s one every minute and a half; there is no pace and no setting.'],
  ['Each card says why', 'A card names its reason in one word, place, arrives, leaves, action, object, time or feeling, before the beat it falls in, so a proposal is judged at a glance. The headline says where the story changes in place of a pace: 12 pictures · where the story changes · 12 to make, Wide and Tall · 15 already there.'],
  ['The cap', 'At most one picture per 20 s of a chapter’s narration, counting those already there: 61 for Chapter 1’s 20:28. It is a ceiling, never an aim, and the request says so.'],
  ['A picture holds until the next', 'A picture stays until the next mark, however soon that comes; there is no shortest hold for the author, and 186’s 20 s hold and its amber flag are retired. The panel says how long it holds (holds 17 s). Illustrate alone keeps its own proposals at least 5 s apart, so a picture it proposes is seen for more than its 1 s crossfade.'],
  ['Wide and Tall', 'A mark’s picture is made in every shape the production has on (235): Generate, and Illustrate’s Accept, make the Wide, then the Tall from it, and the count and price say both (12 to make, Wide and Tall). The chip and the cards show the Wide; Arke Player shows the Tall on a phone held upright and the Wide elsewhere, from the same start, and the vertical video uses the Tall. A picture moved to another sentence keeps both shapes.'],
  ['Nothing moves by itself', 'Each picture standing today becomes a mark at its block’s first word, so every chapter looks and plays as it does now until a mark is added or moved. In 237a the goat face has been moved by the author from 0:03 to 0:37, where Tunde pulls it.'],
  ['Where it plays', 'Arke Player’s package already places each picture by time (SPEC-058’s at), so a picture inside a take needs no new key and no Player change: a phone on P14 reads the next edition as it is. The Studio’s Listen and the wide and vertical videos (197) use the same starts.'],
  ['What it costs', 'More pictures are more to make and a larger package, each with its Tall where Tall is on, and how many now differs by chapter. The author’s say is the proposal itself: its count and price stand before anything is made, Skip drops a card, and Accept is confirmed once at the price of what is left. Chapter 1 is drawn with 12 new beside its 15, under a cap of 61.'],
  ['Sizes and copy', 'The block list keeps its 120 px margin, 780 px measure and row ends; the panel is 520 wide (235’s card). Labels only: + Picture, Picture at 1:48, holds 17 s, to 2:05, Words, Remove, Generate, place, arrives, leaves, action, object, time, feeling, in The goat story, where the story changes, 12 to make, Wide and Tall, 3 pictures, 15 already there.'],
  ['Implementation boundary', 'Spec: SPEC-047 R-66 and R-69 (a picture set at a mark, not on a block), R-101 and R-102 (Illustrate chooses its moments from the story under a cap of one per 20 s, each with its reason, in place of PICTURE_PACE_SEC), 186’s hold and flag (retired; PICTURE_PROPOSAL_GAP_SEC becomes 5 s) and 198d’s question. The chapter record keys its pictures by mark (block, sentence, the sentence’s words’ hash), with a world schema raise; placement and spans move from blocks to marks; Illustrate’s request lists sentences rather than blocks and each row it returns carries its reason. Reused: word timing (prepareAudiobookWordTiming), the picture card and Make tall, Illustrate’s sheet, run and thinning, the package’s picture times. No change to the Pictures sheet, SPEC-058 or Arke Player.'],
];

const turn = `<section class="dv-turn" id="t237"><div class="dv-thd"><a class="dv-tid" href="#t237">237</a><span class="dv-tname">Picture marks &#183; a picture set on the words it shows rather than on a block, so a beat read in one take can change picture as it goes, and Illustrate choosing as many as the story needs, under a cap (amends <a class="dv-oid" href="#t191">191</a>, <a class="dv-oid" href="#t198">198</a>, <a class="dv-oid" href="#t186">186</a>; extends <a class="dv-oid" href="#t235">235</a>)</span></div><p class="dv-next">24 October 2026 · Drawn, for review · ${frames.length} HTML drawings. <a href="picture-marks-237.review.html">Review page</a> · <a href="picture-marks-237.notes.md">Notes</a></p><div class="dv-opts">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${f.title}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: “Arke proposes moving a picture to the words it shows” · “a lower cap for a book” · “marks in the Manuscript”</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t237">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(next);
} else {
  // Newest first: place above the first turn numbered below 237, never above a newer one.
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 237);
  if (!below) throw new Error('No turn below 237 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
if (!master.includes(STYLE)) master = master.replace('<helmet>', '<helmet>\n' + STYLE);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN PICTURE MARKS 237[\s\S]*?  \/\/ END PICTURE MARKS 237(?:\r?\n)*/g, '\n');
const plain = title => title.replaceAll('&#8217;', '’').replaceAll('&#8594;', '→').replaceAll('&#183;', '·');
const entries = frames.map(f => `  { group: "Picture marks · turn 237", screen: ${JSON.stringify(plain(f.title))}, frame: "${f.id}", route: "Story / Audiobook", status: "drawn", checked: "2026-10-24", controls: [], notes: ["Drawn 24 October 2026 for the owner’s review."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN PICTURE MARKS 237\n' + entries.join('\n') + '\n  // END PICTURE MARKS 237\n');
const pageEntry = '{ file: "picture-marks-237.review.html", what: "Turn 237: Picture marks — pictures set on the words inside a beat, + Picture at a sentence, a new mark’s panel, and Illustrate choosing pictures from the story under a cap.", state: "drawn 24 October 2026; not built" }';
if (build.includes('file: "picture-marks-237.review.html"')) build = build.replace(/\{ file: "picture-marks-237\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(STYLE)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', STYLE + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 237: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
