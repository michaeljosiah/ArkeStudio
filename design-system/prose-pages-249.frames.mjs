// Turn 249 · Arke turns prose into pages (SPEC-064 R-3, R-4, R-13): the frames. The book is The
// Undersong's Low Water adapted as a graphic novel in the Manga style of turn 248. Counts, words and
// passages are samples. Each frame's root is .gn249 inside .gn247 (turn 247's pieces).
import { FRAMES as T247 } from './graphic-novel-247.frames.mjs';

const svg = (d, w = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const CHECK = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 3);
const SPARK = svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>');
const DOWN = svg('<path d="m6 9 6 6 6-6"/>');
const LEFT = svg('<path d="m15 18-6-6 6-6"/>');
const MANGA = 'assets/comic-styles/manga.jpg';

// A tiny page: rectangles as [x, y, w, h] in a 60 × 84 frame, each numbered in reading order.
const mini = (cells) => `<div class="gn249-mini" style="width:60px;margin:0 auto">${cells.map(([x, y, w, h, n]) => `<u style="left:${x}px;top:${y}px;width:${w}px;height:${h}px">${n}</u>`).join('')}</div>`;
const example = (label, sub, cells, on) => `<div class="gn249-exc${on ? ' on' : ''}">${mini(cells)}${label}<span>${sub}</span></div>`;
const LTR = [[3, 3, 25, 38, 1], [32, 3, 25, 38, 2], [3, 45, 25, 36, 3], [32, 45, 25, 36, 4]];
const RTL = [[3, 3, 25, 38, 2], [32, 3, 25, 38, 1], [3, 45, 25, 36, 4], [32, 45, 25, 36, 3]];
const SCROLL = [[10, 3, 40, 24, 1], [10, 30, 40, 24, 2], [10, 57, 40, 24, 3]];

const CHAPTERS = [
  ['The tide', 'Chapter 1 · 5,840 words', 8, 'Feature', true],
  ['Salt', 'Chapter 2 · 6,210 words', 7, 'Wide', false],
  ['The bell', 'Chapter 3 · 7,020 words', 9, 'Grid', false],
  ['Low water', 'Chapter 4 · 6,480 words', 8, 'Feature', false],
  ['The weigh house', 'Chapter 5 · 6,955 words', 8, 'Manga', false],
  ['Neap', 'Chapter 6 · 5,907 words', 7, 'Splash', false],
];

// 247b's Pages screen up to its body, so the rail and head are turn 247's own.
const pagesHead = (label, chapter = 1) => {
  let markup = T247.find(([letter]) => letter === 'b')[5]();
  markup = markup.replace(/^<div class="gn247" data-screen-label="[^"]*"/, `<div class="gn247 gn249" data-screen-label="${label}"`);
  if (chapter === 2) markup = markup.replace('<span class="on">1 · The tide</span><span>2 · Salt</span>', '<span>1 · The tide</span><span class="on">2 · Salt</span>');
  return markup.slice(0, markup.indexOf('<div class="gn247-body">'));
};

const sourceRow = (label, passage) => `<span class="gn249-src" title="${passage}">${label}</span>`;
const panel = (n, desc, who, line, src) => `<div class="gn247-panel"><div class="gn247-ph"><b>Panel ${n}</b><span class="grow"></span>${sourceRow(src[0], src[1])}</div><div class="gn247-desc">${desc}</div><div class="gn247-row"><b>Shows</b>${who.map((w) => `<span class="gn247-chip plain">${w}</span>`).join('')}</div>${line ? `<div class="gn247-row"><span class="gn247-kind">${line[0]}${DOWN}</span><span class="gn247-who">${line[1]}</span><span class="gn247-words">${line[2]}</span></div>` : ''}</div>`;

