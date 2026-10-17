// Turn 229 · the frames. The full-screen Stage (144b's chrome) around renders from
// stage-229.render.mjs: a hotel lobby at night, Ade waiting, Ife crossing to lean on his shoulder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const L = JSON.parse(fs.readFileSync(path.join(here, 'stage-229.labels.json'), 'utf8'));
const A = 'assets/stage-229-';
const PLATE = 'assets/stage-229-plate.jpg';

const I = {
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  shrink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6 M20 10h-6V4 M14 10l7-7 M3 21l7-7"/></svg>',
  ghost: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0-6 6v11l3-2 3 2 3-2 3 2V9a6 6 0 0 0-6-6z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>',
  dot: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg>',
  ring: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="6"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/></svg>',
};
const esc = t => String(t).replaceAll('&', '&amp;').replaceAll('<', '&lt;');

// ---------- Head and the blockout line ----------
const pill = (view = 'Stage') => `<div class="pill">Na Love or Juju · ep 1 · the lobby<b>${view}</b></div>`;
const head = ({ shot, title, dur, meta, board = false }) => `<div class="head"><span class="nav">${I.left}</span><span class="t">${board ? 'Board 1' : `Shot ${shot}`}</span><span class="nav">${I.right}</span><span class="mono">${esc(title)} · ${dur}</span><div class="scope"><button type="button"${board ? '' : ' class="on"'}>This shot</button><button type="button"${board ? ' class="on"' : ''}>Board 1</button></div><span class="gap"></span><span class="mono">${esc(meta)}</span><button type="button" class="exit" aria-label="Leave full screen" title="Leave full screen (Esc)">${I.shrink}</button></div>`;
const line = ({ typed = '', running = false, disc = 'AI inspection and assumptions', open = false, plate = true } = {}) => `<div class="line">${plate ? `<button type="button" class="plate" title="Location plate"><i style="background-image:url(${PLATE})"></i>Lobby · plate</button>` : '<button type="button" class="plate empty">Add plate</button>'}<div class="field${typed ? ' typed' : ''}">${typed ? esc(typed) : 'Describe the blockout or changes…'}</div><button type="button" class="btn">Keep blocking ${I.down}</button>${running ? `<button type="button" class="btn">${I.stop} Stop</button>` : '<button type="button" class="btn" title="Claude Sonnet 5 · 40 calls">Build with Arke</button>'}<span class="disc${open ? ' open' : ''}">${open ? I.down : I.right} ${esc(disc)}</span></div>`;

// ---------- Viewport ----------
const look = on => `<div class="seg" role="tablist" aria-label="Look">${['Greybox', 'Lit', 'Plate'].map(v => `<button type="button"${v === on ? ' class="on"' : ''}>${v}</button>`).join('')}</div>`;
const mode = on => `<div class="seg" role="tablist">${['Look', 'Camera'].map(v => `<button type="button"${v === on ? ' class="on"' : ''}>${v}</button>`).join('')}</div>`;
const CAST_TAG = { Ade: 'c1', Ife: 'c2' };
function tags(render, { only, rename = {} } = {}) {
  const r = L[render];
  return r.labels.filter(l => l.visible && (!only || only.includes(l.text))).map(l => {
    const text = rename[l.text] ?? l.text;
    const cls = text === 'CAMERA' || /^\d$/.test(text) ? 'tag ink' : `tag ${CAST_TAG[text] ?? ''}`;
    return `<span class="${cls}" style="left:${(l.x / r.w * 100).toFixed(2)}%;top:${(l.y / r.h * 100).toFixed(2)}%">${text}</span>`;
  }).join('');
}
const tools = (m, lk, extra = '') => `<div class="tools">${mode(m)}${extra}<span class="gap"></span>${look(lk)}<button type="button" class="chipbtn" aria-label="Ghosts" title="Ghosts">${I.ghost}</button></div>`;
const vpLook = ({ img, lk = 'Lit', ground = false, pip, pipLabel = 'camera', tagOpts, render, over = '' }) => `<div class="vp${ground ? ' ground' : ''}" style="background-image:url(${A}${img}.jpg)">${tools('Look', lk)}${tags(render ?? img, tagOpts)}${pip ? `<div class="pip" style="background-image:url(${A}${pip}.jpg)"><span>${pipLabel}</span></div>` : ''}${over}</div>`;
// Camera mode: the lens at 9:16 centred in the 1060 × 580 viewport, 560 tall.
function lensTags(render, list) {
  const r = L[render], h = 560, w = h * 9 / 16, left = (1060 - w) / 2, top = 10;
  return r.labels.filter(l => list.includes(l.text)).map(l => `<span class="tag ${CAST_TAG[l.text] ?? ''}" style="left:${(left + l.x / r.w * w).toFixed(1)}px;top:${(top + l.y / r.h * h).toFixed(1)}px">${l.text}</span>`).join('');
}
const vpLens = ({ img, lk = 'Lit', tagList = [], extra = '', over = '' }) => `<div class="vp" style="background:#0b0b0e">${tools('Camera', lk)}<div class="lens" style="background-image:url(${A}${img}.jpg)"></div>${lensTags(img, tagList)}${extra}${over}</div>`;

