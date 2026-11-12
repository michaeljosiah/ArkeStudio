// Turn 272 · A new book's first steps (SPEC-064). From round 95: Create and open day one landed an
// original book on a Dashboard with no chapters and no next step, and only an adapted book ever met
// Arke or the Mode row. The door is 248a, setup is 256a, the Dashboard is 256e, Pages is what ships
// and the dock is 270's. The book, Neap Tide, is a sample; its counts and lines are synthetic.
import { SPARK, CHECK, DOWN, PLUS, head, dock, user, said, rail as pagesRail } from './comic-arke-270.frames.mjs';
import { STYLES } from './comic-style-248.frames.mjs';

const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const LEFT = svg('<path d="m15 18-6-6 6-6"/>');
const TITLE = 'Neap Tide';
const MANGA = 'assets/comic-styles/manga.jpg';
const picture = (id, given) => given ?? `assets/comic-styles/${id}.jpg`;

// The door's foot stays where it is: in round 95 a style seeded its words above it and the press missed.
const door = (label, height) => `<div class="gn247 gn248 gn272" data-screen-label="${label}" style="width:1360px;height:${height}px"><div class="gn272-door"><div class="gn272-scroll"><h2>Tell a story</h2><div class="q">What kind of story?</div><div class="gn247-cards">${[
  ['Novel', 'Chapters, to read.', 'assets/banner-story.png'], ['Audio drama', 'Episodes, for the ear.', 'assets/banner-audio.png'],
  ['Graphic novel', 'Pages, to look at.', picture('superhero')], ['Other', 'Nothing assumed.', ''],
].map(([b, s, img]) => `<div class="gn247-card${b === 'Graphic novel' ? ' on' : ''}"><div class="pl">${img ? `<img src="${img}" alt="">` : ''}</div><div class="tx"><b>${b}</b><span>${s}</span></div></div>`).join('')}</div><div class="gn247-field"><label>Name</label><div class="in gn272-ph">Arke can name it</div></div><div class="gn247-field"><label>Adapt from</label><div class="in">Nothing &#183; an original book<span class="grow"></span>${DOWN}</div></div><div class="gn247-field"><label>Style</label></div><div class="gn248-styles">${STYLES.slice(0, 11).map(([id, name, blurb, given]) => `<div class="gn248-style${id === 'manga' ? ' on' : ''}"><div class="pl"><img src="${picture(id, given)}" alt=""><span class="tick">${CHECK}</span></div><div class="tx"><b>${name}</b><span class="s">${blurb}</span></div></div>`).join('')}<div class="gn248-style"><div class="pl">${PLUS}<span class="tick">${CHECK}</span></div><div class="tx"><b>Your own</b><span class="s">Describe it</span></div></div></div></div><div class="gn272-foot"><span class="m">joins Saltlight &#183; 4 characters, every location, the whole canon</span><span class="grow"></span><span class="gn247-btn ghost">Back</span><span class="gn247-btn">Start empty</span><span class="gn247-btn pri">Plan with Arke</span></div></div></div>`;

const setup = (label, chat, plan) => `<div class="gn247 gn249 gn256 gn272" data-screen-label="${label}" style="width:1360px;height:850px"><div class="gn249-top"><span class="gn247-btn ghost sm">${LEFT}Back</span><b>Saltlight</b><span class="m">new production</span></div><div class="gn249-setup"><div class="gn249-chat">${chat}<div class="gn249-composer"><span class="gn272-attach">${PLUS}</span>Ask Arke, or change the plan&#8230;</div></div><div class="gn249-plan">${plan}</div></div></div>`;

const usual = `<div class="gn256-usual"><div class="row"><span>Reading</span><b>Left to right</b></div><div class="row"><span>Page</span><b>2:3 comic book</b></div><div class="row"><span>Pilot</span><b>Chapter 1 &#183; The bell</b></div><div class="row"><span>Mode</span><b>Panel by panel</b></div><div class="gn249-acts"><span class="gn247-btn pri sm">Use these</span><span class="gn247-btn sm">Change</span></div></div>`;