export const FRAMES = [
  ['b', 'Setup: three questions by example, then one plan', 1360, 860, () => `<div class="gn247 gn249" data-screen-label="249b Plan with Arke: Arke reads the whole source and says so in one line, asks reading direction, page shape and a pilot page by example, then shows one plan, a chapter of pages for each chapter of the source" style="width:1360px;height:860px"><div class="gn249-top"><span class="gn247-btn ghost sm">${LEFT}Back</span><b>The Undersong</b><span class="m">new production</span></div><div class="gn249-setup"><div class="gn249-chat">
<div class="gn249-me">A graphic novel of Low Water.</div>
<div class="gn249-arke"><span class="who">Arke</span><span class="gn249-receipt">${CHECK}Read Low Water · 6 chapters · 38,412 words, every chapter whole</span>Six chapters, mostly Maren alone on the water. Which way should it read?<div class="gn249-ex">${example('Left to right', 'as a western comic', LTR, true)}${example('Right to left', 'as manga', RTL, false)}${example('Scroll', 'one column, as a webtoon', SCROLL, false)}</div></div>
<div class="gn249-me">Left to right.</div>
<div class="gn249-arke"><span class="who">Arke</span>And the page?<div class="gn249-ex">${example('2:3', 'comic book', [[8, 3, 44, 78, '']], true)}${example('3:4', 'album', [[4, 10, 52, 70, '']], false)}</div>Shall I draft chapter 1 first, so you can make a pilot page before the rest?</div>
<div class="gn249-me">Yes, the pilot first.</div>
<div class="gn249-composer">Ask Arke, or change the plan…</div>
</div><div class="gn249-plan"><h3>Low Water, drawn</h3><div class="sub">Graphic novel · from Low Water · 6 chapters · ~47 pages</div><div class="gn249-facts"><span><img src="${MANGA}" alt="">Manga</span><span>Left to right</span><span>2:3</span><span>Pilot · chapter 1</span></div>
<div class="gn249-rows">${CHAPTERS.map(([title, src, pages, layout, pilot], i) => `<div class="gn249-prow${pilot ? ' pilot' : ''}"><span class="n">${i + 1}</span><span>${title}<span class="src">${src}</span></span><span class="pg">~${pages} pages</span><span class="lay">${layout}</span></div>`).join('')}</div>
<div class="m">Page counts are a first guess</div>
<div class="gn249-acts"><span class="gn247-btn pri">Start the pilot</span><span class="gn247-btn">Change the plan</span></div></div></div></div>`],

  ['c', 'Pages: a chapter with no pages, drafted by Arke from its prose', 1360, 760, () => `${pagesHead("249c Pages on chapter 2, which has prose and no pages yet: Draft with Arke turns the chapter into pages; + Page starts one by hand", 2).replace('height:850px', 'height:760px')}<div class="gn247-body"><div class="gn247-strip"><div class="gn247-add">+ Page</div></div><div class="gn249-empty"><h3>2 · Salt has no pages</h3><div class="m">From Low Water · chapter 2 · 6,210 words</div><div class="gn249-acts"><span class="gn247-btn pri">${SPARK}Draft with Arke</span><span class="gn247-btn">+ Page</span></div></div></div></div></div>`],

  ['d', 'Arke&#8217;s draft: every panel cites its passage; Keep or Discard', 1360, 860, () => `${pagesHead("249d Arke's draft of chapter 2 arrives as 7 dashed pages: each panel names the passage it comes from; Keep makes them the chapter's script, Discard leaves the chapter as it was; nothing is made until kept", 2).replace('height:850px', 'height:860px')}<div class="gn247-body"><div class="gn247-strip">${[1, 2, 3, 4, 5, 6, 7].map((n) => `<div class="gn247-thumb gn249-thumb-draft${n === 1 ? ' on' : ''}"><span class="d">draft</span><span class="n">${n}</span></div>`).join('')}</div>
<div class="gn247-edit"><div class="gn249-draftbar">${SPARK}<b style="font-weight:600">Arke&#8217;s draft</b><span>7 pages from chapter 2</span><span class="grow"></span><span class="gn247-btn sm">Discard</span><span class="gn247-btn pri sm">Keep</span></div><h3>Page 1</h3>
${panel(1, 'The harbour at slack water, boats lying on the mud, Maren walking the hard with her lantern.', ['Maren', 'The harbour'], ['Caption', '—', 'Salt was in everything that week.'], ['¶ 1–2', 'Salt was in everything that week, in the bread, in the sheets…'])}
${panel(2, 'Bray at the weigh house door, sleeves rolled, watching her come.', ['Bray', 'The weigh house'], ['Speech', 'Bray', 'You walked the hard again.'], ['¶ 4', 'Bray was at the weigh house door before she reached it…'])}
${panel(3, 'Maren close, not answering, salt dried white on her collar.', ['Maren'], null, ['¶ 5', 'She did not answer him. The salt had dried white…'])}
</div><div class="gn247-side"><div class="gn247-comic" style="background:var(--secondary)">${[[0, 0, 1, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]].map(([x, y, w, h], i) => `<div class="gn247-wire" style="left:calc(${x * 100}% + 6px);top:calc(${y * 100}% + 6px);width:calc(${w * 100}% - 12px);height:calc(${h * 100}% - 12px)">${i + 1}</div>`).join('')}</div><div class="gn249-quote">Salt was in everything that week, in the bread, in the sheets, in the cracks of her hands.</div><div class="m">Panel 1 · chapter 2, ¶ 1–2</div><div class="gn247-make"><span class="gn247-btn pri off">${SPARK}Make page</span><span class="m">Keep the draft first</span></div></div></div></div></div>`],
];
