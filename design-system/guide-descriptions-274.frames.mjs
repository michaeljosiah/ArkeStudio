// Turn 274 · A description for readers, the rest after the story: the frames. The sample is Na Love or
// Juju as its Guide holds it on 8 November 2026: fourteen characters and three places public, six
// teasers, no voice line and no settled lore. Ife's and Ade's descriptions are drafts for the owner to
// change; every heading, role and section is the world's own. The page and its rows are turn 234's,
// its teasers turn 236's, so the classes of both are used under the turn's own root, .ap274.
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const EYEOFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>';
const DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
const PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/></svg>';
const SPARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.94 14.06 4 20"/><path d="M14 4l1.5 3.5L19 9l-3.5 1.5L14 14l-1.5-3.5L9 9l3.5-1.5z"/></svg>';

const A = 'assets/';
const WORLD = 'Na Love or Juju';
const sw = (on) => `<span class="ap234-sw${on ? ' on' : ''}"></span>`;
const box = (on) => `<span class="ap234-box${on ? ' on' : ''}">${on ? CHECK : ''}</span>`;
const face = (c) => (c.img ? `<img class="ap234-face" src="${A}${c.img}" alt="" style="object-position:50% 20%">` : `<span class="ap234-ini">${c.ini}</span>`);
const AFTER = (name) => `<span class="ap234-tag">${EYEOFF}After ${name}</span>`;
const DRAFTED = '<span class="ap274-mark">Drafted</span>';
const NONE = '<span class="ap274-none">No description</span>';

export const ABOUT = {
  ife: 'Late twenties, and in no hurry about anything. Ife never asks a man for a thing, and men give her everything anyway: the flat, the car, the gold at her ear and wrist. Ade Akinola sees her across a club on Victoria Island and is sure he is the one doing the choosing.',
  ade: 'Forty-three, self-made, and careful about everything. Ade pays before anyone reaches for a wallet, keeps the generator serviced, and has never needed to raise his voice. The life is built and the accounts are clean. There is one empty place at his table, and he keeps it ready.',
  house: 'High walls, two floors and a great deal of window, in Ikoyi. Everything in Ade’s house was earned, and everything in it works, down to the generator that never stutters.',
};

// The order is the Guide's; when a character shows is their own, as the world's Guide has it.
const CAST = [
  { img: 'juju-ife.jpg', name: 'Ife', role: 'Kept woman, keeper of men', about: ABOUT.ife, n: 2, shows: 'From the start' },
  { img: 'juju-ade.jpg', name: 'Adeyemi “Ade” Akinola', role: 'Self-made Lagos man', about: ABOUT.ade, drafted: true, n: 2, shows: 'From the start' },
  { img: 'juju-tunde.jpg', name: 'Tunde', role: 'The friend who was right', n: 2, shows: 'From the start' },
  { img: 'juju-musa.jpg', name: 'Musa', role: 'Ade’s gateman', n: 2, shows: 'From the start' },
  { img: 'juju-nkechi.jpg', name: 'Nkechi Obi', role: 'Ade’s operations manager', n: 2, shows: AFTER('Chapter 2') },
  { img: 'juju-abosede.jpg', name: 'Mrs. Abosede Akinola', role: 'Ade’s mother', n: 2, shows: AFTER('Chapter 3') },
  { img: 'juju-kemi.jpg', name: 'Kemi', role: 'Ife’s friend, insurance', n: 2, shows: AFTER('Chapter 4') },
  { img: 'juju-zee.jpg', name: 'Zee', role: 'Ife’s friend from the club', n: 2, shows: AFTER('Chapter 4') },
];
const PLACES = [
  { img: 'juju-ade-house.jpg', name: 'Ade’s House, Ikoyi', role: 'Place', about: ABOUT.house, drafted: true, n: 2, shows: 'From the start' },
  { ini: 'IF', name: 'Ife’s Flat', role: 'Place', n: 2, shows: AFTER('Chapter 2') },
  { ini: 'SB', name: 'The Sister’s Bungalow, Ibadan', role: 'Place', n: 2, shows: AFTER('Chapter 12') },
];
const TEASERS = [
  { img: 'juju-m-look.jpg', pos: '50% 40%', name: 'Gold on Gold', what: 'Clip &#183; Chapter 1', clip: true },
  { img: 'juju-ife.jpg', pos: '50% 20%', name: 'Ife', what: 'Character' },
  { img: 'juju-m-car.jpg', pos: '50% 40%', name: 'Suya at Midnight', what: 'Clip &#183; Chapter 2', clip: true },
  { img: 'juju-m-hand.jpg', pos: '50% 50%', name: 'The napkin', what: 'Clip &#183; Chapter 1', clip: true },
  { img: 'juju-w-table.jpg', pos: '50% 50%', name: 'Ofada for Two', what: 'Picture &#183; Chapter 3' },
  { img: 'juju-ade.jpg', pos: '50% 20%', name: 'Adeyemi “Ade” Akinola', what: 'Character' },
];
const tz = ({ img, pos = 'center', name, what, n, clip = false }) => `<div class="ap236-tz"><div class="im"><img src="${A}${img}" alt="" style="object-position:${pos}">${clip ? `<span class="play">${PLAY}</span>` : ''}${n ? `<span class="n">${n}</span>` : ''}</div><b>${name}</b><span class="m">${what}</span></div>`;

