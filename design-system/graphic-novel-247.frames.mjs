// Turn 247 · The graphic novel (SPEC-064): the frames. The sample is The Undersong's Low Water
// drawn as a graphic novel: chapter 1, The tide, page 3 in the Feature layout, Maren on the rail.
// The comic pages are drawn from the master's own pictures with lettering laid over them in HTML;
// they stand for generated pages and are samples, as are every count, price and finding. Every
// frame's root is .gn247 with its data-screen-label.
const svg = (d, w = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const CHECK = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 3);
const ALERT = svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>');
const X = svg('<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>');
const DOWN = svg('<path d="m6 9 6 6 6-6"/>');
const LEFT = svg('<path d="m15 18-6-6 6-6"/>');
const RIGHT = svg('<path d="m9 18 6-6-6-6"/>');
const PLUS = svg('<path d="M12 5v14M5 12h14"/>');
const SPARK = svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>');

const rail = (on) => `<div class="gn247-rail"><div class="t">Low Water, drawn</div><div class="k">Graphic novel</div>${[
  ['Dashboard'], ['Cast', '4'], ['Develop'], ['Overview', 'v2'], ['Chapters', '6'], ['Pages', '24'],
].map(([label, n]) => `<a class="${label === on ? 'on' : ''}">${label}${n ? `<span>${n}</span>` : ''}</a>`).join('')}<hr><a>Artifacts<span>31</span></a></div>`;

const head = (extra = '') => `<div class="gn247-head"><h2>Pages</h2><span class="gn247-tabs"><span class="on">1 · The tide</span><span>2 · Salt</span><span>3 · The bell</span></span><span class="grow"></span>${extra}<span class="gn247-sel"><b>Reading</b>Left to right${DOWN}</span><span class="gn247-sel"><b>Lettering</b>In the picture${DOWN}</span><span class="gn247-btn">Read</span><span class="gn247-btn">Export</span></div>`;

// Feature: one wide panel over two. Rectangles are the layout template's (contracts LAYOUT_TEMPLATES).
const FEATURE = [{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }];
const PICS = ['assets/saltlight-shot15.png', 'assets/char-maren.png', 'assets/drowned-quarter.png'];
const pct = (n) => `${(n * 100).toFixed(2)}%`;
const panels = (pics = PICS, clean = false) => FEATURE.map((r, i) => `<div class="p${clean ? ' clean' : ''}" style="left:calc(${pct(r.x)} + 6px);top:calc(${pct(r.y)} + 6px);width:calc(${pct(r.w)} - 12px);height:calc(${pct(r.h)} - 12px)"><img src="${pics[i]}" alt=""></div>`).join('');
const LETTERS = {
  caption: (t) => `<div class="gn247-bal cap" style="left:5%;top:4%;max-width:46%">${t}</div>`,
  speech: (t) => `<div class="gn247-bal" style="left:8%;top:55%;max-width:34%">${t}</div>`,
  sfx: (t) => `<div class="gn247-bal sfx" style="left:62%;top:80%">${t}</div>`,
};
const page = ({ caption = 'The tide came in grey.', speech = 'Where are you?', sfx = 'Hsssh', clean = false, extra = '' } = {}) =>
  `<div class="gn247-comic">${panels(PICS, clean)}${clean ? '' : LETTERS.caption(caption) + LETTERS.speech(speech) + (sfx ? LETTERS.sfx(sfx) : '')}${extra}</div>`;

const lay = (id, label, rects, on) => `<div class="gn247-lay${on ? ' on' : ''}"><i>${rects.map((r) => `<u style="left:${2 + r.x * 32}px;top:${2 + r.y * 50}px;width:${r.w * 32 - 2}px;height:${r.h * 50 - 2}px"></u>`).join('')}</i>${label}</div>`;
const grid = (c, r) => Array.from({ length: c * r }, (_, i) => ({ x: (i % c) / c, y: Math.floor(i / c) / r, w: 1 / c, h: 1 / r }));
const LAYOUTS = () => `<div class="gn247-layouts">${[
  ['grid-2x2', 'Grid', grid(2, 2)], ['feature', 'Feature', FEATURE], ['strip-3', 'Wide', grid(1, 3)], ['splash', 'Splash', [{ x: 0, y: 0, w: 1, h: 1 }]],
  ['manga', 'Manga', [{ x: 0, y: 0, w: .4, h: .35 }, { x: .4, y: 0, w: .6, h: .35 }, { x: 0, y: .35, w: 1, h: .3 }, { x: 0, y: .65, w: .6, h: .35 }, { x: .6, y: .65, w: .4, h: .35 }]],
  ['webtoon', 'Webtoon', grid(1, 3)],
].map(([id, label, rects]) => lay(id, label, rects, id === 'feature')).join('')}</div>`;

