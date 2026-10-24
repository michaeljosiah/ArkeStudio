// Turn 238 · Music as a production: the frames. The sample is The Undersong's music: Songs of the
// Drowned Quarter (an album of nine tracks), Saltmouth Bells (a single) and The Bell Watch —
// Soundtrack. The track names, lengths, takes and lyrics are samples; the covers are the design
// system's own near-square pictures, shown square. Every frame's root is .ap238 with its
// data-screen-label.
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';
const DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
const OUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>';
const X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const NOTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
const GRIP = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
const UPLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg>';
const IMAGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>';
const SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
const MORE = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
const PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/></svg>';
const SPARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><path d="m6 6 2 2M16 16l2 2M6 18l2-2M16 8l2-2"/></svg>';

const A = 'assets/';
const KEY_ART = 'assets/world-undersong.png';
// The covers are square (1:1, made at 1024 × 1024); the sample pictures are near square and shown so.
const COVER = { album: 'scene4-shot15.png', single: 'launch-harbour.webp', score: 'scene4-shot14b.png' };
const ALBUM = 'Songs of the Drowned Quarter';
const PAGE = '<div class="ap238-page">' + [28, 92, 88, 95, 60, 90, 84, 93, 70, 89, 91, 55, 80, 66].map((w) => `<i style="width:${w}%"></i>`).join('') + '</div>';
const root = (label, width, height, inner) => `<div class="ap238" data-screen-label="${label}" style="width:${width}px;height:${height}px">${inner}</div>`;
const play = `<span class="ap238-play">${PLAY}</span>`;
// A take's waveform, as 230e draws one; `from`–`to` (0–1) marks an excerpt.
const wv = (seed, n = 48, from = -1, to = -1) => `<div class="ap238-wv">${Array.from({ length: n }, (_, i) => `<i${i / n >= from && i / n < to ? ' class="in"' : ''} style="height:${6 + Math.round(Math.abs(Math.sin(seed * 3.1 + i * 1.7)) * 30)}px"></i>`).join('')}</div>`;

// The album, in order: title, length, where it came from, where it is heard, whose theme it is.
const TRACKS = [
  ['The Drowned Verse', '4:12', 'Bench &#183; take 2', 'The Ledger of Nights &#183; Chapter 9', 'The Chorister&#8217;s theme'],
  ['Slack Water', '3:05', 'Bench &#183; take 1', '', ''],
  ['Saltmouth Bells', '3:42', 'Bench &#183; take 4', 'The Ledger of Nights &#183; Chapter 8', ''],
  ['Tide-caller', '3:58', 'File &#183; tide-caller.wav', '', 'Maren Kest&#8217;s theme'],
  ['The Vigil', '4:40', 'Bench &#183; take 1', '', ''],
  ['Lantern Road', '3:20', 'Bench &#183; take 3', '', ''],
  ['Ledger Hymn', '2:55', 'Bench &#183; take 2', '', ''],
  ['Low Water', '3:33', 'Bench &#183; take 2', '', ''],
  ['Undersong', '5:01', 'Bench &#183; take 3', '', ''],
];

const top = (crumbs, tail = '') => `<div class="ap238-top">${crumbs.map((c, i) => i === crumbs.length - 1 ? `<b>${c}</b>` : `<span class="crumb">${c}</span><span class="crumb">/</span>`).join('')}<span class="grow"></span>${tail}</div>`;
const trackRows = (open = -1) => TRACKS.map(([t, len, src, heard, theme], i) => `<div class="ap238-tr${i === open ? ' on' : ''}"><span class="grip">${GRIP}</span><span class="n">${i + 1}</span><div class="t"><b>${t}</b>${theme ? `<span>${theme}</span>` : ''}</div><span class="src">${src}</span><span class="heard${heard ? '' : ' none'}">${heard || '&#8212;'}</span><span class="len">${len}</span><span class="ap238-ib">${PLAY}</span></div>`).join('');
const albumPage = (open = -1) => `${top(['Worlds', 'The Undersong', 'Productions', ALBUM], `<span class="ap238-btn">${PHONE}Preview</span>`)}<div class="ap238-prod"><div class="ap238-side"><div class="ap238-cover"><img src="${A}${COVER.album}" alt=""></div><div style="display:flex;align-items:center;gap:8px"><span class="ap238-btn">${SPARK}Make cover</span><span class="m">1:1 &#183; 1024 &#215; 1024</span></div><div style="margin-top:6px"><div class="ap238-eyebrow">ALBUM &#183; THE UNDERSONG</div><h1>${ALBUM}</h1><div class="m" style="margin-top:4px">9 tracks &#183; 34:26</div></div><div class="acts"><span class="ap238-btn pri">${PLAY}Play all</span><span class="ap238-btn">Export</span><span class="ap238-btn" style="width:32px;padding:0;justify-content:center">${MORE}</span></div></div><div><div class="ap238-group"><div class="ap238-gh">Tracks<span class="m">9 &#183; 34:26</span><span class="grow"></span><span class="ap238-btn" style="height:28px">${PLUS}Add track</span></div><div class="ap238-th" style="border-top:0"><span class="grip"></span><span class="n">#</span><span class="t">Title</span><span class="src">From</span><span class="heard">Heard in</span><span class="len">Length</span><span style="width:28px"></span></div>${trackRows(open)}<div class="ap238-addrow">${PLUS}Add track</div></div></div></div>`;

