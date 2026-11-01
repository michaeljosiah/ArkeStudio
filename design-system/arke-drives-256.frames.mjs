// Turn 256 · Arke drives, the screen stays simple: a graphic novel made by asking. From the owner's
// run of 1 November 2026 (installed 0.5.77 – 0.5.79), making The Ledger of Nights, redrawn, chapter 1
// entirely in Arke. Frames reuse turn 247's pieces, 249b's setup and 254's plan and draft; only what
// is new is drawn new. The book is 249's sample, Low Water drawn. Counts, words and passages are samples.
import { FRAMES as T247 } from './graphic-novel-247.frames.mjs';

const svg = (d, w = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const SPARK = svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>');
const CHECK = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 3);
const ALERT = svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>');
const X = svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>');
const LEFT = svg('<path d="m15 18-6-6 6-6"/>');
const MANGA = 'assets/comic-styles/manga.jpg';
const SPIN = '<span class="gn256-spin" aria-hidden="true"></span>';

// 247b's Pages up to its body, on the chapter asked for, as 249 and 254 take it.
const pagesHead = (label, height, chapter = 2) => {
  let markup = T247.find(([letter]) => letter === 'b')[5]();
  markup = markup.replace(/^<div class="gn247" data-screen-label="[^"]*"/, `<div class="gn247 gn249 gn254 gn256" data-screen-label="${label}"`);
  if (chapter === 2) markup = markup.replace('<span class="on">1 · The tide</span><span>2 · Salt</span>', '<span>1 · The tide</span><span class="on">2 · Salt</span>');
  markup = markup.replace('height:850px', `height:${height}px`);
  return markup.slice(0, markup.indexOf('<div class="gn247-body">'));
};
const close = '</div></div>';

const CHAPTERS = [
  ['The tide', 'Pages made', 'made', '8 of 8'],
  ['Salt', 'Draft waiting', 'wait', '7 pages'],
  ['The bell', 'Plan kept', 'kept', '9 pages'],
  ['Low water', 'Not planned', 'none', ''],
  ['The weigh house', 'Not planned', 'none', ''],
  ['Neap', 'Not planned', 'none', ''],
];