// ---------- Inspector ----------
const li = (mk, name, state, { on = false, warn = false } = {}) => `<div class="li${on ? ' on' : ''}"><span class="mk ${mk}"${mk.startsWith('#') ? ` style="background:${mk}"` : ''}></span><span class="nm">${esc(name)}</span><span class="mono${warn ? ' warn' : ''}">${esc(state)}</span></div>`;
const stageList = (sel, { building = false } = {}) => `<div class="eyebrow">Stage<span class="mono">${building ? 'building' : 'shared · scene'}</span></div>
${li('', 'camera', sel === 'board' ? '4 cameras' : sel === 'camera' ? 'locked off · 18 mm' : 'push in · 2 keys', { on: sel === 'camera' })}
${li('plate', 'plate', 'Lobby · matched', { on: sel === 'plate' }).replace('mk plate', 'mk o')}
${li('#2f7fd8', 'Ade', 'sits · armchair', { on: sel === 'Ade' })}
${li('#d6336c', 'Ife', 'walks 3.3 m · leans', { on: sel === 'Ife' })}
<div class="grp">set · 9</div>
${li('o', 'lobby', 'room · 8 × 12 × 5', { on: sel === 'lobby' })}
${li('o', 'lifts', '2 doors · right wall')}
${li('o', 'armchairs', '2 · leather')}
${li('o', 'planter · palm · lamp', '3 · kit')}
<div class="grp">lights · 5</div>
${li('l', 'niche wash · lamp · pendant · 2 strips', 'warm')}
<div class="add">${I.plus} Add set</div>`;
const row = (k, v) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
const sel = t => `<span class="sel">${t}${I.down}</span>`;
const num = t => `<span class="num">${t}<i>− +</i></span>`;
const chips = (all, on) => `<span class="chips">${all.map(a => `<span${a === on ? ' class="on"' : ''}>${a}</span>`).join('')}</span>`;
const three = (labels, values) => `<span class="three">${labels.map((l, i) => `<span><b>${l}</b>${values[i]}</span>`).join('')}</span>`;
const foot = (state = 'filed', what = 'playblast', cls = 'ok', off = false) => `<div class="foot">${row(what, `<span style="${cls === 'ok' ? 'color:var(--success)' : 'color:var(--warning)'}">${state}</span>`)}<div class="btns"><button type="button" class="btn"${off ? ' disabled' : ''}>Export ${what}</button><button type="button" class="btn primary"${off ? ' disabled' : ''}>Render with this</button></div></div>`;
const panel = (list, form, ft = foot()) => `<div class="panel">${list}<div class="rule"></div>${form}${ft}</div>`;

// ---------- Transport ----------
const pct = (t, d) => `${(t / d * 100).toFixed(2)}%`;
function transport({ dur, at, keys = [], lanes = [], cuts = null }) {
  const track = cuts
    ? cuts.map(([n, from, to, name, on]) => `<span class="seg${on ? ' on' : ''}" style="left:${pct(from, dur)};width:calc(${pct(to - from, dur)} - 3px)">${n}<em>${name}</em></span>`).join('') + `<span class="head" style="left:${pct(at, dur)}"></span>`
    : `<span class="rail"></span><span class="done" style="width:${pct(at, dur)}"></span>${keys.map((k, i) => `<span class="k${i === 0 || i === keys.length - 1 ? ' end' : ''}" style="left:${pct(k, dur)}"></span>`).join('')}<span class="head" style="left:${pct(at, dur)}"></span>`;
  const right = cuts ? `${cuts.length} shots` : `${keys.length} keys`;
  return `<div class="tl"><div class="play"><i>▶</i><span class="mono">${at.toFixed(1)}s / ${dur.toFixed(1)}s</span></div><div class="track">${track}</div><span class="mono">${right}</span>
${lanes.map(({ who, colour, marks, poses = [], bars = [] }) => `<div class="who"><i style="background:${colour}"></i>${who}</div><div class="lane"><span class="rail"></span>${bars.map(([a, b]) => `<span class="bar" style="left:${pct(a, dur)};width:${pct(b - a, dur)};background:${colour}"></span>`).join('')}${marks.map(m => `<span class="m" style="left:${pct(m, dur)};background:${colour}"></span>`).join('')}${poses.map(([t, p]) => `<span class="p" style="left:${pct(t, dur)};top:-3px">${p}</span>`).join('')}</div><span class="mono">${marks.length} marks</span>`).join('\n')}</div>`;
}
const ADE = { who: 'Ade', colour: '#2f7fd8' }, IFE = { who: 'Ife', colour: '#d6336c' };

