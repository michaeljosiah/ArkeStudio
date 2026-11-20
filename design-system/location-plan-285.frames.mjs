// Turn 285 · the Plan: the frames. Every screen the Plan stands in is the app's own, taken by
// location-plan-285.capture.mjs (the scene page on Flow, the Stage in the page, a location's
// Reference tab and the scene page on a phone) and patched here in the few places the turn
// changes: a tab, a toolbar press, the part of the page the Plan takes. The Plan's inspector is
// the Stage's inspector (its own classes, so its own rules), and its pictures are renders from
// location-plan-285.render.mjs. The sample is location-plan-285.plan.mjs: Gold on Gold.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { screens } from './location-plan-285.app.mjs';
import { CAST, CROSSING, DRAWN, NAME_AT, PLACE, POSITIONS, SET_LABELS, SHOTS, SIDES, shotsAt } from './location-plan-285.plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const L = JSON.parse(fs.readFileSync(path.join(here, 'location-plan-285.labels.json'), 'utf8'));
const A = 'assets/location-plan-285-';
export const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

// Glyphs: the client's own paths (icons.tsx), as the captured markup carries them.
const svg = (paths, px = 12) => `<svg width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const PLUS = svg('<path d="M5 12h14"></path><path d="M12 5v14"></path>');
const MINUS = svg('<path d="M5 12h14"></path>', 10);
const UP = svg('<path d="M5 12h14"></path><path d="M12 5v14"></path>', 10);
const CHECK = svg('<path d="M20 6 9 17l-5-5"></path>', 13);
const DOWN = svg('<path d="m6 9 6 6 6-6"></path>');

// ---------- The sample's numbers, counted from the sample ----------
const shotsWord = n => `${n} ${n === 1 ? 'shot' : 'shots'}`;
const placed = SHOTS.filter(shot => shot.position > 0).length;
if (placed !== 57 || SHOTS.length !== 72) throw new Error('the sample is 72 shots, 57 of them in the club');
for (const position of [...POSITIONS, CROSSING]) if ([...position.name].length > 24) throw new Error(`${position.name}: a position's name is 24 characters at most`);
const colourOf = name => CAST.find(member => member.name === name).colour;

// ---------- The plan: a render, and what is written on it ----------
const spot = (frame, x, z) => `left:${((x - frame.x0) * frame.s).toFixed(1)}px;top:${((z - frame.z0) * frame.s).toFixed(1)}px`;
// The Stage's own label, placed as the Stage places one.
const label = (frame, text, x, z, cast) => `<div class="fy-swstage__label"${cast ? ' data-cast="true"' : ''} style="position:absolute;transform:translate(-50%,-50%);white-space:nowrap;${cast ? `--fy-cast:${cast};` : ''}${spot(frame, x, z)}">${esc(text)}</div>`;
const numbers = (frame, positions) => positions.map(p => `<span class="pl285-n" style="${spot(frame, p.at[0], p.at[2])}">${p.n}</span>`).join('');
const scale = frame => `<span class="pl285-scale"><i style="width:${(2 * frame.s).toFixed(1)}px"></i>2 m</span>`;
function planView(render, { positions = POSITIONS, cast = true, find = '' } = {}) {
  const frame = L[render];
  return `<div class="fy-swstage__viewport pl285-vp" style="background-image:url(${A}${render}.jpg)">${SET_LABELS.map(([name, x, z]) => label(frame, name, x, z)).join('')}${cast ? CAST.map(member => label(frame, member.name, ...NAME_AT[member.id], member.colour)).join('') : ''}${numbers(frame, positions)}${scale(frame)}${find}</div>`;
}

