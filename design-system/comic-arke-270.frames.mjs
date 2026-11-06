// Turn 270 · Arke makes the book (SPEC-064; amends 269). From the owner's request of 6 November 2026 and
// round 95 on 0.5.99: Panel by panel works by hand, while Arke cannot see it or drive it. The book is
// 247's sample, Low Water drawn. The head and rail are 269's, what Pages ships; the dock is the Builder
// Chat as 0.5.99 draws it, and the card is .fy-actioncard's shape and its status words.
const svg = (d, w = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const SPARK = svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>');
export const CHECK = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 3);
export const ALERT = svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>');
export const WARN = svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>');
export const DOWN = svg('<path d="m6 9 6 6 6-6"/>');
export const RIGHT = svg('<path d="m9 6 6 6-6 6"/>');
export const PLUS = svg('<path d="M12 5v14M5 12h14"/>');
export const UNDO = svg('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>');
const MIC = svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>');
const SEND = svg('<path d="M12 19V5M6 11l6-6 6 6"/>');
const CLOSE = svg('<path d="M6 6l12 12M18 6 6 18"/>');
export const SPIN = '<span class="gn269-spin" aria-hidden="true"></span>';

export const STYLE = 'assets/comic-styles/painted.jpg';
export const NOIR = 'assets/comic-styles/noir.jpg';
export const PIER = 'assets/saltlight-shot15.png';
export const MAREN = 'assets/char-maren.png';
export const WATER = 'assets/drowned-quarter.png';

export const rail = `<div class="gn247-rail"><div class="t">Low Water, drawn</div><div class="k">Graphic novel</div><a>Dashboard</a><a>Cast<span>4</span></a><a>Develop</a><a>Overview<span>v2</span></a><a>Chapters<span>6</span></a><a class="on">Pages<span>24</span></a><hr><a>Artifacts<span>31</span></a></div>`;
export const head = (mode = 'Panel by panel', style = ['Painted', STYLE]) => `<div class="gn247-head"><h2>Pages</h2><span class="gn247-sel"><b>Chapter</b>1 · The tide${DOWN}</span><span class="grow"></span><span class="gn247-sel"><b>Mode</b>${mode}${DOWN}</span><span class="gn247-sel"><b>Style</b><img class="gn269-styleimg" src="${style[1]}" alt="">${style[0]}</span><span class="gn247-sel"><b>Reading</b>Left to right${DOWN}</span><span class="gn247-btn">Read</span><span class="gn247-btn">Export</span></div>`;

export const ok = `<span class="gn269-mark ok">${CHECK}</span>`;
export const bad = `<span class="gn269-mark bad">${ALERT}</span>`;
export const held = `<span class="gn269-mark gn271-held">${WARN}</span>`;
export const going = `<span class="gn269-mark">${SPIN}</span>`;
export const wait = '<span class="gn269-mark none"></span>';

export const thumb = (n, img, state = '', on = false) => `<div class="gn247-thumb${on ? ' on' : ''}${img ? '' : ' empty'}">${img ? `<img src="${img}" alt="">` : state === 'busy' ? '' : `<span class="m">${n}</span>`}${state === 'ok' ? `<span class="s">${CHECK}</span>` : state === 'x' ? `<span class="s x">${ALERT}</span>` : state === 'busy' ? `<span class="gn269-thumbspin">${SPIN}</span>` : ''}${img ? `<span class="n">${n}</span>` : ''}</div>`;
export const strip = thumbs => `<div class="gn247-strip">${thumbs.join('')}<div class="gn247-add">+ Page</div></div>`;

