// Turn 269 · Two ways to make a page (SPEC-064). From the owner, 5 November 2026, after the
// cell-by-cell trial on Legend of Dumah chapter 1. Whole page is today's Pages and is not redrawn;
// these frames are the setting and the second mode. The book is 247's sample, Low Water drawn, and
// the head and rail are what Pages ships (the chapter picker of 262, the style of 248).
const svg = (d, w = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const SPARK = svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>');
const CHECK = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 3);
const ALERT = svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>');
const WARN = svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>');
const DOWN = svg('<path d="m6 9 6 6 6-6"/>');
const PLUS = svg('<path d="M12 5v14M5 12h14"/>');
const UNDO = svg('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>');
const SPIN = '<span class="gn269-spin" aria-hidden="true"></span>';
const STYLE = 'assets/comic-styles/painted.jpg';

const PIER = 'assets/saltlight-shot15.png';
const MAREN = 'assets/char-maren.png';
const WATER = 'assets/drowned-quarter.png';

const rail = `<div class="gn247-rail"><div class="t">Low Water, drawn</div><div class="k">Graphic novel</div><a>Dashboard</a><a>Cast<span>4</span></a><a>Develop</a><a>Overview<span>v2</span></a><a>Chapters<span>6</span></a><a class="on">Pages<span>24</span></a><hr><a>Artifacts<span>31</span></a></div>`;
const head = (mode, open = false) => `<div class="gn247-head"><h2>Pages</h2><span class="gn247-sel"><b>Chapter</b>1 · The tide${DOWN}</span><span class="grow"></span><span class="gn247-sel${open ? ' gn269-on' : ''}"><b>Mode</b>${mode}${DOWN}</span><span class="gn247-sel"><b>Style</b><img class="gn269-styleimg" src="${STYLE}" alt="">Painted</span><span class="gn247-sel"><b>Reading</b>Left to right${DOWN}</span><span class="gn247-btn">Read</span><span class="gn247-btn">Export</span></div>`;
const screen = (label, height, body) => `<div class="gn247 gn251 gn253 gn269" data-screen-label="${label}" style="width:1360px;height:${height}px">${rail}<div class="gn247-main">${body}</div></div>`;

const thumb = (n, img, state = '', on = false) => `<div class="gn247-thumb${on ? ' on' : ''}${img ? '' : ' empty'}">${img ? `<img src="${img}" alt="">` : state === 'busy' ? '' : `<span class="m">${n}</span>`}${state === 'ok' ? `<span class="s">${CHECK}</span>` : state === 'x' ? `<span class="s x">${ALERT}</span>` : state === 'busy' ? `<span class="gn269-thumbspin">${SPIN}</span>` : ''}${img ? `<span class="n">${n}</span>` : ''}</div>`;
const strip = (third, state) => `<div class="gn247-strip">${thumb(1, 'assets/scene4-shot13.png', 'ok')}${thumb(2, 'assets/scene4-shot14.png', 'ok')}${thumb(3, third, state, true)}${thumb(4)}<div class="gn247-add">+ Page</div></div>`;