const stage = (inner, view = 'Stage') => `<div class="st229">${pill(view)}${inner}</div>`;
const main = (vp, pn) => `<div class="main" style="height:580px;flex:none">${vp}${pn}</div>`;

// ---------- Frames ----------
const frameLit = (lk = 'Lit') => stage(`${head({ shot: 1, title: 'Wide · Ade waits', dur: '2.0s', meta: 'v6 · 2 keys · locked off' })}${line()}${main(
  lk === 'Lit'
    ? vpLook({ img: 'over-lit', pip: 'shot1-lit', tagOpts: { only: ['Ade', 'Ife', 'CAMERA', 'lifts', 'armchair', 'planter', 'glass wall'] } })
    : vpLook({ img: 'over-grey', lk: 'Greybox', ground: true, pip: 'shot1-grey', tagOpts: { only: ['Ade', 'Ife'] } }),
  panel(stageList('camera'), `<div class="eyebrow">Camera<span class="mono">key 1 of 2</span></div>
${row('subject', sel('Ade'))}
${row('size', chips(['Wide', 'Med', 'MCU', 'CU'], 'Wide'))}
${row('angle', chips(['Eye', 'Low', 'High', 'Top'], 'Eye'))}
${row('side', sel('Front'))}
${row('lens', num('18 mm'))}
${row('move', sel('Locked off'))}
${row('at', '<span class="mono">0.00 1.05 6.20 · aim 0.90 0.40 −6.00</span>')}
${row('', '<span class="way">Edit as numbers</span>')}`))}${transport({ dur: 2, at: 0.8, keys: [0, 2], lanes: [{ ...ADE, marks: [0, 2], poses: [[0.3, 'sit']] }, { ...IFE, marks: [0, 2], poses: [[0.25, 'walk']] }] })}`);

const framePlate = () => stage(`${head({ shot: 1, title: 'Wide · Ade waits', dur: '2.0s', meta: 'v6 · 2 keys · locked off' })}${line()}${main(
  vpLens({ img: 'shot1-plate', lk: 'Plate', tagList: ['Ade'], extra: '<div class="score"><span>horizon 1.05 m</span><span>18 mm</span><span>match 0.81</span></div>' }),
  panel(stageList('plate'), `<div class="eyebrow">Plate<span class="mono">Lobby · night</span></div>
<div style="display:flex;gap:10px;margin:4px 0 4px"><i style="width:40px;height:71px;border-radius:6px;background:url(${PLATE}) center/cover;flex:none"></i><div style="display:flex;flex-direction:column;gap:4px"><span>Lobby · plate</span><span class="mono">540 × 960 · v1</span><span class="way">Replace</span></div></div>
${row('matches', sel('Shot 1'))}
${row('lens', num('18 mm'))}
${row('horizon', num('1.05 m'))}
${row('light', '<span class="mono">night · warm practicals · 5</span>')}
${row('rides', chips(['Image 1', 'Off'], 'Image 1'))}
${row('', '<span class="way">Match camera</span>')}`))}${transport({ dur: 2, at: 0, keys: [0, 2], lanes: [{ ...ADE, marks: [0, 2], poses: [[0.3, 'sit']] }, { ...IFE, marks: [0, 2], poses: [[0.25, 'walk']] }] })}`);

