import { readFileSync, writeFileSync } from 'node:fs';
import { frames } from './compare-273.frames.mjs';
const root = new URL('./', import.meta.url);
const style = '<link rel="stylesheet" href="compare-273.css">';
const rules = [
  'A selected upscale whose source take still has media <b>shows a <code>Compare</code> tab</b> beside the crop tab. Pressing it again, or selecting another take, <b>returns to the player</b>. With the source deleted the tab is <b>absent</b>; its brief line already says why. Both pictures load through the existing authenticated media URLs, with no new route.',
  'Both layers share <b>one box at the result’s aspect</b>, each <code>object-fit: cover</code>, so the source lines up with the centre crop the upscale made. The handle is a <b>2px line and a 28px grip</b>, <code>role="slider"</code> with <code>aria-valuenow</code> as a percentage: <b>Left/Right 2%</b>, <b>Shift 10%</b>, <b>Home/End</b> to the edges. A mouse drags from anywhere on the picture; a touch drags <b>only from the grip</b>, so the page still scrolls over it.',
  'The result is the <b>clock</b>: the transport plays, pauses, seeks and loops it, and the source <b>follows</b> by nudging <code>playbackRate</code> within <code>0.85</code>–<code>1.15</code>, seeking only past <code>0.3 s</code> of drift. Both are muted and stay inside a take’s segment. Compare has <b>no resting play disc</b>, and a click on the picture moves the line, never plays.',
  '<code>Fit</code> is the default. <code>Pixels</code> scales both to the result’s <b>native width</b> about the pointer, and moving the pointer pans; on a coarse pointer <code>Pixels</code> is <b>absent</b>. The two chips are <b>data only</b> (<code>Take 19 · 864×480</code>, <code>Take 21 · 1920×1080</code>), with no caption. If the source will not load, the result plays alone and the tab is followed by <b>one clause</b>: <code>Take 19 did not load</code>.',
];
const turn = `<section class="dv-turn" id="t273"><div class="dv-thd"><a class="dv-tid" href="#t273">273</a><span class="dv-tname">Compare an upscale with its source - a wipe over one frame (extends <a class="dv-oid" href="#178b">178b</a>)</span></div><p class="dv-next">7 November 2026 · Drawn for the owner’s approval, issue 2402. <a href="compare-273.review.html">Review</a> · <a href="compare-273.notes.md">Scope and decisions</a></p><div class="dv-opts" style="margin-top:22px">${frames.map(frame => `<div class="dv-opt" id="${frame.id}"><div class="dv-olabel"><a class="dv-oid" href="#${frame.id}">${frame.id}</a>${frame.title}</div><div class="dv-card" style="width:${frame.width}px;height:${frame.height}px;max-width:none"><div data-screen-label="${frame.id} Bench · ${frame.title}" style="height:100%">${frame.markup}</div></div></div>`).join('\n')}</div>${rules.map(rule => `<p class="dv-rule"><b>Binding.</b> ${rule}</p>`).join('')}<p class="dv-next">The composer, the take strip and the wall’s other tabs are unchanged and left out. Comparing any two takes, looks, tall recomposes and marks wait for a later turn.</p></section>\n`;
for (const file of ['Arke Studio.dc.html', 'Arke Studio Prototype.dc.html']) {
  let html = readFileSync(new URL(file, root), 'utf8');
  const start = html.indexOf('<section class="dv-turn" id="t273">');
  if (start >= 0) {
    const end = html.indexOf('<section class="dv-turn"', start + 1);
    if (end < 0) throw Error('No safe turn boundary');
    html = html.slice(0, start) + turn + html.slice(end);
  } else {
    const next = html.indexOf('<section class="dv-turn" id="t272">');
    if (next < 0) throw Error('Missing prior turn');
    html = html.slice(0, next) + turn + html.slice(next);
  }
  if (!html.includes(style)) html = html.replace('<helmet>', '<helmet>\n' + style);
  writeFileSync(new URL(file, root), html);
}
const tokens = ['fonts', 'colors', 'typography', 'spacing', 'effects'].map(name => `<link rel="stylesheet" href="_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens/${name}.css">`).join('');
writeFileSync(new URL('compare-273.review.html', root), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${tokens}<link rel="stylesheet" href="compare-273.css"><title>Compare · turn 273</title></head><body style="margin:0">${frames.map(frame => `<section id="${frame.id}" style="width:${frame.width}px;height:${frame.height}px">${frame.markup}</section>`).join('')}</body></html>`);
