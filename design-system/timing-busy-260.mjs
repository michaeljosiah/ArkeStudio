import { readFileSync, writeFileSync } from 'node:fs';
import { frames } from './timing-busy-260.frames.mjs';
const root = new URL('./', import.meta.url);
const style = '<link rel="stylesheet" href="timing-busy-260.css">';
const turn = `<section class="dv-turn" id="t260"><div class="dv-thd"><a class="dv-tid" href="#t260">260</a><span class="dv-tname">Word timing busy state · issue 2241</span></div><p class="dv-next">1 November 2026 · Design shown inline before implementation. <a href="timing-busy-260.review.html">Review</a> · <a href="timing-busy-260.notes.md">Scope and decisions</a></p><div class="dv-opts">${frames.map(frame => `<div class="dv-opt" id="${frame.id}"><div class="dv-olabel">${frame.id} · ${frame.title}</div><div class="dv-card" style="width:${frame.width}px;height:${frame.height}px;max-width:none">${frame.markup}</div></div>`).join('\n')}</div><p class="dv-rule">Use the existing word timing panel and reason field. A Words check holds preparation for its production; the reply explicitly says nothing started and tells the author to retry after the check. No queued intent or concurrent recognizer is introduced. Each task keeps its own Stop. Read and status requests retain the explanation; reconnect refreshes the selected scope without preparing it.</p></section>\n`;
for (const file of ['Arke Studio.dc.html', 'Arke Studio Prototype.dc.html']) {
  let html = readFileSync(new URL(file, root), 'utf8');
  const start = html.indexOf('<section class="dv-turn" id="t260">');
  if (start >= 0) {
    const end = html.indexOf('<section class="dv-turn"', start + 1);
    if (end < 0) throw Error('No safe turn boundary');
    html = html.slice(0, start) + turn + html.slice(end);
  } else {
    const next = html.indexOf('<section class="dv-turn" id="t259">');
    if (next < 0) throw Error('Missing prior turn');
    html = html.slice(0, next) + turn + html.slice(next);
  }
  if (!html.includes(style)) html = html.replace('<helmet>', '<helmet>\n' + style);
  writeFileSync(new URL(file, root), html);
}