const frameFigure = () => stage(`${head({ shot: 4, title: 'Two · she leans in', dur: '4.0s', meta: 'v7 · 2 keys · push in' })}${line()}${main(
  vpLens({ img: 'shot4-lit', tagList: ['Ife'], extra: `<span class="tag" style="left:${((1060 - 315) / 2 + 0.79 * 315).toFixed(0)}px;top:${(10 + 0.6 * 560).toFixed(0)}px">hand · Ade’s shoulder</span>` }),
  panel(stageList('Ife'), `<div class="eyebrow">Figure<span class="mono">Ife · mark 3 of 3</span></div>
${row('pose', sel('Lean on'))}
${row('hand', chips(['Left', 'Right', 'Both'], 'Left'))}
${row('on', sel('Ade · left shoulder'))}
${row('look at', sel('Ade'))}
${row('at', '<span class="mono">3.20 s · hold 0.80 s</span>')}
${row('place', three(['x', 'z', 'y'], ['1.32', '−0.60', '0']))}
${row('facing', num('0 °'))}
${row('ease in', num('0.30'))}
${row('', '<span class="way">Mark here</span>')}`, foot('stale', 'playblast', 'warn')))}${transport({ dur: 4, at: 3.4, keys: [0, 4], lanes: [{ ...ADE, marks: [0, 4], poses: [[0.25, 'sit']] }, { ...IFE, marks: [0, 2.6, 3.2], poses: [[0.3, 'walk'], [3.2, 'lean on']], bars: [[3.2, 4]] }] })}`);

const kitMenu = `<div style="border:1px solid var(--border);border-radius:10px;padding:6px;box-shadow:var(--shadow-md);background:var(--popover)">
${[['Room', 'walls · openings'], ['Doorway', ''], ['Window', ''], ['Stairs', ''], ['Counter', ''], ['Booth', ''], ['Table and chairs', ''], ['Armchair', ''], ['Sofa', ''], ['Bed', ''], ['Planter', ''], ['Tree', ''], ['Lamp', 'with light'], ['Car', ''], ['Street', ''], ['Facade', '']].map(([n, m]) => li('o', n, m)).join('')}
<div class="rule" style="margin:4px 0"></div>${['Box', 'Cylinder', 'Sphere', 'Mesh'].map(n => li('o', n, '')).join('')}</div>`;
const surface = (k, colour, name) => row(k, `<span class="swatch" style="background:${colour}"></span>${sel(name)}`);
const frameForms = () => `<div class="st229" style="width:920px;height:700px;display:grid;grid-template-columns:repeat(3,264px);gap:28px;padding:24px">
<div class="panel"><div class="mono" style="padding-bottom:6px">Add set</div><div class="eyebrow">Stage<span class="mono">shared · scene</span></div>${li('', 'camera', 'locked off · 18 mm')}${li('#2f7fd8', 'Ade', 'sits · armchair')}<div class="add" style="color:var(--foreground)">${I.plus} Add set</div>${kitMenu}</div>
<div class="panel"><div class="mono" style="padding-bottom:6px">lobby selected</div><div class="eyebrow">Set<span class="mono">lobby · kit</span></div>
${row('kit', sel('Room'))}
${row('size', three(['w', 'h', 'd'], ['8.0', '5.0', '12.0']))}
${row('open', chips(['Front', 'Back', 'Left', 'Right'], 'Front'))}
${row('ceiling', chips(['Off', 'On'], 'Off'))}
<div class="eyebrow">Openings<span class="mono">3</span></div>
${li('o', 'door · right wall', '1.1 × 2.3 · 2')}
${li('o', 'glass · left wall', 'full height')}
<div class="add">${I.plus} Opening</div>
<div class="eyebrow">Surfaces<span class="mono">from plate</span></div>
${surface('floor', '#2a2622', 'Marble')}
${surface('walls', '#b88a57', 'Plaster')}
${surface('right', '#3a281d', 'Wood')}
${surface('left', '#101a22', 'Glass')}
${row('place', three(['x', 'z', 'turn'], ['0', '0', '0 °']))}
<div style="margin-top:8px"><span class="way">Remove set</span></div></div>
<div class="panel"><div class="mono" style="padding-bottom:6px">niche wash selected</div><div class="eyebrow">Light<span class="mono">niche wash</span></div>
${row('kind', chips(['Point', 'Spot', 'Area', 'Sun'], 'Spot'))}
${row('colour', `<span class="swatch" style="background:#ffb35c"></span>${num('3200 K')}`)}
${row('strength', num('14'))}
${row('reach', num('8.0 m'))}
${row('shadow', '<span style="width:12px;height:12px;border:1px solid var(--border);border-radius:3px"></span>')}
${row('place', three(['x', 'y', 'z'], ['0.3', '3.6', '−5.2']))}
${row('aims at', sel('planter'))}
<div class="eyebrow" style="margin-top:8px">Look<span class="mono">this production</span></div>
${row('time', sel('Night'))}
${row('sky', `<span class="swatch" style="background:linear-gradient(#05070d,#1b1a22)"></span>${sel('Night city')}`)}
${row('haze', num('0.02'))}
${row('shading', chips(['Soft', 'Off'], 'Soft'))}
<div style="margin-top:8px"><span class="way">Remove light</span></div></div></div>`;

