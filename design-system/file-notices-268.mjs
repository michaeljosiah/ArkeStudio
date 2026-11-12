import { readFileSync, writeFileSync } from 'node:fs';
import { frames } from './file-notices-268.frames.mjs';
const root = new URL('./', import.meta.url);
const style = '<link rel="stylesheet" href="file-notices-268.css">';
const turn = `<section class="dv-turn" id="t268"><div class="dv-thd"><a class="dv-tid" href="#t268">268</a><span class="dv-tname">File problems - a notice, not a banner</span></div><p class="dv-next">3 November 2026 · Drawn for the owner's approval. <a href="file-notices-268.review.html">Review</a> · <a href="file-notices-268.notes.md">Scope and decisions</a></p><div class="dv-opts">${frames.map(frame => `<div class="dv-opt" id="${frame.id}"><div class="dv-olabel">${frame.id} · ${frame.title}</div><div class="dv-card" style="width:${frame.width}px;height:${frame.height}px;max-width:none">${frame.markup}</div></div>`).join('\n')}</div><p class="dv-rule"><b>Binding.</b> A world's file problems draw <b>no band on any world screen</b>. A newly seen unreadable file or shared name raises <b>one notice</b> and the bell's foreground dot; <code>View</code>, <code>×</code> or opening the Inbox settles them all, for every window, until a <b>path not already settled</b> appears. Past-version problems raise neither. The Inbox lists every current problem for the open world, always, at its foot. The outside-edit band is unchanged, because writes wait on it.</p></section>\n`;
for (const file of ['Arke Studio.dc.html', 'Arke Studio Prototype.dc.html']) {
  let html = readFileSync(new URL(file, root), 'utf8');
  const start = html.indexOf('<section class="dv-turn" id="t268">');
  if (start >= 0) {
    const end = html.indexOf('<section class="dv-turn"', start + 1);
    if (end < 0) throw Error('No safe turn boundary');
    html = html.slice(0, start) + turn + html.slice(end);
  } else {
    const next = html.indexOf('<section class="dv-turn" id="t267">');
    if (next < 0) throw Error('Missing prior turn');
    html = html.slice(0, next) + turn + html.slice(next);
  }
  if (!html.includes(style)) html = html.replace('<helmet>', '<helmet>\n' + style);
  writeFileSync(new URL(file, root), html);
}
const tokens = ['fonts', 'colors', 'typography', 'spacing', 'effects'].map(name => `<link rel="stylesheet" href="_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens/${name}.css">`).join('');
writeFileSync(new URL('file-notices-268.review.html', root), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${tokens}<link rel="stylesheet" href="file-notices-268.css"><title>File problems · turn 268</title></head><body style="margin:0">${frames.map(frame => `<section id="${frame.id}" style="width:${frame.width}px;height:${frame.height}px">${frame.markup}</section>`).join('')}</body></html>`);
