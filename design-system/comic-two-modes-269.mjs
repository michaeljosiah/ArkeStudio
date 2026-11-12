// Turn 269 · Two ways to make a page (SPEC-064). Places the turn in both design documents and writes
// the review page.
//   node design-system/comic-two-modes-269.mjs
// Then: node design-system/check-master.mjs --record
import { readFileSync, writeFileSync } from 'node:fs';
import { frames } from './comic-two-modes-269.frames.mjs';
const root = new URL('./', import.meta.url);
const styles = ['graphic-novel-247', 'pages-room-251', 'page-review-253', 'comic-two-modes-269'].map(name => `<link rel="stylesheet" href="${name}.css">`);
const rules = [
  `<b>Binding.</b> A graphic novel has <b>one mode for the book</b>: <code>Whole page</code> or <code>Panel by panel</code>, chosen at setup and changed from <code>Mode</code> on Pages. Books that exist are Whole page. Changing mode <b>keeps every page already made</b>; the new mode applies to a page the next time it is made.`,
  `<b>Binding.</b> <code>Whole page</code> is <b>today's Pages, unchanged</b>: one image, words drawn by the model, both checks.`,
  `<b>Binding.</b> <code>Panel by panel</code> draws <b>each panel as its own image with no words</b>, then lays them out in code on the page's layout. One press makes every panel not yet made, at one price. A fault, a refusal or Make again touches <b>that panel alone</b>. The script's lines never reach the picture prompt.`,
  `<b>Binding.</b> Each panel takes the <b>picture review</b>, hand by hand. There is <b>no lettering check</b> in this mode: the words are the script's own text, set in type, so there is nothing to misread.`,
  `<b>Binding.</b> Words are a <b>layer over the art</b>, stored by line id with position, size and tail, and <b>read from the script</b> (R-38). Editing a line changes the balloon and redraws nothing. Shape follows the line's kind and can be changed. The book has one typeface from a short list.`,
  `<b>Binding.</b> <code>Place with Arke</code> places every unplaced line, or a whole chapter's with <code>Whole chapter</code>: clear of faces and hands, in reading order. It spends no picture credit, and its result is <b>ordinary balloons</b> the author can move. <code>Undo</code> takes all of one placing back. Making panels stays the author's press.`,
  `<b>Binding.</b> A page is <code>Accept page</code> when every panel is accepted and every line is placed. Read, Export and Arke Player then take it as <b>one finished image</b>, so readers and the Player need no change.`,
];
const turn = `<section class="dv-turn" id="t269"><div class="dv-thd"><a class="dv-tid" href="#t269">269</a><span class="dv-tname">Two ways to make a page &#183; Whole page, or Panel by panel with words placed after (SPEC-064; extends <a class="dv-oid" href="#t253">253</a>)</span></div><p class="dv-next">5 November 2026 · Drawn for the owner's approval. <a href="comic-two-modes-269.review.html">Review</a> · <a href="comic-two-modes-269.notes.md">Scope and decisions</a></p><div class="dv-opts" style="margin-top:22px">${frames.map(frame => `<div class="dv-opt" id="${frame.id}"><div class="dv-olabel"><a class="dv-oid" href="#${frame.id}">${frame.id}</a>${frame.title}</div><div class="dv-card" style="width:${frame.width}px;height:${frame.height}px;max-width:none">${frame.markup}</div></div>`).join('\n')}</div>${rules.map(rule => `<p class="dv-rule">${rule}</p>`).join('')}<p class="dv-next">Samples are synthetic. Nothing here is built.</p></section>\n`;
for (const file of ['Arke Studio.dc.html', 'Arke Studio Prototype.dc.html']) {
  let html = readFileSync(new URL(file, root), 'utf8');
  const start = html.indexOf('<section class="dv-turn" id="t269">');
  if (start >= 0) {
    const end = html.indexOf('<section class="dv-turn"', start + 1);
    if (end < 0) throw Error('No safe turn boundary');
    html = html.slice(0, start) + turn + html.slice(end);
  } else {
    const next = html.indexOf('<section class="dv-turn" id="t268">');
    if (next < 0) throw Error('Missing prior turn');
    html = html.slice(0, next) + turn + html.slice(next);
  }
  for (const style of styles) if (!html.includes(style)) html = html.replace('<helmet>', '<helmet>\n' + style);
  writeFileSync(new URL(file, root), html);
}
const tokens = ['fonts', 'colors', 'typography', 'spacing', 'effects'].map(name => `<link rel="stylesheet" href="_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens/${name}.css">`).join('');
writeFileSync(new URL('comic-two-modes-269.review.html', root), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${tokens}${styles.join('')}<title>Two ways to make a page · turn 269</title><style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head><body><div class="rv"><header><b>Turn 269 · for approval · Two ways to make a page</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="comic-two-modes-269.notes.md" style="color:inherit">Notes</a></header>${frames.map(frame => `<section id="${frame.id}"><h2>${frame.id} ${frame.title}</h2><div class="fr">${frame.markup}</div></section>`).join('\n')}</div></body></html>`);
console.log(`Placed turn 269: ${frames.length} frames, ${rules.length} rules.`);
