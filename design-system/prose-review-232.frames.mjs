// Turn 232 · the frames. The chapter review gains an AI tells check, drawn in turn 227's writing
// room: tells are counted by the stretch of prose, and only a crowded stretch is marked.
// The prose is written for the drawing, deliberately crowded with tells; it is not the book's.
import { I, PEOPLE } from './chapter-page-227.view.mjs';
import { shell, writing, docHead, foot, frame } from './chapter-page-227.frames.mjs';

// The six tells, in the order the What counts card teaches them.
export const KINDS = {
  three: { name: 'Rule of three', what: 'Three beats that build.' },
  list: { name: 'Stacked list', what: 'Details piled up for effect.' },
  metaphor: { name: 'Metaphor', what: 'A figure, or a thing given a will.' },
  notxy: { name: 'Not X but Y', what: 'Saying what it isn’t first.' },
  pivot: { name: 'Pivot sentence', what: 'A short line that turns the scene.' },
  shorthand: { name: 'Emotional shorthand', what: 'A feeling summed up, not shown.' },
};
const LINE = 8, KIND_LINE = 4, SCALE = 16;

// [[key|word]] is a linked name (turn 227); {{kind|words}} is a tell the review counted.
const render = (t, { lit, hot, quiet = false } = {}) => t
  .replace(/\[\[(\w+)\|([^\]]+)\]\]/g, (_, k, w) => k === 'place' ? `<span class="nm place">${w}</span>` : `<span class="nm ${PEOPLE[k].v}">${w}</span>`)
  .replace(/\{\{(\w+)\|([^}]+)\}\}/g, (_, k, w) => `<span class="tl${lit === k ? ' lit' : ''}${hot === w ? ' hot' : ''}${quiet && lit !== k && hot !== w ? ' quiet' : ''}" data-kind="${k}">${w}</span>`);
const ps = (list, opts) => list.map(t => `<p>${render(t, opts)}</p>`).join('');

// The crowded stretch: thirteen of its fourteen tells are on screen, the fifth metaphor below.
const BEFORE = ['“Close your mouth,” [[tunde|Tunde]] said. “You have a flight.”'];
const DENSE = [
  '[[ade|Ade]] did not answer. {{pivot|He was already standing.}}',
  'He crossed the floor {{metaphor|the way a man crosses a river he has already decided not to measure}}. {{three|Past the dancers. Past the bar. Past the last of his good sense.}}',
  '{{notxy|It was not her beauty that stopped him halfway. It was the stillness}}, the way she {{metaphor|held the whole loud room at arm’s length and made it wait}}.',
  'He had been coming to [[place|the club]] for six years. {{list|The champagne carried in under sparklers. The men who laughed with their wallets. The women who had learned to look bored in three languages. The same remix every Friday, a little louder each time}}, {{metaphor|as if volume could stand in for joy}}.',
  '{{pivot|He stopped.}}',
  '{{shorthand|Something in his chest had shifted, quietly and for good}}, {{metaphor|like furniture moved in a house he thought he knew by heart}}.',
  '{{pivot|She looked up.}} {{notxy|Not startled. Not impressed. Curious, which was worse.}}',
  'And {{shorthand|he understood, with a clarity that frightened him, that wanting and wisdom could share one body and never once speak}}.',
];
// The same stretch after the writer rewrote it by hand.
const REWRITTEN = [
  '[[ade|Ade]] did not answer. He was already standing.',
  'He crossed the floor without deciding to. Someone’s elbow caught him near the bar and he didn’t feel it.',
  'She hadn’t moved since the stairs. Everyone else in [[place|the club]] was performing something. She was drinking, and watching the door.',
  'Six years he had been coming here, and the DJ was already cueing the remix he played every Friday.',
  'He stopped two steps short of her, which was a stupid place to stop.',
  'She looked him over. “Yes?”',
  '“What are you drinking?” he said, and heard how it sounded.',
  '“Something you haven’t ordered yet.”',
  'Behind him, [[tunde|Tunde]] laughed loud enough for both of them.',
];

