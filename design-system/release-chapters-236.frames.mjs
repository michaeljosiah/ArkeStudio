// Turn 236 · Releasing chapters, and a world's teasers: the frames. The sample is The Undersong's
// The Ledger of Nights, its 23 chapters published on 22 October 2026 as the world's edition, and
// Chapter 24 released on its own a week later; the later dates, sizes and the schedule are samples.
// The teasers are the world's own pictures (234's guide). Every frame's root is .ap236 with its
// data-screen-label.
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const EYEOFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>';
const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';
const PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/></svg>';
const CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>';
const DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';

const A = 'assets/';
const KEY_ART = 'assets/world-undersong.png';
const SHA = '4d17b9a0c2e85f3361d0a7e4b98c25f61e3a07d9c4b82e15f60a9d3c7e1b48f2';
const PART = 'the-undersong-part-2026-10-30.zip';
const PAGE = '<div class="ap236-page">' + [28, 92, 88, 95, 60, 90, 84, 93, 70, 89, 91, 55, 80, 66].map((w) => `<i style="width:${w}%"></i>`).join('') + '</div>';
const box = (on = true) => `<span class="ap236-box${on ? ' on' : ''}">${on ? CHECK : ''}</span>`;
const sw = (on) => `<span class="ap236-sw${on ? ' on' : ''}"></span>`;
const after = (n) => `<span class="ap236-tag">${EYEOFF}After Chapter ${n}</span>`;
const root = (label, width, height, inner) => `<div class="ap236" data-screen-label="${label}" style="width:${width}px;height:${height}px">${inner}</div>`;
const opt = (label, middle, tail = '') => `<div class="ap236-opt"><b>${label}</b>${middle}<span class="grow"></span>${tail ? `<i>${tail}</i>` : ''}</div>`;

// A teaser card, one shape whatever it holds (a character too, so a row of teasers lines up): its
// picture, its place in the order, its name and what it is.
const tz = ({ img, pos = 'center', name, what, n, clip = false, cls = '' }) => `<div class="ap236-tz${cls ? ' ' + cls : ''}"><div class="im"><img src="${A}${img}" alt="" style="object-position:${pos}">${clip ? `<span class="play">${PLAY}</span>` : ''}${n ? `<span class="n">${n}</span>` : ''}</div><b>${name}</b><span class="m">${what}</span></div>`;
const add = (w = 168) => `<div class="ap236-tz add" style="width:${w}px"><div class="im">${PLUS}Add</div></div>`;
const TEASERS = [
  { img: 'char-maren.png', pos: '50% 18%', name: 'Maren Kest', what: 'Character' },
  { img: 'scene4-shot14b.png', name: 'Saltmouth bells', what: 'Clip &#183; 0:24 &#183; Chapter 1', clip: true },
  { img: 'scene4-shot13.png', pos: '70% 30%', name: 'The Vigil', what: 'Place' },
];

const top = `<div class="ap236-top"><span class="crumb">Worlds</span><span class="crumb">/</span><b>The Undersong</b><span class="grow"></span><span class="ap236-btn">${PHONE}Preview</span></div>`;
const pills = `<div class="ap236-pills">${['Overview', 'Art direction', 'Cast', 'Bible', 'Canon', 'World Chat', 'Artifacts', 'Productions', 'Guide'].map((p) => `<span${p === 'Guide' ? ' class="on"' : ''}>${p}</span>`).join('')}</div>`;
const head = `<div class="ap236-head"><div><h1>Guide</h1><div class="m">3 of 6 teasers &#183; 4 of 5 characters &#183; 3 of 6 places &#183; 7 of 16 lore &#183; 4 after a chapter</div></div></div>`;
const teaserGroup = `<div style="padding:18px 40px 0"><div class="ap236-group"><div class="ap236-gh">Teasers<span class="grow"></span><span class="m">3 of 6</span></div><div class="ap236-teasers">${TEASERS.map((t, i) => tz({ ...t, n: i + 1 })).join('')}${add()}${add()}${add()}</div></div></div>`;
const CAST = [
  ['char-maren.png', 'Maren Kest', 'Tide-caller', 'Essence &#183; Appearance', 'From the start', true],
  ['char-bray.png', 'Bray Half-Hitch', 'Rigger', 'Essence &#183; Appearance', 'From the start', true],
  ['char-chorister.png', 'The Chorister', 'Keeper of the drowned verse', 'Essence', after(9), true],
];
const castRows = CAST.map(([img, name, role, sections, shows, on]) => `<div class="ap236-row"><div class="who"><img class="ap236-face" src="${A}${img}" alt=""><div style="min-width:0"><b>${name}</b><span>${role}</span></div></div><span class="col ink">${sections}</span><span class="col" style="flex:.9">${shows}</span>${sw(on)}</div>`).join('');
const loreRows = [['CANON-001', 'The Undersong', 'Lore'], ['CANON-002', 'Tide-calling', 'Rule'], ['CANON-031', 'The drowning of the god', 'Timeline', after(6)]].map(([id, title, kind, shows]) => `<div class="ap236-row"><span class="col" style="flex:none;width:76px">${id}</span><div class="who" style="flex:1.6"><div style="min-width:0"><b>${title}</b><span>${kind}</span></div></div><span class="col" style="flex:.9">${shows ?? 'From the start'}</span>${sw(true)}</div>`).join('');
const guidePage = `${top}${pills}${head}${teaserGroup}<div class="ap236-cols"><div><div class="ap236-group"><div class="ap236-gh">Characters<span class="grow"></span><span class="m">4 of 5</span></div>${castRows}</div></div><div><div class="ap236-group"><div class="ap236-gh">Lore<span class="grow"></span><span class="m">7 of 16</span></div>${loreRows}</div></div></div>`;