const STEPS = [
  ['ok', 'read plate', 'Lobby'], ['ok', 'read sheets', 'Ade · Ife'],
  ['ok', 'room 8 × 12 × 5', 'glass left · lifts right'], ['ok', 'armchair · table · planter · palm · lamp', '5 kit'],
  ['ok', 'lights from the plate', '5'], ['ok', 'Ade · sit', 'armchair'], ['ok', 'Ife · walk 3.3 m · lean on', 'hand · Ade'],
  ['ok', 'shot 1 · wide on Ade', '18 mm'], ['ok', 'render shot 1 · 0.0 s', 'plate · build'], ['ok', 'match plate', '0.81'],
  ['run', 'check', '180° · standoff · speed'], ['wait', 'shots 2–4', ''],
];
const log = `<div class="log"><div class="eyebrow" style="padding-top:0">Working<span class="mono">round 1 · 38 calls · 1:52</span></div>
${STEPS.map(([s, a, b], i) => `<div class="st ${s}"><span class="ic">${s === 'ok' ? I.check : s === 'run' ? I.dot : I.ring}</span><span>${a}</span><span class="mono">${b}</span></div>${i === 8 ? `<div class="thumbs"><i style="background-image:url(${PLATE})"></i><i style="background-image:url(${A}shot1-lit.jpg)"></i></div>` : ''}`).join('\n')}</div>`;
const frameBuild = () => stage(`${head({ shot: 1, title: 'Wide · Ade waits', dur: '2.0s', meta: 'building · v6' })}${line({ typed: 'Ife comes out of the lifts, crosses to Ade and leans on his shoulder', running: true, disc: 'Working', open: true })}${main(
  vpLook({ img: 'over-lit', pip: 'shot1-lit', tagOpts: { only: ['Ade', 'Ife', 'lifts', 'planter'] }, over: '' }).replace('<div class="tools">', `${log}<div class="tools" style="left:444px">`),
  panel(stageList(null, { building: true }), `<div class="eyebrow">Shot<span class="mono">Wide · Ade waits</span></div>
${row('size', 'wide')}${row('lens', '18 mm')}${row('movement', 'locked off')}${row('rig', sel('Sticks'))}`, foot('building', 'playblast', 'warn', true)))}${transport({ dur: 2, at: 0, keys: [0, 2], lanes: [{ ...ADE, marks: [0, 2], poses: [[0.3, 'sit']] }, { ...IFE, marks: [0, 2], poses: [[0.25, 'walk']] }] })}`);

const CUTS = [[1, 0, 2, 'wide', false], [2, 2, 4, 'Ade', false], [3, 4, 8, 'Ife', true], [4, 8, 12, 'two · push in', false]];
const frameBoard = () => stage(`${head({ shot: 3, title: '4 shots', dur: '12.0s', meta: 'v6 · 180° clear', board: true })}${line()}${main(
  vpLook({ img: 'board-lit', render: 'board-lit', pip: 'shot3-lit', pipLabel: '3 · 6.4s', tagOpts: { only: ['Ade', 'Ife', '1', '2', '3', '4', 'lifts'] } }),
  panel(stageList('board'), `<div class="eyebrow">Board 1<span class="mono">12.0 of 15 s</span></div>
${li('', '1 · Wide · Ade waits', '2.0 s')}
${li('', '2 · Ade · checks the time', '2.0 s')}
${li('', '3 · Ife · from the lifts', '4.0 s', { on: true })}
${li('', '4 · Two · she leans in', '4.0 s')}
${row('line', '<span style="color:var(--success)">180° · clear</span>')}
${row('action', chips(['Shared', 'Per shot'], 'Shared'))}
${row('cuts', chips(['Hard', 'Markers'], 'Hard'))}`, foot('filed · v2', 'animatic')))}${transport({ dur: 12, at: 6.4, cuts: CUTS, lanes: [{ ...ADE, marks: [0, 12], poses: [[1, 'sit'], [2.2, 'checks time']] }, { ...IFE, marks: [0, 8.6, 9.6, 12], poses: [[1, 'walk'], [9.6, 'lean on']], bars: [[9.6, 12]] }] })}`, 'Stage');

