// Turn 236 · Releasing chapters, and a world's teasers. Writes the review page and, unless --preview,
// places the turn in the design master and registers its frames with build-review.
//   node design-system/release-chapters-236.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './release-chapters-236.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const STYLE = '<link rel="stylesheet" href="release-chapters-236.css">';
// Titles are authored with entities, so they are placed as written rather than escaped again.
const frames = FRAMES.map(([letter, title, width, height, , draw]) => ({ id: '236' + letter, title, width, height, markup: draw() }));
for (const f of frames) if (!f.markup.startsWith('<div class="ap236"')) throw new Error(`${f.id}: frame root is not .ap236`);

write('release-chapters-236.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Releasing chapters · Turn 236</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 236 · proposed · Releasing chapters, and a world’s teasers</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t236" style="color:inherit">Design master</a><a href="release-chapters-236.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${f.title}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote release-chapters-236.review.html: ${frames.length} frames.`); process.exit(0); }

export const rules = [
  ['Review status', '24 October 2026. Proposed with Player P15 (ArkePlayer PR #10); nothing is built. Asked by the owner: in Arke Player, should Worlds become Discover, showing worlds, their productions and other things made for them; and a world may release its story a chapter at a time to bring its audience back. The owner approved five calls the same day: Discover beside Library; productions and new chapters first; teasers the author’s choice; a new chapter fetched on its own over Wi-Fi; the phone’s own notification per world. This turn is the author’s half: choosing teasers and releasing chapters. The Player’s half is P15.'],
  ['Teasers are the Guide’s', 'A world’s Guide (234a) gains Teasers, first on the page (236a): up to six, in the author’s order, each a card with its picture, its place in the order, its name and what it is (Character, Place, Picture, or Clip with its length and chapter). Drag reorders; a card’s menu removes it. Until one is chosen the world has none, and Discover shows none of it. The head counts them with the rest: 3 of 6 teasers.'],
  ['Adding a teaser', 'Add opens a picker over the Guide (236b) with Characters, Places, Pictures and Clips. A character or place must already be public from the start: one that waits for a chapter or is not public is dimmed and says so in one clause, After Chapter 9 or Not public (236c), never offered and refused later. A picture is any picture made for the world’s productions, its chapter as data. A clip is a moment of a chapter read whole — its picture or loop and its narration — at most 30 seconds from the moment’s start. A teaser already chosen says Teaser 1.'],
  ['What a teaser gives away is the author’s call', 'A character or place follows the Guide’s own gate (234, P11 rule 7). A picture or clip is shown to anyone in Discover, whatever its chapter, so its chapter is always on its card as data for the author to judge; nothing in the Studio hides a late one for them.'],
  ['Teasers travel in the guide', 'A world’s teasers ride in its guide alone (SPEC-059 R-10) as well as its package, so Discover shows them before a world is installed: each picture fitted for a phone, each clip one small audio file with its picture. They change when the guide is exported again.'],
  ['Release: the whole world, or its new chapters', 'Export → Arke Player (233a) gains Release (236d): Whole world, the package as today, the only choice for a world never released; and New chapters, a part. Since names the last release, its date and last chapter. Chapters lists each chapter after it: read whole ones ticked, each with its length and pictures; one read in part says how far, read 6 of 31 blocks, and cannot be ticked, because only chapters read whole go to a listener (233 rule 4).'],
  ['A part holds only what is new', 'A part carries the chosen chapters’ narration, pictures (every shape made, at the Size chosen, 235), Text and loops, the book’s new chapters when The book is on, and the listening document for those chapters; it names the edition it follows. Nothing already released is sent again. It is priced as a package is, ~24 MB · ~20 s on this machine, and made in Activity (233b).'],
  ['The author’s schedule', 'Schedule is the day new chapters come (none, a weekday, or Daily) and Next, an optional date. It rides in the part and the world’s entry in Arke’s list, and the Player shows it as written and drops a date once it passes (P15 rule 8). It is the author’s word, not a promise the Studio keeps: nothing is released on its own.'],
  ['The part made', 'Made, the sheet lists the part as a package is (236e, as 233c): 1 part · 24 MB, its file, exports/the-undersong-part-2026-10-30.zip, Show in folder, and its SHA-256 with Copy. Under it the world’s releases in order: the edition, then each part, the new one marked. Publications lists parts under Other exports with the packages (233e).'],
  ['A new edition gathers the parts', 'Release · Whole world after parts makes a new edition holding every chapter released; the Player offers it as Update (P12) and the parts before it fall away. Parts after it follow it.'],
  ['Publishing stays the owner’s', 'Putting a part in Arke Player is the owner’s four steps, as for a package: upload it under its own name to the world’s public story release, pin it, add it to the world’s entry in Arke’s list as its next part, raise the list’s serial and publish the list. Nothing here uploads.'],
  ['Sizes and copy', 'The Guide keeps 234’s page; every teaser card is one shape, 16:9 and 168 wide, a character’s too, so the row lines up (the owner, 24 October 2026: mixed sizes look unkempt), as P15 rule 10 makes the Player’s rows one tile; the picker is 760 wide, four to a row, each tab in the same card. The Export sheet is 720 (233). Labels only: Teasers, Add, Add teaser, Characters, Places, Pictures, Clips, Release, Whole world, New chapters, Chapters, Schedule, Next, Make part, Part, Edition, Done; Teaser 1, After Chapter 9, Not public, dates, lengths, counts and sizes as data.'],
  ['Implementation boundary', 'Spec: SPEC-058 (a part: its file, its listening document, the edition it follows; the list entry’s parts, each pinned by length and SHA-256; the schedule) and SPEC-059 (teasers in the Guide record, the guide alone and the package). Reused: the Arke Player exporter (the listening plan, fitted pictures, Size, Activity, the read-back check), the Guide page and its gates, and Publications. New: Release and its chapter list, the part writer, Schedule, and Teasers with its picker.'],
];

const turn = `<section class="dv-turn" id="t236"><div class="dv-thd"><a class="dv-tid" href="#t236">236</a><span class="dv-tname">Releasing chapters &#183; a world&#8217;s new chapters made as a part for Arke Player, its schedule, and the teasers Discover shows (extends <a class="dv-oid" href="#t233">233</a>, <a class="dv-oid" href="#t234">234</a>; Player P15)</span></div><p class="dv-next">24 October 2026 · Proposed · ${frames.length} HTML drawings. <a href="release-chapters-236.review.html">Review page</a> · <a href="release-chapters-236.notes.md">Notes</a></p><div class="dv-opts">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${f.title}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: “a clip from a film or an episode” · “a release taken back” · “releasing on a date”</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t236">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(next);
} else {
  // Newest first: place above the first turn numbered below 236, never above a newer one.
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 236);
  if (!below) throw new Error('No turn below 236 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
if (!master.includes(STYLE)) master = master.replace('<helmet>', '<helmet>\n' + STYLE);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN RELEASE CHAPTERS 236[\s\S]*?  \/\/ END RELEASE CHAPTERS 236(?:\r?\n)*/g, '\n');
const plain = title => title.replaceAll('&#8217;', '’').replaceAll('&#8594;', '→').replaceAll('&#183;', '·');
const routes = { a: 'World / Guide', b: 'World / Guide', c: 'World / Guide', d: 'Story / Audiobook', e: 'Story / Audiobook' };
const entries = frames.map(f => `  { group: "Releasing chapters · turn 236", screen: ${JSON.stringify(plain(f.title))}, frame: "${f.id}", route: "${routes[f.id.slice(3)]}", status: "drawn", checked: "2026-10-24", controls: [], notes: ["Proposed 24 October 2026 with Player P15 (ArkePlayer PR #10)."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN RELEASE CHAPTERS 236\n' + entries.join('\n') + '\n  // END RELEASE CHAPTERS 236\n');
const pageEntry = '{ file: "release-chapters-236.review.html", what: "Turn 236: Releasing chapters — a world’s Guide with its teasers, adding a clip, a character that waits for a chapter, Export → Arke Player releasing new chapters as a part, and the part made beside the releases before it.", state: "proposed 24 October 2026; not built" }';
if (build.includes('file: "release-chapters-236.review.html"')) build = build.replace(/\{ file: "release-chapters-236\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(STYLE)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', STYLE + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 236: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
