// Turn 227 · the chapter page, full width. Pure functions returning frame markup; the generator
// (chapter-page-227.mjs) places them in the master and the review page.
// Illustrative content: Na love or Juju, chapter 1. The prose is written for the drawing, not the book's.
const A = 'assets/';
const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const I = {
  panel: svg('<path d="M3 4h18v16H3z M9 4v16"/>'),
  home: svg('<path d="M3 10l9-7 9 7v11h-7v-7h-4v7H3z"/>'),
  cast: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M18 8a3 3 0 0 1 0 6 M22 21v-2a4 4 0 0 0-3-4"/>'),
  chat: svg('<path d="M21 11a9 9 0 0 1-9 9H3l2-5a9 9 0 1 1 16-4"/>'),
  overview: svg('<path d="M8 3h11v18H7V7H3V3h5 M7 7h8 M10 11h6 M10 15h6"/>'),
  book: svg('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
  speaker: svg('<path d="M11 5 6 9H2v6h4l5 4z M15.5 8.5a5 5 0 0 1 0 7 M19 5a10 10 0 0 1 0 14"/>'),
  folder: svg('<path d="M3 6h7l2 3h9v12H3z"/>'),
  inbox: svg('<path d="M4 4h16l2 12v4H2v-4z M2 16h6l2 2h4l2-2h6"/>'),
  bell: svg('<path d="M5 16l2-3V9a5 5 0 0 1 10 0v4l2 3z M10 20h4"/>'),
  gear: svg('<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 2h6l1 4 4 1 2 5-2 5-4 1-1 4H9l-1-4-4-1-2-5 2-5 4-1z"/>'),
  user: svg('<path d="M5 21v-3a7 7 0 0 1 14 0v3 M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8"/>'),
  left: svg('<path d="M15 5l-7 7 7 7"/>'),
  right: svg('<path d="M9 5l7 7-7 7"/>'),
  down: svg('<path d="M6 9l6 6 6-6"/>'),
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>',
  more: svg('<path d="M5 12h.01 M12 12h.01 M19 12h.01" stroke-width="3"/>'),
  people: svg('<path d="M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M2 21v-1a6 6 0 0 1 12 0v1 M16 4a3.5 3.5 0 0 1 0 7 M18 15a5 5 0 0 1 4 5v1"/>'),
  image: svg('<path d="M3 4h18v16H3z M3 16l5-5 4 4 3-3 6 6 M15.5 8.5h.01" />'),
  notes: svg('<path d="M4 5h16 M4 12h16 M4 19h10"/>'),
  close: svg('<path d="M6 6l12 12 M18 6L6 18"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2 5.3 M20 4v7h-7"/>'),
  wave: svg('<path d="M3 12h1 M7 8v8 M11 5v14 M15 8v8 M19 10v4 M22 12h-1"/>'),
  check: svg('<path d="M5 12l5 5L20 7"/>'),
  review: svg('<path d="M4 4h12l4 4v12H4z M8 12l3 3 5-6"/>'),
};

// 26 chapters, words for each; chapter 26 planned. Chapter 1 is open.
const WORDS = [4102, 3880, 4215, 4060, 4390, 3725, 4180, 4002, 4433, 3960, 4120, 4288, 3870, 4310, 4055, 3990, 4240, 4170, 3815, 4400, 4080, 3935, 4150, 4260, 3610, 0];
export const strip = (here = 0) => `<span class="strip" aria-label="Chapter ${here + 1} of ${WORDS.length}">${WORDS.map((w, i) => `<i class="${i === here ? 'here' : w ? '' : 'plan'}" style="flex:${w || 3000}" title="Chapter ${i + 1}"></i>`).join('')}</span>`;
export const bars = (here = 0) => `<div class="bars">${WORDS.map((w, i) => `<i class="${i === here ? 'here' : w ? '' : 'plan'}" style="height:${Math.round((w / 4433) * 100)}%"></i>`).join('')}</div>`;

export const PEOPLE = {
  nar: { name: 'Ife’s voice', first: 'Narrator', lines: '212 blocks', v: 'v6', nar: true },
  ade: { name: 'Adeyemi “Ade” Akinola', first: 'Ade', lines: '41 lines', v: 'v1', img: A + 'nloj-ade.jpg' },
  tunde: { name: 'Tunde', first: 'Tunde', lines: '27 lines', v: 'v3', img: A + 'nloj-tunde.jpg' },
  ife: { name: 'Ife', first: 'Ife', lines: '19 lines', v: 'v2', img: A + 'nloj-ife.jpg' },
};

// [speaker, text, picture?]
export const PROSE = [
  ['nar', 'Friday at the club had its own weather: bass in the floor, smoke in the light, a hundred conversations pretending not to watch the door.'],
  ['nar', 'Ade had the corner booth because he always had the corner booth. Tunde had the bottle because Tunde had never once trusted a waiter to pour.', 'nloj-booth.jpg'],
  ['tunde', '“You’re doing it again,” Tunde said. “Sitting like a man waiting for a board meeting.”'],
  ['ade', '“I’m sitting like a man with a flight to Abuja at seven.”'],
  ['tunde', '“Then fly tired. Lagos will forgive you.”'],
  ['nar', 'Ade laughed, and that was when the room shifted. Not the music — the room. Heads turned toward the stairs the way grass leans before rain.'],
  ['nar', 'She came down slowly, gold satin catching every light it passed, her braids gathered over one shoulder. She did not look for anyone. She let the club look for her.', 'nloj-walk.jpg'],
  ['tunde', '“Close your mouth,” Tunde said. “You have a flight.”'],
  ['nar', 'Ade did not answer. He was already standing.'],
  ['ife', '“If you’re about to offer me a drink,” she said, before he had reached her, “ask what I’m drinking first.”'],
  ['ade', '“What are you drinking?”'],
  ['ife', '“Something you haven’t ordered yet.”'],
];

const HERO = A + 'nloj-eyes.jpg';
const esc = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');

export const titlebar = () => `<header class="tb"><span class="crumb">‹ World <span>Na love or Juju · story</span></span><b>Arke <small>Studio</small></b><span class="util">${I.chat}${I.inbox}${I.bell}${I.gear}${I.user}</span></header>`;
const RAIL = [['panel', 'Collapse navigation'], ['home', 'Dashboard'], ['cast', 'Cast'], ['chat', 'Develop'], ['overview', 'Overview'], ['book', 'Chapters'], ['speaker', 'Audiobook'], ['folder', 'Artifacts']];
export const rail = () => `<nav class="crail" aria-label="Production navigation">${RAIL.map(([i, n]) => `<button type="button" aria-label="${n}" title="${n}"${n === 'Chapters' ? ' class="on" aria-current="page"' : ''}>${I[i]}</button>`).join('')}</nav>`;
export const fold = () => `<aside class="fold" aria-label="Arke"><button type="button" aria-label="Open Arke" title="Arke">${I.chat}</button></aside>`;

const book = (wide) => `<div class="book"><button type="button" class="nav" disabled aria-label="Previous chapter">${I.left}</button><b>Chapter 1</b> of 26 ${strip(0)}<button type="button" class="nav" aria-label="Next chapter">${I.right}</button></div>`;
const meta = () => `<div class="meta"><button type="button" class="pov" aria-label="Point of view"><img src="${PEOPLE.ade.img}" alt="">Ade${I.down}</button><span>Friday night</span><span>4,102 words</span><span>Drafted</span></div>`;
export const actions = ({ read = true } = {}) => `<div class="acts">${read
  ? `<button type="button" class="btn pri">${I.play}Listen <small>23:12</small></button>`
  : `<button type="button" class="btn pri">${I.speaker}Read the chapter</button>`}<button type="button" class="btn">${I.review}Review</button><button type="button" class="btn icon" aria-label="More">${I.more}</button></div>`;

export const hero = ({ art = HERO, read = true, title = 'The corner booth', syn = 'Ade and Tunde’s easy, longstanding friendship opens a night at a club. Ife’s deliberate flirtation interrupts Ade’s composure; he approaches her, offers a drink, and asks for her number.' } = {}) =>
  `<section class="hero${art ? '' : ' bare'}">${art ? `<div class="hero__art" style="background-image:url('${art}')"></div>` : ''}<div class="hero__in">${book()}<h1>${title}</h1><p class="syn">${syn}</p>${meta()}${actions({ read })}</div></section>`;

const who = (k, sel) => { const p = PEOPLE[k]; return `<button type="button" class="who ${p.v}${sel ? ' sel' : ''}" aria-label="${p.name}">${p.nar ? `<span class="face nar">${I.wave}</span>` : `<img class="face" src="${p.img}" alt="">`}<span><b>${p.first}</b><small>${p.lines}</small></span></button>`; };
export const cast = ({ sel, owe = 6 } = {}) => `<div class="cast">${['nar', 'ade', 'tunde', 'ife'].map(k => who(k, sel === k)).join('')}<span class="gap"></span>${owe ? `<span class="owe"><span class="dot"></span>${owe} to cast<button type="button" class="btn">${I.refresh}Cast again</button></span>` : ''}</div>`;

export const views = ({ notes = false, flag = true, inBar = false } = {}) => {
  const seg = `<div class="seg" role="tablist"><button type="button" class="on">Manuscript</button><button type="button">Audiobook</button><button type="button">Audio Studio</button></div>`;
  const tools = `<button type="button" class="tog on" aria-pressed="true" aria-label="Speakers in the margin" title="Speakers">${I.people}</button><button type="button" class="tog on" aria-pressed="true" aria-label="Pictures in the margin" title="Pictures">${I.image}</button><span class="sep"></span><button type="button" class="notes-btn${notes ? ' on' : ''}">${flag ? '<span class="dot"></span>' : ''}Notes</button>`;
  return inBar ? { seg, tools } : `<div class="views">${seg}<span class="gap"></span>${tools}</div>`;
};

export const compactBar = ({ notes } = {}) => { const v = views({ notes, inBar: true }); return `<div class="bar"><span class="thumb" style="background-image:url('${HERO}')"></span><span class="t"><small>Chapter 1</small><b>The corner booth</b></span>${v.seg}<span class="gap" style="flex:1"></span>${v.tools}<button type="button" class="btn pri">${I.play}Listen <small>23:12</small></button></div>`; };

// The manuscript grid. `mode`: 'margin' (pictures right), 'inline' (pictures after their passage), 'phone'.
export const manuscript = ({ from = 0, to = PROSE.length, mode = 'margin', names = true, sel } = {}) => {
  let row = 1, out = '', last = null;
  PROSE.slice(from, to).forEach(([k, text, pic], idx) => {
    const p = PEOPLE[k], said = k !== 'nar';
    if (mode === 'phone') {
      out += `<p class="${said ? 'said ' + p.v : ''}">${esc(text)}</p>`;
      if (pic) out += `<figure><div style="background-image:url('${A + pic}')"></div></figure>`;
      return;
    }
    if (said) out += `<span class="mk ${p.v}${names && last !== k ? '' : ' quiet'}" style="grid-row:${row}">${names && last !== k ? p.first : ''}<img src="${p.img}" alt="${p.first}"></span>`;
    out += `<p class="${said ? 'said ' : ''}${sel === from + idx ? 'sel ' + p.v : ''}" style="grid-row:${row}">${esc(text)}</p>`;
    if (pic && mode === 'margin') out += `<figure style="grid-row:${row} / span 4"><div style="background-image:url('${A + pic}')"></div></figure>`;
    row++;
    if (pic && mode === 'inline') { out += `<figure class="in" style="grid-row:${row}"><div style="background-image:url('${A + pic}')"></div></figure>`; row++; }
    last = k;
  });
  return `<div class="ms">${out}</div>`;
};