const PLAN = [
  ['The bell', 'She hears it at low water. Nobody else will say so.', 8, true],
  ['Salt', 'The town closes up around her question.', 7],
  ['The weigh house', 'Bray&#8217;s ledger names the night it sank.', 7],
  ['Neap', 'The lowest tide of the year, and what is under it.', 6],
];

// Rail for a book with nothing made yet; the counts are the book's own.
const rail = (on, chapters, pages) => `<div class="gn247-rail"><div class="t">${TITLE}</div><div class="k">Graphic novel</div>${[['Dashboard'], ['Cast', '4'], ['Develop'], ['Overview'], ['Chapters', chapters], ['Pages', pages]].map(([name, n]) => `<a${name === on ? ' class="on"' : ''}>${name}${n ? `<span>${n}</span>` : ''}</a>`).join('')}<hr><a>Artifacts</a></div>`;
const row = ([title, stage, kind, n], i) => `<div class="gn254-row gn256-ch"><span class="n">${i + 1}</span><span class="t">${title}</span><span class="gn256-stage ${kind}">${stage}</span><span class="m">${n}</span></div>`;
const dash = (label, chapters, pages, line, next, press, rows, shelf = '') => `<div class="gn247 gn254 gn256 gn272" data-screen-label="${label}" style="width:1360px;height:850px">${rail('Dashboard', chapters, pages)}<div class="gn247-main"><div class="gn256-dash"><h2>${TITLE}</h2><div class="m">${line}</div><div class="gn256-next">${SPARK}<span><b>Next</b> &#183; ${next}</span><span class="grow"></span>${press}</div>${shelf}<div class="gn254-list">${rows.map(row).join('')}</div></div></div></div>`;