const line = (kind, who, words) => `<div class="gn247-row"><span class="gn247-kind">${kind}${DOWN}</span><span class="gn247-who">${who}</span><span class="gn247-words">${words}</span></div>`;
const panelRow = (n, mark, desc, shows, lines, on = false) => `<div class="gn247-panel${on ? ' gn269-picked' : ''}"><div class="gn247-ph"><b>Panel ${n}</b>${mark}<span class="grow"></span><span class="m">${lines.length} ${lines.length === 1 ? 'line' : 'lines'}</span></div><div class="gn247-desc">${desc}</div>${shows ? `<div class="gn247-row"><b>Shows</b>${shows}</div>` : ''}${lines.join('')}<div class="gn247-more">+ Line</div></div>`;
const chip = (img, name) => `<span class="gn247-chip"><img src="${img}" alt="">${name}</span>`;
const lay = (name, on, rects) => `<div class="gn247-lay${on ? ' on' : ''}"><i>${rects.map(([l, t, w, h]) => `<u style="left:${l}px;top:${t}px;width:${w}px;height:${h}px"></u>`).join('')}</i>${name}</div>`;
const layouts = lay('Grid', false, [[2, 2, 14, 23], [18, 2, 14, 23], [2, 27, 14, 23], [18, 27, 14, 23]]) + lay('Feature', true, [[2, 2, 30, 23], [2, 27, 14, 23], [18, 27, 14, 23]]) + lay('Wide', false, [[2, 2, 30, 14.7], [2, 18.7, 30, 14.7], [2, 35.3, 30, 14.7]]) + lay('Splash', false, [[2, 2, 30, 48]]) + lay('Manga', false, [[2, 2, 10.8, 15.5], [14.8, 2, 17.2, 15.5], [2, 19.5, 30, 13], [2, 34.5, 17.2, 15.5], [21.2, 34.5, 10.8, 15.5]]) + lay('Webtoon', false, [[2, 2, 30, 14.7], [2, 18.7, 30, 14.7], [2, 35.3, 30, 14.7]]);
export const script = (page, marks, picked = 0) => `<div class="gn247-edit"><h3>Page ${page}</h3><div class="gn247-layouts">${layouts}</div>
${panelRow(1, marks[0], 'Maren alone on the flooded pier at dawn, the lighthouse beam in the fog.', chip(MAREN, 'Maren') + chip(PIER, 'The pier'), [line('Caption', '—', 'She stopped the pen before the hook.')], picked === 1)}
${panelRow(2, marks[1], 'Maren close, collar up, calling out over the water.', chip(MAREN, 'Maren') + chip(PIER, 'The pier'), [line('Speech', 'Maren', 'Where are you?')], picked === 2)}
${panelRow(3, marks[2], 'The empty water. Something moves under the surface.', '', [line('Sound', '—', 'Hsssh')], picked === 3)}
<span class="gn247-btn sm" style="align-self:flex-start">${PLUS}Panel</span></div>`;

const RECTS = [['0%', '0%', '100%', '50%'], ['0%', '50%', '50%', '50%'], ['50%', '50%', '50%', '50%']];
export const cell = (index, inner, cls = '') => {
  const [l, t, w, h] = RECTS[index];
  return `<div class="p ${cls}" style="left:calc(${l} + 6px);top:calc(${t} + 6px);width:calc(${w} - 12px);height:calc(${h} - 12px)">${inner}</div>`;
};
export const art = (src, position = '') => `<img src="${src}" alt=""${position ? ` style="object-position:${position}"` : ''}>`;
export const tabs = active => `<div class="gn269-steps"><span class="${active === 'panels' ? 'on' : ''}">Panels</span><span class="${active === 'words' ? 'on' : ''}">Words</span></div>`;
const num = n => `<span class="gn270-num">${n}</span>`;

// The fault as 271a lays it out, since Arke's result leads the author to this same place.
export const findings = rows => rows.map(([kind, what, warn]) => `<div class="gn271-find"><span class="k${warn ? ' w' : ''}">${kind}</span><span class="what">${what}</span></div>`).join('');
export const faultSide = (page = 'gn271-page') => `<div class="gn247-side gn251-side">${tabs('panels')}<div class="gn247-comic ${page}">${cell(0, art(PIER))}${cell(1, art(MAREN), 'picked')}${cell(2, art(WATER))}<div class="gn247-hit" style="left:17%;top:66%;width:19%;height:11%"><span class="t">Defect</span></div></div>
<div class="gn271-verdict bad"><div class="top">${ALERT}<b>Panel 2</b><span>1 to fix</span><span class="grow"></span><span class="m">1 of 2</span><span class="gn271-next">${RIGHT}</span></div>${findings([['Defect', 'Left eye sits lower than the right.']])}</div>
<div class="gn269-taking"><div class="gn247-takes"><div class="gn247-take gn269-wide"><img src="${MAREN}" alt=""><span class="k w"></span></div><div class="gn247-take gn269-wide on"><img src="${MAREN}" alt=""><span class="k w"></span></div><span class="m">Take 2 of 2</span></div></div>
<div class="gn247-acts"><span class="gn247-btn pri">${SPARK}Make again</span><span class="gn247-btn">Accept anyway</span><span class="gn247-btn">Change with Arke</span></div>
<div class="gn271-foot"><span class="m">3 of 3</span><span class="gn271-model">GPT Image 2${DOWN}</span><span class="grow"></span><span class="gn247-btn ghost sm">Brief</span></div></div>`;