export const FRAMES = [
  ['a', 'Setup: one card for what is usual', 860, () => `<div class="gn247 gn249 gn256" data-screen-label="256a Plan with Arke: Arke reads the whole book, then offers the usual reading, page and pilot as one card to use or change; the plan beside it has no model settings" style="width:1360px;height:860px"><div class="gn249-top"><span class="gn247-btn ghost sm">${LEFT}Back</span><b>The Undersong</b><span class="m">new production</span></div><div class="gn249-setup"><div class="gn249-chat">
<div class="gn249-me">A graphic novel of Low Water.</div>
<div class="gn249-arke"><span class="who">Arke</span><span class="gn249-receipt">${CHECK}Read Low Water · 6 chapters · 38,412 words</span>Six chapters, mostly Maren alone on the water. I&#8217;d make it the usual way:
<div class="gn256-usual"><div class="row"><span>Reading</span><b>Left to right</b></div><div class="row"><span>Page</span><b>2:3 comic book</b></div><div class="row"><span>Pilot</span><b>Chapter 1 · The tide</b></div><div class="gn249-acts"><span class="gn247-btn pri sm">Use these</span><span class="gn247-btn sm">Change</span></div></div></div>
<div class="gn249-composer">Ask Arke, or change the plan…</div>
</div><div class="gn249-plan"><h3>Low Water, drawn</h3><div class="sub">Graphic novel · from Low Water · 6 chapters · ~47 pages</div><div class="gn249-facts"><span><img src="${MANGA}" alt="">Manga</span><span>Left to right</span><span>2:3</span><span>Pilot · chapter 1</span></div>
<div class="gn249-rows">${[['The tide', 8, true], ['Salt', 7], ['The bell', 9], ['Low water', 8], ['The weigh house', 8], ['Neap', 7]].map(([title, pages, pilot], i) => `<div class="gn249-prow${pilot ? ' pilot' : ''}"><span class="n">${i + 1}</span><span>${title}</span><span class="pg">~${pages} pages</span><span class="lay"></span></div>`).join('')}</div>
<div class="gn249-acts"><span class="gn247-btn pri">Start the pilot</span><span class="gn247-btn">Change the plan</span></div></div></div></div>`],

  ['b', 'While Arke works, the page says so', 760, () => `${pagesHead("256b Start the pilot, or Plan with Arke, sends the ask at once; the empty chapter says Arke is planning it, with the time so far and Stop, instead of offering the press again", 760)}<div class="gn247-body"><div class="gn247-strip"><div class="gn247-add">+ Page</div></div><div class="gn249-empty"><div class="gn256-working">${SPIN}<b>Arke is planning 2 · Salt</b><span class="m">reading the chapter &#183; 1:12</span></div><div class="gn249-acts"><span class="gn247-btn sm">Stop</span></div></div></div>${close}`],

  ['c', 'The plan: mysteries kept on purpose, and Fix that redoes it', 860, () => `${pagesHead("256c The page plan as 254b drew it, with one more list: the questions the book means the reader to carry, which the cold read is told and does not count; Fix on a lean asks Arke for a new plan that replaces this one", 860)}<div class="gn247-body"><div class="gn247-strip"><div class="gn247-add">+ Page</div></div><div class="gn254-plan"><div class="gn249-draftbar">${SPARK}<b style="font-weight:600">Page plan</b><span>7 pages from chapter 2</span><span class="grow"></span><span class="gn247-btn sm">Discard</span><span class="gn247-btn pri sm">Keep</span></div>
<div class="gn254-cols"><section><h4>Passages</h4><div class="gn254-list">${[['¶ 1–6', 'Salt in the bread and sheets', 'Keep', 'opens on her hands'], ['¶ 7–12', 'Bray at the weigh house', 'Keep', 'names Bray'], ['¶ 16–21', 'Jory and the boat', 'Cut', 'returns ch. 5'], ['¶ 25–31', 'The bell at low water', 'Keep', 'the turn']].map(([where, what, verdict, why]) => `<div class="gn254-row"><span class="gn249-src">${where}</span><span class="t">${what}<span class="why">${why}</span></span><span class="gn254-v ${verdict.toLowerCase()}">${verdict}</span></div>`).join('')}</div>
<div class="gn254-needs">${ALERT}<span><b>Page 6</b> &#183; &#8220;where&#8217;s Jory?&#8221; leans on a cut passage</span><span class="grow"></span><span class="gn247-btn sm">Fix</span></div>
<h4>Kept on purpose</h4><div class="gn254-list">${['What is under the water?', 'Who rings the bell at low water?', 'What did the harbourmaster’s letter say?'].map((q) => `<div class="gn254-row kn"><span class="t">${q}</span><span class="m">open</span></div>`).join('')}</div></section>
<section><h4>Pages</h4><div class="gn254-list">${[['Maren in the salt house', 'Bray at the door'], ['Bray: the harbour is closing', '“You walked the hard again.”'], ['The tide table, a line circled', 'Low water, too low'], ['The hard at dusk', 'The bell, once'], ['Maren on the mud', 'Something under the water'], ['Bray finds her', '“There’s no bell on the hard.”'], ['Home; salt on her collar', 'She writes it down']].map(([what, turn], i) => `<div class="gn254-row pg"><span class="n">${i + 1}</span><span class="t">${what}<span class="why">ends: ${turn}</span></span></div>`).join('')}</div></section></div></div></div>${close}`],

  ['d', 'The draft, read as pages, with only the gaps counted', 860, () => `${pagesHead("256d Arke's draft read as the reader will meet it: each panel's words in order beside a line of what is drawn; the cold read counts only what a reader cannot follow, and lists the mysteries it met apart; Details opens the script as 254d drew it; Keep is decided here alone", 860)}<div class="gn247-body"><div class="gn247-strip">${[1, 2, 3, 4, 5, 6, 7].map((n) => `<div class="gn247-thumb gn249-thumb-draft${n === 3 ? ' on' : ''}"><span class="d">draft</span>${n === 3 ? `<span class="s x">${X}</span>` : ''}<span class="n">${n}</span></div>`).join('')}</div>
<div class="gn247-edit"><div class="gn249-draftbar">${SPARK}<b style="font-weight:600">Arke&#8217;s draft</b><span>7 pages</span><span class="gn254-read bad">${X}1 to fix</span><span class="gn256-kept">3 kept mysteries</span><span class="grow"></span><span class="gn247-btn sm">Discard</span><span class="gn247-btn sm">Keep anyway</span></div>
<div class="gn254-finds"><div class="gn254-find"><span class="k">Who</span><span>Page 3 &#183; &#8220;Who is Tom?&#8221;</span><span class="grow"></span><span class="gn247-btn ghost sm">Fix</span></div></div>
<div class="gn256-pagehead"><h3>Page 3</h3><span class="grow"></span><span class="gn256-toggle"><span class="on">Read</span><span>Details</span></span></div>
${[['The tide table on the salt-house wall; one line circled in pencil.', [['Caption', 'The table says low water at nine.'], ['Maren', 'Then why is it this low at six?']]], ['Bray in the doorway, shaking rain off his cap.', [['Bray', 'Tom rang the harbour office. Nobody answered.']], true], ['Maren alone, the lamp low, looking at the circled line.', [['Thought', 'Too low. Too early.']]]].map(([desc, lines, flag], i) => `<div class="gn256-read${flag ? ' flag' : ''}"><span class="n">${i + 1}</span><div><div class="d">${desc}</div>${lines.map(([who, words]) => `<div class="l"><b>${who}</b>${words}</div>`).join('')}${flag ? `<div class="gn254-q"><span class="k">Who</span>&#8220;Who is Tom?&#8221;</div>` : ''}</div></div>`).join('')}
</div><div class="gn247-side"><div class="gn247-comic" style="background:var(--secondary)">${[[0, 0, 1, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]].map(([x, y, w, h], i) => `<div class="gn247-wire" style="left:calc(${x * 100}% + 6px);top:calc(${y * 100}% + 6px);width:calc(${w * 100}% - 12px);height:calc(${h * 100}% - 12px)">${i + 1}</div>`).join('')}</div><div class="m">Feature &#183; 3 panels, chosen from the page</div><div class="gn247-make"><span class="gn247-btn pri off">${SPARK}Make page</span><span class="m">Keep the draft first</span></div></div></div>${close}`],

  ['e', 'The book at a glance, and the one next step', 760, () => `${pagesHead("256e A graphic novel's dashboard: each chapter's stage in a word and one next step for Arke, in place of the writing dashboard's words today and Continue chapter", 760, 1).replace(/<div class="gn247-head">[\s\S]*$/, '').replace('<a class="on">Pages', '<a class="">Pages').replace('<a class="">Dashboard', '<a class="on">Dashboard')}<div class="gn256-dash"><h2>Low Water, drawn</h2><div class="m">6 chapters &#183; 15 of ~47 pages planned &#183; 8 made</div>
<div class="gn256-next">${SPARK}<span><b>Next</b> &#183; keep or discard Arke&#8217;s draft of 2 &#183; Salt</span><span class="grow"></span><span class="gn247-btn pri sm">Open the draft</span></div>
<div class="gn254-list">${CHAPTERS.map(([title, stage, kind, n], i) => `<div class="gn254-row gn256-ch"><span class="n">${i + 1}</span><span class="t">${title}</span><span class="gn256-stage ${kind}">${stage}</span><span class="m">${n}</span></div>`).join('')}</div></div>${close}`],
];