// ---------- The inspector, in the Stage's own parts ----------
const eyebrow = (title, meta) => `<div class="fy-swstage__eyebrow"><span>${title}</span><span>${meta}</span></div>`;
const block = inner => `<div class="fy-swstage__block">${inner}</div>`;
const positionRow = (p, { selected = false, warn = false, count } = {}) => `<button type="button" class="fy-swstage__item"${selected ? ' data-selected="true"' : ''}${warn ? ' data-warn="true"' : ''}><span class="pl285-num">${p.n}</span><span>${esc(p.name)}</span><span>${shotsWord(count ?? shotsAt(p.n).length)}</span></button>`;
const positionsBlock = (rows, total) => block(`${eyebrow('Positions', `${total} · ${placed} of ${SHOTS.length} shots`)}${rows}<button type="button" class="fy-swstage__add">${PLUS}Add position</button>`);
const pairRow = (pair, state) => `<button type="button" class="fy-swstage__item"><span class="pl285-pair"><i style="background:${colourOf(pair.left)}"></i><i style="background:${colourOf(pair.right)}"></i></span><span>${pair.left} · ${pair.right}</span><span>${shotsWord(pair.shots)} · ${state}</span></button>`;
const sidesBlock = states => block(`${eyebrow('Sides', 'left · right')}${SIDES.map((pair, i) => pairRow(pair, states[i])).join('')}`);
const CLEAR = '<em class="pl285-ok">clear</em>';
const panel = inner => `<aside class="fy-swstage__panel" aria-label="Plan inspector">${inner}</aside>`;
const work = (view, inspector) => `<section class="pl285" aria-label="Plan"><div class="fy-swstage__work">${view}${inspector}</div></section>`;

const row = (name, control) => `<div class="fy-swstage__row"><span class="fy-swstage__rowlabel">${name}</span>${control}</div>`;
const select = value => `<select class="fy-swstage__select"><option>${esc(value)}</option></select>`;
const chips = (all, on) => `<span class="fy-swstage__chips" role="radiogroup">${all.map(word => `<button type="button" role="radio" aria-checked="${word === on}"${word === on ? ' data-on="true"' : ''}>${word}</button>`).join('')}</span>`;
const stepper = (value, unit) => `<span class="fy-swstage__stepper"><input type="number" value="${value}" style="width: 2.5ch;"><span class="fy-swstage__unit">${unit}</span><span class="fy-swstage__nudge"><button type="button" aria-label="lens down">${MINUS}</button><button type="button" aria-label="lens up">${UP}</button></span></span>`;
// A position's form: its name, then the camera in words exactly as the Stage's camera form writes it.
function positionForm(p) {
  const w = p.words;
  return block(`${eyebrow('Position', `${p.n} of ${POSITIONS.length}`)}<div>${row('name', `<input class="fy-swstage__field" value="${esc(p.name)}" maxlength="24">`)}${row('subject', select(w.subject))}${row('size', chips(['Wide', 'Med', 'MCU', 'CU'], w.size))}${row('angle', chips(['Eye', 'Low', 'High', 'Top'], w.angle))}${row('side', select(w.side))}${w.over ? row('over', select(w.over)) : ''}${row('lens', stepper(w.lens, 'mm'))}</div>`);
}
// Its two views, as two of the Stage's picture-in-picture: the grey view, and the picture drawn from it.
const view = (file, caption) => `<div class="fy-swstage__pip pl285-view" style="background-image:url(${A}${file}.jpg)"><span>${caption}</span></div>`;
const viewsBlock = p => block(`${eyebrow('View', '16:9')}<div class="pl285-views">${view(`grey-${p.n}`, 'grey view')}${DRAWN.includes(p.n) ? view(`pic-${p.n}`, 'picture') : '<div class="pl285-view pl285-view--none"></div>'}</div><div class="fy-swstage__ways"><button type="button" class="ui-btn ui-btn--outline ui-btn--sm">${DRAWN.includes(p.n) ? 'Redraw picture' : 'Draw picture'}<span class="pl285-model">GPT Image 2</span></button></div>`);

// ---------- The scene page, as it ships, with a fourth view ----------
const TAB = (name, on) => `<button type="button" role="radio" aria-checked="${on}" class="fy-sw__tab"${on ? ' data-on="true"' : ''}>${name}</button>`;
function swap(html, from, to, what) {
  if (!html.includes(from)) throw new Error(`the captured page has no ${what}; run location-plan-285.capture.mjs again and look at what changed`);
  return html.replace(from, to);
}
function scenePage(body) {
  let html = screens.scene.html;
  html = swap(html, '<button type="button" role="radio" aria-checked="true" class="fy-sw__tab" data-on="true">Flow</button>', TAB('Flow', false) + TAB('Plan', true), 'Flow tab');
  html = swap(html, '<button type="button" class="fy-sw__full" title="Full screen"', '<button type="button" class="fy-sw__boards-toggle">Export plan</button><button type="button" class="fy-sw__full" title="Full screen"', 'Full screen press');
  return `<div class="app285">${swap(html, '<!--slot:body-->', body, 'body')}</div>`;
}