// The dock, as the installed app draws it.
export const user = words => `<div class="gn270-u">${words}</div>`;
export const said = (...lines) => `<div class="gn270-a">${lines.map(words => `<p>${words}</p>`).join('')}<div class="gn270-tools"><span>Listen</span><span>Copy</span></div></div>`;
const fact = (label, value, cls = '') => `<div class="gn270-fact ${cls}"><span>${label}</span><b>${value}</b></div>`;
const actionCard = (title, status, body, state = 'pending') => `<article class="gn270-card" data-status="${state}"><div class="gn270-cardhead"><h3>${title}</h3><span class="st">${status}</span></div>${body}</article>`;
const decide = '<div class="gn270-cardacts"><span class="gn247-btn pri">Approve</span><span class="gn247-btn ghost">Deny</span></div>';
export const dock = (...turns) => `<aside class="gn270-dock"><div class="gn270-dockhead"><div><b>Builder Chat</b><span>Saltlight / Low Water, drawn</span></div><span class="grow"></span><span class="x">&#183;&#183;&#183;</span><span class="x">${CLOSE}</span></div><div class="gn270-dockbody">${turns.join('')}</div><div class="gn270-composer"><span class="ph">Ask Arke...</span><div class="row"><span class="i">${PLUS}</span><span class="i">${MIC}</span><span class="gn270-modelchip">Claude Opus 5.5${DOWN}</span><span class="grow"></span><span class="send">${SEND}</span></div></div></aside>`;

const screen = (label, side, main) => `<div class="gn247 gn251 gn253 gn269 gn270 gn271" data-screen-label="${label}" style="width:1720px;height:850px">${rail}<div class="gn247-main gn270-main">${main}</div>${side}</div>`;
const body = (...columns) => `<div class="gn247-body" style="grid-template-columns:136px minmax(0,1fr) 372px">${columns.join('')}</div>`;

const askMake = user('Make chapter 1, panel by panel.');
const makeCard = actionCard('Make chapter 1', 'Needs your decision', `<div class="gn270-facts">${fact('Pages', '4')}${fact('Panels', '13')}${fact('Lines', '19')}${fact('Model', 'GPT Image 2')}${fact('Redraws', 'Up to 6')}${fact('Price', 'Up to $4.18', 'price')}</div><div class="gn270-note">${WARN}<span>No picture of Old Tam</span></div>${decide}`);

