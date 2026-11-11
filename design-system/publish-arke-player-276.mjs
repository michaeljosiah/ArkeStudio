// Turn 276 · Publish: one page per production, one Arke Player sheet, and the owner's steps to Arke's
// list (epic 2771, slices 33, 34 and 51: issues 2804, 2805 and 2823). Writes the review page and,
// unless --preview, places the turn in the design master and registers its frames with build-review.
//   node design-system/publish-arke-player-276.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './publish-arke-player-276.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const STYLE = '<link rel="stylesheet" href="publish-arke-player-276.css">';
const frames = FRAMES.map(([letter, title, width, height, kind, draw]) => ({ id: '276' + letter, title, width, height, kind, markup: draw(`276${letter} ${title}`) }));
for (const f of frames) if (!f.markup.startsWith('<div class="pb276 ')) throw new Error(`${f.id}: frame root is not .pb276`);
for (const f of frames) {
  // Every frame closes what it opens: the sheets are spliced onto the page's closing tag.
  const depth = [...f.markup.matchAll(/<(\/?)div\b/g)].reduce((n, m) => n + (m[1] ? -1 : 1), 0);
  if (depth !== 0) throw new Error(`${f.id}: ${depth} unclosed div(s)`);
}

const STATUS = 'Drawn for the owner’s approval';
write('publish-arke-player-276.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Publish · Turn 276</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 276 · ${STATUS} · Publish</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t276" style="color:inherit">Design master</a><a href="publish-arke-player-276.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${esc(f.title)}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote publish-arke-player-276.review.html: ${frames.length} frames.`); process.exit(0); }

export const rules = [
  ['Review status', '11 November 2026. Drawn for the owner’s approval; not built. Epic 2771 slices 33, 34 and 51 (issues 2804, 2805, 2823), from findings UP-01, UP-02 and UP-10 of the 7 November simplification review.'],
  ['Where it sits', 'Every production has one Publish page at /w/:worldId/p/:prodId/publish. Its rail item is the rail’s last, below the divider, for every kind (276a, 276b): after Artifacts for a book, a graphic novel, an album and an audio drama; after Cut for a film, an interactive movie and a series. On a phone it is the page strip’s last pill (276h). The retired exports address stays the Cut’s.'],
  ['One word, one place', 'Publish means this page. The header buttons that open a publishing sheet from a production’s main screen become Publish and open the page: Chapters’ Publish, the Audiobook page’s Publish, Pages’ Export, Tracks’ Export and the audio drama’s Publish…. The Cut’s Export film, the Branch Map’s Export and a chapter’s Export… stay where they are: each exports that screen’s own work. The Publish sheet’s Other exports goes.'],
  ['What each kind offers', 'The page shows the outputs the production’s kind makes, one card each, in this order. Book: Edition (EPUB · PDF · M4B), Audiobook (player · MP3 · video), Arke Player, Manuscript (Word · EPUB). Graphic novel: Comic files (CBZ · PDF · EPUB), Arke Player, and Edition when its chapters hold prose. Album: Arke Player. Interactive movie: Arke Player, Web package, Film. Visual novel: Arke Player, Web package. Audio drama: Edition. Film: Film, Playable edition. Series: Film, Playable edition. Each card opens the sheet that makes it today, except Arke Player’s (rule 7).'],
  ['Readiness', 'A card says Ready and one fact (16 chapters, 12 of 16 read whole), or Blocked · n, its first blocker in one clause and Go to, which opens the place that clears it (276b). Readiness comes from the coordinator, one export state for every kind, as the interactive story’s does today. A blocked card’s button still opens its sheet, which lists every blocker, as the Branch Map’s Export does.'],
  ['Made', 'Below the cards, every file this production has made, newest first, in one list: kind, what it is, the date, the size, and where it went (On Arke’s list, or a submission’s status). A package offers SHA-256 and Show; the rest Show (276a). It replaces the lists the sheets keep: Export manuscript’s and Export film’s Delivered rows, the audio drama’s Editions, the story sheet’s releases and the Publish sheet’s editions. A comic’s files are listed for the first time. Publications keeps every world’s editions and opening a ZIP. Nothing made yet reads Nothing made yet.'],
  ['One Arke Player sheet', 'One sheet makes the Arke Player package for every kind: a book’s edition or part, an album, an interactive movie, a visual novel, a graphic novel, and a world’s guide alone. Its rows are each kind’s rows as they ship today. Once made, every kind shows one block (276c, 276d): 1 package and its size, the file, SHA-256 with Copy, Read back with what the read found, Show in folder, Make again, and Submit to Arke Player; Download and Share on a phone. A graphic novel gains the SHA-256, Make again and Submit; an album gains Make again, Download, Share and Submit; a story gains Share and Submit. Arke Player leaves the Export audiobook sheet’s kinds and the comic dialog’s toggles.'],
  ['Guide alone', 'The Guide page gains Export beside Preview (276g). It opens the Arke Player sheet for the world’s guide alone: World, Characters, Places, Lore and Teasers as public counts, and Edition, made as the export script makes it today and listed nowhere but its made block.'],
  ['Add to Arke’s list', 'Only on a host set up to publish Arke’s list: a host file naming the repository, the list’s release and each world’s release. Everywhere else the made block has no such press. Add to Arke’s list opens what will go public (276e): the world, what the file is in the list (edition, part, album, story, comic, guide), the file, the release and the list’s serial, before and after. Add to list is the approval for that one file. The app then refuses a file name already on the release, uploads, downloads it back and compares, pins it under its kind’s own key, reads the hosted list, raises its serial by one, publishes it and reads it back (276f).'],
  ['What it never does', 'Replace a published file, mark a release Latest, make a release, or add a world or production the list does not have: a first listing stays a hand edit in Arke Player. Refused in one clause, the list untouched: Not on Arke’s list, Already on the release, Follows another edition, The list changed · try again, No connection.'],
  ['Arke Player’s copy', 'The hosted list becomes the one list. Arke Player’s bundled catalogue.json is refreshed from it before each build, so a list published from the app is never undercut by an older serial. That change is Arke Player’s, in its own issue.'],
  ['Sizes and copy', 'The title bar, the 265-wide rail, the 44-wide page gutters, the h1 row, the buttons, the phone switch and strip, the Guide page and the sheet’s chrome and rows are the shipped ones. Cards: four across at 1360, one row each on a phone. Labels only: Publish, Ready, Blocked · n, Go to, Made, Nothing made yet, Add to Arke’s list, Add to list, On Arke’s list.'],
  ['Implementation boundary', 'Issue 2805: the page, its route, the rail item and strip pill, the header buttons, the cards over one coordinator export state, and the Made list over one production-filtered read. Issue 2804: one ArkePlayerExportSheet driven by kind with the shared made block. Issue 2823: Guide alone from the Guide page; the host-configured list publisher as a coordinator service that shells out to gh, never a token in the renderer. To amend first: SPEC-058 R-7, R-29 and R-36, SPEC-059 R-10, SPEC-060 R-18 and SPEC-064 R-50.'],
];

const turn = `<section class="dv-turn" id="t276"><div class="dv-thd"><a class="dv-tid" href="#t276">276</a><span class="dv-tname">Publish &#183; one page per production, one Arke Player sheet, and the owner&#8217;s steps to Arke&#8217;s list (epic 2771: issues 2804, 2805, 2823)</span></div><p class="dv-next">11 November 2026 · ${STATUS} · ${frames.length} HTML drawings. <a href="publish-arke-player-276.review.html">Review page</a> · <a href="publish-arke-player-276.notes.md">Notes</a></p><div class="dv-opts" style="margin-top:22px">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${esc(f.title)}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: “a production’s Made list across worlds in Publications” · “an audio drama or a film for Arke Player” · “a first listing from the app”</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t276">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(next);
} else {
  // Newest first: place above the first turn numbered below 276, never above a newer one.
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 276);
  if (!below) throw new Error('No turn below 276 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
if (!master.includes(STYLE)) master = master.replace('<helmet>', '<helmet>\n' + STYLE);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN PUBLISH 276[\s\S]*?  \/\/ END PUBLISH 276(?:\r?\n)*/g, '\n');
const entries = frames.map(f => `  { group: "Publish · turn 276", screen: ${JSON.stringify(f.title)}, frame: "${f.id}", route: "Production / Publish", status: "drawn", checked: "2026-11-11", controls: [], notes: ["Drawn 11 November 2026 for issues 2804, 2805 and 2823. Not approved, not built."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN PUBLISH 276\n' + entries.join('\n') + '\n  // END PUBLISH 276\n');
const pageEntry = '{ file: "publish-arke-player-276.review.html", what: "Turn 276: one Publish page per production, one Arke Player sheet with one made block for every kind, Guide alone, and Add to Arke’s list on the owner’s host.", state: "drawn 11 November 2026 (issues 2804, 2805, 2823)" }';
if (build.includes('file: "publish-arke-player-276.review.html"')) build = build.replace(/\{ file: "publish-arke-player-276\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(STYLE)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', STYLE + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 276: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
