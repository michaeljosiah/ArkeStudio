// Turn 227 · the chapter page, full width. Writes the review page and, unless --preview, places the
// turn in the design master and registers its frames with build-review.
//   node design-system/chapter-page-227.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES } from './chapter-page-227.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const STYLE = '<link rel="stylesheet" href="chapter-page-227.css">';

const frames = FRAMES.map(([letter, title, width, height, kind, draw]) => ({ id: '227' + letter, title, width, height, kind, markup: draw() }));

write('chapter-page-227.review.html', `<!doctype html><html lang="en" class="dark" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chapter page · Turn 227</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${STYLE}
<style>body{margin:0;background:#131313;color:#ededed;font-family:var(--font-sans)}html:not(.dark) body{background:#EFEEEB;color:#1a1a1a}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv h2 a{color:inherit}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(255,255,255,.08);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #555;background:none;color:inherit;cursor:pointer}</style></head>
<body><div class="rv"><header><b>Turn 227 · revision 2 · a writing room and a Chapter view</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="Arke%20Studio.dc.html#t227" style="color:inherit">Design master</a></header>
${frames.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${esc(f.title)}</h2><div class="fr">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote chapter-page-227.review.html: ${frames.length} frames.`); process.exit(0); }

export const rules = [
  ['Review status', '15 October 2026. Revision 2, drawn for review; nothing is built. Revision 1 put the hero and cast above the prose, which left a writer about 380 px of page on a 900 px screen. The owner asked for a chapter overview separate from the manuscript, and for a manuscript editor better than Obsidian. The drawings use Na love or Juju’s public design assets; the prose is written for the drawing.'],
  ['Two pages', 'A chapter has four views: Chapter, Manuscript, Audiobook and Audio Studio. Opening a chapter lands on Manuscript (owner’s choice, 15 October 2026); a chapter with no words always does. Chapter is the production home: everything the side column held, plus the hero and cast. Manuscript is the writing room and holds nothing else.'],
  ['Full width', 'Both pages fill the centre column like Dashboard and Chapters. Remove the 940 px cap (chapter-responsive.css, --content-max-chapter). Width never goes to the line: the prose keeps a measure of 660 px under 2000 px wide and 760 at 2000 and above; 600 on a Fold.'],
  ['The writing bar', 'The only chrome above the page is one 56 px bar: Brief, previous and next chapter, the four views, the chapter goal (a ring, words and goal), Focus, Compare versions and ⋯. ⋯ holds the speaker and picture margins (both off by default here), Markdown source and Find. The chapter number and title are the top of the document, edited in place, and scroll away with it. The foot keeps Saved · v<version> and the words written today.'],
  ['Linked names', 'The editor recognises the world’s people and places in the prose from sheet names, short names and aliases, and underlines them: a character in its book speaker colour, a place dotted and neutral (227a). Hovering, or a long press on touch, opens a card: face, name, role, lines in this chapter, first and last seen, chapters, the voice with a sample, Open and Ask Arke (227b). Recognition is decoration: nothing is written into the Markdown. Two sheets sharing a name show both in the card.'],
  ['@ inserts a name', 'Typing @ opens the world at the caret: this chapter’s people first, then the rest, then places after a rule (227c). Choosing one inserts the plain name (the short name where the sheet has one), never a link syntax.'],
  ['/ commands', 'The slash menu puts Arke first: Continue, Describe… and Dialogue for…, then the existing format commands, including Scene break (227d). Labels only; no line under an item.'],
  ['Arke edits in the page', 'An Arke edit to the manuscript, from the slash menu, the selection tray (Rewrite, Expand, Tighten, Ask) or Arke’s dock, arrives as tracked edits in the prose: removed words struck, added words marked (227e). Each edit is kept or refused where it sits; the set is held at the foot with the ask’s name, the count, the change in words, Refuse all and Keep all. Nothing is saved until kept, and keeping saves a new version. This is turn 173’s grammar at every width.'],
  ['Compare versions', 'Compare versions puts two versions side by side: the older on the left, quiet, with Restore; the current on the right with its changes marked against the older (227f). Each head picks its version.'],
  ['Focus', 'Focus (the bar’s button or F11) makes the window the page: titlebar, rails, bar, foot and Arke hide. The paragraph with the caret is full strength and the rest at 26%; the caret’s line holds at the middle of the window as the writer types. Linked-name underlines hide. A thin goal track and today’s words sit at the foot. Esc leaves (227g). With reduced motion the page does not glide.'],
  ['Type steps', 'The prose is --text-lg under 2000 px and --text-xl at 2000 and above, with the title one step larger (227h); --text-md on a phone. Wider windows get larger type and calmer margins, never longer lines.'],
  ['Brief', 'Brief is the writer’s reference beside the page: synopsis, point of view and when, the faces in this chapter and After this chapter. A 320 px column toggled from the bar; docked open by default at 2000 px and wider (227h).'],
  ['The Chapter view', 'Chapter keeps revision 1’s hero (the chapter picture fading in; a picture the author set, else the first passage picture, else none) and book strip, then the cast as faces, each opening its voice card (227i, 227j). Below: progress as four steps in order (Written, Cast, Read, Mixed), each with its state and one action; the chapter’s pictures with Illustrate; After this chapter with Derive again; Versions, with overview moved when true. It replaces the side column and its Notes.'],
  ['The cast and voices', 'The cast is the narrator then each speaker in order of first line: a face ringed in its speaker colour, first name and line count. A face opens its voice card (popover on desktop, sheet on a phone): portrait, full name, lines here, the voice with a sample and Change, Direction, This book only and Open character. “Effective character direction” is not on the surface.'],
  ['Narrower widths', 'On a Fold the writing room keeps the bar and a 600 px page (227k). On a phone the bar is back, title, goal and ⋯ (which carries the views); while typing, a format bar rides above the keyboard: bold, italic, @, /, scene break, Arke and hide keyboard (227l). Chapter on a phone is the picture header, faces, progress and pictures, with Write and Listen held at the foot (227m, 227n).'],
  ['Empty chapter', 'A chapter with no words opens in Manuscript at its title, with the placeholder Start writing and a goal of 0 (227o).'],
  ['Implementation boundary', 'New data: a per-chapter goal and a chosen chapter picture. Linked names are recognised in the client from sheets already in the read model. Tracked Arke edits reuse the coordinator’s existing proposal path. Audiobook and Audio Studio keep their approved designs (turns 194–209, 226). Design only; no private specification is amended.'],
];

