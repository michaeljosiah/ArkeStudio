// Turn 277 · Text in the Cut (issue 2990): the frames. The editor is turn 220's source-backed Cut
// shell, drawn by its own script; this turn swaps the shell's Overlay lane for a lane of text clips,
// draws the painter's picture in the Viewer, and writes the Inspector a text clip shows. The sample
// is Harbour lights (16:9, 72 s, 24 fps) with three titles on a picture track of their own. The
// shell letterboxes its still; here the Viewer draws it as the film's 16:9 frame, the frame every per
// cent in the Inspector is measured against.
import { nativeScreen } from './air-particles-220.native.mjs';

const SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';
const T = `<svg class="tx-t" ${SVG} stroke-width="2"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/></svg>`;
const CHECK = `<svg ${SVG} stroke-width="2.4"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const b = (label, cls = '', attrs = '') => `<button type="button" class="${cls}"${attrs}>${label}</button>`;

// The film's three titles: words as typed, start and length in seconds. Capitals draws them upper
// case and never rewrites what is stored, so the lane and the Inspector show them as typed.
const TITLES = [['Harbour lights', 2, 16], ['The coast\nat first light', 22, 12], ['Evening', 56, 12]];
const NEW = [['Text', 2, 4]];
const FILM = 72;
const GOLD = ['#f6da94', '#e9c069', '#c9973d', '#9c6a1e'];
const DARK = '#1c1408';

// --- the shell, patched ---------------------------------------------------------------------------
function swap(html, from, to, what) {
  const i = html.indexOf(from);
  if (i < 0) throw new Error(`turn 220 shell: ${what} not found`);
  return html.slice(0, i) + to + html.slice(i + from.length);
}
function span(html, open, close, to, what) {
  const i = html.indexOf(open);
  const j = i < 0 ? -1 : html.indexOf(close, i);
  if (i < 0 || j < 0) throw new Error(`turn 220 shell: ${what} not found`);
  return [html.slice(0, i) + to + html.slice(j + close.length), html.slice(i, j + close.length)];
}
const pct = (seconds) => (seconds / FILM * 100).toFixed(3);
// Narrower than 64px a clip shows its glyph alone; scale is the lane's pixels per second. The face
// is the first line; the accessible name is every word.
const lane = (clips, picked, scale) => `<div class="n-lane tx-lane"><label>▤ Overlay 1</label><div>${clips.map(([words, from, length], i) => `<span class="tx-clip${picked.includes(i) ? ' on' : ''}${length * scale < 64 ? ' tiny' : ''}" role="button" aria-label="${words.replace('\n', ' ')}" style="left:${pct(from)}%;width:${pct(length)}%">${T}<b>${words.split('\n')[0]}</b></span>`).join('')}</div></div>`;
const clock = (seconds) => `00:00:${String(seconds).padStart(2, '0')}:00`;

// options: clips, picked (indexes), view (the Viewer's svg), inspector (markup), tip (Add's tip
// showing), at (playhead, seconds), device, foot (phone tools), sheet (phone Inspector open).
function screen(label, o) {
  const { clips = TITLES, picked = [0], at = 2, device = 'desktop' } = o;
  let html = nativeScreen({ overlay: true, highlight: false, values: { added: true }, label, device, phoneInspector: !!o.sheet });
  html = swap(html, 'class="air220 native220 ', 'class="air220 native220 tx277 ', 'root');
  [html] = span(html, '<div class="n-lane n-overlay-lane">', '</div></div>', lane(clips, picked, device === 'phone' ? 4.8 : 8.1), 'Overlay lane');
  [html] = span(html, '<canvas ', '</canvas>', o.view ?? '', 'Viewer canvas');
  html = swap(html, '<div class="n-media-row selected">', '<div class="n-media-row ">', 'Library row');
  html = swap(html, '4 lanes · 6 clips', `4 lanes · ${5 + clips.length} clips`, 'timeline count');
  html = swap(html, '· 5 clips', `· ${5 + clips.length} clips`, 'cut head count');
  html = swap(html, '<button type="button" class=""  >↷</button>', b('↷') + b(T, o.tip ? 'tx-add tx-tip' : 'tx-add', ' aria-label="Add text" data-tip="Add text · T"'), 'Redo');
  // A centred title would sit under the Viewer's Play button: with a text clip selected it is not drawn.
  if (picked.length) html = swap(html, '<button type="button" class="n-play" data-native-act="play" >▷</button>', '', 'Play button');
  if (at !== 2) {
    html = swap(html, '* 0.027777777777777776)', `* ${at / FILM})`, 'playhead');
    html = swap(html, 'aria-valuenow="48"', `aria-valuenow="${at * 24}"`, 'ruler value');
    html = swap(html, '00:00:02:00 / 00:01:12:00', `${clock(at)} / 00:01:12:00`, 'Viewer time');
    html = swap(html, '<span data-native-clock>00:00:02:00</span>', `<span data-native-clock>${clock(at)}</span>`, 'phone clock');
  }
  const body = o.inspector;
  const open = '<div class="n-inspector-scroll">';
  const i = html.indexOf(open), j = html.indexOf('</div><footer class="n-sheet-foot">', i);
  if (i < 0 || j < 0) throw new Error('turn 220 shell: Inspector not found');
  html = html.slice(0, i + open.length) + body + html.slice(j);
  if (o.foot) [html] = span(html, '<nav class="n-phone-tools">', '</nav>', o.foot, 'phone tools');
  if (o.sheetTitle) html = swap(html, '<b>Details</b>', o.sheetTitle, 'sheet title');
  return html;
}

// --- the Viewer: the film's frame and the painter's picture, in frame units (1920 × 1080) ---------
const STILL = '<image href="assets/launch-harbour.webp" x="0" y="-330" width="1920" height="2003" preserveAspectRatio="none"/>';
const stage = (inner) => `<svg class="tx-stage" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${STILL}${inner}</svg>`;
const halo = (id, colour, blur, opacity) => `<filter id="${id}" x="-20%" y="-80%" width="140%" height="260%"><feDropShadow dx="0" dy="0" stdDeviation="${blur}" flood-color="${colour}" flood-opacity="${opacity}"/></filter>`;
// A production's first text clip: Geist Regular at 8 % of the frame's height, centred, white, a dark halo.
const plain = (id) => stage(`<defs>${halo(`tx277${id}h`, '#000', 14, 0.8)}</defs><text x="960" y="540" font-family="Geist Sans" font-weight="400" font-size="86.4" text-anchor="middle" dominant-baseline="central" fill="#fff" filter="url(#tx277${id}h)">Text</text>`);
// The promo's look: four golds top to bottom of each line, a dark edge, a halo, a faded rule under
// the last line, a shade behind. y is the middle of the block (R-9); lines sit 120 % apart. Tracking
// falls between characters, so the half-step right keeps the letters, not their trailing space, on
// the centre. "HARBOUR LIGHTS" at 9 % is 1027 wide; Max width 50 % is 960, so Fit draws 8.4 %.
function gold(id, lines, size, { y = 810 } = {}) {
  const p = `tx277${id}`, n = lines.length, pitch = size * 1.2;
  const at = (i) => y + (i - (n - 1) / 2) * pitch;
  const text = lines.map((line, i) => `<text x="${960 + size * 0.1}" y="${at(i).toFixed(1)}" font-family="Jost" font-weight="400" font-size="${size}" letter-spacing="0.2em" text-anchor="middle" dominant-baseline="central" fill="url(#${p}g)" stroke="${DARK}" stroke-width="${(size * 0.044).toFixed(1)}" stroke-linejoin="round" paint-order="stroke" filter="url(#${p}h)">${line.toUpperCase()}</text>`).join('');
  return stage(`<defs><linearGradient id="${p}g" x1="0" y1="0" x2="0" y2="1">${GOLD.map((c, i) => `<stop offset="${(i / 3).toFixed(3)}" stop-color="${c}"/>`).join('')}</linearGradient><linearGradient id="${p}r"><stop offset="0" stop-color="${GOLD[1]}" stop-opacity="0"/><stop offset=".5" stop-color="${GOLD[1]}"/><stop offset="1" stop-color="${GOLD[1]}" stop-opacity="0"/></linearGradient><radialGradient id="${p}s"><stop offset="0" stop-color="#000" stop-opacity=".45"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>${halo(`${p}h`, DARK, 16, 0.85)}</defs><ellipse cx="960" cy="${y + 16}" rx="660" ry="${Math.round(170 + (n - 1) * pitch / 2)}" fill="url(#${p}s)"/>${text}<rect x="789" y="${Math.round(at(n - 1) + size * 0.95)}" width="342" height="3" fill="url(#${p}r)"/>`);
}

// --- the Inspector a text clip shows --------------------------------------------------------------
const section = (name, key, html, cls = '') => `<section class="n-section ${cls}" data-native-section="${key}"><h3>${name}</h3>${html}</section>`;
const switched = (name, key, on, html) => `<section class="n-section" data-native-section="${key}"><h3 class="tx-h">${name}<span class="tx-switch${on ? ' on' : ''}" role="switch" aria-checked="${on}" aria-label="${name}"></span></h3>${html}</section>`;
const head = (name) => `<header class="n-effect-title"><span>TEXT</span><h2>${name}</h2></header>`;
const select = (label, values, value, name = label) => `<label class="n-select">${label}<select aria-label="${name}">${values.map((v) => `<option${v === value ? ' selected' : ''}>${v}</option>`).join('')}</select></label>`;
// A value that differs across the selection is null: the field reads Mixed, the slider has no thumb.
const input = (name, value, unit = '%') => `<span class="n-input"><input type="number" aria-label="${name}" ${value === null ? 'placeholder="Mixed"' : `value="${value}"`}>${unit}</span>`;
const field = (label, value, name = label) => `<label class="tx-f">${label}${input(name, value)}</label>`;
const slider = (label, value, min, max, chip = '') => `<div class="n-number"><label><span>${label}${chip ? `<span class="tx-drawn">${chip}</span>` : ''}</span>${input(label, value)}</label><input type="range" aria-label="${label} slider" min="${min}" max="${max}" ${value === null ? `class="tx-mixed" value="${min}" aria-valuetext="Mixed"` : `value="${value}"`}></div>`;
const seg = (label, values, value, off = []) => `<div class="tx-seg" role="radiogroup" aria-label="${label}">${values.map((v) => `<button type="button" role="radio" aria-checked="${v === value}"${v === value ? ' class="on"' : ''}${off.includes(v) ? ' disabled' : ''}>${v}</button>`).join('')}</div>`;
const check = (label, on, off = false) => `<label class="n-check${off ? ' tx-off' : ''}"><input type="checkbox"${on ? ' checked' : ''}${off ? ' disabled' : ''}>${label}</label>`;
const swatch = (label, colour) => `<button type="button" class="tx-swatch" aria-label="${label} ${colour}" style="background:${colour}"></button>`;
const time = (label, value) => `<label class="n-time">${label}<input aria-label="${label}" value="${value}" inputmode="numeric"></label>`;

// The four faces the app ships today: family, has Bold, has Italic. Two more are proposed, not drawn.
const FACES = { Geist: ['Geist Sans', true, false], Jost: ['Jost', true, true], 'Comic Neue': ['Comic Neue', true, true], Bangers: ['Bangers', false, false] };
const family = (face) => `font-family:'${FACES[face][0]}',sans-serif`;
const faceMenu = (current) => `<div class="tx-menu" role="listbox" aria-label="Typeface">${Object.keys(FACES).map((f) => `<span class="it${f === current ? ' on' : ''}" role="option" aria-selected="${f === current}" style="${family(f)}">${f}${f === current ? CHECK : ''}</span>`).join('')}</div>`;
// Custom is what Place reads once X, Y or the alignment is changed by hand; it is not offered otherwise.
const PLACES = ['Middle', 'Lower third', 'Upper third', 'Lower left', 'Lower right'];
const COLOURS = ['One colour', 'Two colours', 'Three colours', 'Four colours'];

const words = (text, { selected = false, typing = false, refusal = '' } = {}) => section('Words', 'words', `<div class="tx-words${selected || typing ? ' focus' : ''}${refusal ? ' bad' : ''}" role="textbox" aria-multiline="true" aria-label="Words"${refusal ? ' aria-invalid="true"' : ''}>${selected ? `<span class="tx-sel">${text}</span>` : text}</div>${refusal ? `<p class="tx-refusal" role="alert">${refusal}</p>` : ''}`);
function type(l, { menu = false } = {}) {
  const [, bold, italic] = FACES[l.face];
  return section('Type', 'type', `<label class="n-select">Typeface${b(`${l.face}<i>▾</i>`, 'tx-face', ` aria-haspopup="listbox" aria-expanded="${menu}" style="${family(l.face)}"`)}</label>`
    + seg('Weight', ['Regular', 'Bold'], l.weight, bold ? [] : ['Bold'])
    + `<div class="tx-checks">${check('Italic', l.italic, !italic)}${check('Capitals', l.capitals)}</div>`
    + slider('Size', l.size, 1, 40, l.drawn ? `drawn ${l.drawn} %` : '')
    + `<div class="tx-row">${field('Tracking', l.tracking)}${field('Line', l.line, 'Line distance')}</div>`
    + (menu ? faceMenu(l.face) : ''), 'tx-type');
}
const place = (l) => section('Place', 'place', select('', l.place === null ? ['Mixed'] : l.place === 'Custom' ? [...PLACES, 'Custom'] : PLACES, l.place ?? 'Mixed', 'Place') + seg('Align', ['Left', 'Centre', 'Right'], l.align) + `<div class="tx-row">${field('X', l.x)}${field('Y', l.y)}${field('Max width', l.room)}</div>`);
const fill = (l) => section('Fill', 'fill', select('', COLOURS, COLOURS[l.fill.length - 1], 'Fill') + `<div class="tx-swatches">${l.fill.map((c, i) => swatch(`Colour ${i + 1}`, c)).join('')}</div>`);
const edge = (l) => switched('Edge', 'edge', !!l.edge, l.edge ? `<div class="tx-row sw">${swatch('Edge colour', l.edge[0])}${field('Width', l.edge[1], 'Edge width')}</div>` : '');
const shadow = (l) => switched('Shadow', 'shadow', !!l.shadow, l.shadow ? `<div class="tx-row sw">${swatch('Shadow colour', l.shadow[0])}${field('Opacity', l.shadow[1], 'Shadow opacity')}${field('Softness', l.shadow[2], 'Shadow softness')}</div><div class="tx-row">${field('X', l.shadow[3], 'Shadow offset X')}${field('Y', l.shadow[4], 'Shadow offset Y')}</div>` : '');
const rule = (l) => switched('Rule', 'rule', !!l.rule, l.rule ? `<div class="tx-row">${field('Length', l.rule[0], 'Rule length')}${field('Thickness', l.rule[1], 'Rule thickness')}${field('Distance', l.rule[2], 'Rule distance')}</div><div class="tx-checkline">${check('Faded ends', l.rule[3])}</div>` : '');
const backing = (l) => section('Backing', 'backing', select('', ['None', 'Shade', 'Box'], l.backing ? l.backing[0] : 'None', 'Backing') + (l.backing ? `<div class="tx-row sw">${swatch('Backing colour', l.backing[1])}${field('Opacity', l.backing[2], 'Backing opacity')}</div>` : ''));
const look = (l) => fill(l) + edge(l) + shadow(l) + rule(l) + backing(l);
// The rows a still picture shows, as shipped. PictureClipTiming: Position, In, Out and Duration, each
// a timecode between two frame steps, with no heading; a text clip has no source, so no Source in.
const step = (label, value) => `<div class="tx-trow"><span>${label}</span><strong><button type="button" class="tx-step" aria-label="${label} one frame earlier">−</button><input class="tx-code" aria-label="${label} timecode" value="${value}" inputmode="decimal"><button type="button" class="tx-step" aria-label="${label} one frame later">+</button></strong></div>`;
const timing = (from, length) => `<div class="tx-trows">${step('Position', clock(from))}${step('In', clock(from))}${step('Out', clock(from + length))}${step('Duration', clock(length))}</div>`;
const motion = () => section('Motion', 'motion', select('Move', ['None', 'Push in', 'Pull out', 'Drift left', 'Drift right', 'Drift up', 'Drift down'], 'None') + time('Fade in', '00:00:00:12') + time('Fade out', '00:00:00:12'));
// Appearance carries its own protection block, as the picture's does: no object line, no count.
const protection = () => `<section class="tx-protect" aria-label="Protection from AI suggestions"><h3>Protection from AI suggestions</h3><p>You can still edit protected settings yourself. Whole clip protection follows its split segments. Release removes only the named rule.</p><details><summary>Add setting protection</summary></details><p>No picture settings protected.</p></section>`;
const appearance = () => section('Appearance', 'appearance', select('Blend mode', ['Normal', 'Screen', 'Add'], 'Normal') + slider('Opacity', 100, 0, 100) + protection());
const top = (name, text, l, o = {}) => head(name) + words(text, o) + type(l, o) + place(l);

const FIRST = { face: 'Geist', weight: 'Regular', italic: false, capitals: false, size: 8, tracking: 0, line: 120, align: 'Centre', place: 'Middle', x: 50, y: 50, room: 90, fill: ['#ffffff'], shadow: ['#000000', 80, 30, 0, 0] };
const PROMO = { face: 'Jost', weight: 'Regular', italic: false, capitals: true, size: 9, drawn: '8.4', tracking: 20, line: 120, align: 'Centre', place: 'Lower third', x: 50, y: 75, room: 50, fill: GOLD, edge: [DARK, 2.2], shadow: [DARK, 85, 35, 0, 0], rule: [17.8, 3, 35, true], backing: ['Shade', '#000000', 45] };
// The other two titles differ from the first, so 277g's Mixed is true: The coast is two lines at 7 %,
// which Fit leaves alone; Evening was moved by hand to Y 70, which makes its place Custom.
const UNFIT = { ...PROMO, drawn: '' };
const COAST = { ...UNFIT, size: 7 };
const EVENING = { ...UNFIT, place: 'Custom', y: 70 };
const HARBOUR = () => gold('', ['Harbour lights'], 90.8);
const COASTAL = (id) => gold(id, ['The coast', 'at first light'], 75.6);

const DESKTOP = [
  ['a', 'Add: one press places a text clip at the playhead, selected, its words ready to type', 1360, 900, 'screen',
    () => screen('277a Add text pressed beside Redo: a four-second text clip on a new picture track at the playhead, selected, its words selected in the Inspector and drawn in the Viewer', { clips: NEW, tip: true, view: plain('a'), inspector: top('Text', 'Text', FIRST, { selected: true }) })],
  ['b', 'A text clip selected: Words, Type and Place', 1360, 900, 'screen',
    () => screen('277b A text clip selected: its words, its typeface, weight, size, tracking and line distance, and where it sits; Size shows the size Fit draws', { at: 6, view: HARBOUR().replaceAll('tx277', 'tx277b'), inspector: top('Harbour lights', 'Harbour lights', PROMO) })],
  ['c', 'The typeface menu, over a title of two lines', 1360, 900, 'screen',
    () => screen('277c The typeface menu open: the app’s faces, each name drawn in its own face, the current one checked; the clip and the heading show the first of the title’s two lines', { picked: [1], at: 24, view: COASTAL('c'), inspector: top('The coast', 'The coast\nat first light', COAST, { menu: true }) })],
  ['d', 'The look: Fill, Edge, Shadow, Rule and Backing', 1360, 900, 'screen',
    () => screen('277d Further down the Inspector: one to four colours top to bottom of each line, an edge, a shadow, a rule under the last line and a backing', { picked: [1], at: 24, view: COASTAL('d'), inspector: look(COAST) })],
  ['e', 'Then the rows a still picture shows: timing, Motion and Appearance', 1360, 900, 'screen',
    () => screen('277e The end of the Inspector: the timing rows, Motion and Appearance a still picture has, with Appearance’s own protection', { at: 6, view: HARBOUR().replaceAll('tx277', 'tx277e'), inspector: timing(2, 16) + motion() + appearance() })],
  ['f', 'A character the typeface cannot draw refuses by name', 1360, 900, 'screen',
    () => screen('277f Words typed that the typeface cannot draw: the field refuses by naming the face and the character; nothing is saved, so the clip and the Viewer keep the old words. This title was moved by hand, so Place reads Custom', { picked: [2], at: 58, view: gold('f', ['Evening'], 97.2, { y: 756 }), inspector: top('Evening', 'Alẹ́', EVENING, { typing: true, refusal: 'Jost has no ẹ' }) })],
  ['g', 'Several text clips selected: a change to the look reaches all of them', 1360, 900, 'screen',
    () => screen('277g Three text clips selected: the look without the words; a value that differs reads Mixed', { picked: [0, 1, 2], at: 6, view: HARBOUR().replaceAll('tx277', 'tx277g'), inspector: head('3 clips') + type({ ...UNFIT, size: null }) + place({ ...PROMO, place: null, y: null }) + fill(PROMO) })],
];

// --- the phone: the foot's tools as shipped (Library, Split, Undo, Redo, Arke; Split, the sheet's
// button, Duplicate, Delete, More over a selection), with Text among them ---------------------------
const glyph = (paths) => `<svg ${SVG} stroke-width="1.75" aria-hidden="true">${paths}</svg>`;
const GLYPHS = {
  Library: glyph('<rect width="7" height="7" x="3" y="3" rx="1"></rect><rect width="7" height="7" x="14" y="3" rx="1"></rect><rect width="7" height="7" x="3" y="14" rx="1"></rect><rect width="7" height="7" x="14" y="14" rx="1"></rect>'),
  Text: T,
  Split: glyph('<circle cx="6" cy="6" r="3"></circle><path d="M8.12 8.12 12 12"></path><path d="M20 4 8.12 15.88"></path><circle cx="6" cy="18" r="3"></circle><path d="M14.8 14.8 20 20"></path>'),
  Undo: glyph('<path d="M9 14 4 9l5-5"></path><path d="M4 9h11a5 5 0 0 1 0 10h-3"></path>'),
  Redo: glyph('<path d="m15 14 5-5-5-5"></path><path d="M20 9H9a5 5 0 0 0 0 10h3"></path>'),
  Arke: glyph('<path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2Z"></path>'),
  Edit: glyph('<path d="M8 3H5v18h3"></path><path d="M16 3h3v18h-3"></path>'),
  Duplicate: glyph('<rect width="14" height="14" x="8" y="8" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>'),
  Delete: glyph('<path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>'),
  More: glyph('<circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle>'),
};
const tools = (names, off = []) => names.map((n) => `<button type="button"${off.includes(n) ? ' disabled' : ''}>${GLYPHS[n]}${n}</button>`).join('');
const FOOT = `<nav class="tx-foot" aria-label="Tools">${tools(['Library', 'Text', 'Split', 'Undo', 'Redo', 'Arke'], ['Redo'])}</nav>`;
const footOver = (words, seconds) => `<nav class="tx-foot picked" aria-label="Tools"><div class="tx-picked">${T}${words} · ${seconds.toFixed(1)}s</div>${tools(['Split', 'Edit', 'Duplicate', 'Delete', 'More'])}</nav>`;
const faceList = (current) => `<div class="tx-list" role="listbox" aria-label="Typeface">${Object.keys(FACES).map((f) => `<span class="it" role="option" aria-selected="${f === current}" style="${family(f)}">${f}${f === current ? CHECK : ''}</span>`).join('')}</div>`;
const phone = (label, id, o) => screen(label, { device: 'phone', at: 6, view: HARBOUR().replaceAll('tx277', `tx277${id}`), inspector: '', foot: footOver('Harbour lights', 16), ...o });

const PHONE = [
  ['h', 'Phone: Text among the foot’s tools', 390, 844, 'phone',
    () => phone('277h Phone, nothing selected: Text sits in the foot between Library and Split', 'h', { picked: [], foot: FOOT })],
  ['i', 'Phone: a text clip selected', 390, 844, 'phone',
    () => phone('277i Phone, a text clip selected: the selection line names its words and length; Edit opens its sheet', 'i', {})],
  ['j', 'Phone: the sheet, under the Viewer', 390, 844, 'phone',
    () => phone('277j Phone, the sheet open on a text clip: it starts under the Viewer, so the words stay in sight while they change', 'j', { sheet: true, inspector: top('Harbour lights', 'Harbour lights', PROMO) })],
  ['k', 'Phone: the typeface list, in the sheet', 390, 844, 'phone',
    () => phone('277k Phone, Typeface pressed: the list takes the sheet, each name in its own face; the arrow goes back', 'k', { sheet: true, sheetTitle: `<span class="tx-back">${b('‹', '', ' aria-label="Back"')}<b>Typeface</b></span>`, inspector: faceList('Jost') })],
];

export const FRAMES = [...DESKTOP, ...PHONE];