const frameScene = () => scenePage(work(
  planView('plan-scene'),
  panel(`${positionsBlock(POSITIONS.map(p => positionRow(p)).join(''), POSITIONS.length)}${sidesBlock([CLEAR, CLEAR])}`)));

const WIDE = POSITIONS[4];
const framePosition = () => scenePage(work(
  planView('plan-selected'),
  panel(`${block(`${eyebrow('Positions', `${POSITIONS.length} · ${placed} of ${SHOTS.length} shots`)}${positionRow(WIDE, { selected: true })}`)}${positionForm(WIDE)}${viewsBlock(WIDE)}`)));

// Shot 23 tried from the bar's side: it leaves position 7 for a new one across the pair's line.
const frameCrossing = () => scenePage(work(
  planView('plan-crossing', { positions: [...POSITIONS, CROSSING], find: '<div class="pl285-find"><i></i>Shot 23 crosses Ade · Ife</div>' }),
  panel(`${positionsBlock([...POSITIONS.map(p => positionRow(p, { count: shotsAt(p.n).length - (p.n === 7 ? 1 : 0) })), positionRow(CROSSING, { warn: true, count: 1 })].join(''), POSITIONS.length + 1)}${sidesBlock([CLEAR, '<em class="pl285-warn">1 crossing</em>'])}`)));

// ---------- The place's sheet, as it ships, with a third tab ----------
const card = p => `<article class="fy-locref__view"><div class="fy-locref__viewimage fy-imghost"><button type="button" class="fy-locref__zoom" aria-label="View larger: ${esc(p.name)}"><img class="fy-portrait" alt="${esc(`${PLACE.name}: ${p.name}`)}" src="${A}${DRAWN.includes(p.n) ? 'pic' : 'grey'}-${p.n}.jpg" style="border-radius: 6px;"></button></div><div class="fy-locref__viewfoot"><div class="fy-locref__viewhead"><span class="fy-locref__panel fy-mono">${p.n}</span><h3 title="${esc(p.name)}">${esc(p.name)}</h3></div><p class="fy-mono">${p.mm} mm · ${DRAWN.includes(p.n) ? 'picture Nov 18' : 'no picture'}</p></div></article>`;
function framePlace() {
  const frame = L['plan-place'];
  let html = screens.reference.html;
  html = swap(html, '<span class="fy-seg__item fy-seg__item--active">Reference</span>', '<button type="button" class="fy-seg__item">Reference</button><span class="fy-seg__item fy-seg__item--active">Plan</span>', 'Reference tab');
  html = swap(html, '<p>locked · location reference set</p>', `<p>locked · set v${PLACE.version} · ${POSITIONS.length} positions</p>`, 'line under the name');
  const plan = `<div class="pl285-vp pl285-vp--place" style="height:${frame.h}px;background-image:url(${A}plan-place.jpg)">${SET_LABELS.map(([name, x, z]) => `<span class="pl285-tag" style="${spot(frame, x, z)}">${esc(name)}</span>`).join('')}${numbers(frame, POSITIONS)}${scale(frame)}</div>`;
  const body = `<main class="fy-locref fy-locref--uncompiled pl285-place"><section class="fy-locref__views"><div class="fy-locref__sechead"><h2>Positions</h2><span class="fy-mono">${POSITIONS.length} · ${DRAWN.length} drawn</span></div><div class="pl285-grid">${plan}${POSITIONS.map(card).join('')}</div><div class="pl285-foot"><button type="button" class="ui-btn ui-btn--secondary ui-btn--default">Add position</button><button type="button" class="ui-btn ui-btn--outline ui-btn--default">Export plan</button></div></section></main>`;
  return `<div class="app285">${swap(html, '<!--slot:body-->', body, 'body')}</div>`;
}

