// Arke Player · the parts every frame is drawn from: icons, the phone around a screen, the tabs,
// the dock, cards and rows. arke-player.frames.mjs composes them; arke-player.mjs writes the master.
export const A = 'assets/';

const P = {
  home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  library: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  download: '<path d="M12 15V3"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  downloaded: '<circle cx="12" cy="12" r="9.5"/><path d="m8.5 12.2 2.4 2.4 4.6-4.8"/>',
  user: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  captions: '<rect width="18" height="14" x="3" y="5" rx="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/>',
  route: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  text: '<path d="M4 7V5h16v2"/><path d="M9 19h6"/><path d="M12 5v14"/>',
  full: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  unfull: '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
  cast: '<path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><path d="M2 12a9 9 0 0 1 8 8"/><path d="M2 16a5 5 0 0 1 4 4"/><path d="M2 20h.01"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  package: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/><path d="m7.5 4.27 9 5.15"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  wifioff: '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
  book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  headphones: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
  auto: '<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>',
  replay: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  clock: '<circle cx="12" cy="12" r="9.5"/><path d="M12 7v5l3 2"/>',
  eyeoff: '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  out: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
  pausec: '<circle cx="12" cy="12" r="9.5"/><path d="M10 9v6M14 9v6"/>',
  volume: '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>',
};
const FILLED = {
  play: '<path d="M7 4.5v15l13-7.5z"/>',
  pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>',
  prev: '<path d="M6 5h2v14H6zM20 5v14L9 12z"/>',
  next: '<path d="M16 5h2v14h-2zM4 5v14l11-7z"/>',
  more: '<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>',
};

/** One icon. Stroked on Lucide's 24 grid, or filled for the transport. */
export function ic(name, size = 20, sw = 1.8) {
  if (FILLED[name]) return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${FILLED[name]}</svg>`;
  if (!P[name]) throw new Error(`no icon ${name}`);
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name]}</svg>`;
}

/** Seek by n seconds, back or forward, as 186d draws them. */
export function seek(n, back = true, size = 22) {
  const arc = back ? '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>' : '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${arc}<text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif">${n}</text></svg>`;
}

const bars = '<svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor" aria-hidden="true"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>';
const wifi = '<svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor" aria-hidden="true"><path d="M8.5 2.6c2.4 0 4.6.9 6.2 2.5l1.2-1.2C14 2 11.4.9 8.5.9S3 2 1.1 3.9l1.2 1.2C3.9 3.5 6.1 2.6 8.5 2.6z"/><path d="M8.5 6c1.5 0 2.8.6 3.8 1.5l1.2-1.2C12.2 5 10.4 4.3 8.5 4.3S4.8 5 3.5 6.3l1.2 1.2C5.7 6.6 7 6 8.5 6z"/><circle cx="8.5" cy="10" r="1.7"/></svg>';
const battery = '<svg width="27" height="13" viewBox="0 0 27 13" fill="none" aria-hidden="true"><rect x=".5" y=".5" width="23" height="12" rx="3.5" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="17" height="9" rx="2" fill="currentColor"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2z" fill="currentColor" opacity=".45"/></svg>';

/** The status bar. `over` lays it on a picture, in the overlay's ink; `offline` swaps Wi-Fi for its absence. */
export const sb = (over = false, offline = false) => `<div class="sb${over ? ' over on-media' : ''}"><span>9:41</span><span>${bars}${offline ? ic('wifioff', 16, 2) : wifi}${battery}</span></div>`;
export const hi = () => '<div class="hi"></div>';

const TABS = [['home', 'Home'], ['library', 'Library'], ['download', 'Downloads'], ['user', 'You']];
/** The four tabs: a bar above the home indicator on a phone, a rail on a Fold. */
export const tabs = (on, rail = false) => `<div class="${rail ? 'rail' : 'tabs'}">${TABS.map(([i, l]) => `<span class="tab${l === on ? ' on' : ''}">${ic(i, rail ? 24 : 24, l === on ? 2.1 : 1.7)}${l}</span>`).join('')}</div>`;

/** The dock: what plays while its player is closed, above the tabs. */
export const dock = ({ img, title, where, at = 44, playing = true }) => `<div class="dock"><span class="ln" style="width:${at}%"></span><img src="${A}${img}" alt=""><div class="grow"><b>${title}</b><span class="w">${where}</span></div><span class="dib">${seek(15)}</span><span class="dib">${ic(playing ? 'pause' : 'play', 22)}</span></div>`;

/** A frame's root. The label is what build tooling and the shooting driver find a frame by. */
export const frame = (id, title, cls, inner, style = '') => ({ id, title, markup: `<div class="ap ${cls}" data-screen-label="${id} ${esc(title)}"${style ? ` style="${style}"` : ''}>${inner}</div>` });

export const esc = (t) => String(t).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

/** A Continue card: a 16:9 picture with what it is, its title, where you are and a line of progress. */
export const cc = ({ img, kind, title, where, at, pos = 'center', w = 300 }) => `<div class="cc" style="width:${w}px;height:${Math.round(w * 9 / 16)}px"><img src="${A}${img}" alt="" style="object-position:${pos}"><div class="shade"></div><span class="go">${ic('play', 16)}</span><div class="tx"><div class="k">${kind}</div><div class="t">${title}</div><div class="w">${where}</div></div><div class="pl"><i style="width:${at}%"></i></div></div>`;

/** A production tile. `state` is one quiet word under the kind, or nothing. */
export const tile = ({ img, title, kind, pos = 'center', at, w = 160, tag = '', cls = '', mid = '' }) => `<div class="tile ${cls}" style="width:${w}px"><div class="im"><img src="${A}${img}" alt="" style="object-position:${pos}">${tag ? `<span class="tg">${tag}</span>` : ''}${mid ? `<span class="mid">${mid}</span>` : ''}${at != null ? `<div class="pl"><i style="width:${at}%"></i></div>` : ''}</div><div class="t">${title}</div><div class="m">${kind}</div></div>`;

/** A world as a wide card. */
export const wc = ({ img, name, meta, pos = 'center', cls = '', tag = '', style = '' }) => `<div class="wc ${cls}"${style ? ` style="${style}"` : ''}><img src="${A}${img}" alt="" style="object-position:${pos}"><div class="shade"></div>${tag ? `<div class="tg">${tag}</div>` : ''}<div class="tx"><h3>${name}</h3><div class="m">${meta}</div></div></div>`;

/** A section head. */
export const sh = (title, right = '') => `<div class="sh"><h2>${title}</h2>${right}</div>`;

/** A settings row: a label, its value, its state. */
export const row = (label, value = '', end = 'chev') => `<div class="r"><span class="l">${label}</span>${value ? `<span class="v">${value}</span>` : ''}${end === 'chev' ? `<span class="c">${ic('right', 16)}</span>` : end === 'on' ? '<span class="sw on"></span>' : end === 'off' ? '<span class="sw"></span>' : end}</div>`;

/** A sheet from the foot. */
export const sheet = (title, inner, { glass = false, count = '', close = true, style = '' } = {}) => `<div class="sheet${glass ? ' glass' : ''}"${style ? ` style="${style}"` : ''}><span class="grip"></span>${title ? `<div class="sht"><h3>${title}</h3>${count ? `<span class="ct">${count}</span>` : ''}${close ? `<span class="x">${ic('x', 16, 2)}</span>` : ''}</div>` : ''}${inner}</div>`;

/** Glass icon button on a picture. */
export const gb = (name, size = 20) => `<span class="ib glass">${ic(name, size)}</span>`;
