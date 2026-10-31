// Turn 252 · Opening and closing credits (SPEC-047, SPEC-058). Writes the review page and, unless
// --preview, places the turn in the design master and registers its frames with build-review.
//   node design-system/audiobook-credits-252.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './audiobook-credits-252.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const STYLE = '<link rel="stylesheet" href="picture-shapes-235.css"><link rel="stylesheet" href="audiobook-credits-252.css">';
const STATUS = 'approved';
const frames = FRAMES.map(([letter, title, width, height, draw]) => ({ id: '252' + letter, title, width, height, markup: draw() }));
for (const f of frames) if (!/^<div class="(v199|ap235) cr252"/.test(f.markup)) throw new Error(`${f.id}: frame root is not .cr252`);

let master = read('Arke Studio.dc.html');
// Turn 199's page lives in the master's own styles: the review page takes the same rules from there,
// so it draws the page exactly as the master does.
const helmet = master.slice(master.indexOf('<helmet>'), master.indexOf('</helmet>'));
const pageRules = [...helmet.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '').split('}').filter(rule => /^\s*\.(v199|v190|v177|v184)\b[^{]*\{/.test(rule) && !rule.includes('@')).map(rule => rule.trim() + '}').join('\n');
if (!pageRules.includes('.v199-ep') || !pageRules.includes('.v199-sheet')) throw new Error('Turn 199 page rules not found in the master');

write('audiobook-credits-252.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening and closing credits · Turn 252</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLE}
<style>${pageRules}</style>
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 252 · ${STATUS} · Opening and closing credits</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t252" style="color:inherit">Design master</a><a href="audiobook-credits-252.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${f.title}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote audiobook-credits-252.review.html: ${frames.length} frames.`); process.exit(0); }

export const rules = [
  ['Review status', '31 October 2026. Approved by the owner the same day (“Approve as drawn”), calls 1 – 7 as drawn. From the owner’s question after the Na Love or Juju chapter files went out at 192 kbps: Audible asks for opening and closing credits, and they would suit the story’s audiobook everywhere. ACX’s submission rules (checked 31 October 2026): opening credits state the title, author(s) and narrator(s), matching the metadata and cover; closing credits indicate finality, ideally “You have been listening to…” with the same names and “The End”; both should be separate files. The same page says a submitted audiobook must be narrated by a human unless otherwise authorized, so credits alone do not make an AI-read book eligible for Audible. Nothing here is built.'],
  ['Two credits, at the ends of the book', 'A story’s audiobook has an Opening credits section before Chapter 1 and a Closing credits section after the last chapter (252a, 252b). They are rows of Chapters in the chapter row’s own markup: the cover as the picture, the name, the length as m:ss, the state, and the words in the synopsis slot. They are not chapters: no number, no pictures of their own, not counted in the chapter count or the meta line’s length. Pressing either opens the Credits sheet.'],
  ['Words drafted from the book’s details', 'The Credits sheet holds four details: Title (the production’s title), Written by (the author Publish last named, else empty), Narrated by and Copyright (the year and the author, optional). The opening is drafted as “Title. Written by Author. Narrated by credit.” and the closing as “You have been listening to Title, written by Author, narrated by credit. Copyright year holder. The End.” Changing a detail redrafts a credit whose words were not edited; edited words are kept.'],
  ['A credit names title, author and narrator', 'A credit whose words no longer name the title, the author or the narrator says which in one clause on its label (“names no narrator”, 252c) and on its row’s state. It is a warning, not a refusal: the words are the author’s.'],
  ['Narrated by says the voice is AI', 'Narrated by defaults to “an AI voice”. The other choices are the voice’s name and “an AI voice” (“Nigerian Woman 2, an AI voice”) and Your words (252c). A book read by a person names them in Your words.'],
  ['Read like the rest of the book', 'The credits are read in the book’s narrator voice, with the narrator’s direction and no other, and are made, flagged and read again as any block is. Read on the sheet reads what is not read, priced on the press; Read the book reads unread credits with the chapters. The two are one request when both are to read, so their words are checked. A credit read alone is checked too, as issue 2272 asks of every lone block. Hear plays a credit’s take.'],
  ['Chapter files', 'Chapters exports each read credit as its own file: 00-OpeningCredits.mp3 first and NN-ClosingCredits.mp3 last, NN one past the last chapter, mastered and checked as the chapters are (R-23) and listed in the report (252d). A credit not read is left out and the Credits row says so; the chapters still export.'],
  ['The book, the player, the video', 'The M4B carries the credits as its first and last chapters, named Opening credits and Closing credits. The player package and Arke Player play the opening at the start of Chapter 1 and the closing at the end of the last chapter, over the cover, with their words as timed phrases (252e): no new kind of entry, so the package schema and every installed Player read them as they are. The video’s credit card says the credits’ words.'],
  ['Calls for the owner', '1 · Credits are two rows at the ends of Chapters, opening a Credits sheet. 2 · The words are drafted from four details and stay editable; a credit that drops the title, author or narrator warns. 3 · Narrated by defaults to “an AI voice”. 4 · They are read in the narrator’s voice, checked like any block. 5 · Chapter files: two files of their own. 6 · Arke Player: inside the first and last chapters, over the cover, with no Player change. 7 · No music under the credits for now.'],
  ['Sizes and copy', 'Rows are 199a’s chapter row (thumbnail 240, two lines of words). The sheet is 199e’s, 460 wide. Labels only: Opening credits, Closing credits, Title, Written by, Narrated by, Copyright, Hear opening, Read closing and its price. File names keep ACX’s plain letters and digits.'],
  ['Implementation boundary', 'Spec: SPEC-047 R-210 – R-218 (the credits, their details and words, reading, the record and the exports) and SPEC-058 R-94, revision 15 (the credits inside the first and last chapters of a package). Issue 2272 (lone blocks unchecked) is a prerequisite. Reused: the chapter title block’s reading path, the take record and its flags, the retail mastering and report (R-22 – R-28), the listening plan’s phrases, Publish’s author. New with approval: the credits record and its two rows, the Credits sheet, the two files, the fold into the first and last chapters.'],
];

const turn = `<section class="dv-turn" id="t252"><div class="dv-thd"><a class="dv-tid" href="#t252">252</a><span class="dv-tname">Opening and closing credits &#183; the book&#8217;s first and last words, read in the narrator&#8217;s voice, in every edition (SPEC-047, SPEC-058; extends <a class="dv-oid" href="#t199">199</a>, <a class="dv-oid" href="#t235">235</a>)</span></div><p class="dv-next">31 October 2026 · ${STATUS} · ${frames.length} HTML drawings. <a href="audiobook-credits-252.review.html">Review page</a> · <a href="audiobook-credits-252.notes.md">Notes</a></p><div class="dv-opts">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${f.title}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: “music under the credits”</p></section>\n`;

const start = master.indexOf('<section class="dv-turn" id="t252">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(next);
} else {
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 252);
  if (!below) throw new Error('No turn below 252 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
const LINK = '<link rel="stylesheet" href="audiobook-credits-252.css">';
if (!master.includes(LINK)) master = master.replace('<helmet>', '<helmet>\n' + LINK);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN AUDIOBOOK CREDITS 252[\s\S]*?  \/\/ END AUDIOBOOK CREDITS 252(?:\r?\n)*/g, '\n');
const plain = title => title.replaceAll('&#8217;', '’').replaceAll('&#183;', '·');
const entries = frames.map(f => `  { group: "Opening and closing credits · turn 252", screen: ${JSON.stringify(plain(f.title))}, frame: "${f.id}", route: "${f.id < '252d' ? 'Story / Audiobook' : 'Story / Audiobook / Export'}", status: "drawn", checked: "2026-10-31", controls: [], notes: ["Approved 31 October 2026."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN AUDIOBOOK CREDITS 252\n' + entries.join('\n') + '\n  // END AUDIOBOOK CREDITS 252\n');
const pageEntry = '{ file: "audiobook-credits-252.review.html", what: "Turn 252: opening and closing credits — two rows at the ends of Chapters, the Credits sheet, Narrated by, and the credits in chapter files and Arke Player.", state: "approved 31 October 2026; not built" }';
if (build.includes('file: "audiobook-credits-252.review.html"')) build = build.replace(/\{ file: "audiobook-credits-252\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(LINK)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', LINK + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 252: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
