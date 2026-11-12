// Turn 254 · Adapt before drawing (SPEC-064 R-60 – R-66, revision 8): a chapter's page plan, then
// a cold read of Arke's draft by a reader who has only the pages. The frames are 249c and 249d's
// Pages in their own markup (turn 247's pieces); only the plan, the read and their buttons are new.
// The book is 249's sample, Low Water drawn, chapter 2 · Salt. Counts, words and passages are samples.
import { FRAMES as T247 } from './graphic-novel-247.frames.mjs';

const svg = (d, w = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const SPARK = svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>');
const CHECK = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 3);
const ALERT = svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>');
const X = svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>');
const DOWN = svg('<path d="m6 9 6 6 6-6"/>');

// 247b's Pages up to its body, on chapter 2, as 249 takes it.
const pagesHead = (label, height) => {
  let markup = T247.find(([letter]) => letter === 'b')[5]();
  markup = markup.replace(/^<div class="gn247" data-screen-label="[^"]*"/, `<div class="gn247 gn249 gn254" data-screen-label="${label}"`);
  markup = markup.replace('<span class="on">1 · The tide</span><span>2 · Salt</span>', '<span>1 · The tide</span><span class="on">2 · Salt</span>');
  markup = markup.replace('height:850px', `height:${height}px`);
  return markup.slice(0, markup.indexOf('<div class="gn247-body">'));
};
const close = '</div></div>';

// The chapter with no pages (249c), with its first press changed.
const empty = (sub, acts) => `<div class="gn247-body"><div class="gn247-strip"><div class="gn247-add">+ Page</div></div><div class="gn249-empty"><h3>2 · Salt has no pages</h3><div class="m">${sub}</div><div class="gn249-acts">${acts}</div></div></div>`;

const VERDICT = { Keep: 'keep', Cut: 'cut', Merge: 'merge', Show: 'show', Invent: 'invent' };
const PASSAGES = [
  ['¶ 1–6', 'Salt in the bread and sheets', 'Keep', 'opens on her hands'],
  ['¶ 7–12', 'Bray at the weigh house', 'Keep', 'names Bray'],
  ['¶ 13–15', 'The harbourmaster’s letter', 'Merge', 'into Bray’s line on page 2'],
  ['¶ 16–21', 'Jory and the boat', 'Cut', 'a second thread; returns ch. 5'],
  ['¶ 22–24', 'What the tide table says', 'Show', 'the table, drawn, not told'],
  ['¶ 25–31', 'The bell at low water', 'Keep', 'the turn'],
];
const PAGES = [
  ['Maren in the salt house; her cracked hands', 'Bray at the door'],
  ['Bray: the harbour is closing', '“You walked the hard again.”'],
  ['The tide table on the wall, a line circled', 'Low water, too low'],
  ['The hard at dusk, nobody out', 'The bell, once'],
  ['Maren on the mud, lantern up', 'Something under the water'],
  ['Bray finds her', '“There’s no bell on the hard.”'],
  ['Home; the salt on her collar', 'She writes it down'],
];
const READER = [
  ['Bray', 'named, page 1'],
  ['The weigh house', 'shown, page 1'],
  ['The tide table', 'shown, page 3'],
  ['The bell', 'heard, page 4'],
];

const plan = (state) => `<div class="gn254-plan"><div class="gn249-draftbar">${SPARK}<b style="font-weight:600">Page plan</b><span>7 pages from chapter 2</span><span class="grow"></span>${state === 'proposed' ? '<span class="gn247-btn sm">Discard</span><span class="gn247-btn pri sm">Keep</span>' : '<span class="gn247-btn sm">Change</span>'}</div>
<div class="gn254-cols"><section><h4>Passages</h4><div class="gn254-list">${PASSAGES.map(([where, what, verdict, why]) => `<div class="gn254-row"><span class="gn249-src">${where}</span><span class="t">${what}<span class="why">${why}</span></span><span class="gn254-v ${VERDICT[verdict]}">${verdict}</span></div>`).join('')}</div>
<div class="gn254-needs">${ALERT}<span><b>Page 6</b> &#183; “where’s Jory?” leans on a cut passage</span><span class="grow"></span><span class="gn247-btn ghost sm">Fix</span></div></section>
<section><h4>Pages</h4><div class="gn254-list">${PAGES.map(([what, turn], i) => `<div class="gn254-row pg"><span class="n">${i + 1}</span><span class="t">${what}<span class="why">ends: ${turn}</span></span></div>`).join('')}</div>
<h4>The reader knows</h4><div class="gn254-list">${READER.map(([who, where]) => `<div class="gn254-row kn"><span class="t">${who}</span><span class="m">${where}</span></div>`).join('')}</div></section></div></div>`;