const line = (kind, who, words) => `<div class="gn247-row"><span class="gn247-kind">${kind}${DOWN}</span><span class="gn247-who">${who}</span><span class="gn247-words">${words}</span></div>`;
const panelRow = (n, mark, desc, shows, lines, on = false) => `<div class="gn247-panel${on ? ' gn269-picked' : ''}"><div class="gn247-ph"><b>Panel ${n}</b>${mark}<span class="grow"></span><span class="m">${lines.length} ${lines.length === 1 ? 'line' : 'lines'}</span></div><div class="gn247-desc">${desc}</div>${shows ? `<div class="gn247-row"><b>Shows</b>${shows}</div>` : ''}${lines.join('')}<div class="gn247-more">+ Line</div></div>`;
const chip = (img, name) => `<span class="gn247-chip"><img src="${img}" alt="">${name}</span>`;
const script = (marks, picked = 0) => `<div class="gn247-edit"><h3>Page 3</h3><div class="gn247-layouts">${layouts}</div>
${panelRow(1, marks[0], 'Maren alone on the flooded pier at dawn, the lighthouse beam in the fog.', chip(MAREN, 'Maren') + chip(PIER, 'The pier'), [line('Caption', '—', 'She stopped the pen before the hook.')], picked === 1)}
${panelRow(2, marks[1], 'Maren close, collar up, calling out over the water.', chip(MAREN, 'Maren') + chip(PIER, 'The pier'), [line('Speech', 'Maren', 'Where are you?')], picked === 2)}
${panelRow(3, marks[2], 'The empty water. Something moves under the surface.', '', [line('Sound', '—', 'Hsssh')], picked === 3)}
<span class="gn247-btn sm" style="align-self:flex-start">${PLUS}Panel</span></div>`;
const lay = (name, on, rects) => `<div class="gn247-lay${on ? ' on' : ''}"><i>${rects.map(([l, t, w, h]) => `<u style="left:${l}px;top:${t}px;width:${w}px;height:${h}px"></u>`).join('')}</i>${name}</div>`;
const layouts = lay('Grid', false, [[2, 2, 14, 23], [18, 2, 14, 23], [2, 27, 14, 23], [18, 27, 14, 23]]) + lay('Feature', true, [[2, 2, 30, 23], [2, 27, 14, 23], [18, 27, 14, 23]]) + lay('Wide', false, [[2, 2, 30, 14.7], [2, 18.7, 30, 14.7], [2, 35.3, 30, 14.7]]) + lay('Splash', false, [[2, 2, 30, 48]]) + lay('Manga', false, [[2, 2, 10.8, 15.5], [14.8, 2, 17.2, 15.5], [2, 19.5, 30, 13], [2, 34.5, 17.2, 15.5], [21.2, 34.5, 10.8, 15.5]]) + lay('Webtoon', false, [[2, 2, 30, 14.7], [2, 18.7, 30, 14.7], [2, 35.3, 30, 14.7]]);
const ok = `<span class="gn269-mark ok">${CHECK}</span>`;
const bad = `<span class="gn269-mark bad">${ALERT}</span>`;
const going = `<span class="gn269-mark">${SPIN}</span>`;
const wait = '<span class="gn269-mark none"></span>';

const RECTS = [['0%', '0%', '100%', '50%'], ['0%', '50%', '50%', '50%'], ['50%', '50%', '50%', '50%']];
const cell = (index, inner, cls = '') => {
  const [l, t, w, h] = RECTS[index];
  return `<div class="p ${cls}" style="left:calc(${l} + 6px);top:calc(${t} + 6px);width:calc(${w} - 12px);height:calc(${h} - 12px)">${inner}</div>`;
};
const art = src => `<img src="${src}" alt="">`;

// A balloon is drawn the way the app would: a shape from the line's kind, the script's words, a tail.
const tails = list => `<svg class="gn269-tails" viewBox="0 0 100 100" preserveAspectRatio="none">${list.map(p => `<polygon points="${p}"/>`).join('')}</svg>`;
const balloon = (kind, left, top, width, words, n, picked = false) => `<div class="gn269-bal ${kind}${picked ? ' picked' : ''}" style="left:${left}%;top:${top}%;width:${width}%">${words}${n ? `<i class="ord">${n}</i>` : ''}${picked ? '<u class="h a"></u><u class="h b"></u><u class="h c"></u><u class="h d"></u>' : ''}</div>`;

const lineCard = (n, kind, who, words, state, picked = false) => `<div class="gn269-line${picked ? ' on' : ''}"><i class="ord">${n}</i><div class="body"><div class="top"><span class="gn247-kind">${kind}${DOWN}</span><span class="gn247-who">${who}</span><span class="grow"></span>${state ? `<span class="gn269-mark ok">${CHECK}</span>` : '<span class="gn269-mark none"></span>'}</div><span class="gn247-words">${words}</span></div></div>`;
const tabs = active => `<div class="gn269-steps"><span class="${active === 'panels' ? 'on' : ''}">Panels</span><span class="${active === 'words' ? 'on' : ''}">Words</span></div>`;

