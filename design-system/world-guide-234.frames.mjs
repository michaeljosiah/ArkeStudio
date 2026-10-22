// Turn 234 · A world's Guide: the frames. The sample is The Undersong as the fixture world holds it:
// its cast, places and canon, with The Ledger of Nights as the production a chapter is counted in.
// Every frame's root is .ap234 with its data-screen-label.
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const EYEOFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>';
const DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
const PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/></svg>';
const BACK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';

const A = 'assets/';
const AFTER = (n) => `<span class="ap234-tag">${EYEOFF}After Chapter ${n}</span>`;
const sw = (on) => `<span class="ap234-sw${on ? ' on' : ''}"></span>`;
const box = (on) => `<span class="ap234-box${on ? ' on' : ''}">${on ? CHECK : ''}</span>`;
const face = (c) => (c.img ? `<img class="ap234-face" src="${A}${c.img}" alt="">` : `<span class="ap234-ini">${c.ini}</span>`);

const CAST = [
  { img: 'char-maren.png', name: 'Maren Kest', role: 'Tide-caller', sections: 'Essence · Appearance', voice: 'Voice 0:08', shows: 'From the start', on: true },
  { img: 'char-bray.png', name: 'Bray Half-Hitch', role: 'Rigger', sections: 'Essence · Appearance', voice: 'Voice 0:06', shows: 'From the start', on: true },
  { img: 'char-chorister.png', name: 'The Chorister', role: 'Keeper of the drowned verse', sections: 'Essence', voice: '—', shows: AFTER(9), on: true },
  { ini: 'PT', name: 'Perrin Tallow', role: 'Council actuary', sections: 'Essence', voice: '—', shows: 'From the start', on: true },
  { ini: 'IH', name: 'Ines Half-Hitch', role: 'Council clerk, retired', sections: '—', voice: '—', shows: '—', on: false },
];
const PLACES = [
  { img: 'scene4-shot13.png', name: 'The Vigil', role: 'Harbour mouth', sections: 'Look · Sound', shows: 'From the start', on: true },
  { img: 'launch-harbour.webp', name: 'The Saltmarket', role: 'Market', sections: 'Look · Sound · Customs', shows: 'From the start', on: true },
  { img: 'drowned-quarter.png', name: 'The Drowned Chapel', role: 'Chapel', sections: 'Look', shows: AFTER(6), on: true },
  { ini: 'QW', name: 'The Quiet Ward', role: 'Ward', sections: '—', shows: '—', on: false },
];
// Settled canon can be public; an open thread is the author's question and cannot.
const LORE = [
  ['CANON-001', 'The Undersong', 'Lore', 'From the start', true],
  ['CANON-002', 'Tide-calling', 'Rule', 'From the start', true],
  ['CANON-031', 'The drowning of the god', 'Timeline', AFTER(6), true],
  ['CANON-045', 'The ledger is never wrong', 'Rule', 'From the start', true],
  ['CANON-053', 'The Departure', 'Lore', 'From the start', true],
  ['CANON-057', 'The Seven Anchors', 'Rule', 'From the start', true],
  ['CANON-052', 'What was left to hold the harbour', 'Lore', AFTER(11), true],
  ['CANON-049', 'What the tithe actually buys is notice', 'Rule', '—', false],
  ['CANON-044', 'Who taught the Chorister?', 'Thread · open', '', null],
  ['CANON-048', 'Why the Quiet Ward is mostly one family', 'Thread · open', '', null],
];

const top = `<div class="ap234-top"><span class="crumb">Worlds</span><span class="crumb">/</span><b>The Undersong</b><span class="grow"></span><span class="ap234-btn">${PHONE}Preview</span></div>`;
const pills = `<div class="ap234-pills">${['Overview', 'Art direction', 'Cast', 'Bible', 'Canon', 'World Chat', 'Artifacts', 'Productions', 'Guide'].map((p) => `<span${p === 'Guide' ? ' class="on"' : ''}>${p}</span>`).join('')}</div>`;
const head = `<div class="ap234-head"><div><h1>Guide</h1><div class="m">4 of 5 characters · 3 of 6 places · 7 of 16 lore · 4 after a chapter</div></div></div>`;
const castRows = CAST.map((c) => `<div class="ap234-row${c.on ? '' : ' off'}"><div class="who">${face(c)}<div style="min-width:0"><b>${c.name}</b><span>${c.role}</span></div></div><span class="col ink">${c.sections}</span><span class="col" style="flex:.55">${c.voice}</span><span class="col" style="flex:.9">${c.shows}</span>${sw(c.on)}</div>`).join('');
const placeRows = PLACES.map((p) => `<div class="ap234-row${p.on ? '' : ' off'}"><div class="who">${face(p)}<div style="min-width:0"><b>${p.name}</b><span>${p.role}</span></div></div><span class="col ink">${p.sections}</span><span class="col" style="flex:.9">${p.shows}</span>${sw(p.on)}</div>`).join('');
const loreRows = LORE.map(([id, title, kind, shows, on]) => `<div class="ap234-row${on === null ? ' shut' : on ? '' : ' off'}"><span class="ap234-id">${id}</span><div class="who" style="flex:1.6"><div style="min-width:0"><b>${title}</b><span>${kind}</span></div></div><span class="col" style="flex:.9">${shows}</span>${on === null ? '<span style="width:34px"></span>' : sw(on)}</div>`).join('');
const guidePage = `${top}${pills}${head}<div class="ap234-cols"><div><div class="ap234-group"><div class="ap234-gh">Characters<span class="grow"></span><span class="m">4 of 5</span></div>${castRows}</div><div class="ap234-group"><div class="ap234-gh">Places<span class="grow"></span><span class="m">3 of 6</span></div>${placeRows}</div></div><div><div class="ap234-group"><div class="ap234-gh">Lore<span class="grow"></span><span class="m">7 of 16</span></div>${loreRows}</div></div></div>`;

