// Turn 288 · Director's checks, drawn: the frames. Every screen is the app's own, taken by
// director-checks-288.capture.mjs (Production settings over the production's front page; Generate on
// the bench lens, shot 13 before and after its first take; the Cut), and patched here only where the
// turn changes it: a Look section in the settings sheet, a count beside the press it holds, and the
// list opened at its count. The sample is 285's Gold on Gold (location-plan-285.plan.mjs).
import { screens } from './director-checks-288.app.mjs';

export const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
function swap(html, from, to, what) {
  if (!html.includes(from)) throw new Error(`the captured page has no ${what}; run director-checks-288.capture.mjs again and look at what changed`);
  if (html.indexOf(from) !== html.lastIndexOf(from)) throw new Error(`the captured page has more than one ${what}`);
  return html.replace(from, () => to);
}

// The client's own glyphs (icons.tsx), as the captured markup carries them.
const svg = (paths, px, stroke = '1.75') => `<svg width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const PLUS = svg('<path d="M5 12h14"></path><path d="M12 5v14"></path>', 12);
const TICK = svg('<path d="M20 6 9 17l-5-5"></path>', 11, '3');
const CHEVRON = svg('<path d="m6 9 6 6 6-6"></path>', 12);

// ---------- The lists: a label, a result, pass or fix, and whether it holds the paid press ----------
const BEFORE = [
  ['Line', 'word for word', 'pass', 'hard'], ['Named', 'Ade, Tunde', 'pass', 'hard'], ['Camera', 'says locked off', 'fix', 'hard'],
  ['Opens', 'as shot 12 ends', 'pass', 'hard'], ['Cut', 'matched', 'pass'], ['Light', 'purple from above', 'pass'],
  ['Beat before the line', '1.0 s', 'pass'], ['First frame', 'S2 set-up', 'pass', 'hard'], ['Voice', 'Tunde', 'pass', 'hard'],
  ["Ade’s watch", 'near wrist', 'fix', 'hard'],
];
const AFTER = [
  ['Lip sync', '0 ms', 'pass'], ['Words', 'as written', 'pass'], ['Voice nobody wrote', '7.6 s', 'fix'], ['Cuts inside', 'none', 'pass'],
  ['Camera', 'handheld · 7 px', 'pass'], ['Face', 'as the sheet', 'pass'], ['Hands', '2', 'pass'], ['Light', 'as shot 12', 'pass'],
  ['Joins', 'shot 12', 'pass'], ['Effects', 'on the action', 'pass'],
];
const CUT = [
  ['Matched cuts', '36 of 37 · cut 22', 'fix'], ['Sync at the end', '0 ms', 'pass'], ['Room tone', 'one a place', 'pass'],
  ['Mouth without a line', 'none', 'pass'], ['Inserts', '1.0–1.6 s', 'pass'], ['Lines over a listener', '24', 'pass'],
  ['Waiting', '2 shots over 1 s', 'fix'],
];
const passed = list => list.filter(item => item[2] === 'pass').length;
const heldBy = list => list.filter(item => item[2] !== 'pass' && item[3] === 'hard').length;
// The counts the turn states, counted from the lists rather than typed twice.
if (`${passed(BEFORE)} of ${BEFORE.length}` !== '8 of 10' || heldBy(BEFORE) !== 2) throw new Error('the list before shot 13 is 8 of 10 with 2 to fix');
if (`${passed(AFTER)} of ${AFTER.length}` !== '9 of 10') throw new Error('take 1 is 9 of 10');
if (`${passed(CUT)} of ${CUT.length}` !== '5 of 7') throw new Error('the cut is 5 of 7');

const TONE = { pass: 'ok', fix: 'warn', ask: 'sketch' };
const dot = result => `<span class="fy-dot fy-dot--${TONE[result]}"></span>`;
const chip = (list, { open = false } = {}) => `<button type="button" class="fy-takechip${open ? ' fy-takechip--on' : ''} dc288-chip" aria-haspopup="dialog" aria-expanded="${open}">${dot(passed(list) === list.length ? 'pass' : 'fix')}Checks · ${passed(list)} of ${list.length}</button>`;
const row = ([label, result, state], fixes) => `<div class="dc288-row" data-result="${state}">${dot(state)}<span class="dc288-label">${esc(label)}</span><span class="dc288-result">${esc(result)}</span>${state === 'fix' && fixes ? '<button type="button" class="ui-btn ui-btn--outline ui-btn--sm">Fix</button>' : ''}</div>`;
const button = (label, variant = 'outline') => `<button type="button" class="ui-btn ui-btn--${variant} ui-btn--sm">${esc(label)}</button>`;
const panel = ({ name, list, at, wide = false, fixes = true, foot = '' }) =>
  `<div class="dc288-panel${wide ? ' dc288-panel--wide' : ''}" role="dialog" aria-label="${esc(name)}" style="${at}"><div class="dc288-head">${esc(name)}</div><div class="dc288-list">${list.map(item => row(item, fixes)).join('')}</div>${foot ? `<div class="dc288-foot">${foot}</div>` : ''}</div>`;

// ---------- 288a · the look, in Production settings ----------
const seg = (all, on) => `<span class="fy-seg">${all.map(word => word === on ? `<span class="fy-seg__item fy-seg__item--active">${esc(word)}</span>` : `<button type="button" class="fy-seg__item">${esc(word)}</button>`).join('')}</span>`;
const check = (label, on = true) => `<label class="ui-check"><span class="ui-check__box"><input type="checkbox"${on ? ' data-s-on=""' : ''}>${TICK}</span><span class="ui-check__label">${esc(label)}</span></label>`;
const select = (value, name) => `<span class="ui-select"><select class="ui-select__control" aria-label="${esc(name)}"><option data-s-on="">${esc(value)}</option></select>${CHEVRON}</span>`;
const words = (value, name, wide = false) => `<input class="ui-input dc288-words${wide ? ' dc288-words--wide' : ''}" aria-label="${esc(name)} words" value="${esc(value)}">`;
const field = (name, controls) => `<div class="fy-models__row"><span class="fy-models__what">${esc(name)}</span>${controls}</div>`;
const PRESETS = ['Naturalistic drama', 'Romance', 'Thriller', 'Found footage', 'Music video'];
const OWN = ['Ade’s watch on his near wrist', 'Ife in her October look', 'Tunde in the navy polo', 'Bucket on her table from shot 42'];
const LOOK = `<section class="fy-models dc288-look" aria-label="Look"><div class="fy-models__head"><h3>Look</h3></div>`
  + field('Preset', `<span class="fy-takechips">${PRESETS.map(name => `<button type="button" class="fy-takechip${name === PRESETS[0] ? ' fy-takechip--on' : ''}">${esc(name)}</button>`).join('')}</span>`)
  // The words are Gold on Gold's, as turn 287's notes write its look.
  + field('Camera', `${seg(['Handheld', 'Steady', 'Locked', 'Shaky'], 'Handheld')}${seg(['Gentle', 'Strong'], 'Gentle')}${check('Push in on a beat')}${words('eye level, breathes', 'Camera')}`)
  + field('Light', `${seg(['Low key', 'High key'], 'Low key')}${words('purple from above, the bar’s glow, no fill', 'Light', true)}`)
  + field('Lens and focus', `${seg(['Wide', 'Normal', 'Long'], 'Long')}${seg(['Shallow', 'Deep'], 'Shallow')}${words('long across the floor', 'Lens and focus')}`)
  + field('Grade', words('35 mm, a little under, grain', 'Grade', true))
  + field('Cutting', `${check('Split cuts')}${select('Inserts 1 s', 'Inserts')}${words('cut on the beat', 'Cutting')}`)
  + field('Sound', `${check('One room tone a place')}${check('Keep the model’s clear effects')}${words('the club’s song under everything', 'Sound')}`)
  + field('Performance', `${seg(['Naturalistic', 'Heightened', 'Deadpan'], 'Naturalistic')}${words('nobody plays to camera', 'Performance')}`)
  + field('Own checks', `<span class="dc288-lines">${OWN.map(line => `<input class="ui-input dc288-line" aria-label="Own check" value="${esc(line)}">`).join('')}<button type="button" class="ui-btn ui-btn--ghost ui-btn--sm">${PLUS}Add</button></span>`)
  + '</section>';
function frameLook() {
  const html = swap(screens.settings.html, '<section class="fy-models" aria-label="Models">', LOOK + '<section class="fy-models" aria-label="Models">', 'Models card in the settings sheet');
  return `<div class="app288 dc288f-a">${html}</div>`;
}

// ---------- 288b and 288c · Generate, shot 13, on the bench lens ----------
// The press row, in two: the model chip where it was; then the count and the press beside it.
const CTA = /<div class="fy-gen__cta">(<span class="fy-modelchip">.*?<\/span><\/span>)<span class="fy-h1row__push"><\/span>(<button type="button" class="ui-btn ui-btn--primary ui-btn--default">Open generation session<\/button>)<\/div>/;
// The look line names the production's look and its preset, its mono part the look's choices as data.
// The sample production has no look of its own, so the capture's line reads the world's.
const lookLine = html => swap(html, '<div class="fy-worldlook-line"><span>World look · v3</span><small>inherited · Arke writes it into shot prompts</small></div>',
  '<div class="fy-worldlook-line"><span>Production look · Naturalistic drama</span><small>handheld · low key · long, shallow</small></div>', 'look line');
function pressRow(source, list, press) {
  const html = lookLine(source);
  const found = CTA.exec(html);
  if (!found) throw new Error('the captured bench has no press row; run director-checks-288.capture.mjs again');
  return html.replace(found[0], () => `<div class="fy-gen__cta">${found[1]}<span class="fy-h1row__push"></span></div><div class="fy-gen__cta dc288-cta"><span class="fy-h1row__push"></span>${chip(list, { open: list === BEFORE })}${press ?? found[2]}</div>`);
}
function frameBefore() {
  // Held: the press says what holds it, and the panel has the way past it.
  const html = pressRow(screens.before.html, BEFORE, `<button type="button" class="ui-btn ui-btn--primary ui-btn--default" data-s-off="">Generate · ${heldBy(BEFORE)} to fix</button>`);
  return `<div class="app288 dc288f-b">${html}${panel({ name: 'Before the shot', list: BEFORE, at: 'left:287px;width:392px;bottom:391px', foot: button('Generate anyway') })}</div>`;
}
// Shot 13's own list passed before its take was made, so its press is its own again.
const PASSED = BEFORE.map(([label, result, , hard]) => [label, label === 'Camera' ? 'handheld' : label === 'Ade’s watch' ? 'near wrist' : result, 'pass', hard]);
function frameAfter() {
  let html = pressRow(screens.after.html, PASSED);
  html = swap(html, '<div class="fy-bench__wallactions"><span style="flex: 1 1 0%;"></span>', `<div class="fy-bench__wallactions"><span style="flex: 1 1 0%;"></span>${chip(AFTER, { open: true })}`, 'take’s presses');
  return `<div class="app288 dc288f-c">${html}${panel({ name: 'After the take', list: AFTER, wide: true, fixes: false, at: 'left:716px;width:526px;bottom:56px', foot: `${button('Trim to 7.4 s')}${button('Remake')}` })}</div>`;
}

// ---------- 288d · the Cut ----------
function frameCut() {
  let html = screens.cut.html;
  html = swap(html, 'Watch from top</button>', `Watch from top</button>${chip(CUT, { open: true })}`, 'Watch from top');
  // The viewer holds the frame at the playhead, which the capture put on shot 21: the two-shot at
  // her table, as its poster shows it.
  swap(html, '<span class="fy-viewer__tag">1:51 / 5:33 · SHOT 21 · Both at her table</span>', '', 'viewer caption on shot 21');
  html = swap(html, '<video class="fy-cutviewer__video" playsinline="" style="opacity: 1;"></video>', '<video class="fy-cutviewer__video" playsinline="" style="opacity: 1;" poster="assets/juju-w-table.jpg"></video>', 'viewer');
  // The panel opens from the count's left edge across the Inspector, clear of both faces in the viewer.
  return `<div class="app288 dc288f-d">${html}${panel({ name: 'On the cut', list: CUT, at: 'left:826px;width:380px;top:93px' })}</div>`;
}

export const FRAMES = [
  ['a', 'The look, on the production. Production settings gains a Look between Clips and Models: a preset, each field a choice and its words, and the production’s own checks.', 1360, 850, frameLook()],
  ['b', 'Before a shot. Shot 13 on Generate: its count beside its press, the list open, two to fix, and the press held until they are.', 1360, 850, frameBefore()],
  ['c', 'After a take. Take 1 of shot 13: its count beside its verdicts, the list open over the take, one to fix, and the take’s two fixes.', 1360, 850, frameAfter()],
  ['d', 'On the cut. The Cut: its count beside Export film and the list open, two to fix.', 1360, 850, frameCut()],
];
