// Turns 270 and 271 · Arke makes the book; Panels and Words, the shorter path (SPEC-064). Places both
// turns in both design documents and writes their review pages.
//   node design-system/comic-arke-270.mjs
// Then: node design-system/check-master.mjs --record
import { readFileSync, writeFileSync } from 'node:fs';
import { frames as arkeFrames } from './comic-arke-270.frames.mjs';
import { frames as panelFrames } from './comic-panels-271.frames.mjs';
const root = new URL('./', import.meta.url);
const styles = ['graphic-novel-247', 'pages-room-251', 'page-review-253', 'comic-two-modes-269', 'comic-arke-270'].map(name => `<link rel="stylesheet" href="${name}.css">`);

const turns = [{
  id: 270, slug: 'comic-arke-270', frames: arkeFrames, before: 269,
  name: `Arke makes the book &#183; One priced card, then only what needs you (SPEC-064; amends <a class="dv-oid" href="#t269">269</a>)`,
  title: 'Arke makes the book',
  rules: [
    `<b>Binding.</b> Arke <b>reads the book as it is</b>: its <code>Mode</code>, and for every panel whether it is made, accepted or at fault, with the review's words; for every page its lines placed and whether it is accepted. Arke never says a page is unchecked when a review is on the record.`,
    `<b>Binding.</b> <code>Make</code> is <b>one card for a chapter, a page or a panel</b>: pages, panels, lines, model, redraws and the most it can cost. <b>Approve is the author's press</b>, and replaces the line in <a class="dv-oid" href="#t269">269</a> that making panels stays on Pages alone. The Pages press stays too. A plan-paid model shows the plan in place of a price.`,
    `<b>Binding.</b> An approved card runs in order: make the panels not yet made, redraw a fault with what was found, then place the words on every page whose panels are all clear. It <b>never spends past the price approved</b>, and it <b>stops</b> at that price, at the redraw limit, or on <code>Stop</code>. A panel already started finishes; nothing new starts.`,
    `<b>Binding.</b> A panel the review clears is accepted as it is today. <b>Arke never accepts a panel at fault and never accepts a page.</b> <code>Accept 2 pages</code> on the finished card is the author's press, for pages with nothing left to decide.`,
    `<b>Binding.</b> The finished card lists <b>only what needs the author</b>, and each row opens that panel in Pages. Its counts are of what happened, never of what was asked.`,
    `<b>Binding.</b> <code>Change with Arke</code> <b>sends the panel and the review's words</b> in one press. Its card names the change to the script and prices a redraw of that panel alone. With no finding to send, it leaves the words in the box for the author to finish and sends nothing.`,
    `<b>Binding.</b> <code>Mode</code> and <code>Export</code> are cards as well. A mode card keeps every page made. An export card names its files and pages, and asks only for pages already accepted.`,
    `<b>Binding.</b> <b>Approving a card leaves its siblings ready to approve</b> unless it changed what they act on. A card that truly went out of date names what changed, in words, with no ids.`,
    `<b>Binding.</b> Asked for several things, Arke <b>carries on to the next</b> without being asked again, stopping only at a card or a question. It names a character or place with no picture on the card and offers to make the sheet first.`,
  ],
}, {
  id: 271, slug: 'comic-panels-271', frames: panelFrames, before: 270,
  name: `Panels and Words, the shorter path &#183; The fault in view, one Undo, lettering from the style (SPEC-064; amends <a class="dv-oid" href="#t269">269</a>)`,
  title: 'Panels and Words, the shorter path',
  rules: [
    `<b>Binding.</b> A panel's review sits <b>directly under the page</b>, joined to its verdict, and its words <b>wrap in full</b>. They are never cut off. The page gives up height so that the verdict, takes and actions stay on screen without scrolling at the app's smallest supported window.`,
    `<b>Binding.</b> Model and <code>Brief</code> are <b>one line at the foot</b>. The count there is panels made.`,
    `<b>Binding.</b> <code>1 of 2</code> counts the faults on this page and its arrow goes to the next. <code>Accept</code> and <code>Accept anyway</code> <b>move to the next fault</b>. With none left, the verdict offers <code>Words</code>.`,
    `<b>Binding.</b> A panel accepted with a fault is <b>amber, not red</b>, in the script and on the strip. What was found stays on the record and shows when the panel is opened.`,
    `<b>Binding.</b> While panels wait, <b>Words says how many and goes to them</b>. <code>Place with Arke</code> is not shown greyed.`,
    `<b>Binding.</b> Words has <b>one Undo</b>, stepping back the last change. A placing by Arke is one change.`,
    `<b>Binding.</b> The lines scroll. <b>Lettering, the verdict and <code>Accept page</code> stay at the foot</b>.`,
    `<b>Binding.</b> <b>Lettering colours come from the style.</b> Noir, Ink wash, Manga and Clean line print white captions and black sound words. The others keep cream and orange. The colours are the book's, in light and dark.`,
    `<b>Binding.</b> <code>Place with Arke</code> keeps <b>every balloon inside its panel</b> and aims each tail at the speaker without crossing a face. A placement that breaks this is corrected or asked for again before it is shown.`,
  ],
}];

