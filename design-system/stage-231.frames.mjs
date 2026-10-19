// Turn 231 · the frames. The Stage inside the app's own page (no full screen), drawn with turn
// 229's parts and renders: the lobby at night, Ade waiting, Ife crossing to lean on his shoulder.
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
  grow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6 M10 20H4v-6 M20 4l-7 7 M4 20l7-7"/></svg>',
  ghost: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0-6 6v11l3-2 3 2 3-2 3 2V9a6 6 0 0 0-6-6z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5 M6 11l6-6 6 6"/></svg>',
};
const esc = t => String(t).replaceAll('&', '&amp;').replaceAll('<', '&lt;');

// ---------- The app around the Stage ----------
const appbar = `<div class="appbar"><span class="crumb">${I.left}<span>World</span><b>Na Love or Juju · micro drama</b></span><span class="brand">Arke<span>Studio</span></span><span class="icons"><i></i><i></i><i></i><i></i><i></i></span></div>`;
const rail = `<div class="prail"><i></i><i></i><i class="on"></i><i></i><i></i><i></i></div>`;
const page = inner => `<div class="st229 st231">${appbar}<div class="body">${rail}<div class="work">${inner}</div></div></div>`;

// ---------- The head, folded to one line ----------
const head = ({ shot = 1, title = 'Wide · Ade waits', dur = '2.0s', meta = 'v6 · 2 keys · locked off' } = {}) => `<div class="head"><span class="nav">${I.left}</span><span class="t">Shot ${shot}</span><span class="nav">${I.right}</span><span class="mono">${esc(title)} · ${dur}</span><div class="views"><button type="button">Shot</button><button type="button" class="on">Stage</button></div><div class="scope"><button type="button" class="on">This shot</button><button type="button">Board 1</button></div><span class="gap"></span><span class="mono">${esc(meta)}</span><button type="button" class="exit" aria-label="Full screen" title="Full screen">${I.grow}</button></div>`;

// ---------- The blockout line, and the draft bar that takes its place ----------
const from = (value = 'The scene') => `<button type="button" class="from"><span class="k">start from</span>${esc(value)}${I.down}</button>`;
const line = ({ typed = '', start = 'The scene', plate = true } = {}) => `<div class="line">${plate ? `<button type="button" class="plate" title="Location plate"><i style="background-image:url(${PLATE})"></i>Lobby · plate</button>` : '<button type="button" class="plate empty">Add plate</button>'}<div class="field${typed ? ' typed' : ''}">${typed ? esc(typed) : 'Describe the blockout or changes…'}</div>${from(start)}<button type="button" class="btn">Quick layout</button><button type="button" class="btn" title="Claude Sonnet 5 · 40 calls">Build with Arke</button></div>`;
const draftBar = ({ who, items, notes = true, open = false }) => `<div class="draft"><span class="who">${esc(who)}</span><span class="sum">${items.map(([n, label, chg]) => `<span><b${chg ? ' class="chg"' : ''}>${n}</b>${esc(label)}</span>`).join('')}</span>${notes ? `<span class="disc${open ? ' open' : ''}">${open ? I.down : I.right} Arke’s notes</span>` : ''}<button type="button" class="btn">Discard</button><button type="button" class="btn primary">Keep</button></div>`;

// ---------- Viewport ----------
const look = on => `<div class="seg" role="tablist" aria-label="Look">${['Greybox', 'Lit', 'Plate'].map(v => `<button type="button"${v === on ? ' class="on"' : ''}>${v}</button>`).join('')}</div>`;
const mode = on => `<div class="seg" role="tablist">${['Look', 'Camera'].map(v => `<button type="button"${v === on ? ' class="on"' : ''}>${v}</button>`).join('')}</div>`;
const tools = (m, lk, left = '') => `<div class="tools"${left ? ` style="left:${left}"` : ''}>${mode(m)}<span class="gap"></span>${look(lk)}<button type="button" class="chipbtn" aria-label="Ghosts" title="Ghosts">${I.ghost}</button></div>`;
const CAST_TAG = { Ade: 'c1', Ife: 'c2' };
function tags(render, only) {
  const r = L[render];
  return r.labels.filter(l => l.visible && only.includes(l.text)).map(l => {
    const cls = l.text === 'CAMERA' ? 'tag ink' : `tag ${CAST_TAG[l.text] ?? ''}`;
    return `<span class="${cls}" style="left:${(l.x / r.w * 100).toFixed(2)}%;top:${(l.y / r.h * 100).toFixed(2)}%">${l.text}</span>`;
  }).join('');
}
const vp = ({ img = 'over-lit', lk = 'Lit', pip = 'shot1-lit', only = ['Ade', 'Ife', 'CAMERA', 'lifts', 'armchair', 'planter', 'glass wall'], over = '', toolsLeft = '' } = {}) =>
  `<div class="vp" style="background-image:url(${A}${img}.jpg)">${tools('Look', lk, toolsLeft)}${tags(img, only)}${pip ? `<div class="pip" style="background-image:url(${A}${pip}.jpg)"><span>camera · 18 mm</span></div>` : ''}${over}</div>`;

