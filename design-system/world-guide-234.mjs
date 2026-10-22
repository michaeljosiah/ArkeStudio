// Turn 234 · A world's Guide. Writes the review page and, unless --preview, places the turn in the
// design master and registers its frames with build-review.
//   node design-system/world-guide-234.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './world-guide-234.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const STYLE = '<link rel="stylesheet" href="world-guide-234.css">';
const frames = FRAMES.map(([letter, title, width, height, kind, draw]) => ({ id: '234' + letter, title, width, height, kind, markup: draw() }));
for (const f of frames) if (!f.markup.startsWith('<div class="ap234"')) throw new Error(`${f.id}: frame root is not .ap234`);

write('world-guide-234.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>A world’s Guide · Turn 234</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 234 · approved · A world’s Guide</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t234" style="color:inherit">Design master</a><a href="world-guide-234.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${esc(f.title)}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote world-guide-234.review.html: ${frames.length} frames.`); process.exit(0); }

export const rules = [
  ['Review status', '22 October 2026. Approved as drawn by the owner the same day; nothing is built. Asked: a Worlds section in Arke Player where people explore a world’s productions and read about its characters and some of its lore, starting with the worlds Arke makes available. The Player’s side is Player P11 (the Worlds tab, a world’s characters, places and lore, and Reveal). To be specified in SPEC-059.'],
  ['A world’s Guide', 'The world’s pages gain Guide, after Productions (234a): what Arke Player shows of the world — its characters, its places, and its lore. Nothing is public until the author turns it on, so a world’s Guide starts empty. The head counts, as data, what is public of each and how many wait for a chapter: 4 of 5 characters · 3 of 6 places · 7 of 16 lore · 4 after a chapter.'],
  ['What a row says', 'A character or a place: its portrait or picture (initials without one), its name and role, the sections made public, a character’s voice line and its length, when it shows, and Public. Lore: the canon id, the title and kind, when it shows, and Public. Characters and places are on the left, lore on the right; a row that is not public is drawn in the muted ink.'],
  ['Lore is settled canon', 'Only a settled canon entry can be public. An open thread or a proposed entry is the author’s question, not the world’s, and has no switch (CANON-044, CANON-048). A retired entry does not appear. Factions follow places when a world has them.'],
  ['An entry', 'Pressing a row opens its entry (234b), a panel over the Guide: Public; Shows, From the start or After a chapter — a production and one of its chapters, in manuscript order; and Sections, each of the sheet’s sections with its own box and its own After a chapter, so a character can be public from the start while their relationships wait for chapter 6. The text the Player shows is the section as written, with the author’s notes left out (a Room note), and follows the sheet as it changes. A lore entry’s text is its statement, without its amendment notes.'],
  ['A line in their voice', 'Voice is a line the character says in a chapter read whole, chosen from its takes with Change: the words, the production, the chapter and the length. Nothing is generated or spent. A character with no line read has none, and the Player draws no Voice press.'],
  ['As the Player draws it', 'Beside the entry, the Player’s page as it will look (234b; Player P11d), what waits for a chapter drawn as the Player draws it. Preview, in the head, shows the whole Guide as Player P11 does.'],
  ['Kept in the world', 'The Guide is the world’s own record, kept beside its canon and changed only here; it changes nothing in a sheet or an entry. It names what is public and when, never a copy of the text, so an edit to a sheet shows in the Player’s next package.'],
  ['In the package', 'Export → Arke Player (233a) gains Guide (234c), after World: what is public, counted, with what waits for a chapter, and Edit, which opens the Guide. The guide goes into the package with its portraits and pictures fitted as the package’s pictures are, and its voice lines as M4A; the size and the estimate count it. A world with nothing public carries no guide and the row says none public.'],
  ['From a phone', 'On a paired phone the Guide is one column of 56-high rows, each with its switch, the line under the name its role or when it shows (234d); an entry opens as its own page with Shows, Sections and Voice in the same order.'],
  ['Sizes and copy', 'The page keeps the world pages’ pill nav and head; the panel is 820 wide, its preview 300. Labels only: Guide, Preview, Characters, Places, Lore, Public, Shows, From the start, After a chapter, After Chapter N, Sections, Voice, Change, Close, Edit; counts, canon ids, chapters and lengths as data. The sections’ headings and texts are the author’s.'],
  ['Implementation boundary', 'To be specified in SPEC-059: the Guide record in the world, the guide document in a world package and the catalogue (read in contracts and in Arke Player’s arke_world by shared fixtures, as SPEC-058), the Export’s Guide row, and the Player’s Worlds tab (Player P11). Reused: the sheets and their sections, canon and its status, the audiobook’s takes for a voice line, picture fitting, and the world pages’ nav.'],
];

const turn = `<section class="dv-turn" id="t234"><div class="dv-thd"><a class="dv-tid" href="#t234">234</a><span class="dv-tname">A world&#8217;s Guide &#183; what Arke Player shows of a world: its characters, places and lore, each from the start or after a chapter (extends <a class="dv-oid" href="#t233">233</a>; Player P11)</span></div><p class="dv-next">22 October 2026 · Approved · ${frames.length} HTML drawings. <a href="world-guide-234.review.html">Review page</a> · <a href="world-guide-234.notes.md">Notes</a></p><div class="dv-opts">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${esc(f.title)}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: “a world with factions” · “a character in two productions” · “a guide with nothing public yet”</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t234">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(next);
} else {
  // Newest first: place above the first turn numbered below 234, never above a newer one.
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 234);
  if (!below) throw new Error('No turn below 234 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
if (!master.includes(STYLE)) master = master.replace('<helmet>', '<helmet>\n' + STYLE);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN WORLD GUIDE 234[\s\S]*?  \/\/ END WORLD GUIDE 234(?:\r?\n)*/g, '\n');
const entries = frames.map(f => `  { group: "Guide · turn 234", screen: ${JSON.stringify(f.title)}, frame: "${f.id}", route: "World / Guide", status: "drawn", checked: "2026-10-22", controls: [], notes: ["Approved 22 October 2026; Player P11 is its other half; to be specified in SPEC-059."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN WORLD GUIDE 234\n' + entries.join('\n') + '\n  // END WORLD GUIDE 234\n');
const pageEntry = '{ file: "world-guide-234.review.html", what: "Turn 234: a world’s Guide — what Arke Player shows of a world, its characters, places and settled lore, each public from the start or after a chapter; an entry with its sections, a voice line and the Player’s page beside it; Export → Arke Player carrying the guide; and from a phone.", state: "approved; to be specified in SPEC-059 (Player P11)" }';
if (build.includes('file: "world-guide-234.review.html"')) build = build.replace(/\{ file: "world-guide-234\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(STYLE)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', STYLE + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 234: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
