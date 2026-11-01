// Turn 254 · Adapt before drawing: the page plan and the cold read of a draft (SPEC-064 R-60 – R-66,
// revision 8). Writes
// the review page and, unless --preview, places the turn in the design master and registers its
// frames with build-review.
//   node design-system/page-plan-254.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './page-plan-254.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const STYLE = '<link rel="stylesheet" href="graphic-novel-247.css"><link rel="stylesheet" href="prose-pages-249.css"><link rel="stylesheet" href="page-plan-254.css">';
const STATUS = 'proposed';
const frames = FRAMES.map(([letter, title, height, draw]) => ({ id: '254' + letter, title, width: 1360, height, markup: draw() }));
for (const f of frames) if (!f.markup.startsWith('<div class="gn247 gn249 gn254"')) throw new Error(`${f.id}: frame root is not .gn254`);

write('page-plan-254.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Adapt before drawing · Turn 254</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 254 · ${STATUS} · Adapt before drawing</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t253" style="color:inherit">Design master</a><a href="page-plan-254.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${f.title}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote page-plan-254.review.html: ${frames.length} frames.`); process.exit(0); }


export const rules = [
  ['Review status', '1 November 2026, proposed. The owner read The Ledger of Nights, drawn, and found parts that made no sense and did not flow. Arke had drafted straight from the prose, faithful to it and written for someone who knew the novel, and nothing read the draft as a reader would. SPEC-064 revision 8 adds a page plan (R-60 – R-63) and a cold read of the script (R-64 – R-66); the owner asked for both in one turn. Nothing here is built.'],
  ['Plan first', 'A chapter with no pages offers Plan with Arke first (254a). Draft with Arke appears once a plan is kept (254c). + Page still starts a page by hand, with no plan.'],
  ['The plan is three lists', 'Passages, each with Keep, Cut, Merge, Show or Invent and a reason of a few words; Pages, each with what changes and the turn it ends on; and what the reader knows, with the page that shows or names it (254b). Keep or Discard, as a draft is.'],
  ['A cut names what leans on it', 'A line on a planned page that relies on a cut passage, or on anything the reader has not been shown, is named under Passages with its page, and Fix asks Arke to settle it (254b). Keep is still allowed; the line stays named.'],
  ['The draft is read cold before you see it', 'A reader that has only the pages, never the prose, reads every draft. Arke redrafts at most twice for what it finds. What is left shows as a count on the draft bar, a list under it, and a mark on the page and the panel, with the question a reader would ask (254d).'],
  ['Kinds', 'Who, What, Why and Voice block: a person not shown or named, a thing not set up, an act with no reason, a caption nobody can place. Where, Picture and Load warn. A draft with something blocking offers Keep anyway in place of Keep, and records what it kept.'],
  ['Not read says why', 'With no script reader the bar says Not read and why, with Choose reader and Keep anyway (254e). Not read is never a pass.'],
  ['Calls for the owner', '1 · Plan with Arke comes before Draft with Arke. 2 · The plan is passages, pages and what the reader knows. 3 · A line that leans on a cut is named in the plan. 4 · Every draft is read cold; what is left is marked on the page with the reader’s question. 5 · Blocking findings turn Keep into Keep anyway.'],
  ['Sizes and copy', 'The plan takes the editor and side columns; rows 40 – 42; verdict chips 22. Labels only: Plan with Arke, Page plan, Passages, Pages, The reader knows, ends:, Fix, Keep, Discard, Change, 1 to fix, Not read, Choose reader, Keep anyway, and the kinds. Passages, pages, names and questions are data.'],
  ['Implementation boundary', 'Spec: SPEC-064 R-60 – R-66 (revision 8). Reused: Pages (247b, 249c, 249d), the draft bar and Keep / Discard of a proposal, SPEC-052’s adaptation record and verdicts, Settings › Harness’s per-agent models. New with approval: the plan in Pages, its three lists and the named leans, the script reader and its marks on a draft, Keep anyway on a draft.'],
];

const turn = `<section class="dv-turn" id="t254"><div class="dv-thd"><a class="dv-tid" href="#t254">254</a><span class="dv-tname">Adapt before drawing &#183; a page plan before Arke drafts, and a cold read of every draft (SPEC-064 revision 8; extends <a class="dv-oid" href="#t249">249</a>)</span></div><p class="dv-next">1 November 2026 · ${STATUS} · ${frames.length} HTML drawings. <a href="page-plan-254.review.html">Review page</a> · <a href="page-plan-254.notes.md">Notes</a></p><div class="dv-opts">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${f.title}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: “read the whole book cold before export”</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t254">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(next);
} else {
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 254);
  if (!below) throw new Error('No turn below 254 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
const LINK = '<link rel="stylesheet" href="page-plan-254.css">';
if (!master.includes(LINK)) master = master.replace('<helmet>', '<helmet>\n' + LINK);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN PAGE PLAN 254[\s\S]*?  \/\/ END PAGE PLAN 254(?:\r?\n)*/g, '\n');
const plain = title => title.replaceAll('&#8217;', '’').replaceAll('&#183;', '·');
const entries = frames.map(f => `  { group: "Adapt before drawing · turn 254", screen: ${JSON.stringify(plain(f.title))}, frame: "${f.id}", route: "Graphic novel / Pages", status: "drawn", checked: "2026-11-01", controls: [], notes: ["Proposed 1 November 2026."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN PAGE PLAN 254\n' + entries.join('\n') + '\n  // END PAGE PLAN 254\n');
const pageEntry = '{ file: "page-plan-254.review.html", what: "Turn 254: adapt before drawing — a page plan of passages, pages and what the reader knows, then a cold read of every draft.", state: "proposed 1 November 2026; not built" }';
if (build.includes('file: "page-plan-254.review.html"')) build = build.replace(/\{ file: "page-plan-254\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(LINK)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', LINK + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 254: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