const root = (label, width, height, inner) => `<div class="ap234" data-screen-label="${label}" style="width:${width}px;height:${height}px">${inner}</div>`;

const section = (on, heading, text, shows = '') => `<div class="ap234-sec${on ? '' : ' off'}"><div class="h">${box(on)}<span>${heading}</span><span class="grow"></span>${shows}</div><p>${text}</p></div>`;
const entryPanel = `<div class="ap234-dim"></div><div class="ap234-panel"><div class="ap234-pane">
<div style="display:flex;align-items:center;gap:12px"><img class="ap234-face" src="${A}char-maren.png" alt="" style="width:44px;height:44px;border-radius:10px"><div style="flex:1;min-width:0"><div class="eb">Character · Guide</div><div class="ttl">Maren Kest</div></div><span style="font:var(--type-ui)">Public</span>${sw(true)}</div>
<div class="ap234-line"><b>Shows</b><span class="ap234-seg"><span class="on">From the start</span><span>After a chapter</span></span></div>
<div class="ap234-line" style="align-items:flex-start"><b style="padding-top:6px">Sections</b><div class="grow" style="display:flex;flex-direction:column;gap:8px">
${section(true, 'Essence', 'Tide-caller. She hears the verse under the harbour and pulls the water where it needs to go. She has paid for it: her left ear is done, and she knows the right is next.')}
${section(true, 'Appearance', 'Salt-crusted braids, pale grey eyes, oilskin coat with a bioluminescent thread at the collar.')}
${section(true, 'Relationships', 'Trusts Bray with her life, not her secrets. The Chorister knows her true note, and Maren does not know how.', `<span class="ap234-field">${EYEOFF}After Chapter 6 ${DOWN}</span>`)}
${section(false, 'Voice · written', 'Low and even. Speaks to the water before she speaks to people. Never wastes a word she could keep.')}
</div></div>
<div class="ap234-line"><b>Voice</b><div class="ap234-voice grow"><span class="play">${PLAY}</span><div class="grow"><div>“I hear it. I always hear it.”</div><div class="m">The Ledger of Nights · Chapter 2 · 0:08</div></div><span class="ap234-btn">Change</span></div></div>
<div class="ap234-foot"><span class="grow"></span><span class="ap234-btn">Close</span></div>
</div><div class="ap234-prev"><div class="eb" style="font:var(--type-label);font-size:var(--text-2xs);letter-spacing:var(--tracking-label);text-transform:uppercase;color:var(--muted-foreground)">Arke Player</div><div class="ap234-phone"><div class="hero"><img src="${A}char-maren.png" alt="" style="object-position:50% 18%"><div class="fd"></div><div class="in"><b>Maren Kest</b><span>Tide-caller · The Undersong</span></div></div><div class="tx"><div class="eb">Essence</div><p>Tide-caller. She hears the verse under the harbour and pulls the water where it needs to go.</p><div class="eb">Appearance</div><p>Salt-crusted braids, pale grey eyes, oilskin coat with a bioluminescent thread at the collar.</p><div class="gate">${EYEOFF}After Chapter 6</div></div></div></div></div>`;

const PAGE = '<div class="ap234-page">' + [28, 92, 88, 95, 60, 90, 84, 93, 70, 89, 91, 55, 80, 66].map((w) => `<i style="width:${w}%"></i>`).join('') + '</div>';
const opt = (label, middle, tail = '', cls = '') => `<div class="ap234-opt${cls ? ' ' + cls : ''}"><b>${label}</b>${middle}<span class="grow"></span>${tail ? `<i>${tail}</i>` : ''}</div>`;
const kinds = `<div class="ap234-kinds">${[
  ['Audiobook player', 'player.html &#183; web package'],
  ['Chapter files', 'Retail &#183; no pictures'],
  ['Video', 'MP4 &#183; pictures &#183; captions'],
  ['Arke Player', 'phone &#183; pictures &#183; the book', true],
].map(([name, line, on]) => `<div class="ap234-kind${on ? ' on' : ''}"><span class="r"></span><div><b>${name}</b><span>${line}</span></div></div>`).join('')}</div>`;

