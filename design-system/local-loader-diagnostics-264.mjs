import { readFileSync, writeFileSync } from 'node:fs';
import { frames } from './local-loader-diagnostics-264.frames.mjs';
const root = new URL('./', import.meta.url);
const style = '<link rel="stylesheet" href="local-loader-diagnostics-264.css">';
const turn = `<section class="dv-turn" id="t264"><div class="dv-thd"><a class="dv-tid" href="#t264">264</a><span class="dv-tname">Local model read failure - issue 2247</span></div><p class="dv-next">1 November 2026 · Design shown inline before implementation. <a href="local-loader-diagnostics-264.review.html">Review</a> · <a href="local-loader-diagnostics-264.notes.md">Scope and decisions</a></p><div class="dv-opts">${frames.map(frame => `<div class="dv-opt" id="${frame.id}"><div class="dv-olabel">${frame.id} · ${frame.title}</div><div class="dv-card" style="width:${frame.width}px;height:${frame.height}px;max-width:none">${frame.markup}</div></div>`).join('\n')}</div><p class="dv-rule">Explain host-buffer model reads separately from explicit CUDA allocation failures. Do not infer physical or committed-memory pressure or incompatibility from error 1450 or measurements after restart. Retain safe engine evidence, current gates, engine/model context and explicit retry; no automatic replay or cloud reroute. Explain that a responding engine does not establish recipe readiness.</p></section>\n`;
for (const file of ['Arke Studio.dc.html', 'Arke Studio Prototype.dc.html']) {
  let html = readFileSync(new URL(file, root), 'utf8');
  const start = html.indexOf('<section class="dv-turn" id="t264">');
  if (start >= 0) {
    const end = html.indexOf('<section class="dv-turn"', start + 1);
    if (end < 0) throw Error('No safe turn boundary');
    html = html.slice(0, start) + turn + html.slice(end);
  } else {
    const next = html.indexOf('<section class="dv-turn" id="t263">');
    if (next < 0) throw Error('Missing prior turn');
    html = html.slice(0, next) + turn + html.slice(next);
  }
  if (!html.includes(style)) html = html.replace('<helmet>', '<helmet>\n' + style);
  writeFileSync(new URL(file, root), html);
}
