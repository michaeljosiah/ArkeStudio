// Turn 275 · The Cut's Library, another production's shots (issue 2953). Writes the review page and,
// unless --preview, places the turn in the design master and registers its frames with build-review.
//   node design-system/cut-other-production-275.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './cut-other-production-275.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
// The turn draws inside turn 220's Cut shell, so its review page carries that shell's styles, then its own.
const STYLES = ['air-particles-220.css', 'air-particles-220.native.css'].map(n => `<link rel="stylesheet" href="${n}">`).join('');
const STYLE = '<link rel="stylesheet" href="cut-other-production-275.css">';
const frames = FRAMES.map(([letter, title, width, height, kind, draw]) => ({ id: '275' + letter, title, width, height, kind, markup: draw() }));
for (const f of frames) if (!f.markup.startsWith('<div class="air220 native220 cb275 ')) throw new Error(`${f.id}: frame root is not .cb275`);

write('cut-other-production-275.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Another production’s shots · Turn 275</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLES}${STYLE}
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 275 · approved · The Cut’s Library, another production’s shots</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t275" style="color:inherit">Design master</a><a href="cut-other-production-275.notes.md" style="color:inherit">Notes</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${esc(f.title)}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote cut-other-production-275.review.html: ${frames.length} frames.`); process.exit(0); }

export const rules = [
  ['Review status', '11 November 2026. Approved as drawn by the owner the same day; not built yet. Issue 2953 (epic 2952): a production’s Cut can use a shot made in another production of the same world.'],
  ['Where they sit', 'The Library’s one select, which today reads This world and then the author’s other worlds, gains a group above them: This world’s productions, each other production of the world by its title (275a). Other worlds follow under their own label. No new panel, sheet or screen; a world with one production and no other world shows no select, as now.'],
  ['This production', 'The select’s first option, the Library’s own list, reads This production. It read This world, which beside a group named This world’s productions says the wrong thing. The one change to shipped copy in this turn.'],
  ['A shot’s row', 'With a production chosen the list is its shots that have an accepted take, in story order (275b): the take’s picture, Shot n and the shot’s title, the scene and the take’s length. A shot with no accepted take, or whose take has no file of its own, is not listed. Search finds by the shot’s title; the filters and the Kind select stay and do nothing new.'],
  ['Add', 'A picked row offers Add to Library, where a row from another world offers Copy into this world. It copies the take’s file into this production’s Library. Sixteen at most in one request. Nothing is placed in the cut by adding.'],
  ['Once added', 'It is a file in this production’s Library like any other (275c): named for its production, scene and shot, with kind, length and from and the production’s title, and it places, appends and removes as an upload does. The select returns to This production with the new file first. It is a copy: a later take in the other production changes nothing here, and removing it here removes nothing there.'],
  ['None', 'A production with no accepted take reads No accepted takes, in the Library’s own empty state (275d).'],
  ['Not drawn', 'No mark on a shot’s row for one already added, no link back to the other production, no takes from another world’s productions, and no choice among a shot’s takes: the accepted one is the one.'],
  ['Sizes and copy', 'The shell, the 286-wide Library column, its rows, chips and selects are turn 220’s and the shipped Library’s. Labels only: This production, This world’s productions, Other worlds, Add to Library, from and a title, No accepted takes; Shot n, SC n and seconds as data.'],
  ['Implementation boundary', 'Issue 2953: a read of another production’s shots with accepted takes, in the same world only; a copy command that writes a new artifact in this production with its origin recorded and never writes the source production; the select’s option groups and the row in the Library. Reused: the Library’s browse list, its picked-row action, pending rows and empty state, and the artifact’s imported-from line.'],
];

const turn = `<section class="dv-turn" id="t275"><div class="dv-thd"><a class="dv-tid" href="#t275">275</a><span class="dv-tname">The Cut&#8217;s Library, another production&#8217;s shots &#183; the Library&#8217;s select lists the world&#8217;s other productions, and a shot with an accepted take is added as a file (issue 2953)</span></div><p class="dv-next">11 November 2026 · Approved · ${frames.length} HTML drawings. <a href="cut-other-production-275.review.html">Review page</a> · <a href="cut-other-production-275.notes.md">Notes</a></p><div class="dv-opts">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${esc(f.title)}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: “mark a shot already added” · “add a whole scene” · “a story production’s own shots beside another’s”</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t275">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(next);
} else {
  // Newest first: place above the first turn numbered below 275, never above a newer one.
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 275);
  if (!below) throw new Error('No turn below 275 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
if (!master.includes(STYLE)) master = master.replace('<helmet>', '<helmet>\n' + STYLE);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN CUT OTHER PRODUCTION 275[\s\S]*?  \/\/ END CUT OTHER PRODUCTION 275(?:\r?\n)*/g, '\n');
const entries = frames.map(f => `  { group: "Cut · turn 275", screen: ${JSON.stringify(f.title)}, frame: "${f.id}", route: "Production / Cut", status: "drawn", checked: "2026-11-11", controls: [], notes: ["Approved 11 November 2026 for issue 2953. Not built."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN CUT OTHER PRODUCTION 275\n' + entries.join('\n') + '\n  // END CUT OTHER PRODUCTION 275\n');
const pageEntry = '{ file: "cut-other-production-275.review.html", what: "Turn 275: the Cut’s Library lists the world’s other productions in its select, and a shot of theirs with an accepted take is added to this production’s Library as a file.", state: "approved 11 November 2026 (issue 2953)" }';
if (build.includes('file: "cut-other-production-275.review.html"')) build = build.replace(/\{ file: "cut-other-production-275\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(STYLE)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', STYLE + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 275: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