const turn = `<section class="dv-turn" id="t227"><div class="dv-thd"><a class="dv-tid" href="#t227">227</a><span class="dv-tname">The chapter · a writing room and a Chapter view</span></div><p class="dv-next">15 October 2026 · Revision 2 · For review · ${frames.length} HTML drawings. <a href="chapter-page-227.review.html">Review page</a> · <a href="chapter-page-227.notes.md">Notes</a></p><div class="dv-opts">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${esc(f.title)}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}</section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t227">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + master.slice(next);
}
const first = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0);
if (!first || Number(first[1]) >= 227 && start < 0) throw new Error(`Top turn is t${first?.[1]}; renumber before inserting`);
master = master.slice(0, first.index) + turn + master.slice(first.index);
if (!master.includes(STYLE)) master = master.replace('<helmet>', '<helmet>\n' + STYLE);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN CHAPTER PAGE 227[\s\S]*?  \/\/ END CHAPTER PAGE 227(?:\r?\n)*/g, '\n');
const entries = frames.map(f => `  { group: "Chapter · turn 227 · revision 2", screen: ${JSON.stringify(f.title)}, frame: "${f.id}", route: "Story / Chapters / chapter", status: "drawn", checked: "2026-10-15", controls: [], notes: ["For review; not built."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN CHAPTER PAGE 227\n' + entries.join('\n') + '\n  // END CHAPTER PAGE 227\n');
const pageEntry = '{ file: "chapter-page-227.review.html", what: "Turn 227 revision 2: the Manuscript as a writing room (linked names, @ and / menus, Arke edits in the page, compare, focus, Brief) and a Chapter view (hero, cast and voices, progress, pictures, continuity), desktop, ultrawide, Fold and phone.", state: "for review" }';
if (build.includes('file: "chapter-page-227.review.html"')) build = build.replace(/\{ file: "chapter-page-227\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(STYLE)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', STYLE + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered turn 227: ${frames.length} frames, ${rules.length} rules. Run check-master --record and build-review next.`);
