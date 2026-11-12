import { readFileSync, writeFileSync } from 'node:fs';
import { frames } from './storage-holds-259.frames.mjs';
const root = new URL('./', import.meta.url);
const style = '<link rel="stylesheet" href="storage-holds-259.css">';
const turn = `<section class="dv-turn" id="t259"><div class="dv-thd"><a class="dv-tid" href="#t259">259</a><span class="dv-tname">Operation storage holds · issue 2240</span></div><p class="dv-next">1 November 2026 · Design shown inline before implementation. <a href="storage-holds-259.review.html">Review</a> · <a href="storage-holds-259.notes.md">Scope and decisions</a></p><div class="dv-opts">${frames.map(frame => `<div class="dv-opt" id="${frame.id}"><div class="dv-olabel">${frame.id} · ${frame.title}</div><div class="dv-card" style="width:${frame.width}px;height:${frame.height}px;max-width:none">${frame.markup}</div></div>`).join('\n')}</div><p class="dv-rule">Use the existing Activity and Diagnostics surfaces. A job-specific storage hold remains visible alongside broadly healthy drive readings. Closed reason codes, destination roles and measurement ages contain no host paths. Checking status never implies provider submission. Completed generation is retained without replay. The operation's existing owner performs bounded rechecks; no new bypass or confirmation. Disconnected observations are historical.</p></section>\n`;
for (const file of ['Arke Studio.dc.html', 'Arke Studio Prototype.dc.html']) {
  let html = readFileSync(new URL(file, root), 'utf8');
  const start = html.indexOf('<section class="dv-turn" id="t259">');
  if (start >= 0) {
    const end = html.indexOf('<section class="dv-turn"', start + 1);
    if (end < 0) throw Error('No safe turn boundary');
    html = html.slice(0, start) + turn + html.slice(end);
  } else {
    const next = html.indexOf('<section class="dv-turn" id="t258">');
    if (next < 0) throw Error('Missing prior turn');
    html = html.slice(0, next) + turn + html.slice(next);
  }
  if (!html.includes(style)) html = html.replace('<helmet>', '<helmet>\n' + style);
  writeFileSync(new URL(file, root), html);
}