const chip = (name, img) => `<span class="gn247-chip${img ? '' : ' plain'}">${img ? `<img src="${img}" alt="">` : ''}${name}</span>`;
const line = (kind, who, words, bad = false) => `<div class="gn247-row"><span class="gn247-kind">${kind}${DOWN}</span><span class="gn247-who">${who}</span><span class="gn247-words${bad ? ' bad' : ''}">${words}</span></div>`;
const editor = (badLine = false) => `<div class="gn247-edit"><h3>Page 3</h3>${LAYOUTS()}
<div class="gn247-panel"><div class="gn247-ph"><b>Panel 1</b><span class="m">wide</span><span class="grow"></span><span class="m">1 line</span></div><div class="gn247-desc">Maren alone on the flooded pier at dawn, the lighthouse beam in the fog.</div><div class="gn247-row"><b>Shows</b>${chip('Maren', 'assets/char-maren.png')}${chip('The pier', 'assets/saltlight-shot15.png')}</div>${line('Caption', '—', 'The tide came in grey.')}</div>
<div class="gn247-panel"><div class="gn247-ph"><b>Panel 2</b><span class="grow"></span><span class="m">1 line</span></div><div class="gn247-desc">Maren close, collar up, calling out over the water.</div><div class="gn247-row"><b>Shows</b>${chip('Maren', 'assets/char-maren.png')}${chip('The pier', 'assets/saltlight-shot15.png')}</div>${line('Speech', 'Maren', 'Where are you?', badLine)}</div>
<div class="gn247-panel"><div class="gn247-ph"><b>Panel 3</b><span class="grow"></span><span class="m">1 line</span></div><div class="gn247-desc">The empty water. Something moves under the surface.</div>${line('Sound', '—', 'Hsssh')}<div class="gn247-more">+ Line</div></div>
<span class="gn247-btn sm" style="align-self:flex-start">${PLUS}Panel</span></div>`;

const strip = (on = 3, states = ['ok', 'ok', on === 3 ? '' : 'ok']) => `<div class="gn247-strip">${[1, 2, 3, 4].map((n) => {
  if (n === 4) return `<div class="gn247-thumb empty"><span class="m">4</span></div>`;
  const s = states[n - 1];
  return `<div class="gn247-thumb${n === on ? ' on' : ''}"><img src="${['assets/scene4-shot13.png', 'assets/scene4-shot14.png', 'assets/saltlight-shot15.png'][n - 1]}" alt="">${s ? `<span class="s${s === 'w' ? ' w' : ''}">${s === 'w' ? ALERT : CHECK}</span>` : ''}<span class="n">${n}</span></div>`;
}).join('')}<div class="gn247-add">+ Page</div></div>`;

const screen = (label, height, side, opts = {}) => `<div class="gn247" data-screen-label="${label}" style="width:1360px;height:${height}px">${rail('Pages')}<div class="gn247-main">${head()}<div class="gn247-body">${strip(3, opts.states)}${editor(opts.badLine)}<div class="gn247-side">${side}</div></div></div></div>`;

const takes = (n, on, marks) => `<div class="gn247-takes">${Array.from({ length: n }, (_, i) => `<div class="gn247-take${i === on ? ' on' : ''}"><img src="assets/saltlight-shot15.png" alt="">${marks[i] ? `<span class="k${marks[i] === 'w' ? ' w' : ''}"></span>` : ''}</div>`).join('')}<span class="m">Take ${on + 1} of ${n}</span></div>`;

