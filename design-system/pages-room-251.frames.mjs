// Turn 251 · Pages uses the window, and says what it is doing (issues 2259, 2260; SPEC-064). The
// frames are turn 247's Pages (247b – 247e) in its own markup: the rail, head, strip, editor and side
// are 247's classes; only the side's sizing and the making and checking states are new. The book is
// 247's sample, The Undersong's Low Water drawn, page 3 in the Feature layout. Counts are samples.
const svg = (d, w = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const CHECK = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 3);
const ALERT = svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>');
const DOWN = svg('<path d="m6 9 6 6 6-6"/>');
const PLUS = svg('<path d="M12 5v14M5 12h14"/>');
const SPARK = svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>');
const SPIN = `<span class="gn251-spin" aria-hidden="true"></span>`;

const rail = () => `<div class="gn247-rail"><div class="t">Low Water, drawn</div><div class="k">Graphic novel</div>${[
  ['Dashboard'], ['Cast', '4'], ['Develop'], ['Overview', 'v2'], ['Chapters', '6'], ['Pages', '24'],
].map(([label, n]) => `<a class="${label === 'Pages' ? 'on' : ''}">${label}${n ? `<span>${n}</span>` : ''}</a>`).join('')}<hr><a>Artifacts<span>31</span></a></div>`;
const head = () => `<div class="gn247-head"><h2>Pages</h2><span class="gn247-tabs"><span class="on">1 · The tide</span><span>2 · Salt</span><span>3 · The bell</span></span><span class="grow"></span><span class="gn247-sel"><b>Reading</b>Left to right${DOWN}</span><span class="gn247-btn">Read</span><span class="gn247-btn">Export</span></div>`;

const FEATURE = [{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }];
const PICS = ['assets/saltlight-shot15.png', 'assets/char-maren.png', 'assets/drowned-quarter.png'];
const pct = (n) => `${(n * 100).toFixed(2)}%`;
const at = (r) => `left:calc(${pct(r.x)} + 6px);top:calc(${pct(r.y)} + 6px);width:calc(${pct(r.w)} - 12px);height:calc(${pct(r.h)} - 12px)`;
const page = (extra = '') => `<div class="gn247-comic">${FEATURE.map((r, i) => `<div class="p" style="${at(r)}"><img src="${PICS[i]}" alt=""></div>`).join('')}<div class="gn247-bal cap" style="left:5%;top:4%;max-width:46%">The tide came in grey.</div><div class="gn247-bal" style="left:8%;top:55%;max-width:34%">Where are you?</div><div class="gn247-bal sfx" style="left:62%;top:80%">Hsssh</div>${extra}</div>`;
const wire = (extra = '') => `<div class="gn247-comic" style="background:var(--secondary)">${FEATURE.map((r, i) => `<div class="gn247-wire" style="${at(r)}">${i + 1}</div>`).join('')}${extra}</div>`;

const lay = (label, rects, on) => `<div class="gn247-lay${on ? ' on' : ''}"><i>${rects.map((r) => `<u style="left:${2 + r.x * 32}px;top:${2 + r.y * 50}px;width:${r.w * 32 - 2}px;height:${r.h * 50 - 2}px"></u>`).join('')}</i>${label}</div>`;
const grid = (c, r) => Array.from({ length: c * r }, (_, i) => ({ x: (i % c) / c, y: Math.floor(i / c) / r, w: 1 / c, h: 1 / r }));
const LAYOUTS = `<div class="gn247-layouts">${[
  ['Grid', grid(2, 2)], ['Feature', FEATURE], ['Wide', grid(1, 3)], ['Splash', [{ x: 0, y: 0, w: 1, h: 1 }]],
  ['Manga', [{ x: 0, y: 0, w: .4, h: .35 }, { x: .4, y: 0, w: .6, h: .35 }, { x: 0, y: .35, w: 1, h: .3 }, { x: 0, y: .65, w: .6, h: .35 }, { x: .6, y: .65, w: .4, h: .35 }]],
  ['Webtoon', grid(1, 3)],
].map(([label, rects]) => lay(label, rects, label === 'Feature')).join('')}</div>`;
const chip = (name, img) => `<span class="gn247-chip${img ? '' : ' plain'}">${img ? `<img src="${img}" alt="">` : ''}${name}</span>`;
const line = (kind, who, words) => `<div class="gn247-row"><span class="gn247-kind">${kind}${DOWN}</span><span class="gn247-who">${who}</span><span class="gn247-words">${words}</span></div>`;
const editor = `<div class="gn247-edit"><h3>Page 3</h3>${LAYOUTS}
<div class="gn247-panel"><div class="gn247-ph"><b>Panel 1</b><span class="m">wide</span><span class="grow"></span><span class="m">1 line</span></div><div class="gn247-desc">Maren alone on the flooded pier at dawn, the lighthouse beam in the fog.</div><div class="gn247-row"><b>Shows</b>${chip('Maren', 'assets/char-maren.png')}${chip('The pier', 'assets/saltlight-shot15.png')}</div>${line('Caption', '—', 'The tide came in grey.')}<div class="gn247-more">+ Line</div></div>
<div class="gn247-panel"><div class="gn247-ph"><b>Panel 2</b><span class="grow"></span><span class="m">1 line</span></div><div class="gn247-desc">Maren close, collar up, calling out over the water.</div><div class="gn247-row"><b>Shows</b>${chip('Maren', 'assets/char-maren.png')}${chip('The pier', 'assets/saltlight-shot15.png')}</div>${line('Speech', 'Maren', 'Where are you?')}<div class="gn247-more">+ Line</div></div>
<div class="gn247-panel"><div class="gn247-ph"><b>Panel 3</b><span class="grow"></span><span class="m">1 line</span></div><div class="gn247-desc">The empty water. Something moves under the surface.</div>${line('Sound', '—', 'Hsssh')}<div class="gn247-more">+ Line</div></div>
<span class="gn247-btn sm" style="align-self:flex-start">${PLUS}Panel</span></div>`;