// The world's Guide (234a, 236a): Characters gains Theme.
const pills = `<div class="ap238-pills">${['Overview', 'Art direction', 'Cast', 'Bible', 'Canon', 'World Chat', 'Artifacts', 'Productions', 'Guide'].map((p) => `<span${p === 'Guide' ? ' class="on"' : ''}>${p}</span>`).join('')}</div>`;
const guideHead = `<div class="ap238-head"><div><h1>Guide</h1><div class="m">3 of 6 teasers &#183; 4 of 5 characters &#183; 2 themes &#183; 3 of 6 places &#183; 7 of 16 lore</div></div></div>`;
const theme = (name, cls = '') => name ? `<span class="ap238-theme${cls ? ' ' + cls : ''}">${NOTE}${name}</span>` : `<span class="ap238-theme none">${PLUS}Theme</span>`;
const CAST = [
  ['char-maren.png', 'Maren Kest', 'Tide-caller', 'Essence &#183; Appearance', 'From the start', 'Tide-caller'],
  ['char-bray.png', 'Bray Half-Hitch', 'Rigger', 'Essence &#183; Appearance', 'From the start', ''],
  ['char-chorister.png', 'The Chorister', 'Keeper of the drowned verse', 'Essence', 'After Chapter 9', 'The Drowned Verse', 'on'],
  ['char-odile.png', 'Odile', 'Lamp-keeper', 'Essence &#183; Voice', 'From the start', ''],
];
const PLACES = [
  ['scene4-shot13.png', 'The Vigil', 'Lighthouse', 'From the start', 'The Vigil'],
  ['launch-harbour.webp', 'The Saltmarket', 'Harbour market', 'From the start', 'Saltmouth Bells'],
  ['drowned-quarter.png', 'The Drowned Chapel', 'Ruin', 'After Chapter 6', ''],
];
const head = (cells) => `<div class="ap238-th" style="border-top:0">${cells.map(([label, flex]) => flex ? `<span class="src" style="flex:${flex}">${label}</span>` : `<span style="width:34px"></span>`).join('')}</div>`;
const who = (img, name, sub) => `<div class="who"><img class="ap238-face" src="${A}${img}" alt=""><div style="min-width:0"><b>${name}</b><span>${sub}</span></div></div>`;
const guidePage = (focus = false) => `${top(['Worlds', 'The Undersong'], `<span class="ap238-btn">${PHONE}Preview</span>`)}${pills}${guideHead}<div class="ap238-cols"><div><div class="ap238-group"><div class="ap238-gh">Characters<span class="grow"></span><span class="m">4 of 5</span></div>${head([['Character', 1.3], ['Sections', 1], ['Shows', 0.8], ['Theme', 1.1], ['']])}${CAST.map(([img, name, role, sections, shows, th, cls]) => `<div class="ap238-row">${who(img, name, role).replace('class="who"', 'class="who" style="flex:1.3"')}<span class="col ink" style="flex:1">${sections}</span><span class="col" style="flex:.8">${shows}</span><span class="col" style="flex:1.1;overflow:visible">${theme(th, focus ? cls : '')}</span><span class="ap238-sw on"></span></div>`).join('')}</div></div><div><div class="ap238-group"><div class="ap238-gh">Places<span class="grow"></span><span class="m">3 of 6</span></div>${head([['Place', 1.2], ['Theme', 1], ['']])}${PLACES.map(([img, name, kind, shows, th]) => `<div class="ap238-row">${who(img, name, `${kind} &#183; ${shows}`)}<span class="col" style="flex:1;overflow:visible">${theme(th)}</span><span class="ap238-sw on"></span></div>`).join('')}</div></div></div>`;