export const FRAMES = [
  ['a', 'Tell a story: Graphic novel, a kind of its own', 1360, 620, '', () => `<div class="gn247" data-screen-label="247a Tell a story's step two offers Graphic novel beside Novel, Audio drama and Other; the name, and Adapt from a story in the world" style="width:1360px;height:620px"><div class="gn247-door"><h2>Tell a story</h2><div class="q">What kind of story?</div><div class="gn247-cards">${[
    ['Novel', 'Chapters, to read.', 'assets/banner-story.png'], ['Audio drama', 'Episodes, for the ear.', 'assets/banner-audio.png'],
    ['Graphic novel', 'Pages, to look at.', 'assets/scene4-shot13.png'], ['Other', 'Nothing assumed.', ''],
  ].map(([b, s, img]) => `<div class="gn247-card${b === 'Graphic novel' ? ' on' : ''}"><div class="pl">${img ? `<img src="${img}" alt="">` : ''}</div><div class="tx"><b>${b}</b><span>${s}</span></div></div>`).join('')}</div><div class="gn247-field"><label>Name</label><div class="in">Low Water, drawn</div></div><div class="gn247-field"><label>Adapt from</label><div class="in">Low Water &#183; book &#183; 6 chapters<span class="grow"></span>${DOWN}</div></div><div class="foot"><span class="gn247-btn">Back</span><span class="gn247-btn pri">Plan with Arke</span></div></div></div>`],

  ['b', 'Pages: a page&#8217;s panels and lines, priced before it is made', 1360, 850, '', () => screen("247b Pages: the chapter's page strip, page 3's layout, its panels with who and where they show and each line's kind, speaker and exact words; the empty page priced with what rides", 850,
    `<div class="gn247-comic" style="background:var(--secondary)">${FEATURE.map((r, i) => `<div class="gn247-wire" style="left:calc(${pct(r.x)} + 6px);top:calc(${pct(r.y)} + 6px);width:calc(${pct(r.w)} - 12px);height:calc(${pct(r.h)} - 12px)">${i + 1}</div>`).join('')}</div>
<div class="gn247-make"><span class="gn247-btn pri">${SPARK}Make page</span><span class="gn247-check"><i class="on">${CHECK}</i>Until it passes</span><span class="grow"></span><span class="gn247-btn ghost sm">Brief</span><span class="m">GPT Image 2 &#183; 2:3 &#183; Maren, The pier ride &#183; ~$0.25 &#183; up to 3 &#183; ~$0.75</span></div>`)],

  ['c', 'A take checked: words that are not the script&#8217;s', 1360, 850, '', () => screen("247c A take read back: Maren's line came out misspelt and the sound effect is missing; each finding drawn where it is on the page, with the script's words beside what was read", 850,
    `${page({ speech: 'Wher are you?', sfx: '', extra: `<div class="gn247-hit" style="left:6.5%;top:53.5%;width:31%;height:7%"><span class="t">Altered</span></div><div class="gn247-hit" style="left:58%;top:76%;width:30%;height:12%"><span class="t">Missing</span></div>` })}
<div class="gn247-verdict bad">${X}<b style="font-weight:600">2 to fix</b><span class="grow"></span><span class="m">1 of 3 lines &#183; read by Claude Sonnet 5</span></div>
<div class="gn247-finds"><div class="gn247-find"><span class="k">Altered</span><span>Where are you?</span><s>Wher are you?</s></div><div class="gn247-find"><span class="k">Missing</span><span>Hsssh</span></div></div>
${takes(2, 1, ['w', 'w'])}
<div class="gn247-acts"><span class="gn247-btn pri">Make again</span><span class="gn247-btn">Accept anyway</span><span class="grow"></span><span class="gn247-btn ghost sm">Check again</span></div>`, { badLine: true, states: ['ok', 'ok', 'w'] })],

  ['d', 'A take that passes, accepted', 1360, 850, '', () => screen("247d Take 3 read back with every line the script's: one press accepts it, and the strip marks the page done", 850,
    `${page()}
<div class="gn247-verdict ok">${CHECK}<b style="font-weight:600">Lettering</b><span>3 of 3</span><span class="grow"></span><span class="m">read by Claude Sonnet 5</span></div>
${takes(3, 2, ['w', 'w', 'ok'])}
<div class="gn247-acts"><span class="gn247-btn pri">Accept</span><span class="gn247-btn">Make again</span></div>`, { states: ['ok', 'ok', 'ok'] })],

  ['e', 'Not checked: never a pass', 1360, 850, '', () => screen("247e The check could not run, here because no image reader is on: the take is marked not checked, and only Accept anyway keeps it", 850,
    `${page()}
<div class="gn247-verdict warn">${ALERT}<b style="font-weight:600">Not checked</b><span>no image reader</span><span class="grow"></span><span class="gn247-btn ghost sm">Settings</span></div>
${takes(1, 0, ['w'])}
<div class="gn247-acts"><span class="gn247-btn">Accept anyway</span><span class="gn247-btn">Make again</span><span class="grow"></span><span class="gn247-btn ghost sm">Check again</span></div>`, { states: ['ok', 'ok', 'w'] })],

  ['f', 'Read: the book as it will be read', 1360, 760, '', () => `<div class="gn247" data-screen-label="247f Read: the accepted pages one at a time, turned left to right or right to left, or as one vertical scroll; a page with no accepted take shows as missing" style="width:1360px;height:760px"><div class="gn247-read"><div class="bar"><b style="font-weight:600">Low Water, drawn</b><span class="m">Page 3 of 24</span><span class="grow"></span><span class="gn247-tabs"><span class="on">Left to right</span><span>Right to left</span><span>Scroll</span></span><span class="gn247-btn sm" style="background:#262626;color:#ededed;border-color:#3a3a3a">Close</span></div><div class="stage"><span class="arrow">${LEFT}</span>${page()}<span class="arrow">${RIGHT}</span></div><div class="scrub"><i></i></div></div></div>`],

  ['g', 'Over the art: lettering Arke places on clean art', 1360, 850, '', () => screen("247g Lettering over the art: the page made without words, each line placed as a balloon or caption Arke draws, dragged and sized; the words stay the script's", 850,
    `${page({ extra: `<div class="gn247-handle" style="left:8%;top:55%;width:24%;height:5%"></div>` }).replace('gn247-comic', 'gn247-comic')}
<div class="gn247-verdict ok">${CHECK}<b style="font-weight:600">Clean art</b><span class="grow"></span><span class="m">no words read</span></div>
<div class="gn247-finds"><div class="gn247-place"><span class="k">Caption</span><span class="grow">The tide came in grey.</span><span class="m">placed</span></div><div class="gn247-place on"><span class="k">Speech</span><span class="grow">Where are you?</span><span class="m">placed</span></div><div class="gn247-place"><span class="k">Sound</span><span class="grow">Hsssh</span><span class="m">placed</span></div></div>
<div class="gn247-acts"><span class="gn247-btn pri">Accept</span><span class="gn247-btn">Place all</span></div>`, { states: ['ok', 'ok', 'ok'] }).replace('<b>Lettering</b>In the picture', '<b>Lettering</b>Over the art')],

  ['h', 'Export: a book of pages, and what holds it', 1360, 720, '', () => `<div class="gn247" data-screen-label="247h Export: CBZ, PDF, EPUB and Arke Player from the accepted pages, the reading direction carried in each; what holds it, each in one clause with the press that clears it" style="width:1360px;height:720px">${rail('Pages')}<div class="gn247-main">${head()}</div><div class="gn247-dim"></div><div class="gn247-sheet" style="top:40px;width:760px"><h3>Export &#183; Low Water, drawn</h3><div class="sub">Graphic novel &#183; 6 chapters &#183; 24 pages &#183; 2:3</div><div class="gn247-kinds">${[
    ['CBZ', 'comic readers', true], ['PDF', 'print &#183; share', true], ['EPUB', 'fixed layout', false], ['Arke Player', 'phone &#183; offline', false],
  ].map(([b, s, on]) => `<div class="gn247-kindc${on ? ' on' : ''}"><span class="r"></span><div><b>${b}</b><span>${s}</span></div></div>`).join('')}</div><div class="gn247-opts"><div class="gn247-opt"><b>Pages</b><span>23 of 24 accepted</span><span class="grow"></span><i>1 to clear</i></div><div class="gn247-opt"><b>Lettering</b><span>21 checked</span><span class="grow"></span><i>2 accepted anyway</i></div><div class="gn247-opt"><b>Reading</b><span>Left to right</span><span class="grow"></span></div><div class="gn247-opt"><b>Credits</b><span>Michael Josiah &#183; pictures by GPT Image 2</span><span class="grow"></span></div><div class="gn247-opt"><b>Edition</b><span>28 Oct 2026</span><span class="grow"></span></div></div><div class="gn247-block">${ALERT}<span class="c">Page 17 &#183; no accepted take</span><span class="gn247-btn sm">Go to</span></div><div class="gn247-foot"><span class="m">~96 MB &#183; 2 files</span><span class="grow"></span><span class="gn247-btn">Cancel</span><span class="gn247-btn pri off">Export</span></div></div></div>`],
];
