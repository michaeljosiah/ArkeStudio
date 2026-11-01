import { readFileSync, writeFileSync } from 'node:fs';
import { frames } from './words-review-261.frames.mjs';
const root = new URL('./', import.meta.url);
const style = '<link rel="stylesheet" href="words-review-261.css">';
const turn = `<section class="dv-turn" id="t261"><div class="dv-thd"><a class="dv-tid" href="#t261">261</a><span class="dv-tname">Saved Words review · issue 2242</span></div><p class="dv-next">1 November 2026 · Design shown inline before implementation. <a href="words-review-261.review.html">Review</a> · <a href="words-review-261.notes.md">Scope and decisions</a></p><div class="dv-opts">${frames.map(frame => `<div class="dv-opt" id="${frame.id}"><div class="dv-olabel">${frame.id} · ${frame.title}</div><div class="dv-card" style="width:${frame.width}px;height:${frame.height}px;max-width:none">${frame.markup}</div></div>`).join('\n')}</div><p class="dv-rule">Keep the saved Words dialog, raw transcript and raw diff. Separate ordinary case, quotation, punctuation, title separator and hyphenation differences from wording to review. Preserve possible initialisms, numbers, symbols, negation, repeats, omissions, direction words and uncertain spelling or names for listening. No audio acceptance, cache identity, acoustic alignment or paid-generation policy changes.</p></section>\n`;
for (const file of ['Arke Studio.dc.html', 'Arke Studio Prototype.dc.html']) {
  let html = readFileSync(new URL(file, root), 'utf8');
  const start = html.indexOf('<section class="dv-turn" id="t261">');
  if (start >= 0) {
    const end = html.indexOf('<section class="dv-turn"', start + 1);
    if (end < 0) throw Error('No safe turn boundary');
    html = html.slice(0, start) + turn + html.slice(end);
  } else {
    const next = html.indexOf('<section class="dv-turn" id="t260">');
    if (next < 0) throw Error('Missing prior turn');
    html = html.slice(0, next) + turn + html.slice(next);
  }
  if (!html.includes(style)) html = html.replace('<helmet>', '<helmet>\n' + style);
  writeFileSync(new URL(file, root), html);
}