const top = `<div class="ap234-top"><span class="crumb">Worlds</span><span class="crumb">/</span><b>${WORLD}</b><span class="grow"></span><span class="ap234-btn">${PHONE}Preview</span></div>`;
const pills = `<div class="ap234-pills">${['Overview', 'Art direction', 'Cast', 'Bible', 'Canon', 'World Chat', 'Artifacts', 'Productions', 'Guide'].map((p) => `<span${p === 'Guide' ? ' class="on"' : ''}>${p}</span>`).join('')}</div>`;
// The story every section waits for is named once, for the world, beside what is still to describe.
const head = `<div class="ap234-head"><div><h1>Guide</h1><div class="m">6 of 6 teasers &#183; 14 of 15 characters &#183; 3 of 3 places &#183; 1 of 17 described &#183; 2 drafted</div></div><span class="grow"></span><span class="ap274-story"><b>After the story</b><span class="ap234-field">${WORLD}${DOWN}</span></span><span class="ap234-btn">${SPARK}Draft 14</span></div>`;
const teaserGroup = `<div style="padding:18px 40px 0"><div class="ap236-group"><div class="ap236-gh">Teasers<span class="grow"></span><span class="m">6 of 6</span></div><div class="ap236-teasers">${TEASERS.map((t, i) => tz({ ...t, n: i + 1 })).join('')}</div></div></div>`;
// A row: who, what a reader is told first, how much waits for the story, when they show, Public. The
// narrower Places column keeps only whether there is a description, so its chapters still fit.
const row = (c) => `<div class="ap234-row"><div class="who">${face(c)}<div style="min-width:0"><b>${c.name}</b><span>${c.role}</span></div></div><span class="col ink ap274-about">${c.about ? `${c.drafted ? DRAFTED : ''}<span>${c.about}</span>` : NONE}</span><span class="col" style="flex:.5">${c.n} after the story</span><span class="col" style="flex:.62">${c.shows}</span>${sw(true)}</div>`;
const placeRow = (c) => `<div class="ap234-row"><div class="who">${face(c)}<div style="min-width:0"><b>${c.name}</b><span>${c.role}</span></div></div><span class="col ink" style="flex:.55">${c.about ? (c.drafted ? DRAFTED : 'Described') : NONE}</span><span class="col" style="flex:.75">${c.shows}</span>${sw(true)}</div>`;
const guidePage = `${top}${pills}${head}${teaserGroup}<div class="ap234-cols"><div><div class="ap234-group"><div class="ap234-gh">Characters<span class="grow"></span><span class="m">14 of 15</span></div>${CAST.map(row).join('')}</div></div><div><div class="ap234-group"><div class="ap234-gh">Places<span class="grow"></span><span class="m">3 of 3</span></div>${PLACES.map(placeRow).join('')}</div></div></div>`;

const root = (label, width, height, inner) => `<div class="ap274" data-screen-label="${label}" style="width:${width}px;height:${height}px">${inner}</div>`;

