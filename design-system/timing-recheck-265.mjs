import { readFileSync, writeFileSync } from 'node:fs';
import { frames } from './timing-recheck-265.frames.mjs';
const root = new URL('./', import.meta.url);
const style = '<link rel="stylesheet" href="timing-recheck-265.css">';
const turn = `<section class="dv-turn" id="t265"><div class="dv-thd"><a class="dv-tid" href="#t265">265</a><span class="dv-tname">Focused timing recheck - issue 2243</span></div><p class="dv-next">1 November 2026 · Design shown inline before implementation. <a href="timing-recheck-265.review.html">Review</a> · <a href="timing-recheck-265.notes.md">Scope and decisions</a></p><div class="dv-opts">${frames.map(frame => `<div class="dv-opt" id="${frame.id}"><div class="dv-olabel">${frame.id} · ${frame.title}</div><div class="dv-card" style="width:${frame.width}px;height:${frame.height}px;max-width:none">${frame.markup}</div></div>`).join('\n')}</div><p class="dv-rule">Keep the existing timing review and confirmation. Offer focused Prepare again for every unready block with saved audio, including recognition or boundary failures, alongside Review. Explicit local recheck only; unchanged confidence, complete-text and acoustic-boundary requirements. Phrase captions and estimated picture anchors remain available.</p></section>\n`;
for (const file of ['Arke Studio.dc.html', 'Arke Studio Prototype.dc.html']) {
  let html = readFileSync(new URL(file, root), 'utf8');
  const start = html.indexOf('<section class="dv-turn" id="t265">');
  if (start >= 0) {
    const end = html.indexOf('<section class="dv-turn"', start + 1);
    if (end < 0) throw Error('No safe turn boundary');
    html = html.slice(0, start) + turn + html.slice(end);
  } else {
    const next = html.indexOf('<section class="dv-turn" id="t264">');
    if (next < 0) throw Error('Missing prior turn');
    html = html.slice(0, next) + turn + html.slice(next);
  }
  if (!html.includes(style)) html = html.replace('<helmet>', '<helmet>\n' + style);
  writeFileSync(new URL(file, root), html);
}