const sourceRow = (label) => `<span class="gn249-src">${label}</span>`;
const panel = (n, desc, who, line, src, find) => `<div class="gn247-panel${find ? ' gn254-flag' : ''}"><div class="gn247-ph"><b>Panel ${n}</b><span class="grow"></span>${sourceRow(src)}</div><div class="gn247-desc">${desc}</div><div class="gn247-row"><b>Shows</b>${who.map((w) => `<span class="gn247-chip plain">${w}</span>`).join('')}</div>${line ? `<div class="gn247-row"><span class="gn247-kind">${line[0]}${DOWN}</span><span class="gn247-who">${line[1]}</span><span class="gn247-words">${line[2]}</span></div>` : ''}${find ? `<div class="gn254-q"><span class="k">${find[0]}</span>${find[1]}</div>` : ''}</div>`;
const thumbs = (marks) => [1, 2, 3, 4, 5, 6, 7].map((n) => `<div class="gn247-thumb gn249-thumb-draft${n === 6 ? ' on' : ''}"><span class="d">draft</span>${marks[n] ? `<span class="s ${marks[n]}">${marks[n] === 'x' ? X : ALERT}</span>` : ''}<span class="n">${n}</span></div>`).join('');
const side = `<div class="gn247-side"><div class="gn247-comic" style="background:var(--secondary)">${[[0, 0, 1, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]].map(([x, y, w, h], i) => `<div class="gn247-wire" style="left:calc(${x * 100}% + 6px);top:calc(${y * 100}% + 6px);width:calc(${w * 100}% - 12px);height:calc(${h * 100}% - 12px)">${i + 1}</div>`).join('')}</div><div class="gn249-quote">Bray came down the hard with the lantern held low, the way you carry one when you don’t want to see.</div><div class="m">Panel 1 · chapter 2, ¶ 28</div><div class="gn247-make"><span class="gn247-btn pri off">${SPARK}Make page</span><span class="m">Keep the draft first</span></div></div>`;

export const FRAMES = [
  ['a', 'A chapter with no pages: plan it first', 760, () => `${pagesHead("254a Pages on chapter 2, which has prose and no pages: Plan with Arke is the first press; Draft with Arke waits until a plan is kept; + Page still starts one by hand", 760)}${empty('From Low Water · chapter 2 · 6,210 words', `<span class="gn247-btn pri">${SPARK}Plan with Arke</span><span class="gn247-btn">+ Page</span>`)}${close}`],

  ['b', 'The page plan: passages, pages and what the reader knows', 860, () => `${pagesHead("254b Arke's page plan for chapter 2: each passage kept, cut, merged or shown with a reason; each page's change and the turn it ends on; what the reader has been shown and where; a line that leans on a cut passage is named before any page is drafted", 860)}<div class="gn247-body"><div class="gn247-strip"><div class="gn247-add">+ Page</div></div>${plan('proposed')}</div>${close}`],

  ['c', 'Plan kept: now draft', 760, () => `${pagesHead("254c The plan is kept: Draft with Arke drafts the pages from it, and the plan stays one click away", 760)}${empty(`${CHECK.replace('<svg', '<svg class="gn254-ok"')}Plan kept &#183; 7 pages`, `<span class="gn247-btn pri">${SPARK}Draft with Arke</span><span class="gn247-btn">Plan</span><span class="gn247-btn">+ Page</span>`)}${close}`],

  ['d', 'The draft, read cold: what a reader would ask', 860, () => `${pagesHead("254d Arke's draft after the cold read: a reader with only the pages could not place one name, after two redrafts; the page and panel are marked and the question is quoted; Keep anyway keeps it with the question on record", 860)}<div class="gn247-body"><div class="gn247-strip">${thumbs({ 6: 'x', 3: 'w' })}</div>
<div class="gn247-edit"><div class="gn249-draftbar">${SPARK}<b style="font-weight:600">Arke&#8217;s draft</b><span>7 pages from chapter 2</span><span class="gn254-read bad">${X}1 to fix</span><span class="grow"></span><span class="gn247-btn sm">Discard</span><span class="gn247-btn sm">Keep anyway</span></div>
<div class="gn254-finds"><div class="gn254-find"><span class="k">Who</span><span>Page 6 &#183; “Who is Jory?”</span></div><div class="gn254-find w"><span class="k">Where</span><span>Page 3 &#183; “Is this the same night?”</span></div></div><h3>Page 6</h3>
${panel(1, 'Bray coming down the hard with the lantern held low.', ['Bray', 'The hard'], ['Speech', 'Bray', 'There’s no bell on the hard.'], '¶ 28')}
${panel(2, 'Maren on the mud, looking past him at the water.', ['Maren'], ['Speech', 'Maren', 'Then where’s Jory?'], '¶ 29', ['Who', '“Who is Jory?” · not shown or named before'])}
</div>${side}</div>${close}`],

  ['e', 'The draft not read: say so', 860, () => `${pagesHead("254e No script reader is set: the draft says Not read and why; Choose reader opens the setting; Keep anyway keeps it with that on record", 860)}<div class="gn247-body"><div class="gn247-strip">${thumbs({})}</div>
<div class="gn247-edit"><div class="gn249-draftbar">${SPARK}<b style="font-weight:600">Arke&#8217;s draft</b><span>7 pages from chapter 2</span><span class="gn254-read warn">${ALERT}Not read</span><span class="grow"></span><span class="gn247-btn sm">Discard</span><span class="gn247-btn sm">Keep anyway</span></div>
<div class="gn254-needs">${ALERT}<span>No script reader</span><span class="grow"></span><span class="gn247-btn sm">Choose reader</span></div><h3>Page 6</h3>
${panel(1, 'Bray coming down the hard with the lantern held low.', ['Bray', 'The hard'], ['Speech', 'Bray', 'There’s no bell on the hard.'], '¶ 28')}
${panel(2, 'Maren on the mud, looking past him at the water.', ['Maren'], ['Speech', 'Maren', 'Then where’s the bell?'], '¶ 29')}
</div>${side}</div>${close}`],
];