// The strip: page 3 selected; `three` is page 3's thumbnail state.
const strip = (three) => `<div class="gn247-strip">${[1, 2, 3, 4].map((n) => {
  if (n === 4) return `<div class="gn247-thumb empty"><span class="m">4</span></div>`;
  const pic = ['assets/scene4-shot13.png', 'assets/scene4-shot14.png', 'assets/saltlight-shot15.png'][n - 1];
  if (n < 3) return `<div class="gn247-thumb"><img src="${pic}" alt=""><span class="s">${CHECK}</span><span class="n">${n}</span></div>`;
  if (three === 'making') return `<div class="gn247-thumb on gn251-busy">${SPIN}<span class="n">${n}</span></div>`;
  if (three === 'checking') return `<div class="gn247-thumb on gn251-busy"><img src="${pic}" alt="">${SPIN}<span class="n">${n}</span></div>`;
  if (three === 'warn') return `<div class="gn247-thumb on"><img src="${pic}" alt=""><span class="s w">${ALERT}</span><span class="n">${n}</span></div>`;
  return `<div class="gn247-thumb on"><img src="${pic}" alt=""><span class="s">${CHECK}</span><span class="n">${n}</span></div>`;
}).join('')}<div class="gn247-add">+ Page</div></div>`;

const takes = (n, on, marks, busy = -1) => `<div class="gn247-takes">${Array.from({ length: n }, (_, i) => `<div class="gn247-take${i === on ? ' on' : ''}">${i === busy ? `<div class="gn251-takewait">${SPIN}</div>` : '<img src="assets/saltlight-shot15.png" alt="">'}${marks[i] ? `<span class="k${marks[i] === 'w' ? ' w' : ''}"></span>` : ''}</div>`).join('')}<span class="m">Take ${on + 1} of ${n}</span></div>`;
const make = (label, busy, price) => `<div class="gn247-make"><span class="gn247-btn pri${busy ? ' off' : ''}">${busy ? SPIN : SPARK}${label}</span><span class="gn247-check"><i class="on">${CHECK}</i>Until it passes</span><span class="grow"></span><span class="gn247-btn ghost sm">Brief</span><span class="m">${price}</span></div>`;
const PRICE = 'Codex Image &#183; 2:3 &#183; Maren, The pier ride &#183; included &#183; up to 3';

// The page column is as wide as the page needs to stand at full height above its controls.
const screen = (label, width, height, side, three) => {
  const controls = 196; // verdict 38 + takes 70 + actions 32 + gaps and padding
  const pageH = height - 56 - 32 - controls;
  const sideW = Math.round(pageH * 2 / 3) + 36;
  return `<div class="gn247 gn251" data-screen-label="${label}" style="width:${width}px;height:${height}px">${rail()}<div class="gn247-main">${head()}<div class="gn247-body" style="grid-template-columns:136px minmax(440px,1fr) ${sideW}px">${strip(three)}${editor}<div class="gn247-side gn251-side">${side}</div></div></div></div>`;
};

export const FRAMES = [
  ['a', 'Pages uses the window: the page at full height, the script takes the rest', 1920, 1080, () => screen("251a Pages in a 1920 by 1080 window: the page column is as wide as the page needs to stand at full height above its verdict, takes and Accept; the script column takes every other pixel, so its lines no longer cut off", 1920, 1080,
    `${page()}
<div class="gn247-verdict ok">${CHECK}<b style="font-weight:600">Lettering</b><span>3 of 3</span><span class="grow"></span><span class="m">read by Claude Opus 5.5</span></div>
${takes(3, 2, ['w', 'w', 'ok'])}
<div class="gn247-acts"><span class="gn247-btn pri">Accept</span><span class="gn247-btn">Make again</span></div>`, 'ok')],

  ['b', 'Making: the page and its thumbnail say so', 1360, 850, () => screen("251b Make page pressed: the page shows Making with the take and the time so far, the strip's thumbnail spins, and the button reads Making until the take lands", 1360, 850,
    `${wire(`<div class="gn251-over">${SPIN}<b>Making</b><span>Take 1 of up to 3 &#183; 1:12</span></div>`)}
${make('Making', true, PRICE)}`, 'making')],

  ['c', 'A take lands: shown at once, then checked', 1360, 850, () => screen("251c Take 2 has landed and is shown by itself; while its lettering is read the verdict line says Checking, and Accept waits for the verdict", 1360, 850,
    `${page(`<div class="gn251-band">${SPIN}Checking lettering</div>`)}
<div class="gn247-verdict">${SPIN}<b style="font-weight:600">Checking lettering</b><span class="grow"></span><span class="m">Claude Opus 5.5</span></div>
${takes(2, 1, ['w', ''])}
<div class="gn247-acts"><span class="gn247-btn pri off">Accept</span><span class="gn247-btn">Make again</span></div>`, 'checking')],

  ['d', 'Not checked, in plain words, with the way out', 1360, 850, () => screen("251d The lettering reader cannot see pictures: the verdict says so in one clause; Choose reader opens the setting that fixes it and the page is checked again on return; Accept anyway and Make again stay", 1360, 850,
    `${page()}
<div class="gn247-verdict warn">${ALERT}<b style="font-weight:600;white-space:nowrap">Not checked</b><span>the reader can&#8217;t see pictures</span></div>
${takes(1, 0, ['w'])}
<div class="gn247-acts"><span class="gn247-btn pri">Choose reader</span><span class="gn247-btn">Accept anyway</span><span class="gn247-btn">Make again</span></div>`, 'warn')],
];
