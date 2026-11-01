// Rebuild proposed turn 258 and its accepted prototype mirror.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frames, esc } from './media-measurement-258.frames.mjs';
const root = dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(join(root, name), 'utf8');
const write = (name, value) => writeFileSync(join(root, name), value);
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const style = '<link rel="stylesheet" href="media-measurement-258.css">';
export const rules = [
 ['Status and scope','Proposed for owner UI approval on 1 November 2026, issue 253. Backend implementation is independent; these controls await approval. The narrow issue covers music-aware generation and reliable local measurement/retry.'],
 ['Existing home','Use the Cut inspector and its existing Clip details sheet on phone. A missing source measurement exposes Measure media. No new route, timeline, master editor, marker authoring flow or Settings surface. The saved timeline remains delivery authority.'],
 ['One local act','Measure only the selected source by an opaque artifact/take identity. It reads local bytes through existing media tools, never uploads, generates, accepts, switches takes, rewrites prompts or changes timing. Segment takes resolve to their physical parent. Disable repeated presses while pending; the coordinator also coalesces them.'],
 ['Honest evidence','A full probe establishes duration and audio presence. A duration-only host cannot label silence. Success updates the existing duration facts. Failure preserves all paid media, immutable take records, source pins, selections and cut settings, and leaves an explicit retry.'],
 ['Source and lifecycle fences','Metadata binds to the source bytes checked before and after probing. A changed or vanished source refuses stale metadata. A changed source must be selected again; another press cannot bless it under an old identity. Close/world switching cancels or discards old results. Source paths and tool diagnostics do not appear in this panel.'],
 ['Phone and focus','Reuse the native Clip details sheet: fixed heading and footer, a separately scrolling body, Escape/Close and focus return. Phone controls have targets of at least 44 pixels, 12-pixel outer margins and 16-pixel body padding. Long errors and labels wrap.'],
 ['Recovery boundaries','Missing tools and failed probes are named; retry uses the same local service with no provider spend. Closing this sheet leaves its take and timeline intact. A successful measurement is adjacent operational metadata, not a new version of immutable take history.'],
];
const turn = `<section class="dv-turn" id="t258"><div class="dv-thd"><a class="dv-tid" href="#t258">258</a><span class="dv-tname">Local media measurement · retry from the Cut inspector (issue 253)</span></div><p class="dv-next">1 November 2026 · Proposed · ${frames.length} HTML drawings. <a href="media-measurement-258.review.html">Clickable review</a> · <a href="media-measurement-258.notes.md">Scope and decisions</a></p><div class="dv-opts">${frames.map(frame => `<div class="dv-opt" id="${frame.id}"><div class="dv-olabel"><a class="dv-oid" href="#${frame.id}">${frame.id}</a>${esc(frame.title)}</div><div class="dv-card" style="width:${frame.width}px;height:${frame.height}px;max-width:none">${frame.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], index) => `<p class="dv-rule"><b>${index + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}</section>\n`;
for (const file of ['Arke Studio.dc.html']) {
let html = read(file);
const start = html.indexOf('<section class="dv-turn" id="t258">');
if (start >= 0) {
  const next = html.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw Error('No safe end for turn 258');
  html = html.slice(0, start) + turn + html.slice(next);
} else {
  const next = [...html.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(match => Number(match[1]) > 0 && Number(match[1]) < 258);
  if (!next) throw Error('No safe insertion point');
  html = html.slice(0, next.index) + turn + html.slice(next.index);
}
if (!html.includes(style)) html = html.replace('<helmet>', '<helmet>\n' + style);
write(file, html);
}
write('media-measurement-258.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Media measurement · proposed turn 258</title>${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(name => `<link rel="stylesheet" href="${tokens}/${name}.css">`).join('')}${style}<style>html{background:var(--muted);color:var(--foreground);font:var(--type-ui)}body{margin:0}.review{padding:26px;display:flex;flex-direction:column;gap:34px}.review>header{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.review a{color:inherit}.review>p{font:var(--type-body);line-height:var(--leading-body);max-width:850px;margin:0}.review>nav{display:flex;gap:12px;flex-wrap:wrap}.review h2{font:var(--type-ui);margin:0 0 12px}.review .frame{border:1px solid var(--border);border-radius:12px;overflow:hidden;max-width:none}.review section{scroll-margin-top:20px}.review>header button{font:inherit;min-height:36px;padding:7px 12px;color:inherit;background:var(--background);border:1px solid var(--border);border-radius:7px}</style></head><body><main class="review"><header><b>Turn 258 · Proposed · Media measurement</b><button onclick="document.documentElement.classList.toggle('dark')" type="button">Light / dark</button><a href="Arke%20Studio.dc.html#t258">Design master</a><a href="media-measurement-258.notes.md">Scope and decisions</a></header><p>Local source duration and audio measurement from the existing Cut inspector. These synthetic drawings demonstrate local measurement states. Their controls link between drawings and perform no media I/O. UI implementation follows owner approval.</p><nav>${frames.map(frame => `<a href="#${frame.id}">${frame.id}</a>`).join('')}</nav>${frames.map(frame => `<section id="${frame.id}"><h2>${frame.id} · ${esc(frame.title)}</h2><div class="frame" style="width:${frame.width}px;height:${frame.height}px">${frame.markup}</div></section>`).join('\n')}</main></body></html>`);
let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN SHOT PROMPTS 258[\s\S]*?  \/\/ END SHOT PROMPTS 258(?:\r?\n)*/g, '\n');
const entries = frames.map(frame => `  { group: "Media measurement · turn 258", screen: ${JSON.stringify(frame.title)}, frame: "${frame.id}", route: "Cut / Clip details", status: "drawn", checked: "2026-11-01", controls: [], notes: ["Proposed 1 November 2026 for owner UI review. Local measurement and retry, issue 253."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN SHOT PROMPTS 258\n' + entries.join('\n') + '\n  // END SHOT PROMPTS 258\n');
if (!build.includes('file: "media-measurement-258.review.html"')) build = build.replace('const PAGES = [', 'const PAGES = [\n  { file: "media-measurement-258.review.html", what: "Turn 258: local media measurement and retry in Cut.", state: "proposed; owner UI review pending" },');
if (!build.includes(style)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', style + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log(`Registered proposed turn 258: ${frames.length} frames, ${rules.length} rules. Prototype awaits owner approval.`);