// ---------- Inspector ----------
const li = (mk, name, state, { on = false, mark = '' } = {}) => `<div class="li${on ? ' on' : ''}"><span class="mk ${mk}"${mk.startsWith('#') ? ` style="background:${mk}"` : ''}></span><span class="nm">${esc(name)}</span>${mark ? `<span class="gl ${mark === '+' ? 'new' : 'chg'}">${mark}</span>` : ''}<span class="mono">${esc(state)}</span></div>`;
const row = (k, v) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
const sel = t => `<span class="sel">${t}${I.down}</span>`;
const num = t => `<span class="num">${t}<i>− +</i></span>`;
const chips = (all, on) => `<span class="chips">${all.map(a => `<span${a === on ? ' class="on"' : ''}>${a}</span>`).join('')}</span>`;
const stageList = ({ sel: on = 'camera', draft = false } = {}) => `<div class="eyebrow">Stage<span class="mono">${draft ? 'draft · 14 changes' : 'shared · scene'}</span></div>
${li('', 'camera', draft ? 'locked off · 18 mm' : 'locked off · 18 mm', { on: on === 'camera', mark: draft ? '~' : '' })}
${li('o', 'plate', 'Lobby · matched')}
${li('#2f7fd8', 'Ade', 'sits · armchair', { mark: draft ? '+' : '' })}
${li('#d6336c', 'Ife', 'walks 3.3 m · leans', { mark: draft ? '+' : '' })}
<div class="grp">set · 9</div>
${li('o', 'lobby', 'room · 8 × 12 × 5', { mark: draft ? '+' : '' })}
${li('o', 'lifts', '2 doors · right wall', { mark: draft ? '+' : '' })}
${li('o', 'armchairs', '2 · leather', { mark: draft ? '+' : '' })}
${li('o', 'planter · palm · lamp', '3 · kit', { mark: draft ? '+' : '' })}
<div class="grp">lights · 5</div>
${li('l', 'niche wash · lamp · pendant · 2 strips', 'warm', { mark: draft ? '+' : '' })}
<div class="add">${I.plus} Add set</div><div class="add">${I.plus} Add light</div>`;
const cameraForm = `<div class="eyebrow">Camera<span class="mono">key 1 of 2</span></div>
${row('subject', sel('Ade'))}
${row('size', chips(['Wide', 'Med', 'MCU', 'CU'], 'Wide'))}
${row('angle', chips(['Eye', 'Low', 'High', 'Top'], 'Eye'))}
${row('lens', num('18 mm'))}
${row('move', sel('Locked off'))}`;
// The foot: Keep beside Render while there is something to keep; Render and Export once it is kept.
const foot = ({ waiting = false } = {}) => waiting
  ? `<div class="foot">${row('playblast', '<span class="mono">after Keep</span>')}<div class="btns"><button type="button" class="btn" disabled style="opacity:.45">Export playblast</button><button type="button" class="btn" disabled style="opacity:.45">Render with this</button></div></div>`
  : `<div class="foot">${row('playblast', '<span style="color:var(--success)">filed</span>')}<div class="btns"><button type="button" class="btn">Export playblast</button><button type="button" class="btn primary">Render with this</button></div></div>`;
const panel = (list, form, ft) => `<div class="panel">${list}<div class="rule"></div>${form}${ft}</div>`;
const main = (v, p) => `<div class="main">${v}${p}</div>`;

