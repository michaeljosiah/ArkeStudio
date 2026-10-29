// Turn 249 · Arke turns prose into pages (SPEC-064 R-3, R-4, R-13). Writes the review page and,
// unless --preview, places the turn in the design master and registers its frames with build-review.
//   node design-system/prose-pages-249.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './prose-pages-249.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const STYLE = '<link rel="stylesheet" href="graphic-novel-247.css"><link rel="stylesheet" href="prose-pages-249.css">';
const STATUS = 'proposed';
const frames = FRAMES.map(([letter, title, width, height, draw]) => ({ id: '249' + letter, title, width, height, markup: draw() }));
for (const f of frames) if (!f.markup.startsWith('<div class="gn247 gn249"')) throw new Error(`${f.id}: frame root is not .gn249`);

write('prose-pages-249.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prose into pages · Turn 249</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 249 · ${STATUS} · Arke turns prose into pages</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t249" style="color:inherit">Design master</a><a href="prose-pages-249.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${f.title}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote prose-pages-249.review.html: ${frames.length} frames.`); process.exit(0); }

export const rules = [
  ['Review status', '29 October 2026. Proposed. The owner chose this next on 29 October (“proceed”) after turn 248: today a graphic novel starts empty and every page is written by hand. SPEC-064 R-3, R-4 and R-13 already ask for it; turn 247a drew only the entry. Nothing here is built.'],
  ['The door is 248a', 'With Graphic novel picked and a story set in Adapt from, the primary press is Plan with Arke and nothing is created yet, as for an audio drama (turn 230b). Without a source it is Create, as today. The style chosen there rides into setup.'],
  ['Setup reads first, then asks three things by example', 'Setup is the audio drama’s conversation (249b). Arke reads every chapter whole and says so in one line. It asks reading direction and page shape by showing them, and whether to draft a pilot chapter first. Everything else arrives as one plan.'],
  ['One plan, a chapter for each chapter', 'The plan is the book’s name, its style, reading and shape, and a row per source chapter with a first guess at its pages and a first layout (249b). Page counts are proposals, never limits. Start the pilot creates the book and asks Arke for the pilot chapter; Change the plan keeps talking.'],
  ['A chapter with no pages offers Draft with Arke', 'In Pages, a chapter that has prose and no pages offers Draft with Arke beside + Page (249c). The prose is the chapter’s own, or its source chapter when the book was adapted.'],
  ['A draft is kept or discarded whole', 'Arke’s pages arrive as a draft: dashed in the strip, with a bar naming how many pages and from where, Keep and Discard (249d). Nothing in a draft can be made: Make page waits for Keep. Discard leaves the chapter as it was. This is SPEC-056 R-27’s draft, as an episode script is drafted.'],
  ['Every panel says where it came from', 'Each drafted panel carries its passage, ¶ 1–2, and the side shows the passage itself (249d). It is kept with the panel as an episode’s source is (SPEC-052 R-29), so the adaptation can be checked later.'],
  ['Calls for the owner', '1 · A graphic novel adapts from a story as an audio drama does: Adapt from, then Plan with Arke. 2 · Setup asks reading, page shape and a pilot chapter, then one plan. 3 · One chapter of pages for each source chapter, page counts a first guess. 4 · Arke drafts a chapter at a time; a draft is kept or discarded whole. 5 · Every panel cites its passage.'],
  ['Sizes and copy', 'Setup: the conversation, then the plan in a 520 column. Labels only: Plan with Arke, Back, Start the pilot, Change the plan, Draft with Arke, + Page, Keep, Discard, Make page. Arke’s questions are its own words; counts, passages and page guesses are data.'],
  ['Implementation boundary', 'Spec: SPEC-064 R-3, R-4, R-13. Reused: the production setup conversation and its review and create (SPEC-057 R-1 – R-9, turn 230), the proposal gate’s comic-script track, Pages (247). New with approval: graphic novel as a setup kind with its plan, an Arke action that drafts a chapter’s pages as a proposal, a source on each panel, and the draft bar in Pages.'],
];

const turn = `<section class="dv-turn" id="t249"><div class="dv-thd"><a class="dv-tid" href="#t249">249</a><span class="dv-tname">Arke turns prose into pages &#183; Adapt from a story, one plan, and a chapter drafted as pages you keep or discard (SPEC-064; extends <a class="dv-oid" href="#t247">247</a>, <a class="dv-oid" href="#t248">248</a>, <a class="dv-oid" href="#t230">230</a>)</span></div><p class="dv-next">29 October 2026 · ${STATUS} · ${frames.length} HTML drawings. <a href="prose-pages-249.review.html">Review page</a> · <a href="prose-pages-249.notes.md">Notes</a></p><div class="dv-opts">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${f.title}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: “an outline into pages” · “redraft one page”</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t249">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(next);
} else {
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 249);
  if (!below) throw new Error('No turn below 249 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
const LINK = '<link rel="stylesheet" href="prose-pages-249.css">';
if (!master.includes(LINK)) master = master.replace('<helmet>', '<helmet>\n' + LINK);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN PROSE PAGES 249[\s\S]*?  \/\/ END PROSE PAGES 249(?:\r?\n)*/g, '\n');
const plain = title => title.replaceAll('&#8217;', '’').replaceAll('&#183;', '·');
const entries = frames.map(f => `  { group: "Prose into pages · turn 249", screen: ${JSON.stringify(plain(f.title))}, frame: "${f.id}", route: "Graphic novel / Setup and Pages", status: "drawn", checked: "2026-10-29", controls: [], notes: ["Proposed 29 October 2026."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN PROSE PAGES 249\n' + entries.join('\n') + '\n  // END PROSE PAGES 249\n');
const pageEntry = '{ file: "prose-pages-249.review.html", what: "Turn 249: Arke turns prose into pages — Plan with Arke from a story, and a chapter drafted as pages to keep or discard.", state: "proposed 29 October 2026; not built" }';
if (build.includes('file: "prose-pages-249.review.html"')) build = build.replace(/\{ file: "prose-pages-249\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(LINK)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', LINK + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 249: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