// The song cards a teaser can be (236b's one shape: 16:9, the square cover whole over its blur).
const song = ({ name, what, img = COVER.album, cls = '' }) => `<div class="ap238-tz${cls ? ' ' + cls : ''}"><div class="im"><img class="bl" src="${A}${img}" alt=""><img class="sq" src="${A}${img}" alt=""><span class="play">${PLAY}</span></div><b>${name}</b><span class="m">${what}</span></div>`;
const SONGS = [
  { name: 'The Drowned Verse', what: 'Track 1 &#183; 4:12 &#183; Chapter 9', cls: 'on' },
  { name: 'Slack Water', what: 'Track 2 &#183; 3:05' },
  { name: 'Saltmouth Bells', what: 'Single &#183; 3:42 &#183; Chapter 8', img: COVER.single },
  { name: 'Tide-caller', what: 'Track 4 &#183; 3:58' },
  { name: 'The Vigil', what: 'Track 5 &#183; 4:40' },
  { name: 'Lantern Road', what: 'Track 6 &#183; 3:20' },
  { name: 'The Bell Watch, main title', what: 'Soundtrack &#183; 1:48', img: COVER.score },
  { name: 'Undersong', what: 'Track 9 &#183; 5:01' },
];

// Kept music takes on the world's shelf (Bench), as Add a sound (230e) shows a take.
const TAKES = [
  ['The Drowned Verse', 'Track 1', 1, 'no'],
  ['Saltmouth Bells', 'Track 3', 2, 'no'],
  ['Bell rope chant', 'Bench &#183; 1:52 &#183; kept 23 Oct', 3, 'on'],
  ['Harbour reel', 'Bench &#183; 2:48 &#183; kept 22 Oct', 4, ''],
  ['A choir underwater', 'Bench &#183; 3:10 &#183; kept 24 Oct', 5, ''],
  ['Lantern Road', 'Track 6', 6, 'no'],
  ['Slack water, piano', 'Bench &#183; 2:21 &#183; kept 21 Oct', 7, ''],
];

const LYRICS = `<span class="sec">[verse]</span>
Under the harbour the old bells turn,
salt in the ledger, the lamps that burn.
Count me the tides that the city forgot,
sing me the name that the water has not.
<span class="sec">[chorus]</span>
Hold the verse, hold it low,
down where the drowned ones go.`;