// The clips a teaser can be: a moment of a chapter read whole, its picture and its narration.
const CLIPS = [
  { img: 'scene4-shot14b.png', name: 'Saltmouth bells', what: 'Teaser 2', clip: true, cls: 'no' },
  { img: 'scene4-shot12.png', name: 'The weir at low water', what: 'Chapter 2 &#183; 0:30', clip: true, cls: 'on' },
  { img: 'launch-harbour.webp', pos: '50% 62%', name: 'Market day', what: 'Chapter 3 &#183; 0:19', clip: true },
  { img: 'scene4-shot15.png', name: 'The tenth key', what: 'Chapter 7 &#183; 0:27', clip: true },
  { img: 'drowned-quarter.png', name: 'The drowned chapel', what: 'Chapter 9 &#183; 0:30', clip: true },
  { img: 'scene4-shot13.png', pos: '70% 30%', name: 'The Vigil at night', what: 'Chapter 11 &#183; 0:22', clip: true },
  { img: 'scene4-shot14.png', name: 'A choir underwater', what: 'Chapter 12 &#183; 0:30', clip: true },
  { img: 'banner-story.png', pos: '50% 40%', name: 'Odile&#8217;s lamp', what: 'Chapter 14 &#183; 0:16', clip: true },
];

const releaseRows = () => [
  opt('World', `<img src="${KEY_ART}" alt=""><span>The Undersong</span>`, 'key art &#183; logline &#183; guide'),
  opt('Release', '<span class="ap236-seg"><span>Whole world</span><span class="on">New chapters</span></span>', 'since 22 Oct 2026 &#183; Chapter 23'),
  `<div class="ap236-opt" style="align-items:flex-start;padding-top:10px;padding-bottom:10px"><b>Chapters</b><div class="ap236-chs"><div class="ap236-ch">${box()}<span class="t">24 &#183; The Bell Ropes</span><i>read whole &#183; 14 min &#183; 13 pictures</i></div><div class="ap236-ch no">${box(false)}<span class="t">25 &#183; Low Water</span><i>read 6 of 31 blocks</i></div></div></div>`,
  opt('Pictures', '<span>13 &#183; 13 wide &#183; 13 tall</span>', '1280 px'),
  opt('Schedule', `<span class="ap236-field">Fridays${DOWN}</span><span class="ap236-field">Next 6 Nov 2026${CAL}</span>`, ''),
];