// ---------- Transport, compact ----------
const pct = (t, d) => `${(t / d * 100).toFixed(2)}%`;
const transport = ({ dur = 2, at = 0.8, keys = [0, 2], cast = true } = {}) => `<div class="tl" style="margin-top:8px"><div class="play"><i>▶</i><span class="mono">${at.toFixed(1)}s / ${dur.toFixed(1)}s</span></div><div class="track"><span class="rail"></span><span class="done" style="width:${pct(at, dur)}"></span>${keys.map((k, i) => `<span class="k${i === 0 || i === keys.length - 1 ? ' end' : ''}" style="left:${pct(k, dur)}"></span>`).join('')}<span class="head" style="left:${pct(at, dur)}"></span></div><span class="mono">${keys.length} keys</span>
${cast ? `<div class="who"><i style="background:#2f7fd8"></i>Ade</div><div class="lane"><span class="rail"></span><span class="m" style="left:0%;background:#2f7fd8"></span><span class="m" style="left:100%;background:#2f7fd8"></span><span class="p" style="left:15%;top:-3px">sit</span></div><span class="mono">2 marks</span>
<div class="who"><i style="background:#d6336c"></i>Ife</div><div class="lane"><span class="rail"></span><span class="m" style="left:0%;background:#d6336c"></span><span class="m" style="left:100%;background:#d6336c"></span><span class="p" style="left:12%;top:-3px">walk</span></div><span class="mono">2 marks</span>` : ''}</div>`;

// ---------- Frames ----------
const SUMMARY = [['+', 'room · 2 doors'], ['+4', 'kit'], ['+', 'lamp with light'], ['+5', 'lights'], ['+', 'Ade sits'], ['+', 'Ife walks · leans'], ['~', 'camera · Wide 18 mm', true]];

const frameRoom = () => page(`${head()}${line()}${main(vp(), panel(stageList(), cameraForm, foot()))}${transport()}`);

const frameDraft = () => page(`${head({ meta: 'draft · v7 · 2 keys' })}${draftBar({ who: 'Arke’s blockout', items: SUMMARY })}${main(
  vp(),
  panel(stageList({ draft: true }), cameraForm, foot({ waiting: true })))}${transport()}`);

const NOTES = `<div class="notes"><div class="eyebrow" style="padding:0">Arke’s notes<span class="mono">round 1 · 38 calls · 2:04</span></div>
<p>Matched the plate at 18 mm, horizon 1.05 m. The niche wash and the lamp read warm against the glass wall, as the plate does.</p>
<p>Ife’s path keeps a metre from the armchair until her last mark.</p>
<p class="warn">The lifts sit 0.4 m off the plate’s right wall; Match camera may move them.</p></div>`;
const frameNotes = () => page(`${head({ meta: 'draft · v7 · 2 keys' })}${draftBar({ who: 'Arke’s blockout', items: SUMMARY, open: true })}${main(
  vp({ over: NOTES, toolsLeft: '444px' }),
  panel(stageList({ draft: true }), cameraForm, foot({ waiting: true })))}${transport()}`);

const frameQuick = () => page(`${head({ meta: 'draft · v7 · 2 keys' })}${draftBar({ who: 'Quick layout', items: [['+', 'Ade sits · armchair'], ['+', 'Ife stands · lifts'], ['~', 'camera · Wide on Ade', true]], notes: false })}${main(
  vp({ img: 'over-grey', lk: 'Greybox', pip: 'shot1-grey', only: ['Ade', 'Ife'] }).replace('class="vp"', 'class="vp ground"'),
  panel(`<div class="eyebrow">Stage<span class="mono">draft · 3 changes</span></div>
${li('', 'camera', 'locked off · 18 mm', { on: true, mark: '~' })}
${li('o', 'plate', 'Lobby · matched')}
${li('#2f7fd8', 'Ade', 'sits · armchair', { mark: '+' })}
${li('#d6336c', 'Ife', 'stands · lifts', { mark: '+' })}
<div class="grp">set · 9</div>
${li('o', 'lobby', 'room · 8 × 12 × 5')}
${li('o', 'lifts', '2 doors · right wall')}
${li('o', 'armchairs', '2 · leather')}
${li('o', 'planter · palm · lamp', '3 · kit')}
<div class="grp">lights · 5</div>
${li('l', 'niche wash · lamp · pendant · 2 strips', 'warm')}
<div class="add">${I.plus} Add set</div><div class="add">${I.plus} Add light</div>`, cameraForm, foot({ waiting: true })))}${transport()}`);

