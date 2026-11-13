// Turn 230 · Audio drama. Writes the review page and the prototype and, unless --preview, places the
// turn in the design master and registers its frames with build-review.
//   node design-system/audio-drama-230.mjs [--preview]
// Then: node design-system/check-master.mjs --record && node design-system/build-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMES, EXTRA } from './audio-drama-230.frames.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const STYLE = '<link rel="stylesheet" href="audio-drama-230.css">';
// Turn 225's chat styles, derived from the master by turn 227's generator; the panel is the approved one.
const CHAT_STYLE = '<link rel="stylesheet" href="chapter-page-227.chat.css">';
const HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${['fonts', 'colors', 'typography', 'spacing', 'effects'].map(n => `<link rel="stylesheet" href="${tokens}/${n}.css">`).join('')}${CHAT_STYLE}${STYLE}`;
const REV = 'Revision 4 · approved';

// ----- Review page: every frame, in order, light and dark -----
write('audio-drama-230.review.html', `<!doctype html><html lang="en"><head>${HEAD}<title>Audio drama · Turn 230</title>
<style>body{margin:0;background:#EFEEEB;color:#1a1a1a;font-family:var(--font-sans)}html.dark body{background:#131313;color:#ededed}.rv{padding:32px;display:flex;flex-direction:column;gap:40px}.rv>section>h2{font:var(--type-ui);margin:0 0 10px}.rv>section>h2 a{color:inherit}.rv .frm{border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(127,127,127,.25);width:max-content}.rv>header{display:flex;gap:12px;align-items:center;font:var(--type-ui);flex-wrap:wrap}.rv>header button,.rv>header a{font:var(--type-ui);padding:6px 12px;border-radius:8px;border:1px solid #888;background:none;color:inherit;cursor:pointer;text-decoration:none}</style></head>
<body><div class="rv"><header><b>Turn 230 · ${REV} · Audio drama: adapting a novel for the ear</b><button type="button" onclick="document.documentElement.classList.toggle('dark')">Light / dark</button><a href="audio-drama-230.prototype.html">Prototype</a><a href="Arke%20Studio.dc.html#t230">Design master</a><a href="audio-drama-230.notes.md">Notes</a></header>
${FRAMES.map(f => `<section id="${f.id}"><h2><a href="#${f.id}">${f.id}</a> ${esc(f.title)}</h2><div class="frm">${f.markup}</div></section>`).join('\n')}</div></body></html>`);

// ----- Prototype: the same drawings as states; anything carrying data-go moves between them -----
const states = [...FRAMES, ...EXTRA];
const JOURNEY = [['door', 'Door'], ['setup', 'Setup'], ['draft', 'Pilot'], ['cue', 'Sound'], ['select', 'Select'], ['hear', 'Hear'], ['audition', 'Audition'], ['review', 'Review'], ['cast', 'Cast'], ['quiet', 'Quiet scene'], ['map', 'Adaptation'], ['changed', 'Source changed'], ['studio', 'Audio Studio'], ['episodes', 'Episodes'], ['publish', 'Publish']];
const PHONE = [['pepisodes', 'Episodes'], ['pscript', 'Script'], ['phear', 'Hear'], ['pcast', 'Cast'], ['psource', 'Source']];
write('audio-drama-230.prototype.html', `<!doctype html><html lang="en"><head>${HEAD}<title>Audio drama prototype · Turn 230</title>
<style>
html,body{margin:0;height:100%}body{background:#E9E8E4;color:#1a1a1a;font-family:var(--font-sans);display:flex;flex-direction:column}html.dark body{background:#111;color:#eee}
.pt-bar{display:flex;align-items:center;gap:8px;padding:10px 16px;flex-wrap:wrap;font:var(--type-label);border-bottom:1px solid rgba(127,127,127,.25)}
.pt-bar b{font:var(--type-ui);margin-right:8px}
.pt-bar button{font:var(--type-label);height:28px;padding:0 10px;border-radius:999px;border:1px solid rgba(127,127,127,.4);background:none;color:inherit;cursor:pointer}
.pt-bar button[aria-current="step"]{background:currentColor}.pt-bar button[aria-current="step"] span{color:#E9E8E4;filter:invert(0)}html.dark .pt-bar button[aria-current="step"] span{color:#111}
.pt-bar .sp{flex:1}.pt-bar .grp{display:flex;gap:4px;flex-wrap:wrap}
.pt-stage{flex:1;min-height:0;display:grid;place-items:center;overflow:hidden;position:relative}
.pt-frame{transform-origin:center center;box-shadow:0 20px 60px rgba(0,0,0,.18);border-radius:12px;overflow:hidden}
.pt-frame [data-go]{cursor:pointer}
.pt-frame [data-go]:focus-visible,.pt-bar button:focus-visible{outline:2px solid #4A63E0;outline-offset:2px}
.pt-toast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);font:var(--type-label);background:#111;color:#fff;padding:8px 12px;border-radius:999px;opacity:0;transition:opacity .2s}
.pt-toast.on{opacity:.92}
@media (prefers-reduced-motion:reduce){.pt-toast{transition:none}}
</style></head><body>
<div class="pt-bar" role="navigation" aria-label="Prototype"><b>Turn 230 · Audio drama</b><div class="grp" id="desk">${JOURNEY.map(([s, n]) => `<button type="button" data-jump="${s}"><span>${n}</span></button>`).join('')}</div><span class="sp"></span><div class="grp" id="phone">${PHONE.map(([s, n]) => `<button type="button" data-jump="${s}"><span>Phone · ${n}</span></button>`).join('')}</div><button type="button" id="theme"><span>Light / dark</span></button><a href="audio-drama-230.review.html" style="color:inherit">All frames</a></div>
<div class="pt-stage" id="stage"></div><div class="pt-toast" id="toast" role="status" aria-live="polite"></div>
${states.map(f => `<template data-state="${f.state}" data-w="${f.w}" data-h="${f.h}" data-title="${esc(f.title)}">${f.markup}</template>`).join('\n')}
<script>
(() => {
  const stage = document.getElementById('stage'), toast = document.getElementById('toast');
  const T = Object.fromEntries([...document.querySelectorAll('template[data-state]')].map(t => [t.dataset.state, t]));
  let cur = null;
  const fit = () => { const f = stage.firstElementChild; if (!f) return; const w = +f.dataset.w, h = +f.dataset.h; if (stage.clientWidth < 60 || stage.clientHeight < 60) return; const s = Math.max(.2, Math.min(1, (stage.clientWidth - 32) / w, (stage.clientHeight - 32) / h)); f.style.transform = 'scale(' + s + ')'; };
  const show = (name, push = true) => {
    const t = T[name]; if (!t) { say('Not drawn in this prototype'); return; }
    cur = name; const box = document.createElement('div'); box.className = 'pt-frame'; box.dataset.w = t.dataset.w; box.dataset.h = t.dataset.h; box.style.width = t.dataset.w + 'px'; box.style.height = t.dataset.h + 'px';
    box.appendChild(t.content.cloneNode(true)); stage.replaceChildren(box); fit();
    box.querySelectorAll('[data-go]').forEach(el => { if (!el.matches('button,a')) { el.tabIndex = 0; el.setAttribute('role', 'button'); } });
    document.querySelectorAll('[data-jump]').forEach(b => b.setAttribute('aria-current', b.dataset.jump === name ? 'step' : 'false'));
    document.title = t.dataset.title + ' · Turn 230';
    if (push) history.replaceState(null, '', '#' + name);
    // A dialog or sheet is modal: everything behind it goes inert and focus starts inside it.
    const dlg = box.querySelector('[role="dialog"]');
    if (dlg) { for (let n = dlg; n && n !== box; n = n.parentElement) for (const sib of n.parentElement.children) if (sib !== n && !sib.classList.contains('scrim')) sib.inert = true; }
    const focus = (dlg || box).querySelector('button:not([disabled]),[data-go]'); if (focus && push) focus.focus({ preventScroll: true });
  };
  const say = m => { toast.textContent = m; toast.classList.add('on'); clearTimeout(say.t); say.t = setTimeout(() => toast.classList.remove('on'), 1600); };
  stage.addEventListener('click', e => { const el = e.target.closest('[data-go]'); if (el && el.dataset.go) { e.preventDefault(); show(el.dataset.go); return; } if (e.target.closest('button')) say('Drawn, not wired in this prototype'); });
  stage.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-go]')) { e.preventDefault(); show(e.target.dataset.go); } if (e.key === 'Escape') { const back = { hear: 'select', hear2: 'select', ask: 'select', cue: 'script', publish: 'episodes', phear: 'pscript', psource: 'pscript', pcast: 'pscript', changed: 'map', hearquiet: 'quiet', addsound: 'cue', gensound: 'addsound', genamb: 'addsound' }[cur]; if (back) show(back); } });
  stage.addEventListener('input', e => { if (!e.target.matches('[data-reason]')) return; const b = e.target.closest('.decision')?.querySelector('[data-needs-reason]'); if (b) b.disabled = !e.target.value.trim(); });
  document.querySelectorAll('[data-jump]').forEach(b => b.addEventListener('click', () => show(b.dataset.jump)));
  document.getElementById('theme').addEventListener('click', () => document.documentElement.classList.toggle('dark'));
  addEventListener('resize', fit);
  show(T[location.hash.slice(1)] ? location.hash.slice(1) : 'door', false);
})();
</script></body></html>`);

if (process.argv.includes('--preview')) { console.log(`Wrote review (${FRAMES.length} frames) and prototype (${states.length} states).`); process.exit(0); }

export const rules = JSON.parse(read('audio-drama-230.rules.json'));
const turn = `<section class="dv-turn" id="t230"><div class="dv-thd"><a class="dv-tid" href="#t230">230</a><span class="dv-tname">Audio drama · adapting a novel for the ear (supersedes <a class="dv-oid" href="#t228">turn 228</a>; amends SPEC-023 R-2, SPEC-047 R-12, SPEC-050 R-26, SPEC-052 R-11)</span></div><p class="dv-next">18 October 2026 · ${REV} · SPEC-057 · epic #1856 (slices #1857–#1864) · ${FRAMES.length} HTML drawings and a prototype. <a href="audio-drama-230.review.html">Review page</a> · <a href="audio-drama-230.prototype.html">Prototype</a> · <a href="audio-drama-230.notes.md">Notes</a></p><div class="dv-opts" style="margin-top:22px">${FRAMES.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${esc(f.title)}</div><div class="dv-card" style="width:${f.w}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}<p class="dv-next">Try next: the prototype from the door to an edition, then the phone path.</p></section>\n`;

let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t230">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + turn + master.slice(next);
} else {
  // Newest first: place above the first turn numbered below 230, never above a newer one.
  const below = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0 && Number(m[1]) < 230);
  if (!below) throw new Error('No turn below 230 to place against');
  master = master.slice(0, below.index) + turn + master.slice(below.index);
}
if (!master.includes(STYLE)) master = master.replace('<helmet>', '<helmet>\n' + STYLE);
write('Arke Studio.dc.html', master);

let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN AUDIO DRAMA 230[\s\S]*?  \/\/ END AUDIO DRAMA 230(?:\r?\n)*/g, '\n');
const entries = FRAMES.map(f => `  { group: "Audio drama · turn 230 · revision 4", screen: ${JSON.stringify(f.title)}, frame: "${f.id}", route: "Audio drama", status: "drawn", checked: "2026-10-18", controls: [], notes: ["Approved 18 October 2026; implementation tracked in #1856 against SPEC-057."] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN AUDIO DRAMA 230\n' + entries.join('\n') + '\n  // END AUDIO DRAMA 230\n');
write('build-review.mjs', build);
console.log(`Placed turn 230 (${FRAMES.length} frames, ${rules.length} rules) and registered it with build-review.`);