export const FRAMES = [
  ['a', 'A world&#8217;s Guide with its teasers', 1360, 720, 'page', () => root(
    '236a The world&#8217;s Guide gains Teasers: up to six in the author&#8217;s order, a character, a clip and a place chosen, three places to add',
    1360, 720,
    guidePage,
  )],

  ['b', 'Adding a teaser: a clip', 1360, 720, 'panel', () => root(
    '236b Add teaser over the Guide: Characters, Places, Pictures and Clips; a clip is a moment of a chapter read whole, its picture and narration, at most 30 seconds',
    1360, 720,
    `${guidePage}<div class="ap236-dim"></div><div class="ap236-pick"><h3>Add teaser &#183; The Undersong</h3><div class="sub">3 of 6</div><div class="ap236-tabs"><span>Characters</span><span>Places</span><span>Pictures</span><span class="on">Clips</span></div><div class="ap236-grid">${CLIPS.map(tz).join('')}</div><div class="ap236-foot"><span class="grow"></span><span class="ap236-btn">Cancel</span><span class="ap236-btn pri">Add</span></div></div>`,
  )],

  ['c', 'A character that waits for a chapter cannot be a teaser', 1360, 720, 'panel', () => root(
    '236c Add teaser, Characters: one not public and one after a chapter are dimmed, each said in one clause',
    1360, 720,
    `${guidePage}<div class="ap236-dim"></div><div class="ap236-pick"><h3>Add teaser &#183; The Undersong</h3><div class="sub">3 of 6</div><div class="ap236-tabs"><span class="on">Characters</span><span>Places</span><span>Pictures</span><span>Clips</span></div><div class="ap236-grid">${[
      { img: 'char-maren.png', pos: '50% 18%', name: 'Maren Kest', what: 'Teaser 1', cls: 'no' },
      { img: 'char-bray.png', pos: '50% 20%', name: 'Bray Half-Hitch', what: 'Rigger', cls: 'on' },
      { img: 'char-chorister.png', pos: '50% 20%', name: 'The Chorister', what: 'After Chapter 9', cls: 'no' },
      { img: 'char-odile.png', pos: '50% 18%', name: 'Odile', what: 'Not public', cls: 'no' },
    ].map(tz).join('')}</div><div class="ap236-foot"><span class="grow"></span><span class="ap236-btn">Cancel</span><span class="ap236-btn pri">Add</span></div></div>`,
  )],

  ['d', 'Export &#8594; Arke Player: releasing new chapters', 1360, 560, 'sheet', () => root(
    '236d The Export sheet with Arke Player and Release, New chapters: the chapters read whole since the last release, its pictures, the author&#8217;s schedule, priced as a part',
    1360, 560,
    `${PAGE}<div class="ap236-dim"></div><div class="ap236-sheet" style="top:36px;width:720px"><h3>Export audiobook &#183; The Ledger of Nights</h3><div class="sub">24 of 25 chapters read &#183; 5:47:12</div><div class="ap236-opts">${releaseRows().join('')}</div><div class="ap236-est"><b style="font-weight:600">~24 MB &#183; ~20 s on this machine</b><span class="m">1 chapter &#183; 26 pictures</span></div><div class="ap236-foot"><span class="grow"></span><span class="ap236-btn">Cancel</span><span class="ap236-btn pri">Make part</span></div></div>`,
  )],

  ['e', 'The part made, beside the releases before it', 1360, 440, 'sheet', () => root(
    '236e Made: the part with its size and SHA-256, and the world&#8217;s releases in order, the edition and each part after it',
    1360, 440,
    `${PAGE}<div class="ap236-dim"></div><div class="ap236-sheet" style="top:40px;width:720px"><h3>Export audiobook &#183; The Ledger of Nights</h3><div class="sub">arke player &#183; part &#183; made 2026-10-30 09:12</div><div class="ap236-est"><b style="font-weight:600">1 part &#183; 24 MB</b><span class="m">exports/${PART}</span><span class="grow"></span><span class="ap236-btn">${FOLDER}Show in folder</span></div><div class="ap236-sha"><b style="font-weight:500">SHA-256</b><code>${SHA}</code><span class="ap236-btn">Copy</span></div><div class="ap236-opts">${[
      ['22 Oct 2026', 'Edition', 'Chapters 1&#8211;23 &#183; 290 pictures &#183; the book', '360 MB'],
      ['30 Oct 2026', 'Part', 'Chapter 24 &#183; 26 pictures', '24 MB', true],
    ].map(([d, k, what, size, now]) => `<div class="ap236-rel${now ? ' now' : ''}"><span class="d">${d}</span><span class="k">${k}</span><span>${what}</span><span class="grow"></span><span class="m">${size}</span></div>`).join('')}</div><div class="ap236-foot" style="margin-top:4px"><span class="grow"></span><span class="ap236-btn">Make again</span><span class="ap236-btn pri">Done</span></div></div>`,
  )],
];
