// Turn 274 · A description for readers, the rest after the story. Writes the review page and, unless
// --preview, places the turn in the design master and registers its frames with build-review.
//   node design-system/guide-descriptions-274.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './guide-descriptions-274.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
// The turn draws with 234's page and 236's teasers, so its review page carries both, then its own.
const STYLES = ['world-guide-234.css', 'release-chapters-236.css'].map(n => `<link rel="stylesheet" href="${n}">`).join('');
const STYLE = '<link rel="stylesheet" href="guide-descriptions-274.css">';
const frames = FRAMES.map(([letter, title, width, height, kind, draw]) => ({ id: '274' + letter, title, width, height, kind, markup: draw() }));
for (const f of frames) if (!f.markup.startsWith('<div class="ap274"')) throw new Error(`${f.id}: frame root is not .ap274`);

write('guide-descriptions-274.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>A description for readers · Turn 274</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLES}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 274 · approved · A description for readers, the rest after the story</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t274" style="color:inherit">Design master</a><a href="guide-descriptions-274.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${esc(f.title)}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote guide-descriptions-274.review.html: ${frames.length} frames.`); process.exit(0); }

export const rules = [
  ['Review status', '8 November 2026. Approved as drawn by the owner the same day, with Player calls 55–58; not built yet. The owner, looking at a character in Arke Player: the page shows what the author used to make the story, not what a reader wants, and the real description waits for the last chapter because it gives the ending away. Asked for a description written for readers that every reader sees, and the rest unlocked once the story is finished, not section by section. The Player’s side is Player P29. To be specified as a revision of SPEC-059.'],
  ['A description', 'Each character’s and place’s entry gains Description, after Shows (274b): the words a reader is given on meeting them, up to 400 characters, counted under the box. Arke Player shows it first, to everyone, the moment the entry shows, whatever they have read, so it gives nothing away past the chapter where they are met. It is the one text the Guide keeps, because it is written only for readers and belongs to no sheet: an edit to a sheet never changes it. This revises SPEC-059 R-5, which kept no text.'],
  ['Draft', 'Draft asks Arke for one (274c), from the sheet and the story up to the chapter where the character or place is first met, and nothing after it. It fills the box for the author to change; Draft again replaces it. Draft 14, in the head, drafts every public entry still without one (274a). A drafted description is marked Drafted in its row until the author changes it or opens it and closes it, and the Export counts those not yet read. Drafting runs on the world’s assistant, as World Chat does; no paid service is called.'],
  ['After the story', 'Sections lose their own After a chapter. Each is ticked or not, and every ticked section waits for the end of the story, together (274b). The story is named once, in the head: one production of the world, the first by default, for Na Love or Juju the book and its audiobook. A section once public from the start, as Juju’s Appearances were, now waits with the rest; nothing ships earlier than it did.'],
  ['Shows', 'An entry is still public From the start or After a chapter, for someone met later or whose name gives the story away (Nkechi Obi after Chapter 2). Their description waits with them.'],
  ['What a row says', 'Its portrait or picture, its name and role, the description’s opening (or No description), Drafted when it is a draft not yet read, how many sections wait for the story, when it shows, and Public (274a). The head counts what is described and drafted.'],
  ['The name and role', 'They are the sheet’s and show to everyone with the description, as before. A role that gives the story away, as Tunde’s The friend who was right does, is changed on the sheet.'],
  ['As the Player draws it', 'The preview beside the entry is Player P29a: the description under the portrait and one row, After the story, with the count.'],
  ['In the package', 'The guide document gains each entry’s description and the story’s production and last chapter, so it is a new guide version; a Player from before P29 reads the guide as Made with a newer Arke (SPEC-059 R-37) and should be updated before an edition carries it. A guide alone (R-10) carries the same.'],
  ['Sizes and copy', 'The page, the rows and the 820-wide panel with its 300-wide preview are turn 234’s; the teasers are turn 236’s. Labels only: Description, Draft, Draft again, Draft N, Drafting, Drafted, No description, Stop, After the story, Sections; counts as data. The description is the author’s.'],
  ['Implementation boundary', 'A SPEC-059 revision: the Guide record keeps a description per character and place and the world’s story; the guide document’s new version, read in contracts and in Arke Player’s arke_world by shared fixtures; Draft on the world’s assistant with the chapters up to an entry’s first meeting; and the Export’s count. Reused: the Guide page and its entry panel, the teasers, the sheets, and Shows.'],
];

const turn = `<section class="dv-turn" id="t274"><div class="dv-thd"><a class="dv-tid" href="#t274">274</a><span class="dv-tname">A description for readers &#183; every character and place gains words for every reader, and the rest waits for the end of the story (amends <a class="dv-oid" href="#t234">234</a>; Player P29)</span></div><p class="dv-next">8 November 2026 · Approved · ${frames.length} HTML drawings. <a href="guide-descriptions-274.review.html">Review page</a> · <a href="guide-descriptions-274.notes.md">Notes</a></p><div class="dv-opts">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${esc(f.title)}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: “a world of two stories” · “a description for a place no one visits” · “Draft for every entry at once”</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t274">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(next);
} else {
  // Newest first: place above the first turn numbered below 274, never above a newer one.
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 274);
  if (!below) throw new Error('No turn below 274 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
if (!master.includes(STYLE)) master = master.replace('<helmet>', '<helmet>\n' + STYLE);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN GUIDE DESCRIPTIONS 274[\s\S]*?  \/\/ END GUIDE DESCRIPTIONS 274(?:\r?\n)*/g, '\n');
const entries = frames.map(f => `  { group: "Guide · turn 274", screen: ${JSON.stringify(f.title)}, frame: "${f.id}", route: "World / Guide", status: "drawn", checked: "2026-11-08", controls: [], notes: ["Approved 8 November 2026; Player P29 is its other half; to revise SPEC-059. Not built."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN GUIDE DESCRIPTIONS 274\n' + entries.join('\n') + '\n  // END GUIDE DESCRIPTIONS 274\n');
const pageEntry = '{ file: "guide-descriptions-274.review.html", what: "Turn 274: a description for readers — every character and place in a world’s Guide gains words every reader is given, drafted by Arke for the author to change, and every public section waits for the end of the world’s story, together.", state: "approved 8 November 2026 (Player P29; to revise SPEC-059)" }';
if (build.includes('file: "guide-descriptions-274.review.html"')) build = build.replace(/\{ file: "guide-descriptions-274\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(STYLE)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', STYLE + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 274: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
