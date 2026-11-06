// Turn 272 · A new book's first steps (SPEC-064). Places the turn in both design documents and
// writes its review page.
//   node design-system/comic-first-steps-272.mjs
// Then: node design-system/check-master.mjs --record
import { readFileSync, writeFileSync } from 'node:fs';
import { frames } from './comic-first-steps-272.frames.mjs';
const root = new URL('./', import.meta.url);
const styles = ['graphic-novel-247', 'comic-style-248', 'prose-pages-249', 'pages-room-251', 'page-review-253', 'page-plan-254', 'arke-drives-256', 'comic-two-modes-269', 'comic-arke-270', 'comic-first-steps-272'].map(name => `<link rel="stylesheet" href="${name}.css">`);

const turn = {
  id: 272, slug: 'comic-first-steps-272', frames, before: 271,
  name: `A new book's first steps &#183; Every new book meets Arke, Mode and a next step (SPEC-064; amends <a class="dv-oid" href="#t256">256</a>)`,
  title: "A new book's first steps",
  rules: [
    `<b>Binding.</b> <code>Plan with Arke</code> is the main press on the door for <b>every</b> graphic novel, adapted or original. <code>Create and open day one</code> is gone for a graphic novel. The name is optional, and Arke proposes one.`,
    `<b>Binding.</b> The door's <b>foot does not move</b>. Picking a style changes what scrolls above it, never where the buttons are.`,
    `<b>Binding.</b> With nothing to read, setup <b>asks what happens in it</b>, and one line is enough. Words can be pasted or a file attached. Arke does not invent the story unasked.`,
    `<b>Binding.</b> An original book's plan has the same shape as an adaptation's: chapters, a page guess, one pilot. Each chapter says <b>what happens in it</b> where an adaptation names its source. <code>Create</code> writes those lines for Arke to plan from.`,
    `<b>Binding.</b> The usual card has <b>four rows</b>, Mode among them, for both kinds of book. <b>A new book is <code>Panel by panel</code> unless changed.</b> <code>Change</code> asks each one by example. Books that exist keep their mode.`,
    `<b>Binding.</b> The plan <b>names any character or place with no picture yet</b>. It does not stop for them and makes nothing here. No picture is made before <code>Create</code>.`,
    `<b>Binding.</b> <code>Start empty</code> writes <b>one chapter</b> and opens it in Pages, with <code>Plan with Arke</code> and <code>+ Page</code>. A chapter with nothing written has Arke ask what happens in it. Start empty needs a name, as Create does today.`,
    `<b>Binding.</b> The Dashboard's Next <b>does the next step</b> with one press, sent at once: <code>Plan with Arke</code> when not planned, <code>Draft with Arke</code> when the plan is kept, <code>Make with Arke</code> when a Panel by panel book has pages to make, which asks for <a class="dv-oid" href="#t270">270</a>'s priced card. A plan or draft waiting, a Whole page book's pages, and anything at fault say <code>Open in Pages</code>, since those are decided there.`,
    `<b>Binding.</b> The Dashboard's line counts what exists: <code>no pages yet</code> before anything is written, never <code>0 pages planned &#183; 0 made</code>. A book with no chapters left has Next offer <code>+ Chapter</code>.`,
  ],
};

const section = `<section class="dv-turn" id="t${turn.id}"><div class="dv-thd"><a class="dv-tid" href="#t${turn.id}">${turn.id}</a><span class="dv-tname">${turn.name}</span></div><p class="dv-next">6 November 2026 · Drawn for the owner's approval. <a href="${turn.slug}.review.html">Review</a> · <a href="${turn.slug}.notes.md">Scope and decisions</a></p><div class="dv-opts" style="margin-top:22px">${turn.frames.map(frame => `<div class="dv-opt" id="${frame.id}"><div class="dv-olabel"><a class="dv-oid" href="#${frame.id}">${frame.id}</a>${frame.title}</div><div class="dv-card" style="width:${frame.width}px;height:${frame.height}px;max-width:none">${frame.markup}</div></div>`).join('\n')}</div>${turn.rules.map(rule => `<p class="dv-rule">${rule}</p>`).join('')}<p class="dv-next">Samples are synthetic. Nothing here is built.</p></section>\n`;

for (const file of ['Arke Studio.dc.html', 'Arke Studio Prototype.dc.html']) {
  let html = readFileSync(new URL(file, root), 'utf8');
  const start = html.indexOf(`<section class="dv-turn" id="t${turn.id}">`);
  if (start >= 0) {
    const end = html.indexOf('<section class="dv-turn"', start + 1);
    if (end < 0) throw Error('No safe turn boundary');
    html = html.slice(0, start) + section + html.slice(end);
  } else {
    const next = html.indexOf(`<section class="dv-turn" id="t${turn.before}">`);
    if (next < 0) throw Error('Missing prior turn');
    html = html.slice(0, next) + section + html.slice(next);
  }
  for (const style of styles) if (!html.includes(style)) html = html.replace('<helmet>', '<helmet>\n' + style);
  writeFileSync(new URL(file, root), html);
}

const tokens = ['fonts', 'colors', 'typography', 'spacing', 'effects'].map(name => `<link rel="stylesheet" href="_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens/${name}.css">`).join('');
writeFileSync(new URL(`${turn.slug}.review.html`, root), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${tokens}${styles.join('')}<title>${turn.title} · turn ${turn.id}</title><style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv h2{font:var(--type-ui);margin:0 0 10px}.rv .fr{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.1);width:max-content}.rv header{display:flex;gap:12px;align-items:center;font:var(--type-ui)}.rv header button{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer}</style></head><body><div class="rv"><header><b>Turn ${turn.id} · for approval · ${turn.title}</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="${turn.slug}.notes.md" style="color:inherit">Notes</a></header>${turn.frames.map(frame => `<section id="${frame.id}"><h2>${frame.id} ${frame.title}</h2><div class="fr">${frame.markup}</div></section>`).join('\n')}</div></body></html>`);
console.log(`Placed turn ${turn.id}: ${turn.frames.length} frames, ${turn.rules.length} rules.`);
