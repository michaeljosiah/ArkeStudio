// Turn 273: an upscale beside its source, as a wipe over one frame. The wall around it is the
// shipped Bench wall (fidelity.css .fy-bench__wall) at token sizes; the composer and the take
// strip beside it are unchanged and left out.
export const AFTER = 'assets/drowned-quarter.png';
// The same frame at 45%, the 864→1920 step, standing in for the 480p source.
export const BEFORE = 'assets/compare-273-before.jpg';

const svg = (d, size = 14) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  rerun: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  notThis: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none"/>',
  grip: '<path d="m9.5 7-5 5 5 5"/><path d="m14.5 7 5 5-5 5"/>',
};
const tool = (label, icon) => `<button type="button" class="tool" aria-label="${label}">${svg(ICON[icon])}</button>`;

const bar = ({ compare = false, pixels = false, refusal = '' } = {}) => `<div class="bar">`
  + `<button type="button" class="tab on">All</button><button type="button" class="tab">Filed</button><button type="button" class="tab">Discarded</button>`
  + `<button type="button" class="tab${compare ? ' on' : ''}" aria-pressed="${compare}">Compare</button>`
  + (refusal ? `<span class="refusal" role="alert">${refusal}</span>` : '')
  + (compare ? `<span class="grow"></span><span class="seg" role="radiogroup" aria-label="Scale"><button type="button" role="radio" aria-checked="${!pixels}"${pixels ? '' : ' class="on"'}>Fit</button><button type="button" role="radio" aria-checked="${pixels}"${pixels ? ' class="on"' : ''}>Pixels</button></span>` : '')
  + `</div>`;

const brief = `<div class="brief"><span class="line">Local · SeedVR2 · 1080p · from Take 19 · 864×480 → 1920×1080</span>`
  + `<span class="tools" role="toolbar" aria-label="Take tools">${tool('Run it again', 'rerun')}${tool('Download', 'download')}<span class="sep"></span>${tool('Not this', 'notThis')}${tool('Delete', 'trash')}</span></div>`;

const transport = (at, elapsed) => `<div class="transport"><button type="button" aria-label="Play">${svg(ICON.play, 11)}</button>`
  + `<span class="time">${elapsed}</span><div class="track" role="slider" aria-label="Position" aria-valuenow="${at}"><span style="width:${at}%"></span></div><span class="time end">0:07</span></div>`;

const actions = `<div class="actions"><span class="grow"></span><button type="button" class="btn">Discard</button><button type="button" class="btn primary">Keep take 21 · artifact</button></div>`;

// Pixels scales both pictures to the result's native width (1920 over a 972-wide box) about the
// point under the pointer; the clip stays on the untransformed layer, so the wipe line holds.
const ZOOM = 'transform:scale(1.98);transform-origin:27% 80%';
const wipe = ({ at, pixels = false, focus = false }) => `<div class="media"><div class="box">`
  + `<div class="layer"><img src="${AFTER}" alt=""${pixels ? ` style="${ZOOM}"` : ''}></div>`
  + `<div class="layer" style="clip-path:inset(0 ${100 - at}% 0 0)"><img src="${BEFORE}" alt=""${pixels ? ` style="${ZOOM}"` : ''}></div>`
  + `<span class="chip l">Take 19 · 864×480</span><span class="chip r">Take 21 · 1920×1080</span>`
  + `<div class="handle${focus ? ' focus' : ''}" style="left:${at}%" role="slider" tabindex="0" aria-label="Compare" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${at}"><span class="grip">${svg(ICON.grip, 16)}</span></div>`
  + transport(42, '0:03')
  + `</div></div>`;

const player = `<div class="media"><div class="box"><div class="layer"><img src="${AFTER}" alt="Take 21"></div>`
  + `<div class="chips"><span class="chip name">TAKE 21</span><span class="chip">1080p · 16:9 · 7.3s</span></div>`
  + `<button type="button" class="disc" aria-label="Play">${svg(ICON.play, 22)}</button>${transport(0, '0:00')}</div></div>`;

const wall = (body) => `<div class="cw273">${body}</div>`;

export const frames = [
  { id: '273a', title: 'An upscale offers Compare: its source wipes over it at Fit', width: 1000, height: 690,
    markup: wall(bar({ compare: true }) + brief + wipe({ at: 50 }) + actions) },
  { id: '273b', title: 'Pixels: both at the result’s native width; the pointer pans, the arrow keys move the line', width: 1000, height: 690,
    markup: wall(bar({ compare: true, pixels: true }) + brief + wipe({ at: 46, pixels: true, focus: true }) + actions) },
  { id: '273c', title: 'The source would not load: the result alone, and one clause by the tab', width: 1000, height: 690,
    markup: wall(bar({ refusal: 'Take 19 did not load' }) + brief + player + actions) },
];
