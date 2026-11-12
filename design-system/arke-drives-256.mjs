// Turn 256 · Arke drives, the screen stays simple: a graphic novel made by asking (SPEC-064). Writes
// the review page and, unless --preview, places the turn in the design master and registers its
// frames with build-review.
//   node design-system/arke-drives-256.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './arke-drives-256.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const STYLE = '<link rel="stylesheet" href="graphic-novel-247.css"><link rel="stylesheet" href="prose-pages-249.css"><link rel="stylesheet" href="page-plan-254.css"><link rel="stylesheet" href="arke-drives-256.css">';
const STATUS = 'approved';
const frames = FRAMES.map(([letter, title, height, draw]) => ({ id: '256' + letter, title, width: 1360, height, markup: draw() }));
for (const f of frames) if (!/^<div class="gn247 gn249 (gn254 )?gn256"/.test(f.markup)) throw new Error(`${f.id}: frame root is not .gn256`);

write('arke-drives-256.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Arke drives · Turn 256</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 256 · ${STATUS} · Arke drives, the screen stays simple</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t253" style="color:inherit">Design master</a><a href="arke-drives-256.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${f.title}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote arke-drives-256.review.html: ${frames.length} frames.`); process.exit(0); }


export const rules = [
  ['Review status', '1 November 2026. Approved by the owner the same day (“Proceed to build”), calls 1 – 5 as drawn. The owner asked for a run making a graphic novel entirely in Arke, with Claude acting as the person, and to look out for where the screens could be simpler: most people will want Arke to drive and a simple screen that still looks capable. The run made The Ledger of Nights, redrawn, chapter 1 (installed 0.5.77 – 0.5.79). These are the places it asked a person to do what Arke could, or showed more than they needed. Nothing here is built.'],
  ['Ask only what is not settled', 'Setup reads the book, then offers the usual reading, page shape and pilot as one card, Use these or Change (256a). It asks a question only where the book or the person has not already settled it. Arke answers in a few lines, not an essay. Its pilot and the plan’s pilot are the same chapter.'],
  ['No settings Arke chooses', 'The setup plan shows no model panel (256a). Arke picks the image model the book’s style needs; the choice is in Settings for whoever wants it. A graphic novel never shows a video model.'],
  ['One press asks', 'Start the pilot, Plan with Arke, Draft with Arke and Fix send their ask to Arke at once. Nothing fills the chat box for a second press.'],
  ['Working is said where you look', 'While Arke plans or drafts a chapter, the chapter itself says so, with the time so far and Stop (256b). It never offers the same press again while the first is running.'],
  ['Mysteries are kept, not counted', 'The plan lists the questions the book means the reader to carry (256c). The cold read is given them and does not count them as faults; the draft bar shows them apart (256d). Fix on a lean asks Arke for a new plan that replaces the one waiting.'],
  ['Read first, details on demand', 'A draft opens as the reader will meet it: each panel’s words in order beside one line of what is drawn (256d). Details opens the script as 254d drew it. A layout is chosen from the page’s panels, never one template for every page.'],
  ['Decide in one place', 'A draft is kept or discarded in Pages only. The chat card says it is waiting in Pages and links there; it has no Approve of its own.'],
  ['Repair before reporting', 'A reply the studio cannot take is repaired by Arke and tried again before anyone sees it. A person sees a failure only when the second try fails too, said in their terms: what was not done and what to press.'],
  ['The book at a glance', 'A graphic novel’s Dashboard is its chapters and their stage in a word, Not planned, Plan kept, Draft waiting, Pages made, and the one next step for Arke (256e). It replaces the writing dashboard’s words today and Continue chapter.'],
  ['Calls for the owner', '1 · Setup offers the usual as one card and shows no model settings. 2 · Every press to Arke sends at once, and the chapter says when Arke is working. 3 · The plan keeps mysteries apart from faults, and Fix replaces a waiting plan. 4 · Drafts open as a reading view; a draft is decided in Pages alone. 5 · The Dashboard shows each chapter’s stage and one next step.'],
  ['Implementation boundary', 'Spec: SPEC-064 R-3, R-4, R-13, R-60 – R-66 (revisions 7 and 8). Reused: 249b setup, 247 and 251 Pages, 254 plan and draft, SPEC-050 cards. New with approval: the usual-settings card, the working state, kept mysteries in the plan and the read, the reading view, the graphic-novel dashboard, and repair before a failure is shown.'],
];

const turn = `<section class="dv-turn" id="t256"><div class="dv-thd"><a class="dv-tid" href="#t256">256</a><span class="dv-tname">Arke drives, the screen stays simple &#183; a graphic novel made by asking (SPEC-064; extends <a class="dv-oid" href="#t254">254</a>)</span></div><p class="dv-next">1 November 2026 · ${STATUS} · ${frames.length} HTML drawings. <a href="arke-drives-256.review.html">Review page</a> · <a href="arke-drives-256.notes.md">Notes</a></p><div class="dv-opts">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${f.title}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: “the same for an audio drama”</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t256">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(next);
} else {
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 256);
  if (!below) throw new Error('No turn below 256 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
const LINK = '<link rel="stylesheet" href="arke-drives-256.css">';
if (!master.includes(LINK)) master = master.replace('<helmet>', '<helmet>\n' + LINK);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN ARKE DRIVES 256[\s\S]*?  \/\/ END ARKE DRIVES 256(?:\r?\n)*/g, '\n');
const plain = title => title.replaceAll('&#8217;', '’').replaceAll('&#183;', '·');
const entries = frames.map(f => `  { group: "Arke drives · turn 256", screen: ${JSON.stringify(plain(f.title))}, frame: "${f.id}", route: "Graphic novel / Pages", status: "drawn", checked: "2026-11-01", controls: [], notes: ["Approved 1 November 2026."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN ARKE DRIVES 256\n' + entries.join('\n') + '\n  // END ARKE DRIVES 256\n');
const pageEntry = '{ file: "arke-drives-256.review.html", what: "Turn 256: Arke drives, the screen stays simple — the usual as one card, Arke working said on the chapter, mysteries kept apart, a reading view, the book at a glance.", state: "approved 1 November 2026; not built" }';
if (build.includes('file: "arke-drives-256.review.html"')) build = build.replace(/\{ file: "arke-drives-256\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(LINK)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', LINK + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 256: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
