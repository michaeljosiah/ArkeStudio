// Turn 252 · Opening and closing credits (SPEC-047, SPEC-058). The page is turn 199's audiobook page
// (199a, 199e) in its own markup, checked on 31 October 2026 against the shipped page: its meta line,
// Continue, Publish and ⋯, the cast cards (the narrator's is the world's art) and the chapter rows. The
// app's shell around it has changed since 199a, so the frames draw the page's content area alone, at
// the 1180 it has in a 1440 window. The Export sheets are turn 235d's grammar. Na love or Juju is
// 199's sample, with its real chapters, lengths and first pictures from the 31 October edition.
const svg = (d, size = 16, w = 1.9) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const PLAY = (size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>`;
const DOTS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
const GO = svg('<path d="m9 6 6 6-6 6"/>');
const X = svg('<path d="M6 6l12 12M18 6L6 18"/>', 15);
const DOWN = svg('<path d="m6 9 6 6 6-6"/>', 14);
const TICK = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 14, 2.4);
const ALERT = svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>', 14);

const TITLE = 'Na love or Juju';
const AUTHOR = 'Michael Josiah';
const COVER = 'assets/t252-nloj-cover-wide.jpg';
const OPENING = `${TITLE}. Written by ${AUTHOR}. Narrated by an AI voice.`;
const CLOSING = `You have been listening to ${TITLE}, written by ${AUTHOR}, narrated by an AI voice. Copyright 2026 ${AUTHOR}. The End.`;

const hero = () => `<div class="v199-hero"><img class="bd" src="assets/nloj-backdrop.jpg" alt=""><div class="sl"></div><div class="sb"></div><div class="v199-wrap" style="--pad:56px"><h1>${TITLE}</h1><div class="v199-meta">Audiobook &#183; 26 chapters &#183; 12 h 9 m recorded &#183; Read by Nigerian Woman 2</div><div class="v199-acts"><span class="v199-btn pri">${PLAY()}Continue <em>&#183; Chapter 10 &#183; 6:57</em></span><span class="v199-btn">Publish</span><span class="v199-btn ic">${DOTS}</span></div></div></div>`;
const cast = () => `<h2 class="v199-h">Cast</h2><div class="v199-cast"><div class="v199-card"><div class="im"><img src="assets/nloj-backdrop.jpg" alt="" style="object-position:62% center"><span class="wv">${svg('<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>', 15, 2)}</span></div><div class="nm">Nigerian Woman 2</div><div class="rl">Narrator</div></div><div class="v199-card"><div class="im"><img src="assets/nloj-ade.jpg" alt="" style="object-position:center 20%"></div><div class="nm">Adeyemi &#8220;Ade&#8221; Akinola</div></div><div class="v199-card"><div class="im"><img src="assets/nloj-tunde.jpg" alt="" style="object-position:center 20%"></div><div class="nm">Tunde</div></div><div class="v199-card"><div class="im"><img src="assets/nloj-ife.jpg" alt="" style="object-position:center 20%"></div><div class="nm">Ife</div></div></div>`;

// A chapter row exactly as 199a draws it; a credits row is the same row with the cover, its name,
// m:ss rather than minutes (a credit runs seconds) and its words where a chapter has its synopsis.
const row = ({ pic, name, length, state, syn, warn = false }) => `<div class="v199-ep"><div class="v199-th"><img src="${pic}" alt=""></div><div><div class="t">${name}${length ? `<span class="d">${length}</span>` : ''}${state ? `<span class="st${warn ? ' cr252-w' : ''}">${state}</span>` : ''}</div><div class="syn">${syn}</div></div><span class="go">${GO}</span></div>`;
const CH = {
  1: { pic: 'assets/t252-nloj-ch01.jpg', name: '1 &#183; Gold on Gold', length: '20 min recorded', syn: 'Ade and Tunde&#8217;s easy, longstanding friendship opens a night at a club. Ife&#8217;s beauty and deliberate flirtation interrupt Ade&#8217;s composure. He approaches her, offers a drink without prompting, and asks for her number.' },
  2: { pic: 'assets/t252-nloj-ch02.jpg', name: '2 &#183; Suya at Midnight', length: '29 min recorded', syn: 'Ade at work in Apapa, disciplined, the port gridlock. He answers her 3:52 message in the morning; she leaves him on blue ticks for two days, and for the first time he checks his phone in a meeting.' },
  25: { pic: 'assets/t252-nloj-ch25.jpg', name: '25 &#183; The Box', length: '28 min recorded', syn: 'Divers search the lagoon for nine days, then stop; Segun says nothing at Panti. Tunde comes every morning and eats the second plate.' },
  26: { pic: 'assets/t252-nloj-ch26.jpg', name: '26 &#183; Every Day', length: '13 min recorded', syn: 'April, a year on, the first rains. The same club, the same booth. Tunde tells the goat story, the true version now.' },
};
const opening = (state = '') => row({ pic: COVER, name: 'Opening credits', length: '0:09 recorded', state, syn: OPENING });
const closing = ({ length = '', state = 'not read', warn = false } = {}) => row({ pic: COVER, name: 'Closing credits', length, state, syn: CLOSING, warn });

const shell = (label, width, height, page, over = '') => `<div class="v199 cr252" data-screen-label="${label}" style="width:${width}px;height:${height}px"><div class="v199-main" style="height:100%"><div class="v199-page">${page}</div>${over}</div></div>`;
const body = (inner, extra = '') => `<div class="v199-wrap v199-body" style="--pad:56px;--cw:220px;--tw:240px${extra}">${inner}</div>`;

// The Credits sheet, in 199e's grammar: the details as rows, then each credit's words over its field.
const field = (value) => `<span class="cr252-in">${value}</span>`;
const credit = (name, data, words, warn = false) => `<div class="v199-lbl" style="margin-top:4px"><span>${name}</span><span class="mono${warn ? ' cr252-w' : ''}">${data}</span></div><textarea aria-label="${name}" style="margin-top:-6px;height:${words.length > 90 ? 88 : 64}px">${words}</textarea>`;
const sheet = ({ narrated, openingWords = OPENING, openingData = `${PLAY(11)} 0:09`, openingWarn = false, closingData = 'not read', foot, menu = '' }) => `<div class="v199-scrim"></div><div class="v199-sheet"><div class="hd"><h3>Credits</h3><span class="v199-x">${X}</span></div><div class="bdy">
<div class="v199-kv"><b>Title</b>${field(TITLE)}</div>
<div class="v199-kv"><b>Written by</b>${field(AUTHOR)}</div>
<div class="v199-sp key cr252-pick"><b>Narrated by</b><span class="v">${narrated}</span><span class="c">${DOWN}</span>${menu}</div>
<div class="v199-kv"><b>Copyright</b>${field(`&#169; 2026 ${AUTHOR}`)}</div>
${credit('Opening credits', openingData, openingWords, openingWarn)}
${credit('Closing credits', closingData, CLOSING)}
</div><div class="ft">${foot}</div></div>`;
const MENU = `<div class="v199-menu cr252-menu"><div class="it on"><span>an AI voice</span><em>${TICK}</em></div><div class="it"><span>Nigerian Woman 2, an AI voice</span></div><div class="it"><span>Your words</span></div></div>`;

// The Export sheet in 235d's grammar, over 235's page.
const PAGE = '<div class="ap235-page">' + [28, 92, 88, 95, 60, 90, 84, 93, 70, 89, 91, 55, 80, 66, 88, 74].map((w) => `<i style="width:${w}%"></i>`).join('') + '</div>';
const opt = (k, v, note = '') => `<div class="ap235-opt"><b class="ap235-k">${k}</b>${v}<span class="grow"></span>${note ? `<i>${note}</i>` : ''}</div>`;
const seg = (items, on) => `<span class="ap235-seg">${items.map((t) => `<span${t === on ? ' class="on"' : ''}>${t}</span>`).join('')}</span>`;
const exportSheet = (label, rows, est, press, height) => `<div class="ap235 cr252" data-screen-label="${label}" style="width:1360px;height:${height}px">${PAGE}<div class="ap235-dim"></div><div class="ap235-sheet" style="top:36px;width:720px"><h3>Export audiobook</h3><div class="sub">26 of 26 chapters read &#183; 12:08:40</div><div class="ap235-opts">${rows.join('')}</div>${est}<div class="ap235-foot"><span class="grow"></span><span class="ap235-btn">Cancel</span><span class="ap235-btn pri">${press}</span></div></div></div>`;

export const FRAMES = [
  ['a', 'Opening credits open the book, above Chapter 1', 1180, 1400, () => shell(
    '252a The audiobook page: Opening credits are the first row of Chapters, the cover as its picture, its length and its words where a chapter has its synopsis',
    1180, 1400,
    hero() + body(`${cast()}<h2 class="v199-h">Chapters</h2><div>${opening()}${row(CH[1])}${row(CH[2])}</div>`),
  )],

  ['b', 'Closing credits close it; the Credits sheet', 1180, 860, () => shell(
    '252b The foot of Chapters: Closing credits after the last chapter, not read yet; pressed, the Credits sheet opens from the side, as Reading does: the details, then each credit&#8217;s words, and Read for what is not read',
    1180, 860,
    body(`<div style="padding-top:8px">${row(CH[25])}${row(CH[26])}${closing()}</div>`),
    sheet({ narrated: 'an AI voice<small>Nigerian Woman 2</small>', foot: `<span class="v184-btn">Hear opening</span><span class="v184-btn primary">Read closing <em>&#183; ~$0.01</em></span>` }),
  )],

  ['c', 'Who it says read the book', 1180, 860, () => shell(
    '252c Narrated by, open: an AI voice, the voice by name and an AI voice, or the author&#8217;s own words; an opening that no longer names the narrator says so in one clause',
    1180, 860,
    body(`<div style="padding-top:8px">${row(CH[25])}${row(CH[26])}${closing({ length: '0:14 recorded' })}</div>`),
    sheet({
      narrated: 'an AI voice<small>Nigerian Woman 2</small>',
      menu: MENU,
      openingWords: `${TITLE}, by ${AUTHOR}.`,
      openingData: `<span class="cr252-wi">${ALERT}</span>names no narrator`,
      openingWarn: true,
      closingData: `${PLAY(11)} 0:14`,
      foot: `<span class="v184-btn">Hear opening</span><span class="v184-btn primary">Read opening <em>&#183; ~$0.01</em></span>`,
    }),
  )],

  ['d', 'Chapter files: the credits as files of their own', 1360, 540, () => exportSheet(
    '252d Export, Chapters: Credits counts the opening and the closing, read; the files are the opening first, the chapters, the closing last',
    [
      opt('Include', seg(['This chapter', 'Whole book'], 'Whole book')),
      opt('Export', seg(['Player', 'Chapters', 'Video', 'Arke Player'], 'Chapters')),
      opt('Chapters', '<span>26 of 26 &#183; read whole</span>'),
      opt('Credits', '<span>Opening &#183; closing &#183; read</span>', '00 &#183; 27'),
      opt('Format', '<span>MP3 &#183; 192 kbps CBR &#183; 44.1 kHz &#183; retail levels</span>'),
    ],
    '<div class="ap235-est"><b style="font-weight:600">28 files &#183; ~1.0 GB</b><span class="m">00-OpeningCredits.mp3 &#183; 01-Chapter1.mp3 &#8230; 27-ClosingCredits.mp3</span></div>',
    'Export chapter files', 540,
  )],

  ['e', 'Arke Player: the credits in the first and last chapters', 1360, 660, () => exportSheet(
    '252e Export, Arke Player: Credits play at the start of Chapter 1 and the end of Chapter 26, over the cover; the package and every Player read them as they are',
    [
      opt('Export', seg(['Player', 'Chapters', 'Video', 'Arke Player'], 'Arke Player')),
      opt('World', `<img class="ap235-art" src="assets/nloj-backdrop.jpg" alt=""><span>Na Love or Juju</span>`, 'key art &#183; logline'),
      opt('Book', '<span>The book</span>', '26 chapters &#183; EPUB'),
      opt('Narration', '<span>26 of 26 &#183; read whole</span>', 'Chapters 1&#8211;26'),
      opt('Credits', '<span>In Chapter 1 and Chapter 26</span>', 'over the cover'),
      opt('Pictures', '<span>409 wide &#183; 409 tall</span>', 'cover before the first'),
      opt('Edition', '<span class="ap235-field">31 Oct 2026</span>'),
    ],
    '<div class="ap235-est"><b style="font-weight:600">~893 MB &#183; ~15 min on this machine</b><span class="m">26 chapters &#183; 818 pictures &#183; the book &#183; credits</span></div>',
    'Make package', 660,
  )],
];