const section = turn => `<section class="dv-turn" id="t${turn.id}"><div class="dv-thd"><a class="dv-tid" href="#t${turn.id}">${turn.id}</a><span class="dv-tname">${turn.name}</span></div><p class="dv-next">6 November 2026 · Drawn for the owner's approval. <a href="${turn.slug}.review.html">Review</a> · <a href="${turn.slug}.notes.md">Scope and decisions</a></p><div class="dv-opts" style="margin-top:22px">${turn.frames.map(frame => `<div class="dv-opt" id="${frame.id}"><div class="dv-olabel"><a class="dv-oid" href="#${frame.id}">${frame.id}</a>${frame.title}</div><div class="dv-card" style="width:${frame.width}px;height:${frame.height}px;max-width:none">${frame.markup}</div></div>`).join('\n')}</div>${turn.rules.map(rule => `<p class="dv-rule">${rule}</p>`).join('')}<p class="dv-next">Samples are synthetic. Nothing here is built.</p></section>\n`;

for (const file of ['Arke Studio.dc.html', 'Arke Studio Prototype.dc.html']) {
  let html = readFileSync(new URL(file, root), 'utf8');
  for (const turn of turns) {
    const start = html.indexOf(`<section class="dv-turn" id="t${turn.id}">`);
    if (start >= 0) {
      const end = html.indexOf('<section class="dv-turn"', start + 1);
      if (end < 0) throw Error('No safe turn boundary');
      html = html.slice(0, start) + section(turn) + html.slice(end);
    } else {
      const next = html.indexOf(`<section class="dv-turn" id="t${turn.before}">`);
      if (next < 0) throw Error('Missing prior turn');
      html = html.slice(0, next) + section(turn) + html.slice(next);
    }
  }
  for (const style of styles) if (!html.includes(style)) html = html.replace('<helmet>', '<helmet>\n' + style);
  writeFileSync(new URL(file, root), html);
}

const tokens = ['fonts', 'colors', 'typography', 'spacing', 'effects'].map(name => `<link rel="stylesheet" href="_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens/${name}.css">`).join('');
for (const turn of turns) {
  writeFileSync(new URL(`${turn.slug}.review.html`, root), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${tokens}${styles.join('')}<title>${turn.title} · turn ${turn.id}</title><style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head><body><div class="rv"><header><b>Turn ${turn.id} · for approval · ${turn.title}</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="${turn.slug}.notes.md" style="color:inherit">Notes</a></header>${turn.frames.map(frame => `<section id="${frame.id}"><h2>${frame.id} ${frame.title}</h2><div class="fr">${frame.markup}</div></section>`).join('\n')}</div></body></html>`);
  console.log(`Placed turn ${turn.id}: ${turn.frames.length} frames, ${turn.rules.length} rules.`);
}
