import { readFileSync, writeFileSync } from 'node:fs';
import { frames } from './manuscript-review-267.frames.mjs';
const root = new URL('./', import.meta.url);
const style = '<link rel="stylesheet" href="manuscript-review-267.css">';
const turn = `<section class="dv-turn" id="t267"><div class="dv-thd"><a class="dv-tid" href="#t267">267</a><span class="dv-tname">Manuscript review - issue 2198</span></div><p class="dv-next">2 November 2026 · Design shown inline and approved by the owner before implementation. <a href="manuscript-review-267.review.html">Review</a> · <a href="manuscript-review-267.notes.md">Scope and decisions</a></p><div class="dv-opts">${frames.map(frame => `<div class="dv-opt" id="${frame.id}"><div class="dv-olabel">${frame.id} · ${frame.title}</div><div class="dv-card" style="width:${frame.width}px;height:${frame.height}px;max-width:none">${frame.markup}</div></div>`).join('\n')}</div><p class="dv-rule">Review the complete saved manuscript through bounded reading stages. Retain original evidence, coverage, author intent and history; never automatically repeat uncertain calls. Export privately as PDF; revisions stay in the existing proposal flow.</p></section>\n`;
for (const file of ['Arke Studio.dc.html', 'Arke Studio Prototype.dc.html']) {
  let html = readFileSync(new URL(file, root), 'utf8');
  const start = html.indexOf('<section class="dv-turn" id="t267">');
  if (start >= 0) {
    const end = html.indexOf('<section class="dv-turn"', start + 1);
    if (end < 0) throw Error('No safe turn boundary');
    html = html.slice(0, start) + turn + html.slice(end);
  } else {
    const next = html.indexOf('<section class="dv-turn" id="t266">');
    if (next < 0) throw Error('Missing prior turn');
    html = html.slice(0, next) + turn + html.slice(next);
  }
  if (!html.includes(style)) html = html.replace('<helmet>', '<helmet>\n' + style);
  writeFileSync(new URL(file, root), html);
}