// Ife's sections as her sheet has them; Essence and Appearance were public before and still are. The
// two she keeps to herself are cut short here, so this public drawing gives none of the story away.
const SECTIONS = [
  [true, 'Essence', 'She cannot make a man want her — she can only make wanting her cost him everything.'],
  [false, 'Before Lagos', 'Born in Epe, one of three children of a fish smoker…'],
  [false, 'The terms she lives under', 'Men fall for her…'],
  [true, 'Appearance', 'Late twenties. Unhurried in every movement — she has never in her life crossed a room quickly.'],
];
const section = ([on, heading, text]) => `<div class="ap234-sec${on ? '' : ' off'}"><div class="h">${box(on)}<span>${heading}</span></div><p>${text}</p></div>`;
const described = (text, count) => `<div class="ap274-desc"><p>${text}</p><div class="ft"><span class="m">${count} of 400</span><span class="grow"></span><span class="ap234-btn">${SPARK}Draft again</span></div></div>`;
const drafting = `<div class="ap274-desc busy"><div class="ln"><i style="width:94%"></i><i style="width:88%"></i><i style="width:97%"></i><i style="width:52%"></i></div><div class="ft"><span class="m">Drafting &#183; her sheet and Chapter 1</span><span class="grow"></span><span class="ap234-btn">Stop</span></div></div>`;
const preview = (rest) => `<div class="ap234-prev"><div class="eb" style="font:var(--type-label);font-size:var(--text-2xs);letter-spacing:var(--tracking-label);text-transform:uppercase;color:var(--muted-foreground)">Arke Player</div><div class="ap234-phone"><div class="hero"><img src="${A}juju-ife.jpg" alt="" style="object-position:50% 18%"><div class="fd"></div><div class="in"><b>Ife</b><span>Kept woman, keeper of men &#183; ${WORLD}</span></div></div><div class="tx">${rest}</div></div></div>`;
const entryPanel = (description, rest) => `<div class="ap234-dim"></div><div class="ap234-panel"><div class="ap234-pane">
<div style="display:flex;align-items:center;gap:12px"><img class="ap234-face" src="${A}juju-ife.jpg" alt="" style="width:44px;height:44px;border-radius:10px;object-position:50% 20%"><div style="flex:1;min-width:0"><div class="eb">Character &#183; Guide</div><div class="ttl">Ife</div></div><span style="font:var(--type-ui)">Public</span>${sw(true)}</div>
<div class="ap234-line"><b>Shows</b><span class="ap234-seg"><span class="on">From the start</span><span>After a chapter</span></span></div>
<div class="ap234-line" style="align-items:flex-start"><b style="padding-top:8px">Description</b><div class="grow">${description}</div></div>
<div class="ap234-line" style="align-items:flex-start"><b style="padding-top:2px">After the story</b><div class="grow" style="display:flex;flex-direction:column;gap:8px">${SECTIONS.map(section).join('')}</div></div>
<div class="ap234-line"><b>Voice</b><span class="grow" style="color:var(--muted-foreground)">None chosen</span><span class="ap234-btn">Change</span></div>
<div class="ap234-foot"><span class="grow"></span><span class="ap234-btn">Close</span></div>
</div>${preview(rest)}</div>`;

const gate = `<div class="gate">${EYEOFF}After the story &#183; 2 sections</div>`;

export const FRAMES = [
  ['a', 'A world’s Guide: what each is told first, the rest after the story', 1360, 850, 'page', () => root(
    '274a The Guide names its story once, for the whole world, and each character and place gains a description for every reader: written, drafted or still to describe, with how many sections wait for the story',
    1360, 850, guidePage,
  )],

  ['b', 'A character’s entry: her description, and her sections after the story', 1360, 850, 'panel', () => root(
    '274b An entry: Public, when it shows, the description every reader is given, the sections ticked to wait for the story, a voice line, and the Player’s page beside it',
    1360, 850, `${guidePage}${entryPanel(described(ABOUT.ife, ABOUT.ife.length), `<p>${ABOUT.ife}</p>${gate}`)}`,
  )],

  ['c', 'Drafting a description', 1360, 850, 'panel', () => root(
    '274c Draft: Arke writes it from the sheet and the story up to where she is met, for the author to change',
    1360, 850, `${guidePage}${entryPanel(drafting, gate)}`,
  )],
];
