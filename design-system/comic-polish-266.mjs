import { readFileSync, writeFileSync } from 'node:fs';
import { frames } from './comic-polish-266.frames.mjs';
const root = new URL('./', import.meta.url);
const style = '<link rel="stylesheet" href="comic-polish-266.css">';
const turn = `<section class="dv-turn" id="t266"><div class="dv-thd"><a class="dv-tid" href="#t266">266</a><span class="dv-tname">Graphic novel polish - issue 2256</span></div><p class="dv-next">1 November 2026 · Design shown inline before implementation. <a href="comic-polish-266.review.html">Review</a> · <a href="comic-polish-266.notes.md">Scope and decisions</a></p><div class="dv-opts">${frames.map(frame => `<div class="dv-opt" id="${frame.id}"><div class="dv-olabel">${frame.id} · ${frame.title}</div><div class="dv-card" style="width:${frame.width}px;height:${frame.height}px;max-width:none">${frame.markup}</div></div>`).join('\n')}</div><p class="dv-rule">Reuse an existing shipped comic-style picture for the Graphic novel kind card. Let the draft bar wrap its complete page count, chapter and review status when chat narrows Pages. Preserve the current comic dashboard, image-only setup and usual-settings choice. Keep the remaining change limited to missing polish.</p></section>\n`;
for (const file of ['Arke Studio.dc.html', 'Arke Studio Prototype.dc.html']) {
  let html = readFileSync(new URL(file, root), 'utf8');
  const start = html.indexOf('<section class="dv-turn" id="t266">');
  if (start >= 0) {
    const end = html.indexOf('<section class="dv-turn"', start + 1);
    if (end < 0) throw Error('No safe turn boundary');
    html = html.slice(0, start) + turn + html.slice(end);
  } else {
    const next = html.indexOf('<section class="dv-turn" id="t265">');
    if (next < 0) throw Error('Missing prior turn');
    html = html.slice(0, next) + turn + html.slice(next);
  }
  if (!html.includes(style)) html = html.replace('<helmet>', '<helmet>\n' + style);
  writeFileSync(new URL(file, root), html);
}