const phoneRows = (list) => list.map((c) => `<div class="ap234-row${c.on ? '' : ' off'}"><div class="who">${face(c)}<div style="min-width:0"><b>${c.name}</b><span>${typeof c.shows === 'string' && c.shows !== '—' ? c.shows : c.on ? c.role : 'Not public'}</span></div></div>${typeof c.shows === 'string' ? '' : c.shows}${sw(c.on)}</div>`).join('');

export const FRAMES = [
  ['a', 'A world’s Guide', 1360, 850, 'page', () => root(
    '234a A world’s Guide: its characters, places and settled lore, each public or not, from the start or after a chapter, with what each shows',
    1360, 850, guidePage,
  )],

  ['b', 'A character’s entry, with the Player’s page beside it', 1360, 850, 'panel', () => root(
    '234b An entry: Public, when it shows, its sections each on or off and each from the start or after a chapter, a line in their voice, and the Player’s page as it will look',
    1360, 850, `${guidePage}${entryPanel}`,
  )],

  ['c', 'Export → Arke Player carries the guide', 1360, 850, 'sheet', () => root(
    '234c The Export sheet’s Arke Player rows gain Guide: what is public, counted, with Edit',
    1360, 850,
    `${PAGE}<div class="ap234-dim"></div><div class="ap234-sheet" style="top:30px;width:720px"><h3>Export audiobook &#183; The Ledger of Nights</h3><div class="sub">12 of 16 chapters read &#183; 3:49:26</div>${kinds}<div class="ap234-opts">${[
      opt('World', `<img src="${A}world-undersong.png" alt=""><span>The Undersong</span>`, 'key art &#183; logline'),
      opt('Guide', '<span>4 characters &#183; 3 places &#183; 7 lore</span>', '4 after a chapter', 'new').replace('</i></div>', '</i><span class="ap234-btn" style="height:28px">Edit</span></div>'),
      opt('Book', `<span style="display:inline-flex;align-items:center;gap:7px">${box(true)}The book</span>`, '16 chapters &#183; EPUB'),
      opt('Narration', '<span>12 of 16 &#183; read whole</span>', 'Chapters 1&#8211;12'),
      opt('Pictures', '<span>131 &#183; fitted for a phone</span>', '2048 px &#183; cover before the first'),
      opt('Text', '<span>Phrases, timed</span>', 'words timed in 9 of 12'),
      opt('Motion', `<span style="display:inline-flex;align-items:center;gap:7px">${box(true)}Loops</span>`, '3 &#183; each with its still'),
      opt('Edition', '<span>21 Oct 2026</span>'),
    ].join('')}</div><div class="ap234-est"><b style="font-weight:600">~231 MB &#183; ~3 min on this machine</b><span class="m">12 chapters &#183; 131 pictures &#183; the book &#183; the guide</span></div><div style="display:flex;align-items:center;gap:8px"><span style="flex:1"></span><span class="ap234-btn">Cancel</span><span class="ap234-btn pri">Make package</span></div></div>`,
  )],

  ['d', 'The Guide from a phone', 900, 920, 'phone', () => root(
    '234d On a phone: the Guide in one column, each row its switch, an entry opening as its own page',
    900, 920,
    `<div style="display:flex;gap:40px;justify-content:center;padding:38px 0;background:var(--secondary);height:100%;box-sizing:border-box"><div class="ap234-ph"><div class="bar">${BACK}<span class="grow">The Undersong</span></div><div class="ttl"><h1>Guide</h1><div class="m">4 of 5 characters &#183; 3 of 6 places &#183; 7 of 16 lore</div></div><div class="gl">Characters</div>${phoneRows(CAST)}<div class="gl">Places</div>${phoneRows(PLACES.slice(0, 3))}</div>
<div class="ap234-ph"><div class="bar">${BACK}<span class="grow">Maren Kest</span>${sw(true)}</div><div style="padding:14px 16px;display:flex;flex-direction:column;gap:12px"><div class="ap234-seg" style="align-self:flex-start"><span class="on">From the start</span><span>After a chapter</span></div>${section(true, 'Essence', 'Tide-caller. She hears the verse under the harbour and pulls the water where it needs to go.')}${section(true, 'Appearance', 'Salt-crusted braids, pale grey eyes, oilskin coat with a bioluminescent thread at the collar.')}${section(true, 'Relationships', 'Trusts Bray with her life, not her secrets.', `<span class="ap234-field">${EYEOFF}Ch 6 ${DOWN}</span>`)}${section(false, 'Voice · written', 'Low and even. Speaks to the water before she speaks to people.')}<div class="ap234-voice"><span class="play">${PLAY}</span><div class="grow"><div>“I hear it. I always hear it.”</div><div class="m">Chapter 2 &#183; 0:08</div></div><span class="ap234-btn">Change</span></div></div></div></div>`,
  )],
];