// Tells per 450-word stretch, start to end of a 4,102-word chapter. Stretch 4 is the open passage.
const WIN = [3, 2, 4, 14, 5, 2, 10, 1, 9];
const WIN_AFTER = [3, 2, 4, 5, 5, 2, 10, 1, 9];
const WIN_CLEAN = [2, 1, 3, 2, 4, 1, 2, 3, 1];
const strip = (w, { here = 3, kept = [], big = false } = {}) => `<div class="tstrip${big ? ' big' : ''}" role="img" aria-label="AI tells in each 450 words of the chapter; the line is ${LINE}"><div class="bars">${w.map((n, i) => `<i class="${n >= LINE ? (kept.includes(i) ? 'kept' : 'over') : ''}${i === here ? ' here' : ''}" style="height:${Math.round(Math.max(n, 0.4) / SCALE * 100)}%" title="${n} in stretch ${i + 1}">${big ? `<b>${n}</b>` : ''}</i>`).join('')}<span class="line" style="bottom:${LINE / SCALE * 100}%"><small>${LINE}</small></span></div>${big ? `<div class="ends"><span>Start</span><span>End</span></div>` : ''}<div class="cap"><span>AI tells per 450 words</span></div></div>`;

const head = (open, w = WIN, opts) => `<div class="rhead">Review <small>${open} open</small><span class="gap"></span><button type="button" class="ibtn" aria-label="Previous note" style="width:28px;height:28px">${I.left}</button><button type="button" class="ibtn" aria-label="Next note" style="width:28px;height:28px">${I.right}</button></div>${strip(w, opts)}`;

// The note for a crowded passage: its count, its kinds, and no Fix (the writer rewrites).
const COUNT = [['metaphor', 5], ['pivot', 3], ['notxy', 2], ['shorthand', 2], ['three', 1], ['list', 1]];
const kindRows = (sel) => `<div class="kinds">${COUNT.map(([k, n]) => `<button type="button" class="kd${sel === k ? ' on' : ''}${n >= KIND_LINE ? ' over' : ''}" aria-pressed="${sel === k}"><span>${KINDS[k].name}</span><span class="pips" aria-hidden="true">${'<i></i>'.repeat(n)}</span><b>${n}</b></button>`).join('')}</div>`;
const note = ({ top, sel } = {}) => `<div class="rnote on tnote" style="top:${top}px"><div class="k"><b>1</b>AI tells · Crowded</div><div class="big"><b>14</b> in 450 words<small>Line ${LINE}</small></div>${kindRows(sel)}<p>Each is fine alone. Here they crowd together.</p><div class="acts2"><button type="button">Intentional</button><button type="button">Dismiss</button><span class="gap"></span><button type="button" class="lnk">What counts</button></div></div>`;
const bracket = (top, height, { stale = false } = {}) => `<div class="tbr${stale ? ' stale' : ''}" style="top:${top}px;height:${height}px" aria-hidden="true"><b>1</b></div>`;
const rnotes = inner => `<div class="rnotes">${inner}</div>`;

// The page scrolled to the passage: no heading, the prose from the paragraph before it.
const midDoc = (paras, opts) => ps(BEFORE) + ps(paras, opts);
const ms = (doc, overlay, ft = foot('v4', '')) => writing(doc, { overlay, ft });

const hoverCard = (k, style) => `<div class="tpop" role="tooltip" style="${style}"><b>${KINDS[k].name}</b><p>${KINDS[k].what} Fine on its own.</p><small>1 of 14 tells in this passage</small></div>`;

const EXAMPLES = {
  three: '“Past the dancers. Past the bar. Past the last of his good sense.”',
  list: '“The champagne… The men who laughed with their wallets…”',
  metaphor: '“held the whole loud room at arm’s length”',
  notxy: '“It was not her beauty… It was the stillness”',
  pivot: '“He stopped.”',
  shorthand: '“Something in his chest had shifted”',
};
const whatCounts = style => `<div class="tcount" role="dialog" aria-label="What counts as an AI tell" style="${style}"><div class="hd"><h3>What counts as an AI tell</h3><button type="button" class="ibtn" aria-label="Close">${I.close}</button></div><p class="lede">Each is ordinary craft. Crowded together, they read as AI-written.</p><dl>${Object.entries(KINDS).map(([k, d]) => `<div><dt>${d.name}</dt><dd>${d.what}<q>${EXAMPLES[k]}</q></dd></div>`).join('')}</dl><p class="rule">Flagged at ${LINE} in any 450 words, or ${KIND_LINE} of one kind.</p></div>`;