export const FRAMES = [
  ['a', 'New production: Make music', 1360, 820, 'page', () => root(
    '238a The door gains a fourth card, LISTEN · Make music: albums, singles and soundtracks',
    1360, 820,
    `<div class="ap238-door"><div style="display:flex;flex-direction:column;align-items:center;gap:30px;width:1220px"><div style="text-align:center;display:flex;flex-direction:column;gap:8px"><span class="ap238-eyebrow">CREATE SOMETHING NEW</span><h1 style="margin:0;font-weight:var(--weight-semibold);font-size:var(--text-4xl);letter-spacing:var(--tracking-tighter)">What should this world become next?</h1></div><div class="ap238-doors">${[
      ['WRITE', 'Tell a story', 'Novel, novella, episodic fiction, audio drama or audiobook', 'Begin with words', 'banner-story.png'],
      ['WATCH', 'Make a film', 'Short film, series, animation or micro-drama', 'Begin with a screen', 'banner-video.png'],
      ['CHOOSE', 'Make it interactive', 'Branching movie, playable story or mixed experience', 'Begin with a choice', 'banner-game.png'],
      ['LISTEN', 'Make music', 'Album, single or soundtrack', 'Begin with a song', 'banner-audio.png', true],
    ].map(([e, t, b, a, img, on]) => `<div class="ap238-dcard${on ? ' on' : ''}"><div class="pl" style="background-image:url('${A}${img}')"></div><span class="ap238-eyebrow" style="margin-top:8px">${e}</span><b>${t}</b><small>${b}</small><small class="aff">${a}</small></div>`).join('')}</div></div></div>`,
  )],

  ['b', 'Step two: what kind of music', 1360, 760, 'panel', () => root(
    '238b Step two asks what kind of music: Album, Single or Soundtrack; a soundtrack names the production it is for',
    1360, 760,
    `<div class="ap238-door blur"><div class="bg" style="background-image:url('${KEY_ART}')"></div><div class="ap238-card"><h2>What kind of music? <small>step 2 of 2</small></h2><div class="ap238-kinds">${[
      ['Album', 'Tracks, in order.', COVER.album],
      ['Single', 'One song.', COVER.single],
      ['Soundtrack', 'For a production.', COVER.score, true],
    ].map(([t, b, img, on]) => `<div class="ap238-kind${on ? ' on' : ''}"><div class="pl" style="background-image:url('${A}${img}')"></div><label><i></i>${t}</label><small>${b}</small></div>`).join('')}</div><div class="ap238-fl"><span>Name</span><div class="ap238-field">The Bell Watch &#8212; Soundtrack</div></div><div class="ap238-fl"><span>For</span><div class="ap238-field"><img src="${A}char-sereth.png" alt="" style="object-position:50% 28%">The Bell Watch<small>Micro drama &#183; 45 episodes</small><span style="display:flex;margin-left:8px">${DOWN}</span></div></div><div style="display:flex;justify-content:flex-end;gap:10px;align-items:center"><span class="ap238-btn ghost">Back</span><span class="ap238-btn pri">Create production</span></div></div></div>`,
  )],

  ['c', 'An album: its cover and its tracks', 1360, 780, 'page', () => root(
    '238c A music production&#8217;s page: the square cover with Make cover, what it is, Play all and Export, and its tracks in order, each with where it came from, where it is heard and its length',
    1360, 780,
    albumPage(),
  )],

  ['d', 'Add track: a kept take, or a file', 1360, 780, 'panel', () => root(
    '238d Add track: the world&#8217;s kept music takes from Bench, each with play; those already on the album say which track; or Import a file',
    1360, 780,
    `${albumPage()}<div class="ap238-dim"></div><div class="ap238-dlg" style="width:880px"><header><h3>Add track</h3><small>${ALBUM} &#183; 9 tracks</small><span class="grow"></span><span class="ap238-ib">${X}</span></header><div class="bd"><div style="display:flex;align-items:center;gap:8px"><span class="ap238-chip on">Kept 7</span><span class="ap238-chip">Songs 5</span><span class="ap238-chip">Instrumental 2</span><span class="grow"></span><span class="ap238-search">${SEARCH}Search the world&#8217;s music</span></div><div class="ap238-tiles">${TAKES.map(([n, m, s, cls]) => `<div class="ap238-tile${cls ? ' ' + cls : ''}"><div class="art">${wv(s, 30)}${play}<span class="rad"></span></div><div class="nm"><b>${n}</b><small>${m}</small></div></div>`).join('')}<div class="ap238-tile dash">${UPLOAD}<b>Import a file</b><small>WAV &#183; MP3 &#183; M4A &#183; FLAC</small></div></div></div><footer><small>Bell rope chant &#183; 1:52</small><span class="grow"></span><span class="ap238-btn ghost">Cancel</span><span class="ap238-btn pri">Add track</span></footer></div>`,
  )],

  ['e', 'A track open', 1360, 780, 'panel', () => root(
    '238e A track open beside the album: its player, where it came from, its lyrics, where it is heard and whose theme it is',
    1360, 780,
    `${albumPage(0)}<div class="ap238-panel"><header><div style="flex:1;min-width:0"><div class="ap238-eyebrow">TRACK 1 &#183; ${ALBUM.toUpperCase()}</div><h3>The Drowned Verse</h3></div><span class="ap238-ib">${X}</span></header><div class="bd"><div class="ap238-player">${play}${wv(1, 64)}<span class="m" style="font:var(--type-mono);font-size:var(--text-2xs)">4:12</span></div><div class="ap238-kv"><span>From</span><span style="display:flex;align-items:center;gap:8px">Bench &#183; The Drowned Verse &#183; take 2<span class="ap238-btn" style="height:26px;margin-left:auto">${OUT}Open</span></span><span>Lyrics</span><div style="display:flex;flex-direction:column;gap:8px"><div class="ap238-lyrics">${LYRICS}</div><span style="display:flex;gap:8px"><span class="ap238-btn" style="height:28px">Draft with Arke</span></span></div><span>Heard in</span><div style="display:flex;flex-direction:column;gap:6px"><div class="ap238-link">The Ledger of Nights &#183; Chapter 9<span class="m">at 12:10</span>${RIGHT}</div></div><span>Theme of</span><span><span class="ap238-who"><img src="${A}char-chorister.png" alt="">The Chorister</span></span></div></div><footer><span class="ap238-btn">Replace</span><span class="grow"></span><span class="ap238-btn ghost">Remove from album</span></footer></div>`,
  )],

  ['f', 'The Guide: a character&#8217;s theme', 1360, 800, 'panel', () => root(
    '238f The Guide&#8217;s Characters and Places gain Theme: one track each is known by, chosen from the world&#8217;s music',
    1360, 800,
    `${guidePage(true)}<div class="ap238-menu" style="left:556px;top:436px"><div class="h">Theme &#183; The Chorister</div><div class="sec"><img src="${A}${COVER.album}" alt="">${ALBUM}</div>${[
      ['The Drowned Verse', '4:12', true],
      ['Slack Water', '3:05'],
      ['Tide-caller', '3:58 &#183; Maren Kest'],
      ['The Vigil', '4:40'],
    ].map(([t, m, on]) => `<div class="it${on ? ' on' : ''}"><span class="ck">${on ? CHECK : ''}</span>${t}<span class="m">${m}</span></div>`).join('')}<div class="sec"><img src="${A}${COVER.single}" alt="">Saltmouth Bells</div><div class="it"><span class="ck"></span>Saltmouth Bells<span class="m">3:42</span></div><hr><div class="it"><span class="ck"></span>None</div></div>`,
  )],

  ['g', 'Adding a teaser: a song', 1360, 780, 'panel', () => root(
    '238g Add teaser gains Songs: a track&#8217;s card in the teaser card&#8217;s one shape, and the excerpt it shows, at most 30 seconds from a start the author sets',
    1360, 780,
    `${guidePage()}<div class="ap238-dim"></div><div class="ap238-pick"><h3>Add teaser &#183; The Undersong</h3><div class="sub">3 of 6</div><div class="ap238-tabs"><span>Characters</span><span>Places</span><span>Pictures</span><span>Clips</span><span class="on">Songs</span></div><div class="ap238-grid">${SONGS.map(song).join('')}</div><div class="ap238-excerpt"><b>Excerpt</b>${play}<div class="track">${wv(2, 84, 0.43, 0.525)}<span class="win" style="left:43%;width:9.5%"></span></div><span class="f"><span>Start</span>1:48</span><span class="f"><span>Length</span>0:24</span></div><div class="ap238-foot"><span class="m">The Drowned Verse &#183; 1:48&#8211;2:12</span><span class="grow"></span><span class="ap238-btn">Cancel</span><span class="ap238-btn pri">Add</span></div></div>`,
  )],

  ['h', 'Export &#8594; Arke Player: an album', 1360, 560, 'sheet', () => root(
    '238h Export &#8594; Arke Player for a music production: its tracks as AAC, the square cover, lyrics and Heard in, priced as a package',
    1360, 560,
    `${PAGE}<div class="ap238-dim"></div><div class="ap238-sheet" style="top:40px;width:720px"><h3>Export &#183; ${ALBUM}</h3><div class="sub">Album &#183; 9 tracks &#183; 34:26</div><div class="ap238-opts">${[
      ['World', `<img src="${KEY_ART}" alt=""><span>The Undersong</span>`, 'key art &#183; logline &#183; guide'],
      ['Tracks', '<span>9 &#183; 34:26</span>', 'AAC &#183; 256 kbps'],
      ['Cover', `<img class="sq" src="${A}${COVER.album}" alt=""><span>1:1</span>`, '1024 &#215; 1024'],
      ['Lyrics', '<span>4 of 9 tracks</span>', ''],
      ['Heard in', '<span>2 tracks</span>', 'The Ledger of Nights'],
    ].map(([label, middle, tail]) => `<div class="ap238-opt"><b>${label}</b>${middle}<span class="grow"></span>${tail ? `<i>${tail}</i>` : ''}</div>`).join('')}</div><div class="ap238-est"><b style="font-weight:600">~66 MB &#183; ~30 s on this machine</b><span class="m">9 tracks &#183; 1 cover</span></div><div class="ap238-foot"><span class="grow"></span><span class="ap238-btn">Cancel</span><span class="ap238-btn pri">Make package</span></div></div>`,
  )],
];