export const frames = [
  {
    id: '270a', title: 'One card makes a chapter', width: 1720, height: 850,
    markup: screen('270a Asked to make a chapter, Arke answers with one priced card: pages, panels, lines, model, how many redraws it may spend and the most it can cost. Nothing is made until Approve', dock(askMake, said('Chapter 1 is 4 pages, 13 panels.'), makeCard), `${head()}${body(strip([thumb(1, null, '', true), thumb(2), thumb(3), thumb(4)]), script(1, [wait, wait, wait]), `<div class="gn247-side gn251-side">${tabs('panels')}<div class="gn247-comic gn269-fixed">${cell(0, num(1), 'empty')}${cell(1, num(2), 'empty')}${cell(2, num(3), 'empty')}</div><div class="gn247-acts"><span class="gn247-btn pri">${SPARK}Make panels</span><span class="fy-price m">$0.66</span></div><div class="gn271-foot"><span class="m">0 of 3</span><span class="gn271-model">GPT Image 2${DOWN}</span><span class="grow"></span><span class="gn247-btn ghost sm">Brief</span></div></div>`)}`),
  },
  {
    id: '270b', title: 'Making: the card counts, the page fills', width: 1720, height: 850,
    markup: screen('270b Approved. The card counts page by page against the price approved and can be stopped; Pages fills in as the panels land, the same way as a press there', dock(askMake, said('Chapter 1 is 4 pages, 13 panels.'), actionCard('Make chapter 1', 'Running', `<div class="gn270-steps"><div class="done">${CHECK}<span>Page 1</span><span class="m">3 of 3</span></div><div class="now">${SPIN}<span>Page 2</span><span class="m">1 of 3</span></div><div><i></i><span>Page 3</span><span class="m">0 of 3</span></div><div><i></i><span>Page 4</span><span class="m">0 of 4</span></div></div><div class="gn270-facts">${fact('Spent', '$0.88 of $4.18', 'price')}</div><div class="gn270-cardacts"><span class="gn247-btn">Stop</span></div>`, 'running')), `${head()}${body(strip([thumb(1, 'assets/scene4-shot13.png', 'ok'), thumb(2, null, 'busy', true), thumb(3), thumb(4)]), script(2, [ok, going, wait], 2), `<div class="gn247-side gn251-side">${tabs('panels')}<div class="gn247-comic gn269-fixed">${cell(0, art(PIER))}${cell(1, `<div class="gn269-cellstate">${SPIN}<b>Making</b><span class="m">0:42</span></div>`, 'empty picked')}${cell(2, num(3), 'empty')}</div><div class="gn247-acts"><span class="gn247-btn off">${SPIN}Making</span></div><div class="gn271-foot"><span class="m">1 of 3</span><span class="gn271-model">GPT Image 2${DOWN}</span><span class="grow"></span><span class="gn247-btn ghost sm">Brief</span></div></div>`)}`),
  },
  {
    id: '270c', title: 'Done: only what needs you', width: 1720, height: 850,
    markup: screen('270c Finished. Panels with a fault left after their redraws are listed and open in place; pages with nothing left to decide are accepted by the author in one press', dock(askMake, said('Made. Two panels still have a fault.'), actionCard('Make chapter 1', 'Completed', `<div class="gn270-facts">${fact('Panels', '13 of 13')}${fact('Lines placed', '13 of 19')}${fact('Redrawn', '5')}${fact('Spent', '$3.96 of $4.18', 'price')}</div><div class="gn270-needs"><b>Needs you</b><div class="on">${ALERT}<span>Page 2 · panel 2</span><span class="m">Defect</span>${RIGHT}</div><div>${ALERT}<span>Page 4 · panel 1</span><span class="m">Likeness</span>${RIGHT}</div></div><div class="gn270-cardacts"><span class="gn247-btn pri">Accept 2 pages</span></div>`, 'completed')), `${head()}${body(strip([thumb(1, 'assets/scene4-shot13.png', 'ok'), thumb(2, PIER, 'x', true), thumb(3, 'assets/scene4-shot14.png', 'ok'), thumb(4, WATER, 'x')]), script(2, [ok, bad, ok], 2), faultSide())}`),
  },
  {
    id: '270d', title: 'Change with Arke carries the fault', width: 1720, height: 850,
    markup: screen('270d One press sends the panel and the finding. Arke proposes the change to that panel and one priced redraw; the other panels stay', dock(user('Page 2, panel 2. Defect: left eye sits lower than the right. Fix it.'), said('I&#8217;ll name her eyes and redraw this panel.'), actionCard('Make panel 2 again', 'Needs your decision', `<div class="gn270-change"><span class="m">Panel 2</span><s>Maren close, collar up, calling out over the water.</s><span>Maren close, collar up, calling out over the water, eyes level.</span></div><div class="gn270-facts">${fact('Other panels', 'Stay')}${fact('Price', '$0.22', 'price')}</div>${decide}`)), `${head()}${body(strip([thumb(1, 'assets/scene4-shot13.png', 'ok'), thumb(2, PIER, 'x', true), thumb(3, 'assets/scene4-shot14.png', 'ok'), thumb(4, WATER, 'x')]), script(2, [ok, bad, ok], 2), faultSide())}`),
  },
  {
    id: '270e', title: 'Arke reads the book, sets it and exports it', width: 1720, height: 850,
    markup: screen('270e Arke answers from the panels, reviews and Mode as they are. Mode and Export are cards too, and approving one leaves its sibling ready to approve', dock(user('How far along is this book? Use panel by panel from now on and export chapter 1.'), said('Whole page. 8 of 24 pages accepted, all of chapter 1. Page 9 has 1 to fix.'), `<div class="gn270-group"><b>2 cards</b><span class="grow"></span><span class="m">1 decision</span></div>`, actionCard('Use Panel by panel', 'Completed', `<div class="gn270-facts">${fact('Pages made', '8 stay')}</div>`, 'completed'), actionCard('Export chapter 1', 'Needs your decision', `<div class="gn270-facts">${fact('Pages', '4')}${fact('Files', 'CBZ, PDF')}${fact('Price', 'No cost', 'price')}</div>${decide}`)), `${head()}${body(strip([thumb(1, 'assets/scene4-shot13.png', 'ok', true), thumb(2, PIER, 'ok'), thumb(3, 'assets/scene4-shot14.png', 'ok'), thumb(4, WATER, 'ok')]), script(1, [ok, ok, ok]), `<div class="gn247-side gn251-side">${tabs('panels')}<div class="gn247-comic gn269-fixed">${art(STYLE)}</div><div class="gn253-verdicts"><div class="gn253-v ok">${CHECK}<b>Page 1</b><span>Accepted</span></div></div></div>`)}`),
  },
];