export const frames = [
  {
    id: '272a', title: 'The door: an original book is planned with Arke too', width: 1360, height: 850,
    markup: door('272a Tell a story with Graphic novel picked and nothing to adapt: Plan with Arke is the main press, as it is for an adaptation, and Start empty is beside it; the name is optional and the foot stays put when a style is picked', 850),
  },
  {
    id: '272b', title: 'Setup: one question, a line is enough', width: 1360, height: 850,
    markup: setup('272b Setup for an original book: there is nothing to read, so Arke asks what happens in it; the plan side holds only what is chosen so far',
      `<div class="gn249-arke"><span class="who">Arke</span>What happens in it? A line is enough.</div>`,
      `<h3>New book</h3><div class="sub">Graphic novel &#183; original</div><div class="gn249-facts"><span><img src="${MANGA}" alt="">Manga</span></div><div class="gn272-noplan">No plan yet</div>`),
  },
  {
    id: '272c', title: 'Setup: the usual card, now with Mode', width: 1360, height: 850,
    markup: setup('272c From one line Arke offers the usual settings as one card, now four rows with Mode, which is Panel by panel for a new book; the plan comes after Use these',
      `<div class="gn249-me">A lighthouse keeper&#8217;s daughter hears a bell under the water at every low tide, and the town pretends it can&#8217;t.</div>
<div class="gn249-arke"><span class="who">Arke</span>Mostly Maren against the town&#8217;s silence. I&#8217;d make it the usual way:${usual}</div>`,
      `<h3>New book</h3><div class="sub">Graphic novel &#183; original</div><div class="gn249-facts"><span><img src="${MANGA}" alt="">Manga</span></div><div class="gn272-noplan">No plan yet</div>`),
  },
  {
    id: '272d', title: 'Setup: one plan, from one line', width: 1360, height: 850,
    markup: setup('272d One plan: each chapter says what happens in it in place of a source, Arke has named the book, and anyone with no picture yet is named beneath it',
      `<div class="gn249-me">A lighthouse keeper&#8217;s daughter hears a bell under the water at every low tide, and the town pretends it can&#8217;t.</div>
<div class="gn249-arke"><span class="who">Arke</span>Mostly Maren against the town&#8217;s silence. I&#8217;d make it the usual way.</div>
<div class="gn249-me">Use these.</div>
<div class="gn249-arke"><span class="who">Arke</span>Four chapters, starting with the bell. Bray and the weigh house have no picture yet.</div>`,
      `<h3>${TITLE}</h3><div class="sub">Graphic novel &#183; original &#183; 4 chapters &#183; ~28 pages</div><div class="gn249-facts"><span><img src="${MANGA}" alt="">Manga</span><span>Left to right</span><span>2:3</span><span>Pilot &#183; chapter 1</span><span>Panel by panel</span></div>
<div class="gn249-rows">${PLAN.map(([title, about, pages, pilot], i) => `<div class="gn249-prow gn272-prow${pilot ? ' pilot' : ''}"><span class="n">${i + 1}</span><span>${title}<span class="src">${about}</span></span><span class="pg">~${pages} pages</span></div>`).join('')}</div>
<div class="gn272-need"><span>No picture yet</span><b>Bray</b><b>The weigh house</b></div>
<div class="gn249-acts"><span class="gn247-btn pri">Start the pilot</span><span class="gn247-btn">Change the plan</span></div>`),
  },
  {
    id: '272e', title: 'Dashboard: a new book, and the press does the next step', width: 1360, height: 850,
    markup: dash('272e A book just created: the Dashboard says it has no pages yet, and Next plans chapter 1 from here, sending at once, where it used to say Open in Pages',
      '4', '', '4 chapters &#183; no pages yet', 'plan 1 &#183; The bell',
      `<span class="gn247-btn pri sm">${SPARK}Plan with Arke</span>`,
      PLAN.map(([title]) => [title, 'Not planned', 'none', ''])),
  },
  {
    id: '272f', title: 'Start empty: chapter 1 in Pages, never a blank Dashboard', width: 1720, height: 850,
    markup: `<div class="gn247 gn251 gn253 gn254 gn269 gn270 gn272" data-screen-label="272f Start empty writes one chapter and opens Pages on it, where a page can be started by hand; Plan with Arke asks what happens in it, because nothing is written yet" style="width:1720px;height:850px">${pagesRail.replace('Low Water, drawn', TITLE).replace('<a>Chapters<span>6</span></a>', '<a>Chapters<span>1</span></a>').replace('<a class="on">Pages<span>24</span></a>', '<a class="on">Pages</a>').replace('<a>Cast<span>4</span></a><a>Develop</a><a>Overview<span>v2</span></a>', '<a>Cast<span>4</span></a><a>Develop</a><a>Overview</a>').replace('<a>Artifacts<span>31</span></a>', '<a>Artifacts</a>')}<div class="gn247-main gn270-main">${head('Panel by panel', ['Manga', MANGA]).replace('1 · The tide', '1 · Untitled')}<div class="gn272-pages"><div class="gn247-strip"><div class="gn247-add">+ Page</div></div><div class="gn249-empty"><h3>1 &#183; Untitled has no pages</h3><div class="gn249-acts"><span class="gn247-btn pri">${SPARK}Plan with Arke</span><span class="gn247-btn">+ Page</span></div></div></div></div>${dock(user('Plan chapter 1, Untitled, as pages.'), said('Nothing is written for this chapter yet. What happens in it? A line is enough.')).replace('Low Water, drawn', TITLE)}</div>`,
  },
  {
    id: '272g', title: 'Dashboard: the script is kept, so Next is the priced card', width: 1360, height: 850,
    markup: dash('272g The pilot script is kept and the book is Panel by panel: Next is Make with Arke, which asks for 270s priced card; rows keep their stages',
      '4', '8', '4 chapters &#183; 8 of ~28 pages written &#183; none made', 'make 1 &#183; The bell',
      `<span class="gn247-btn pri sm">${SPARK}Make with Arke</span>`,
      [['The bell', 'Pages written', 'kept', '8 pages'], ['Salt', 'Not planned', 'none', ''], ['The weigh house', 'Not planned', 'none', ''], ['Neap', 'Not planned', 'none', '']]),
  },
];
