// Turn 233 · Export → Arke Player. Writes the review page and, unless --preview, places the turn in
// the design master and registers its frames with build-review.
//   node design-system/arke-player-export-233.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './arke-player-export-233.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const STYLE = '<link rel="stylesheet" href="arke-player-export-233.css">';
const frames = FRAMES.map(([letter, title, width, height, kind, draw]) => ({ id: '233' + letter, title, width, height, kind, markup: draw() }));
for (const f of frames) if (!f.markup.startsWith('<div class="ap233"')) throw new Error(`${f.id}: frame root is not .ap233`);

write('arke-player-export-233.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Export → Arke Player · Turn 233</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 233 · drawn for review · Export → Arke Player</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t233" style="color:inherit">Design master</a><a href="arke-player-export-233.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${esc(f.title)}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote arke-player-export-233.review.html: ${frames.length} frames.`); process.exit(0); }

export const rules = [
  ['Review status', '21 October 2026. Drawn for review; nothing is built. Asked: an export of a world from Arke that a person adds by hand in Arke Player, where above all the audiobook is heard with its pictures. Specified in SPEC-058 (proposed; R-1 – R-8 and R-29 are this turn) and tracked in #2037. The Player’s side is already drawn in the Player master (P2c–P2f to add a package, P5a–P5c to hear it with its pictures, P9 for Available).'],
  ['A fourth export', 'The audiobook’s Export sheet (197a) offers Arke Player beside Audiobook player, Chapter files and Video, its line phone · pictures · the book; the four kinds sit two by two in the 720 sheet (233a). Arke Player makes one world package: world.json, the world’s key art and logline, the book, and the narration as data. No player page and no script go in: a phone never runs a package’s page (SPEC-048 R-14).'],
  ['What the sheet counts', 'Each row is data from the plan the player plays (SPEC-047 R-73). World: the key art and the world’s name, with key art · logline. Book: The book, on by default, with its chapters and EPUB; every committed chapter goes in, whether read or not. Narration: the chapters read whole of all, 12 of 16 · read whole, and which. Pictures: the count, fitted for a phone, 2048 px · cover before the first. Text: Phrases, timed, and how many chapters carry measured word times. Motion: Loops, on by default, with the count and each with its still. Edition: a label, today’s date by default. With The book off the package is the narration alone; with no chapter read whole the Narration row says none read whole and the package is the book alone.'],
  ['Only what a listener is given', 'Only chapters read whole go in the narration, as in the player package (R-72): a chapter read in part plays in the Studio and never in a file someone is given. Each chapter is one joined audio file. The pictures keep their times, holds and focus, so the phone shows each one when Listen does and pushes about the same point (186, 211).'],
  ['Pictures fitted for a phone', 'Each picture is fitted to 2048 px on its long side and saved as JPEG, a PNG with transparency staying PNG; a loop is made 1080p H.264 with no sound, and its still always ships beside it. A picture shown in two chapters ships once. The Undersong’s pictures are mostly full-size PNGs of about 3 MB; fitted, a book’s worth is tens of megabytes, not hundreds.'],
  ['Priced in size and time', 'Before Make package the sheet says the size and the time, as 197 does: ~228 MB · ~3 min on this machine, then what goes in as data, 12 chapters · 131 pictures · the book. The size is the audio, the fitted pictures and the book; the time is measured on this machine.'],
  ['Made in Activity, and stoppable', 'Making is one Activity row (233b, as 197d): Arke Player and the production, a percent across all of it, Cancel, and its step as data: Joining chapter 7 of 12, then Fitting pictures 54 of 131, then Checking 212 of 262 files, with time left. It is made in staging, read back by the same reader the Player uses, and moved into exports whole. Cancel leaves nothing named. A take made, a picture moved or a focus changed while it is made stops it as A take changed · make again, never a package of two moments.'],
  ['Not made: one clause each', 'What stops the package is listed in the sheet before anything is made, each in one clause with the press that clears it (233d): a loop that will not play (Use still, as R-72 asks), a picture outside this world (Show opens the chapter at it), Needs ffmpeg. Make package waits until the list is empty.'],
  ['The package made', 'When it is made the sheet lists it (233c): 1 package · 228 MB, its path, Show in folder and Make again; the file with its contents as data; and its SHA-256 in full with Copy. The size and SHA-256 are what Arke Player’s Available pins (P9), so a package can be offered there without repacking (SPEC-058 R-29). Make again makes a new file with a new name and never overwrites one: a pinned file must never change.'],
  ['Publications', 'Publications lists the package under Other exports, newest first, beside the audiobook player and videos (233e), with its contents, size, Copy SHA-256 and Show in folder.'],
  ['From a phone', 'A phone or a paired browser starts it in the same sheet, one column with 44-high presses, and the desktop that holds the world makes it, said as on the desktop (233f, as 197f). The phone’s Activity shows the row and can cancel it; the finished package offers Download and Share. Share hands the file to the phone’s share sheet, where Arke Player takes it (Player P2c, Open in and Share to), so a world can go from the Studio to the Player on one phone.'],
  ['Sizes and copy', 'The sheet is 720 wide, the kinds two by two. Labels only: Arke Player, World, Book, The book, Narration, Pictures, Text, Motion, Loops, Edition, Make package, Make again, Cancel, Show in folder, Copy, Copy SHA-256, Download, Share, Use still, Show; sizes, counts, times and the SHA-256 as data.'],
  ['Implementation boundary', 'Spec: SPEC-058 R-1 – R-8 and R-29, with schema 2 and the listening document (R-9 – R-16). Reused: R-72’s exporter (the listening plan, joined chapters, pictures once, files resolved inside the world, staging, the gate, the read-back), the story EPUB writer (SPEC-048 §2.11), Activity, the Export sheet and Publications. New: the world package writer, picture fitting, the listening document, and its reader shared with Arke Player’s arke_world by fixtures.'],
];

const turn = `<section class="dv-turn" id="t233"><div class="dv-thd"><a class="dv-tid" href="#t233">233</a><span class="dv-tname">Export &#8594; Arke Player &#183; a world in one file a phone adds, its audiobook heard with its pictures (extends <a class="dv-oid" href="#t197">197</a>; SPEC-058, #2037)</span></div><p class="dv-next">21 October 2026 · Drawn for review · #2037 · ${frames.length} HTML drawings. <a href="arke-player-export-233.review.html">Review page</a> · <a href="arke-player-export-233.notes.md">Notes</a></p><div class="dv-opts">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${esc(f.title)}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: “several productions in one package” · “a second edition after more is read” · “the package opened in the Player”</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t233">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(next);
} else {
  // Newest first: place above the first turn numbered below 233, never above a newer one.
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 233);
  if (!below) throw new Error('No turn below 233 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
if (!master.includes(STYLE)) master = master.replace('<helmet>', '<helmet>\n' + STYLE);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN ARKE PLAYER EXPORT 233[\s\S]*?  \/\/ END ARKE PLAYER EXPORT 233(?:\r?\n)*/g, '\n');
const entries = frames.map(f => `  { group: "Export · turn 233", screen: ${JSON.stringify(f.title)}, frame: "${f.id}", route: "Story / Audiobook / Export", status: "drawn", checked: "2026-10-21", controls: [], notes: ["Drawn for review 21 October 2026; SPEC-058, #2037."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN ARKE PLAYER EXPORT 233\n' + entries.join('\n') + '\n  // END ARKE PLAYER EXPORT 233\n');
const pageEntry = '{ file: "arke-player-export-233.review.html", what: "Turn 233: Export → Arke Player — the sheet with Arke Player chosen, making it in Activity, the package made with its size and SHA-256, blockers in one clause, Publications’ Other exports, and from a phone with Download and Share.", state: "drawn for review; SPEC-058, #2037" }';
if (build.includes('file: "arke-player-export-233.review.html"')) build = build.replace(/\{ file: "arke-player-export-233\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(STYLE)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', STYLE + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 233: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
