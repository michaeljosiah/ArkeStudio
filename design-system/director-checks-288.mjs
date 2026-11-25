// Turn 288 · Director's checks, drawn (extends 287). Writes the review page and, unless --preview,
// places the turn in the design master and registers its frames with build-review.
//   node design-system/director-checks-288.capture.mjs   (only after a change to the app's screens: the context)
//   node design-system/director-checks-288.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { receipt } from './director-checks-288.app.mjs';
import { FRAMES, esc } from './director-checks-288.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
// The app's own rules for the screens the turn stands in, then the turn's additions over them.
const APP = '<link rel="stylesheet" href="director-checks-288.app.css">';
const STYLE = '<link rel="stylesheet" href="director-checks-288.css">';
// The root carries data-screen-label: build-review and the shooting drivers find a frame by it.
const frames = FRAMES.map(([letter, title, width, height, markup]) => ({ id: '288' + letter, title, width, height, markup: markup.replace(/^<div class="app288/, `<div data-screen-label="288${letter} ${esc(title)}" class="app288`) }));
for (const f of frames) if (!f.markup.startsWith('<div data-screen-label=')) throw new Error(`${f.id}: frame root is not the app's`);
// Every frame sits in one master document, so an id a frame defines must be its own; the captured markup carries none.
for (const f of frames) if (/ id="/.test(f.markup)) throw new Error(`${f.id}: an id in a frame`);
// From turn 139 a frame sets type through the tokens only.
for (const f of frames) { const raw = f.markup.match(/\bfont(?:-size)?\s*:\s*(?:[0-9]{3}\s+)?[0-9]+(?:\.[0-9]+)?px/); if (raw) throw new Error(`${f.id}: a raw font size, ${raw[0]}`); }
// A frame points at nothing the master cannot load: every picture is a file beside it.
for (const f of frames) for (const [, ref] of f.markup.matchAll(/(?:src|poster)="([^"]*)"/g)) if (!ref.startsWith('assets/') || !fs.existsSync(path.join(here, ref))) throw new Error(`${f.id}: ${ref} is not a file in design-system/assets`);
// Balance, so no frame can close a tag of the master's.
for (const f of frames) for (const tag of ['div', 'section', 'span', 'button', 'aside', 'main', 'article', 'header', 'nav', 'dialog', 'label', 'footer']) {
  const open = (f.markup.match(new RegExp(`<${tag}\\b`, 'g')) ?? []).length, close = (f.markup.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
  if (open !== close) throw new Error(`${f.id}: ${open} <${tag}> and ${close} </${tag}>`);
}

write('director-checks-288.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Director's checks, drawn · Turn 288</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${APP}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv>header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv>header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 288 · approved 25 November 2026 · Director’s checks, drawn</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t288" style="color:inherit">Design master</a><a href="director-checks-287.notes.md" style="color:inherit">Notes (turn 287)</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${esc(f.title)}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote director-checks-288.review.html: ${frames.length} frames.`); process.exit(0); }

const { rules: rulesAt, next } = await import('./director-checks-288.rules.mjs');
const rules = rulesAt(receipt.commit);

const turn = `<section class="dv-turn" id="t288"><div class="dv-thd"><a class="dv-tid" href="#t288">288</a><span class="dv-tname">Director&#8217;s checks, drawn &#183; the look and the three lists on the app&#8217;s own screens (extends <a class="dv-oid" href="#t287">287</a>)</span></div><p class="dv-next">25 November 2026 · Approved by the owner · ${frames.length} frames: the app’s own screens, with the checks drawn into them. <a href="director-checks-288.review.html">Review page</a> · <a href="director-checks-287.notes.md">Notes</a></p><div class="dv-opts" style="margin-top:22px">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${esc(f.title)}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: ${esc(next)}</p></section>\n`;

// The section is balanced before it goes in: walked tag by tag, <div> and <section> come back to zero.
{
  let depth = 0;
  for (const m of turn.matchAll(/<(\/?)(div|section)\b[^>]*>/g)) { depth += m[1] ? -1 : 1; if (depth < 0) throw new Error('t288 closes a tag it did not open'); }
  if (depth !== 0) throw new Error(`t288 leaves ${depth} <div>/<section> open`);
}

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t288">');
if (start >= 0) {
  const after = master.indexOf('<section class="dv-turn"', start + 1);
  if (after < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(after);
} else {
  // Newest first: place above the first turn numbered below 288, never above a newer one.
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 288);
  if (!below) throw new Error('No turn below 288 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
// The app's rules before the turn's own: the turn's override them at equal weight.
for (const link of [STYLE, APP]) if (!master.includes(link)) master = master.replace('<helmet>', '<helmet>\n' + link);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN DIRECTOR CHECKS 288[\s\S]*?  \/\/ END DIRECTOR CHECKS 288(?:\r?\n)*/g, '\n');
const route = { a: 'Production / Dashboard / Production settings', b: 'Production / Generate (bench) / a shot', c: 'Production / Generate (bench) / a take', d: 'Production / Cut' };
const entries = frames.map(f => `  { group: "Director’s checks · turn 288", screen: ${JSON.stringify(f.title)}, frame: "${f.id}", route: "${route[f.id.slice(3)]}", status: "drawn", checked: "2026-11-25", controls: [], notes: ["Drawn 25 November 2026 from turn 287. Approved by the owner. Not built."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN DIRECTOR CHECKS 288\n' + entries.join('\n') + '\n  // END DIRECTOR CHECKS 288\n');
const pageEntry = '{ file: "director-checks-288.review.html", what: "Turn 288: Director’s checks, drawn. The production’s look as a card in Production settings, and the three lists of turn 287, each opened at a count beside the control it answers to: before a shot beside its press, which a hard failure holds; after a take beside its verdicts, with Trim and Remake; on the cut beside Export film.", state: "approved 25 November 2026; not built" }';
if (build.includes('file: "director-checks-288.review.html"')) build = build.replace(/\{ file: "director-checks-288\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
for (const link of [APP, STYLE]) if (!build.includes(link)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', link + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 288: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