// Choosing checks: the new AI tells check beside the review's existing ones.
const check = (on, title, sub, extra = '') => `<label class="ck${on ? ' on' : ''}"><span class="box">${on ? I.check : ''}</span><span><b>${title}${extra ? ` <small>${extra}</small>` : ''}</b><small>${sub}</small></span></label>`;
const startSheet = () => `<div class="scrim"></div><div class="tdlg" role="dialog" aria-label="Review chapter"><div class="hd"><div><h3>Review chapter</h3><small>Chapter 1 · The corner booth · 4,102 words · v4</small></div><button type="button" class="ibtn" aria-label="Close">${I.close}</button></div><div class="cks">${check(true, 'AI tells', 'Patterns common in AI-written prose, flagged where they crowd together', 'New')}${check(true, 'Clarity and continuity', 'Unclear moments, and contradictions with earlier chapters')}${check(false, 'Pictures', 'Each chosen picture against its passage', '7')}${check(false, 'Narration records', 'Which blocks have a take, and whose voice')}</div><div class="ft"><span>Notes only. The chapter doesn’t change.</span><span class="gap"></span><button type="button" class="btn">Cancel</button><button type="button" class="btn pri">Start review</button></div></div>`;

// The review read whole: the AI tells section of the report.
const TOTALS = [['metaphor', 14], ['pivot', 8], ['notxy', 6], ['shorthand', 5], ['three', 5], ['list', 3]];
const passage = (n, first, count, state, extra = '') => `<div class="psg ${state.toLowerCase()}"><span class="n">${n}</span><div><q>${first}</q><small>${count}${extra}</small></div><span class="st">${state}</span><button type="button" class="btn">Show in page</button></div>`;
const report = () => `<div class="scrim"></div><div class="trep" role="dialog" aria-label="Chapter review"><div class="hd"><div><h3>Chapter review</h3><small>Chapter 1 · The corner booth · v5 · checked today 14:20</small></div><button type="button" class="ibtn" aria-label="Close">${I.close}</button></div><div class="cols"><nav aria-label="Checks"><button type="button" class="on">AI tells<small>1 open</small></button><button type="button">Clarity and continuity<small>2 open</small></button><button type="button">Pictures<small>Not checked</small></button><button type="button">Narration records<small>Not checked</small></button></nav>
<div class="main"><h2>AI tells</h2><div class="facts"><span><b>41</b> tells</span><span><b>4,102</b> words</span><span><b>10</b> per 1,000 words</span></div>${strip(WIN_AFTER, { here: -1, kept: [8], big: true })}
<div class="two"><section><h4>By kind</h4>${TOTALS.map(([k, n]) => `<div class="tot"><span>${KINDS[k].name}</span><i style="width:${n / 14 * 100}%"></i><b>${n}</b></div>`).join('')}</section><section><h4>Crowded passages</h4>${passage(1, 'Ade did not answer. He was already standing…', '5 in 450 words', 'Cleared', ' · was 14')}${passage(2, 'Tunde poured without asking, the way…', '10 in 450 words', 'Open')}${passage(3, 'Outside, the generators had started…', '9 in 450 words', 'Kept', ' · “The ending is meant to sing.”')}</section></div>
<div class="ft"><span>Read all 4,102 words in one model call. Counts are the model’s reading, checked against your words. Not an AI detector.</span><span class="gap"></span><button type="button" class="btn">Check AI tells again</button></div></div></div></div>`;

// Phone: the passage, its bracket at the edge, and the note as a half sheet.
const phone = () => `<div class="pcol"><div class="pbar"><button type="button" class="ibtn" aria-label="Back to chapters">${I.left}</button><b>The corner booth</b><button type="button" class="ibtn on" aria-label="Review">${I.review}</button><button type="button" class="ibtn" aria-label="Chapter views and more">${I.more}</button></div><div class="wpage"><div class="doc">${ps(DENSE.slice(1, 5))}</div>${bracket(10, 420)}</div></div>
<div class="tsheet" role="dialog" aria-label="AI tells, note 1 of 3"><span class="grab"></span><div class="k"><b>1</b>AI tells · Crowded<span class="gap"></span>1 of 3${I.right}</div><div class="big"><b>14</b> in 450 words<small>Line ${LINE}</small></div>${strip(WIN)}${kindRows()}<div class="acts2"><button type="button">Intentional</button><button type="button">Dismiss</button><span class="gap"></span><button type="button" class="lnk">What counts</button></div></div>`;