// ---------- The Stage in the page, as it ships, opened on a position ----------
const option = (name, { on = false, off = false, meta = '' } = {}) => `<div class="pl285-opt${on ? ' on' : ''}${off ? ' off' : ''}"><span class="tick">${on ? CHECK : ''}</span><span>${name}</span><span class="m">${meta}</span></div>`;
function frameStage() {
  const screen = screens.stage;
  const third = POSITIONS[2];
  let html = screen.html;
  // The viewport's pixels are the app's own canvas, kept as a picture by the capture.
  html = swap(html, 'data-canvas="0" style="', `data-canvas="0" style="background:url(${screen.canvas}) center/100% 100%;`, 'Stage canvas');
  html = swap(html, '<div class="fy-swstage__group">set · 9</div>', `<div class="fy-swstage__group">set · 9 · ${esc(PLACE.name)}</div>`, 'set group');
  html = swap(html, '<div class="fy-swstage__row"><span class="fy-swstage__rowlabel">subject</span>', `${row('position', select(`${third.n} · ${third.name}`))}<div class="fy-swstage__row"><span class="fy-swstage__rowlabel">subject</span>`, 'camera form');
  // Start from, opened: the menu the turn-231 select opens, with the place as its fourth choice.
  const menu = `<div class="pl285-menu">${option('Nothing', { meta: 'set · cast · camera' })}${option('This shot', { on: true })}${option('The scene', { off: true, meta: 'no blocking yet' })}${option('The place', { meta: `set · position ${third.n}` })}</div>`;
  return `<div class="app285">${html}${menu}</div>`;
}

// ---------- The scene page on a phone, as it ships, with a third view ----------
function framePhone() {
  const frame = L['plan-phone'];
  let html = screens['scene-phone'].html;
  html = swap(html, '<button type="button" role="radio" aria-checked="true" class="fy-sw__tab" data-on="true">Storyboard</button>', TAB('Storyboard', false) + TAB('Plan', true), 'Storyboard tab');
  const rows = POSITIONS.map(p => `<button type="button" class="pl285p-row"><span class="pl285-num">${p.n}</span><span>${esc(p.name)}</span><span>${shotsWord(shotsAt(p.n).length)}</span></button>`).join('');
  const pairs = SIDES.map(pair => `<button type="button" class="pl285p-row"><span class="pl285-pair"><i style="background:${colourOf(pair.left)}"></i><i style="background:${colourOf(pair.right)}"></i></span><span>${pair.left} · ${pair.right}</span><span>${shotsWord(pair.shots)} · ${CLEAR}</span></button>`).join('');
  const body = `<section class="pl285p" aria-label="Plan"><div class="pl285-vp pl285-vp--phone" style="background-image:url(${A}plan-phone.jpg)">${numbers(frame, POSITIONS)}</div><div class="pl285p-head"><span>Positions</span><span>${POSITIONS.length} · ${placed} of ${SHOTS.length} shots</span></div>${rows}<div class="pl285p-head"><span>Sides</span><span>left · right</span></div>${pairs}</section>`;
  return `<div class="app285p">${swap(html, '<!--slot:body-->', body, 'body')}</div>`;
}

export const FRAMES = [
  ['a', 'The Plan on a scene. The scene page gains a view: the place’s set from straight above in Greybox, each person on a mark in their colour, the two walks dashed, each position a numbered wedge as wide as its lens. The inspector lists the positions with their shots, then the pairs and the side their cameras keep.', 1360, 850, frameScene()],
  ['b', 'A position selected. The list folds to it and its form follows: its name, the camera in words as the Stage writes it, the grey view the Stage renders from it and the picture drawn from that view, and one press that draws the picture again.', 1360, 850, framePosition()],
  ['c', 'A shot that crosses the line. Shot 23 is tried from the bar’s side: its position’s wedge and row are in the warning colour, the pair counts one crossing, and one clause on the plan names it. Nothing is refused.', 1360, 850, frameCrossing()],
  ['d', 'The Plan on the place’s sheet. A location gains a tab beside Overview and Reference: the same set with no scene’s cast on it, and every position with its picture, or its grey view where none is drawn yet.', 1360, 850, framePlace()],
  ['e', 'A shot’s Stage, opened on a position. The camera form names the position it started from, the set’s header names the place it belongs to, and Start from offers the place after the scene.', 1360, 850, frameStage()],
  ['f', 'The Plan on a phone. The same picture fitted to the width with numbers only; the positions and the sides are the list beneath it.', 390, 844, framePhone()],
];
