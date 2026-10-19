// Turn 231 · the Stage in the page, and after Build. Writes the review page and, unless --preview,
// places the turn in the design master and registers its frames with build-review.
//   node design-system/stage-231.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './stage-231.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
// 231 draws with 229's parts, so it needs 229's sheet beside its own.
const STYLE = '<link rel="stylesheet" href="stage-231.css">';
const STYLE229 = '<link rel="stylesheet" href="stage-229.css">';
// The root carries data-screen-label: build-review and the shooting drivers find a frame by it.
const frames = FRAMES.map(([letter, title, width, height, markup]) => ({ id: '231' + letter, title, width, height, markup: markup.replace(/^<div class="st229 st231/, `<div data-screen-label="231${letter} ${esc(title)}" class="st229 st231`) }));
for (const f of frames) if (!f.markup.startsWith('<div data-screen-label=')) throw new Error(`${f.id}: frame root is not .st231`);

write('stage-231.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stage in the page · Turn 231</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLE229}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv>header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv>header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 231 · the Stage in the page · proposed</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t231" style="color:inherit">Design master</a><a href="stage-231.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${esc(f.title)}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote stage-231.review.html: ${frames.length} frames.`); process.exit(0); }

export const rules = [
  ['Review status', '19 October 2026. Proposed. It closes what turn 229 left undrawn and #1865’s review found: the Stage inside the page, and the Stage after Build. The owner settled four calls before drawing: the Stage is its own workspace in the page, Quick layout waits for Keep, the Bench sends the plate and the cast’s pictures, and the plate picker lists locations first. The viewport pictures are turn 229’s renders.'],
  ['The Stage in the page', 'The Stage view is its own workspace (231a). The shot’s head folds to one line: the shot and its arrows, its title and length, Shot · Stage, This shot · Board 1, its version, and Full screen. The filmstrip and the production dock step away while Stage is open; the rail stays collapsed. The inspector keeps 264 px, and Export playblast and Render with this sit at its foot, never in a row of their own. Keep is not at the foot: it appears only while a draft waits, in the draft bar (231b). In a 1360 × 850 page the viewport is at least 1000 × 560 (231a draws 1004 × 580). Opening Chat narrows the viewport, never the inspector. Full screen remains, for presenting.'],
  ['After Build', 'While a draft waits, the draft bar takes the blockout line’s place, at the line’s height (231b): who made it (Arke’s blockout, Quick layout), then what it changed as counted chips built from the draft itself (added in the success colour, changed in the warning colour), then Arke’s notes, Discard and Keep. No sentence in the bar comes from the model. The viewport draws the draft in its own look, lights and atmosphere. The stage list marks each new line + and each changed line ~, and its header counts the changes. Export playblast and Render with this wait for Keep. Keep and Discard each clear the draft and its note.'],
  ['Arke’s notes', 'The model’s account of its build sits behind the bar’s disclosure, Arke’s notes (231c), over the viewport’s top-left with the round, calls and time. It is the model’s words, kept apart from the summary of what the draft did; a note that warns is drawn in the warning colour. The notes go with the draft.'],
  ['Quick layout', 'Quick layout is a draft like Build (231d): the same bar, named Quick layout, with Discard and Keep and no notes. Nothing from Arke or a preset lands until it is kept.'],
  ['Start from', 'What a build keeps is one select on the line, Start from: Nothing · This shot · The scene (231e). Nothing builds the set, cast and camera fresh; This shot keeps the shot’s own marks and camera; The scene keeps the scene’s shared blocking. Its default is The scene when the scene has blocking, This shot when only the shot has marks, else Nothing. A choice with nothing to keep is drawn but cannot be chosen, with what is missing beside it.'],
  ['One word for keeping', 'The action that keeps a change is Keep, everywhere on the Stage. “Keep blocking” is retired: as the build’s preserve choice it is Start from, and as the touch save button it is Keep.'],
  ['Lights in a draft', 'Add set and Add light stay open while a draft waits (231b). What is added joins the draft and is kept or discarded with it; Keep writes the draft’s lights, atmosphere and plate camera with its blocking.'],
  ['The plate picker', 'Add plate and Replace open the plate picker (231f): the world’s location pictures by name first, then Generate and Upload, then Show all pictures, off by default, for any other picture. The Stage’s own renders are never offered. Use plate places the pick.'],
  ['The Bench', 'A video take’s images are the plate and the cast’s pictures, numbered as 229h draws them. No blockout still rides as an image; a playblast or animatic rides only as Video, for camera and movement.'],
  ['Mesh', 'Mesh is deferred. The kit draws no Mesh until it is decided whether it means importing a model.'],
  ['Implementation boundary', 'Design only; SPEC-036 §1.13 is amended in the private set when a slice is built. Proposed order: the page workspace (231a), the draft bar and its summary with Quick layout and lights in a draft (231b–d), Start from and Keep (231e), the plate picker and the Bench references (231f).'],
];

const turn = `<section class="dv-turn" id="t231"><div class="dv-thd"><a class="dv-tid" href="#t231">231</a><span class="dv-tname">The Stage in the page, and after Build &#8212; its own workspace, a draft that says what it changed, Start from, and the plate picker (completes <a class="dv-oid" href="#t229">229</a>; #1865)</span></div><p class="dv-next">19 October 2026 · Proposed · ${frames.length} frames. <a href="stage-231.review.html">Review page</a> · <a href="stage-231.notes.md">Notes</a></p><div class="dv-opts" style="margin-top:22px">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${esc(f.title)}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: “the Stage in the page on a Fold” · “a draft over a board” · “Start from with a shot’s own marks”</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t231">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(next);
} else {
  // Newest first: place above the first turn numbered below 231, never above a newer one.
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 231);
  if (!below) throw new Error('No turn below 231 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
// After 229's sheet, never before it: 231 overrides 229 rules of equal specificity (.head's margin),
// and the review page loads them in that order too.
master = master.replace(STYLE + '\n', '');
master = master.includes(STYLE229) ? master.replace(STYLE229, STYLE229 + '\n' + STYLE) : master.replace('<helmet>', '<helmet>\n' + STYLE);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN STAGE 231[\s\S]*?  \/\/ END STAGE 231(?:\r?\n)*/g, '\n');
const entries = frames.map(f => `  { group: "Stage · turn 231", screen: ${JSON.stringify(f.title)}, frame: "${f.id}", route: "Scene / shot / Stage", status: "drawn", checked: "2026-10-19", controls: [], notes: ["Proposed 19 October 2026; completes turn 229 for #1865."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN STAGE 231\n' + entries.join('\n') + '\n  // END STAGE 231\n');
const pageEntry = '{ file: "stage-231.review.html", what: "Turn 231: the Stage as its own workspace in the page, the draft bar after Build and Quick layout with Arke’s notes apart, Start from, one Keep, lights in a draft, and the plate picker with locations first.", state: "proposed" }';
if (build.includes('file: "stage-231.review.html"')) build = build.replace(/\{ file: "stage-231\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(STYLE)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', STYLE + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 231: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
