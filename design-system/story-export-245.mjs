// Turn 245 · Export → Arke Player for an interactive story. Writes the review page and, unless
// --preview, places the turn in the design master and registers its frames with build-review.
//   node design-system/story-export-245.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './story-export-245.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const STYLE = '<link rel="stylesheet" href="story-export-245.css">';
// Titles are authored with entities, so they are placed as written rather than escaped again.
const frames = FRAMES.map(([letter, title, width, height, , draw]) => ({ id: '245' + letter, title, width, height, markup: draw() }));
for (const f of frames) if (!f.markup.startsWith('<div class="ap245"')) throw new Error(`${f.id}: frame root is not .ap245`);

write('story-export-245.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Story export · Turn 245</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 245 · proposed · Export → Arke Player for an interactive story</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t245" style="color:inherit">Design master</a><a href="story-export-245.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${f.title}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote story-export-245.review.html: ${frames.length} frames.`); process.exit(0); }

export const rules = [
  ['Review status', '28 October 2026. Proposed; nothing is built. Player P18 (ArkePlayer PR #21) was approved by the owner the same day (“Approve”), with its call 24: Export → Arke Player for an interactive movie or a visual novel is a Studio turn of its own. Asked by the owner: “have we designed what the interface would look like for interactive stories on Arke player?” P18 draws the phone; this turn is the author’s half. The production it is for is The Red Quiet: First Contact; the samples are The Undersong’s Low Water and The Lantern Road, as P18 shows them.'],
  ['One sheet, two kinds', 'Export on an interactive movie or a visual novel opens the Export sheet of 233a, with two kinds: Web package, the folder with player.html that 156 and 174h drew and the Branch Map writes today, unchanged; and Arke Player (245a). The Branch Map’s Export opens the sheet instead of writing the folder at once.'],
  ['What an interactive movie carries', 'World; Story, its scenes and choices with its facts and endings counted; Closed choices, how many and how many have a reason; Clips, one a scene, at the shape and size they were made; Shape, 16:9 or 9:16, which the phone plays whole (P18 rule 1); Format, arke-story 1, compiled from routing; and Edition (245a). It is priced in size and time before anything is made, and made in Activity and read back, as in 233.'],
  ['What a visual novel carries', 'The same Story, Closed choices, Format and Edition, then its beats’ pictures (245b). Pictures counts them wide and tall, as 235d does. A beat with a Tall picture fills the phone upright; one without shows its wide picture whole (P18 rule 5), so the count of wide-only beats is data, beside Make tall, which opens 235’s Tall flow for those beats. Size is 235d’s. Voices counts the voiced lines; the rest play as text, as in 174.'],
  ['One document, one evaluator', 'The story document is compiled from routing by the same contracts code that the web package embeds (SPEC-063 R-23): facts with their values and starting values, choices with their conditions and what they remember, what each scene shows when, and the endings. It carries no fact labels, since a listener is never shown the facts (P18 call 23). Before the file is kept, every route replays through the compiled document, and the read-back line says so: 37 of 37 routes · 2 endings (245d).'],
  ['Not made: each blocker in one clause', 'A blocker is one clause with the press that clears it, as in 233d (245c). The sheet adds the story’s own: a reachable scene with no clip; a state-dependent dead end from Story facts’ findings (240 rule 16), with Show to see the route that reaches it; and a picture or clip that disagrees with a fact (240 rule 12). Make package waits until none is left. A closed choice without a reason is not a blocker: it is hidden (call 3).'],
  ['Made, beside the world’s releases', 'The package with its size, Show in folder and its SHA-256 in full, the read-back line, then the world’s releases in order, as in 236e: the edition, the album, and the story, each a package of its own (245d). A story is a production package beside the edition, so a world’s audiobook is never downloaded again for it (Player call 21). Publishing stays the owner’s steps: upload it under its new name, pin it as the production’s story, and publish the list.'],
  ['Calls for the owner', '1 · A story is exported as its own production package beside the world’s edition, never inside it (Player P18 call 21): drawn so. 2 · The export compiles routing to one story document with the evaluator the web package already uses, and replays every route through it before the file is kept: drawn so. 3 · A closed choice without a reason never blocks an export; it is hidden: drawn so. 4 · The web package stays beside Arke Player in the same sheet: drawn so.'],
  ['Sizes and copy', 'The sheet is 233’s, 720 wide, its row labels 112 wide for Closed choices. Labels only: Export, Web package, Arke Player, World, Story, Closed choices, Clips, Shape, Pictures, Size, Voices, Format, Edition, Make tall, Make package, Go to, Show, Show in folder, Copy, Read back, Make again, Done, Edition, Album, Story. Counts, lengths, shapes, sizes, dates and the format are data.'],
  ['Implementation boundary', 'Spec: SPEC-058 revision 12, R-79 – R-90 (the story package, the arke-story document, its route fixtures, the list’s story pin, installing, Export → Arke Player for a story and publishing it), and SPEC-063 revision 13, R-27 (the Arke Player profile). Reused: the Export sheet, Activity, read-back and Publications (233), picture shapes and Size (235), the releases list (236), the production package (238, SPEC-058 R-68), the interactive web export’s compiler and evaluator (SPEC-063 R-23), and Story facts’ findings (240). New: the story package writer, its route replay at read-back, and the sheet’s two kinds for a story.'],
];

const turn = `<section class="dv-turn" id="t245"><div class="dv-thd"><a class="dv-tid" href="#t245">245</a><span class="dv-tname">Export &#8594; Arke Player for an interactive story &#183; an interactive movie or a visual novel as its own package, its story compiled from routing and every route replayed before it is kept (extends <a class="dv-oid" href="#t233">233</a>, <a class="dv-oid" href="#t235">235</a>, <a class="dv-oid" href="#t236">236</a>, <a class="dv-oid" href="#t238">238</a>, <a class="dv-oid" href="#t240">240</a>; Player P18)</span></div><p class="dv-next">28 October 2026 · Proposed · ${frames.length} HTML drawings. <a href="story-export-245.review.html">Review page</a> · <a href="story-export-245.notes.md">Notes</a></p><div class="dv-opts">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${f.title}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: “First Contact’s export at full size” · “a story released a scene at a time” · “Export → Arke Player on a phone”</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t245">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(next);
} else {
  // Newest first: place above the first turn numbered below 245, never above a newer one.
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 245);
  if (!below) throw new Error('No turn below 245 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
if (!master.includes(STYLE)) master = master.replace('<helmet>', '<helmet>\n' + STYLE);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN STORY EXPORT 245[\s\S]*?  \/\/ END STORY EXPORT 245(?:\r?\n)*/g, '\n');
const plain = title => title.replaceAll('&#8217;', '’').replaceAll('&#8594;', '→').replaceAll('&#183;', '·');
const entries = frames.map(f => `  { group: "Story export · turn 245", screen: ${JSON.stringify(plain(f.title))}, frame: "${f.id}", route: "Interactive / Export", status: "drawn", checked: "2026-10-28", controls: [], notes: ["Proposed 28 October 2026 with Player P18."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN STORY EXPORT 245\n' + entries.join('\n') + '\n  // END STORY EXPORT 245\n');
const pageEntry = '{ file: "story-export-245.review.html", what: "Turn 245: Export → Arke Player for an interactive story — the Export sheet with Web package and Arke Player for an interactive movie and a visual novel, its blockers, and the package made and read back beside the world’s releases.", state: "proposed 28 October 2026; not built" }';
if (build.includes('file: "story-export-245.review.html"')) build = build.replace(/\{ file: "story-export-245\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(STYLE)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', STYLE + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 245: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
