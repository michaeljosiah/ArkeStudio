// Turn 251 · Pages uses the window, and says what it is doing (issues 2259, 2260; SPEC-064). Writes
// the review page and, unless --preview, places the turn in the design master and registers its
// frames with build-review.
//   node design-system/pages-room-251.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './pages-room-251.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const STYLE = '<link rel="stylesheet" href="graphic-novel-247.css"><link rel="stylesheet" href="pages-room-251.css">';
const STATUS = 'proposed';
const frames = FRAMES.map(([letter, title, width, height, draw]) => ({ id: '251' + letter, title, width, height, markup: draw() }));
for (const f of frames) if (!f.markup.startsWith('<div class="gn247 gn251"')) throw new Error(`${f.id}: frame root is not .gn251`);

write('pages-room-251.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pages uses the window · Turn 251</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 251 · ${STATUS} · Pages uses the window, and says what it is doing</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t251" style="color:inherit">Design master</a><a href="pages-room-251.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${f.title}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote pages-room-251.review.html: ${frames.length} frames.`); process.exit(0); }

export const rules = [
  ['Review status', '29 October 2026, proposed. From a person’s run making Legend of Dumah’s chapter 1 in installed 0.5.70 and 0.5.71: Pages sat in a column about 1,075 px wide in a 2,700 px window, the made page about 400 px wide, the script’s lines cut off (issue 2260); and nothing on the page said it was being made or checked, a second press answered “making this page already”, a remade take hid behind the old one and a check that could not run said only “the read failed” (issue 2259). Nothing here is built.'],
  ['Pages fills the window', 'Pages takes the whole content area at any window size, with no centred column (251a). The strip stays 136. The page column is exactly as wide as the page needs to stand at full height above its verdict, takes and actions. The script column takes the rest, never under 440. At 1360 × 850 that is 247b’s 420 side; at 1920 × 1080 the page stands about 800 tall.'],
  ['Accept is always in view', 'The verdict, the takes and Accept or Make again sit directly under the page, inside the window, without scrolling (251a). Findings, when there are any, follow them; the page shrinks before the actions leave the window.'],
  ['Making shows on the page and in the strip', 'While a page is being made, the page shows Making with the take and the time so far, its thumbnail spins, and Make page reads Making and cannot be pressed again (251b). The press itself is the only start; no message answers a second press.'],
  ['A new take is shown when it lands', 'A take that lands becomes the shown take unless the author picked another while it was being made. While its lettering is read, the page and the verdict line say Checking and Accept waits for the verdict (251c).'],
  ['Not checked says why, and the way out', 'A check that cannot run says why in one clause, the author’s terms: the reader can’t see pictures, no reader is on, the reader timed out. When a setting fixes it, one button opens that setting: Choose reader opens Settings › Harness at the lettering reader, and the page is checked again once a reader is chosen (251d). A reason no setting fixes, such as a time-out, offers Check again instead. Not checked is never a pass; Accept anyway stays.'],
  ['Calls for the owner', '1 · Pages fills the window; the page stands at full height and the script takes the rest. 2 · Accept is always in view under the page. 3 · Making and Checking show on the page and in the strip, not as an error. 4 · A new take is shown when it lands. 5 · Not checked says why in one clause, with one button to fix it.'],
  ['Sizes and copy', 'Strip 136; script at least 440; page column = page height × the page’s shape + 36. Labels only: Making, Take 1 of up to 3 and the time, Checking lettering, Not checked, the reason, Choose reader. Counts, times and model names are data.'],
  ['Implementation boundary', 'Spec: SPEC-064 R-24 – R-31 (making, the check, takes). Issues 2259 and 2260. Reused: Pages (247b – 247e), the take record’s making list and its verification status, Settings › Harness’s per-agent models. New with approval: the fill sizing, the making and checking states on the page and thumbnail, showing a landed take, and reasons for an unread check.'],
];

const turn = `<section class="dv-turn" id="t251"><div class="dv-thd"><a class="dv-tid" href="#t251">251</a><span class="dv-tname">Pages uses the window, and says what it is doing &#183; the page at full height, Making and Checking on the page, a reason for Not checked (issues 2259, 2260; extends <a class="dv-oid" href="#t247">247</a>)</span></div><p class="dv-next">29 October 2026 · ${STATUS} · ${frames.length} HTML drawings. <a href="pages-room-251.review.html">Review page</a> · <a href="pages-room-251.notes.md">Notes</a></p><div class="dv-opts">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${f.title}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: “click the page to read it large”</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t251">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(next);
} else {
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 251);
  if (!below) throw new Error('No turn below 251 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
const LINK = '<link rel="stylesheet" href="pages-room-251.css">';
if (!master.includes(LINK)) master = master.replace('<helmet>', '<helmet>\n' + LINK);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN PAGES ROOM 251[\s\S]*?  \/\/ END PAGES ROOM 251(?:\r?\n)*/g, '\n');
const plain = title => title.replaceAll('&#8217;', '’').replaceAll('&#183;', '·');
const entries = frames.map(f => `  { group: "Pages uses the window · turn 251", screen: ${JSON.stringify(plain(f.title))}, frame: "${f.id}", route: "Graphic novel / Pages", status: "drawn", checked: "2026-10-29", controls: [], notes: ["Proposed 29 October 2026."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN PAGES ROOM 251\n' + entries.join('\n') + '\n  // END PAGES ROOM 251\n');
const pageEntry = '{ file: "pages-room-251.review.html", what: "Turn 251: Pages uses the window, and says what it is doing — the page at full height, Making and Checking, a reason for Not checked.", state: "proposed 29 October 2026; not built" }';
if (build.includes('file: "pages-room-251.review.html"')) build = build.replace(/\{ file: "pages-room-251\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(LINK)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', LINK + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 251: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