// Start from, on a stage with nothing on it yet: only Nothing can be chosen.
const FROM_MENU = `<div class="menu" style="right:278px;top:142px">
<div class="opt on"><span class="tick">${I.check}</span><span>Nothing</span><span class="mono">set · cast · camera</span></div>
<div class="opt off"><span class="tick"></span><span>This shot</span><span class="mono">no marks yet</span></div>
<div class="opt off"><span class="tick"></span><span>The scene</span><span class="mono">no blocking yet</span></div></div>`;
const frameFrom = () => page(`${head({ title: 'Wide · Ade waits', meta: 'v1 · empty' })}${line({ typed: 'A hotel lobby at night. Ade waits in an armchair; Ife comes out of the lifts and leans on his shoulder.', start: 'Nothing', plate: true })}${FROM_MENU}${main(
  `<div class="vp empty"><div class="grid"></div>${tools('Look', 'Greybox')}</div>`,
  panel(`<div class="eyebrow">Stage<span class="mono">empty</span></div>
${li('', 'camera', 'unset', { on: true })}
${li('o', 'plate', 'Lobby · not matched')}
<div class="add">${I.plus} Add figure</div><div class="add">${I.plus} Add set</div><div class="add">${I.plus} Add light</div>`, `<div class="eyebrow">Shot<span class="mono">Wide · Ade waits</span></div>
${row('size', 'wide')}${row('lens', 'unset')}${row('rig', sel('Sticks'))}`, `<div class="foot">${row('playblast', '<span class="mono">nothing staged</span>')}<div class="btns"><button type="button" class="btn" disabled style="opacity:.45">Export playblast</button><button type="button" class="btn" disabled style="opacity:.45">Render with this</button></div></div>`))}${transport({ at: 0, keys: [], cast: false })}`);

// The plate picker: the world's location pictures by name; every other picture is a switch away.
const tile = (img, name, on = false) => `<div class="tile${on ? ' on' : ''}"><i style="background-image:url(${img})"></i><span>${esc(name)}</span></div>`;
const PICKER = `<div class="picker" style="left:12px;top:142px">
<div class="ph"><b>Plate</b><span class="search">${I.search}<span style="margin-left:6px">Search locations</span></span></div>
<div class="eyebrow" style="padding:0">Locations<span class="mono">3</span></div>
<div class="tiles">${tile(PLATE, 'Lobby · night', true)}${tile('assets/launch-harbour.webp', 'The marina')}${tile('assets/world-undersong.png', 'The headland')}<div class="makes"><button type="button">${I.plus}Generate</button><button type="button">${I.up}Upload</button></div></div>
<div class="switch"><i></i>Show all pictures</div>
<div class="pf"><button type="button" class="btn">Cancel</button><button type="button" class="btn primary">Use plate</button></div></div>`;
const framePicker = () => page(`${head()}${line()}${PICKER}${main(vp(), panel(stageList(), cameraForm, foot()))}${transport()}`);

export const FRAMES = [
  ['a', 'The Stage in the page. Its own workspace: the head on one line, the dock away, Keep and Render at the inspector’s foot, and a viewport of 1004 × 580 at 1360 × 850.', 1360, 850, frameRoom()],
  ['b', 'After Build. The draft takes the line’s place: what it changed, counted and named from the draft itself, then Discard and Keep. The viewport draws the draft in its own look and lights.', 1360, 850, frameDraft()],
  ['c', 'Arke’s notes, opened. The model’s own words sit behind the bar’s disclosure, apart from the summary of what the draft did.', 1360, 850, frameNotes()],
  ['d', 'Quick layout waits too. The same bar, named Quick layout: nothing from Arke or a preset lands until it is kept.', 1360, 850, frameQuick()],
  ['e', 'Start from, on an empty stage. Nothing, This shot, The scene; with no blocking yet, only Nothing can be chosen.', 1360, 850, frameFrom()],
  ['f', 'The plate picker. The world’s locations by name, Generate and Upload beside them, and every other picture behind Show all pictures.', 1360, 850, framePicker()],
];