const card = (name, on, picture, facts) => `<div class="gn269-card${on ? ' on' : ''}"><div class="pic">${picture}</div><div class="txt"><b>${name}</b>${facts.map(f => `<span>${f}</span>`).join('')}</div></div>`;
const wholePicture = `<div class="gn247-comic">${art(STYLE)}</div>`;
const cellsPicture = `<div class="gn247-comic gn269-apart">${cell(0, art(PIER))}${cell(1, art(MAREN))}${cell(2, art(WATER))}${balloon('cap', 7, 6, 48, 'She stopped the pen.')}${balloon('speech', 9, 57, 36, 'Where are you?')}</div>`;

export const frames = [
  {
    id: '269a', title: 'Mode: chosen for the book', width: 1360, height: 850,
    markup: screen('269a Mode opens two cards: Whole page, the page and its words drawn as one image, and Panel by panel, each panel drawn alone with words placed after', 850, `${head('Whole page', true)}<div class="gn247-body gn269-dim" style="grid-template-columns:136px minmax(440px,1fr) 372px">${strip('assets/saltlight-shot15.png', 'ok')}${script(['', '', ''])}<div class="gn247-side"><div class="gn247-comic gn269-fixed">${art('assets/saltlight-shot15.png')}</div></div></div>
<div class="gn269-sheet"><h3>Mode</h3><div class="gn269-cards">${card('Whole page', false, wholePicture, ['One image per page', 'Words in the picture', 'Redo means the page'])}${card('Panel by panel', true, cellsPicture, ['One image per panel', 'Words placed after', 'Redo one panel'])}</div><div class="gn269-sheetfoot"><span class="m">8 pages made stay as they are</span><span class="grow"></span><span class="gn247-btn">Cancel</span><span class="gn247-btn pri">Use Panel by panel</span></div></div>`),
  },
  {
    id: '269b', title: 'Panels: made together, arriving one at a time', width: 1360, height: 850,
    markup: screen('269b Panel by panel, first press: three panels made at one price; one is on the page, one is being made, one was refused by the image service and waits for a change', 850, `${head('Panel by panel')}<div class="gn247-body" style="grid-template-columns:136px minmax(440px,1fr) 372px">${strip(null, 'busy')}${script([ok, going, bad], 3)}<div class="gn247-side gn251-side">${tabs('panels')}<div class="gn247-comic gn269-fixed">${cell(0, art(PIER))}${cell(1, `<div class="gn269-cellstate">${SPIN}<b>Making</b><span class="m">0:42</span></div>`, 'empty')}${cell(2, `<div class="gn269-cellstate bad">${ALERT}<b>Refused</b></div>`, 'empty picked')}</div>
<div class="gn253-verdicts"><div class="gn253-v bad">${ALERT}<b>Panel 3</b><span>refused</span><span class="grow"></span><span class="m">Codex</span></div></div>
<div class="gn247-acts"><span class="gn247-btn">${SPARK}Make again</span><span class="gn247-btn">Change with Arke</span></div>
<div class="gn269-pricerow"><span class="m">2 of 3 · included in plan</span><span class="grow"></span><span class="gn247-btn ghost sm">Brief</span></div></div></div>`),
  },
  {
    id: '269c', title: 'Panels: a fault redraws one panel', width: 1360, height: 850,
    markup: screen('269c Each panel is checked as a picture. Panel 2 has a hand to fix; it is boxed and listed; Make again redraws panel 2 alone with what was found, and the other two stay', 850, `${head('Panel by panel')}<div class="gn247-body" style="grid-template-columns:136px minmax(440px,1fr) 372px">${strip(PIER, 'x')}${script([ok, bad, ok], 2)}<div class="gn247-side gn251-side">${tabs('panels')}<div class="gn247-comic gn269-fixed">${cell(0, art(PIER))}${cell(1, art(MAREN), 'picked')}${cell(2, art(WATER))}<div class="gn247-hit" style="left:17%;top:66%;width:19%;height:11%"><span class="t">Defect</span></div></div>
<div class="gn253-verdicts"><div class="gn253-v bad">${ALERT}<b>Panel 2</b><span>1 to fix</span><span class="grow"></span><span class="m">Claude Opus 5.5</span></div></div>
<div class="gn247-finds"><div class="gn247-find"><span class="k">Defect</span><span class="gn253-what">Left eye · set too low</span></div></div>
<div class="gn269-taking"><div class="gn247-takes"><div class="gn247-take gn269-wide"><img src="${MAREN}" alt=""><span class="k w"></span></div><div class="gn247-take gn269-wide on"><img src="${MAREN}" alt=""><span class="k w"></span></div><span class="m">Take 2 of 2</span></div></div>
<div class="gn247-acts"><span class="gn247-btn pri">${SPARK}Make again</span><span class="gn247-btn">Accept anyway</span></div></div></div>`),
  },
  {
    id: '269d', title: 'Words: placed by hand', width: 1360, height: 850,
    markup: screen('269d Words: the page large with its accepted panels; the lines come from the script and show placed or not; a balloon drags, resizes and aims its tail; the words stay live and editing them never redraws a panel', 850, `${head('Panel by panel')}<div class="gn247-body" style="grid-template-columns:136px 440px minmax(0,1fr)">${strip(PIER, 'ok')}<div class="gn247-edit gn269-lines"><h3>Page 3<span class="grow"></span><span class="m">2 of 3 placed</span>${tabs('words')}</h3>
<div class="gn269-lineacts"><span class="gn247-btn pri">${SPARK}Place with Arke</span><span class="gn247-btn">Whole chapter</span><span class="grow"></span><span class="gn247-btn ghost sm">${UNDO}Undo</span></div>
${lineCard(1, 'Caption', '—', 'She stopped the pen before the hook.', true)}${lineCard(2, 'Speech', 'Maren', 'Where are you?', true, true)}${lineCard(3, 'Sound', '—', 'Hsssh', false)}
<div class="gn269-tool"><span class="gn247-sel"><b>Shape</b>Speech${DOWN}</span><span class="gn247-sel"><b>Size</b>M${DOWN}</span><span class="grow"></span><span class="gn247-sel"><b>Lettering</b>Comic${DOWN}</span></div>
<div class="gn269-verdict"><span class="gn269-mark none"></span><b>1 line to place</b><span class="grow"></span><span class="gn247-btn off">Accept page</span></div></div>
<div class="gn269-stage"><div class="gn247-comic gn269-big">${cell(0, art(PIER))}${cell(1, art(MAREN))}${cell(2, art(WATER))}${tails(['18,57.5 22,57.5 25,61'])}${balloon('cap', 4, 3, 50, 'She stopped the pen before the hook.', 1)}${balloon('speech', 7, 53, 34, 'Where are you?', 2, true)}<div class="gn269-aim" style="left:24.2%;top:60.4%"></div></div></div></div>`),
  },
  {
    id: '269e', title: 'Words: placed by Arke, then yours', width: 1360, height: 850,
    markup: screen('269e Place with Arke: Arke looks at the art and places every line clear of faces and hands, in reading order; the result is ordinary balloons the author can move; Undo takes all of it back', 850, `${head('Panel by panel')}<div class="gn247-body" style="grid-template-columns:136px 440px minmax(0,1fr)">${strip(PIER, 'ok')}<div class="gn247-edit gn269-lines"><h3>Page 3<span class="grow"></span><span class="m">3 of 3 placed</span>${tabs('words')}</h3>
<div class="gn269-placed">${SPARK}<b>Arke placed 3 lines</b><span class="grow"></span><span class="gn247-btn sm">${UNDO}Undo</span></div>
${lineCard(1, 'Caption', '—', 'She stopped the pen before the hook.', true)}${lineCard(2, 'Speech', 'Maren', 'Where are you?', true)}${lineCard(3, 'Sound', '—', 'Hsssh', true)}
<div class="gn269-tool"><span class="gn247-sel"><b>Lettering</b>Comic${DOWN}</span></div>
<div class="gn269-verdict"><span class="gn269-mark ok">${CHECK}</span><b>Every line placed</b><span class="grow"></span><span class="gn247-btn pri">Accept page</span></div></div>
<div class="gn269-stage"><div class="gn247-comic gn269-big">${cell(0, art(PIER))}${cell(1, art(MAREN))}${cell(2, art(WATER))}${tails(['18,57.5 22,57.5 25,61'])}${balloon('cap', 4, 3, 50, 'She stopped the pen before the hook.', 1)}${balloon('speech', 7, 53, 34, 'Where are you?', 2)}${balloon('sfx', 70, 82, 15, 'Hsssh', 3)}</div></div></div>`),
  },
];