export const FRAMES = [
  frame('pr232 desktop', 1360, 900, '232a', 'Review chapter · choose the checks; AI tells is new', ms(docHead() + ps(['Friday at [[place|the club]] had its own weather: bass in the floor, smoke in the light, a hundred conversations pretending not to watch the door.', '[[ade|Ade]] had the corner booth because he always had the corner booth. [[tunde|Tunde]] had the bottle because [[tunde|Tunde]] had never once trusted a waiter to pour.']), '') + startSheet()),
  frame('pr232 desktop', 1360, 900, '232b', 'Manuscript · a crowded passage: its tells marked, its count in the margin', ms(midDoc(DENSE), bracket(118, 780) + rnotes(head(5) + note({ top: 136 })))),
  frame('pr232 desktop', 1360, 900, '232c', 'Manuscript · one tell hovered: its kind, and that it is fine alone', ms(midDoc(DENSE, { hot: 'Past the dancers. Past the bar. Past the last of his good sense.', quiet: true }), bracket(118, 780) + hoverCard('three', 'left:431px;top:212px') + rnotes(head(5) + note({ top: 136 })))),
  frame('pr232 desktop', 1360, 900, '232d', 'Manuscript · one kind chosen: its five metaphors lit, the rest quiet', ms(midDoc(DENSE, { lit: 'metaphor', quiet: true }), bracket(118, 780) + rnotes(head(5) + note({ top: 136, sel: 'metaphor' })))),
  frame('pr232 desktop', 1360, 900, '232e', 'What counts · the six tells, and the line', ms(midDoc(DENSE), bracket(118, 780) + rnotes(head(5) + note({ top: 136 })) + whatCounts('right:312px;top:150px'))),
  frame('pr232 desktop', 1360, 900, '232f', 'The writer rewrote the passage · its marks lift; Check again', ms(midDoc(REWRITTEN), bracket(118, 660, { stale: true }) + rnotes(head(5) + `<div class="rnote on tnote" style="top:136px"><div class="k"><b>1</b>AI tells · Changed</div><p>You’ve rewritten this passage since the check.</p><div class="was">Was 14 in 450 words</div><div class="acts2"><button type="button" class="pri">Check again</button><button type="button">Dismiss</button></div></div>`), foot('v5', '+38 today'))),
  frame('pr232 desktop', 1360, 900, '232g', 'Checked again · under the line, nothing marked', ms(midDoc(REWRITTEN), rnotes(head(4, WIN_AFTER) + `<div class="rnote min tnote done" style="top:136px"><div class="k"><b>1</b>AI tells · Cleared<span class="gap"></span>${I.check}</div><p>5 in 450 words. Was 14.</p></div>`), foot('v5', '+38 today'))),
  frame('pr232 desktop', 1360, 900, '232h', 'The review read whole · AI tells across the chapter', ms(midDoc(REWRITTEN), '', foot('v5', '+38 today')) + report()),
  frame('pr232 desktop', 1360, 900, '232i', 'A chapter with tells spread out · nothing crowded, nothing marked', ms(docHead() + ps(['Friday at [[place|the club]] had its own weather: bass in the floor, smoke in the light, a hundred conversations pretending not to watch the door.', '[[ade|Ade]] had the corner booth because he always had the corner booth. [[tunde|Tunde]] had the bottle because [[tunde|Tunde]] had never once trusted a waiter to pour.', '“You’re doing it again,” [[tunde|Tunde]] said. “Sitting like a man waiting for a board meeting.”', '“I’m sitting like a man with <span class="anch">a flight to [[place|Abuja]] at seven</span><sup class="fn">1</sup>.”', '“Then fly tired. [[place|Lagos]] will forgive you.”', '[[ade|Ade]] laughed, and that was when the room shifted. Not the music — the room. Heads turned toward the stairs the way grass leans before rain.']), rnotes(head(2, WIN_CLEAN, { here: 0 }) + `<div class="rnote min tnote done" style="top:136px"><div class="k">AI tells · None crowded<span class="gap"></span>${I.check}</div><p>19 in 4,102 words, spread out.</p></div><div class="rnote min" style="top:392px"><div class="k"><b>1</b>Continuity · Contradiction</div><p>Chapter 3 has the flight at six.</p></div>`))),
  frame('pr232 phone', 390, 844, '232j', 'Phone · the passage, and its note as a sheet', phone()),
];