const frameBench = () => `<div class="st229 bench"><div class="tb">Na Love or Juju · Bench<b>Arke <span class="mono">Studio</span></b><span></span></div><div class="bwrap"><div class="crail"></div><div class="bmain"><div class="card">
<div class="tabs"><span>Image</span><span class="on">Video</span><span>Voice</span><span>Music</span></div>
<div class="tabs"><span class="on">Reference</span><span>Keyframe</span></div>
<div class="refs">
<div class="ref"><i style="background-image:url(${PLATE})"></i><span><b>Image 1</b><span class="mono">Lobby · plate</span><span class="who2">the lobby</span></span></div>
<div class="ref"><i style="background-image:url(assets/nloj-ade.jpg)"></i><span><b>Image 2</b><span class="mono">Ade · kit v3</span><span class="who2">Ade</span></span></div>
<div class="ref"><i style="background-image:url(assets/nloj-ife.jpg)"></i><span><b>Image 3</b><span class="mono">Ife · kit v4</span><span class="who2">Ife</span></span></div>
<div class="ref"><i class="v" style="background-image:url(${A}shot1-lit.jpg)"></i><span><b>Video 1</b><span class="mono">Board 1 · animatic v2 · 12.0 s</span><span class="who2">the blockout</span></span></div>
<button type="button" class="ref" style="padding:0 16px;color:var(--muted-foreground)">${I.plus}</button></div>
<div class="prompt"><p>A hotel lobby at night, <span class="at">@Image 1</span>. Ade <span class="at">@Image 2</span> waits in an armchair; Ife <span class="at">@Image 3</span> comes out of the lifts, crosses to him and leans on his shoulder.</p>
<p><span class="cue">0.0–2.0 s</span>Wide. Ade alone in the armchair, the lobby around him.</p>
<p><span class="cue">2.0–4.0 s</span>Medium on Ade. He checks the time.</p>
<p><span class="cue">4.0–8.0 s</span>Ife from the lifts, tracked as she crosses toward him.</p>
<p><span class="cue">8.0–12.0 s</span>Two-shot, slow push in. She leans down, her left hand on his shoulder.</p>
<p>Use <span class="at">@Video 1</span> for camera position and movement only. The figures in it are placeholders; do not copy their poses or body mechanics.</p></div>
<div class="opts"><span class="btn">12 s</span><span class="btn">9:16</span><span class="btn">Seedance 2.5</span><span class="lbl">follow</span><div class="seg"><button type="button">Camera + action</button><button type="button" class="on">Camera only</button></div><span class="gap"></span><span class="btn primary">Generate</span></div>
</div><div class="mono">No takes yet</div></div></div></div>`;

export const FRAMES = [
  ['a', 'Lit. The look the playblast carries: materials, the practical lights, soft shadows and contact shading, a night sky, two strong cast colours. The camera is written in words.', 1360, 850, frameLit('Lit')],
  ['b', 'Greybox. The same stage in today’s look, one press away: the light ground, one grey, the grid and the capsules.', 1360, 850, frameLit('Greybox')],
  ['c', 'Plate. Camera on shot 1 in the Plate look: the set wears the plate, the cast stands in it, and the plate’s form names the shot it matches.', 1360, 850, framePlate()],
  ['d', 'A figure posed. Ife on her last mark: Lean on, her left hand on Ade’s left shoulder, looking at him. The lane names each pose.', 1360, 850, frameFigure()],
  ['e', 'The new forms. Add set opens the kit; a Room with its openings and surfaces; a Light, and the production’s Look beneath it.', 920, 700, frameForms()],
  ['f', 'Build with Arke, working. The build is a log of small steps, each one on the stage as it lands; it renders, compares with the plate and checks before it stops.', 1360, 850, frameBuild()],
  ['g', 'Board 1. One action, four cameras, one cut animatic: the track is the cut list, the lanes run across the cuts, and the line check covers the board.', 1360, 850, frameBoard()],
  ['h', 'The Bench, video. References numbered as they ride, the prompt written as timed cuts, and Follow set to Camera only.', 1360, 850, frameBench()],
];
