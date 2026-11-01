// Turn 253 · The page review: every take read as a picture as well as for its words (SPEC-064
// R-67 – R-73, revision 8). Writes
// the review page and, unless --preview, places the turn in the design master and registers its
// frames with build-review.
//   node design-system/page-review-253.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './page-review-253.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const STYLE = '<link rel="stylesheet" href="graphic-novel-247.css"><link rel="stylesheet" href="pages-room-251.css"><link rel="stylesheet" href="page-review-253.css">';
const STATUS = 'approved';
const frames = FRAMES.map(([letter, title, draw]) => ({ id: '253' + letter, title, width: 1360, height: 850, markup: draw() }));
for (const f of frames) if (!f.markup.startsWith('<div class="gn247 gn251 gn253"')) throw new Error(`${f.id}: frame root is not .gn253`);

write('page-review-253.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The page review · Turn 253</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 253 · ${STATUS} · The page review</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t253" style="color:inherit">Design master</a><a href="page-review-253.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${f.title}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote page-review-253.review.html: ${frames.length} frames.`); process.exit(0); }


export const rules = [
  ['Review status', '1 November 2026. Approved by the owner the same day (“Approved”), calls 1 – 5 as drawn. The owner read The Ledger of Nights, drawn, as published and asked why the pictures had been checked only for their words. The lettering check passed a caption about stopping a pen drawn over Maren at the rail, faces in the water no panel asked for and, before a remake, Bray without his collar; it failed the ledger’s own handwriting as extra (issue 2266). SPEC-064 revision 8 adds the page review (R-67 – R-73). Nothing here is built.'],
  ['Two checks, two lines', 'Every take shows two verdict lines under the page, one block: Lettering, then Picture (253a). Each line says pass, how many to fix, how many to look at, or not checked, and who read it. The page and its thumbnail take the worse of the two.'],
  ['Faults are boxed and listed', 'Picture faults are boxed on the page with their kind, as lettering faults are, and listed under the verdicts as kind, panel and a few words (253a). Kinds that block: Scene, People, Caption, Defect, Speaker. Accept waits for both checks; Make again and Accept anyway stay. Until it passes counts a picture fault as a fail.'],
  ['Writing in the scene is cleared, not hidden', 'Words the lettering check reads as extra are cleared when the panel’s description calls for that writing, a ledger, a notice, a sign. The row stays, struck through, with where it is (253b), so the author sees what was cleared and why. Writing no description calls for stays a fault.'],
  ['Warnings are looked at, not fixed', 'Likeness, Continuity and Layout are warnings (253c). Each has Seen. Accept is offered while they are open; an unseen warning stays on the page record and in chapter review.'],
  ['Not checked says why', 'With no page reviewer, or one that fails, the Picture line says Not checked and the reason (253d). Choose reviewer opens Settings › Harness at the page reviewer; Check again reads the take once a reviewer is set. Not checked is never a pass; Accept anyway stays.'],
  ['Checking', 'While a take is read, 251c’s band reads Checking until both verdicts are in; each line shows its own spinner. Not drawn again here.'],
  ['Calls for the owner', '1 · Two verdict lines, Lettering and Picture. 2 · Picture faults boxed and listed like lettering ones, and blocking. 3 · Cleared writing stays listed, struck through. 4 · Warnings take Seen and do not hold Accept. 5 · Not checked names the reason and offers Choose reviewer and Check again.'],
  ['Sizes and copy', 'Verdict lines 36 each in one bordered block; finding rows 36, kind column 76. The page column follows 251’s rule with the taller controls. Labels only: Lettering, Picture, to fix, to look at, as written, not checked, Seen, Choose reviewer, Check again, and the kinds. Panel numbers, names and model names are data.'],
  ['Implementation boundary', 'Spec: SPEC-064 R-67 – R-73 (revision 8), with R-17, R-21, R-30 and R-31 as amended. Reused: Pages (247b – 247e, 251a – 251d), the take record’s verification and acknowledged, the findings boxes, Settings › Harness’s per-agent models. New with approval: the second verdict line, the picture finding kinds, cleared writing, Seen, Choose reviewer.'],
];

const turn = `<section class="dv-turn" id="t253"><div class="dv-thd"><a class="dv-tid" href="#t253">253</a><span class="dv-tname">The page review &#183; every take read as a picture as well as for its words (SPEC-064 revision 8; extends <a class="dv-oid" href="#t251">251</a>)</span></div><p class="dv-next">1 November 2026 · ${STATUS} · ${frames.length} HTML drawings. <a href="page-review-253.review.html">Review page</a> · <a href="page-review-253.notes.md">Notes</a></p><div class="dv-opts">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${f.title}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: “show the script reader’s findings on a draft”</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t253">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(next);
} else {
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 253);
  if (!below) throw new Error('No turn below 253 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
const LINK = '<link rel="stylesheet" href="page-review-253.css">';
if (!master.includes(LINK)) master = master.replace('<helmet>', '<helmet>\n' + LINK);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN PAGE REVIEW 253[\s\S]*?  \/\/ END PAGE REVIEW 253(?:\r?\n)*/g, '\n');
const plain = title => title.replaceAll('&#8217;', '’').replaceAll('&#183;', '·');
const entries = frames.map(f => `  { group: "The page review · turn 253", screen: ${JSON.stringify(plain(f.title))}, frame: "${f.id}", route: "Graphic novel / Pages", status: "drawn", checked: "2026-11-01", controls: [], notes: ["Approved 1 November 2026."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN PAGE REVIEW 253\n' + entries.join('\n') + '\n  // END PAGE REVIEW 253\n');
const pageEntry = '{ file: "page-review-253.review.html", what: "Turn 253: the page review — Lettering and Picture verdicts, picture faults boxed, writing in the scene cleared, warnings seen, Not checked with a reason.", state: "approved 1 November 2026; not built" }';
if (build.includes('file: "page-review-253.review.html"')) build = build.replace(/\{ file: "page-review-253\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(LINK)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', LINK + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 253: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
