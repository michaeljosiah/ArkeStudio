// Turn 276 · Publish: the frames. The shell (title bar, production rail, phone strip), the Guide
// page and the sheet's chrome are drawn from the shipped client, measured against
// publish-arke-player.capture.mjs; the page's cards and Made list, the one Arke Player sheet's made
// block, Add to Arke's list and Guide alone are this turn's. The sample is The Undersong, as turns
// 233, 245 and 272 draw it; sizes, counts, dates and hashes are samples.
const svg = (d, w = 1.75) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  left: svg('<path d="m15 18-6-6 6-6"/>'),
  right: svg('<path d="m9 18 6-6-6-6"/>'),
  down: svg('<path d="m6 9 6 6 6-6"/>'),
  sparkle: svg('<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>'),
  message: svg('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'),
  cpu: svg('<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>'),
  bell: svg('<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>'),
  cog: svg('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  user: svg('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  panel: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>'),
  folder: svg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  copy: svg('<rect x="8" y="8" width="14" height="14" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  download: svg('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'),
  upload: svg('<path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'),
  book: svg('<path d="M12 7C9 4 6 4 2 5v15c4-1 7-1 10 2 3-3 6-3 10-2V5c-4-1-7-1-10 2Z"/><path d="M12 7v15"/>'),
  phone: svg('<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>'),
  x: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  alert: svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>', 2),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 2.5),
  more: svg('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>', 2),
};
const KEY_ART = 'assets/world-undersong.png';
const COMIC = 'assets/board-scene4-a.png';
const SHA = '4be1f27c90d3a6e85c21b7f04d9e3a618c55f2b0e7d9416a3c08b5e2f9d17c64';
const SHA_COMIC = 'c71a09e4b38f5d2a6e1074c9b2f8d35e60a7c41b9e28f03d5a6c7e19b4d02f85';
const BOOK = 'the-undersong-player-2026-11-11.zip';

// ---- The shell, as it ships ----------------------------------------------------------------------
const bar = (back, context) => `<div class="pb276-bar"><div class="side"><span class="back">${I.left}${back}</span><span class="ctx">${context}</span><span class="pb276-icon">${I.sparkle}</span></div><div class="brand"><b>Arke</b><span>Studio</span></div><div class="side r"><span class="pb276-icon">${I.message}</span><span class="pb276-icon">${I.cpu}</span><span class="pb276-icon">${I.bell}<i class="dot"></i></span><span class="pb276-icon">${I.cog}</span><span class="pb276-icon">${I.user}</span></div></div>`;
// A rail item: [label, count, state] where state is 'on' or 'new' (the item this turn adds).
const rail = (title, sub, items, below) => `<aside class="pb276-rail"><span class="fold">${I.panel}</span><div class="switch"><div class="c"><div class="n">${title}</div><div class="s">${sub}</div></div>${I.right}</div>${items.map(item).join('')}<hr>${below.map(item).join('')}<div class="foot">${I.left}Part of The Undersong</div></aside>`;
const item = ([label, count = '', state = '']) => `<a class="${state}">${label}${count ? `<span class="k">${count}</span>` : ''}</a>`;
const BOOK_RAIL = on => rail('The Ledger of Nights', 'story · 16 chapters', [['Dashboard'], ['Cast', '3'], ['Develop', 'chat'], ['Overview', 'v3'], ['Chapters', '16'], ['Audiobook', '16/16']], [['Artifacts'], ['Publish', '', on]]);
const COMIC_RAIL = on => rail('Neap Tide', 'graphic novel · 6 chapters', [['Dashboard'], ['Cast', '4'], ['Develop', 'chat'], ['Overview', 'v2'], ['Chapters', '6'], ['Pages', '112']], [['Artifacts'], ['Publish', '', on]]);
const desk = (label, kind, rails, main, over = '') => `<div class="pb276 pb276--${kind}" data-screen-label="${label}" style="width:1360px;height:850px">${bar('World', rails.context)}<div class="pb276-body">${rails.rail}<main class="pb276-main">${main}</main></div>${over}</div>`;

// ---- The Publish page ------------------------------------------------------------------------------
const state = (ready, line) => ready ? `<div class="st"><i class="ok"></i><b>Ready</b><span>${line}</span></div>` : `<div class="st"><i class="no"></i><b>Blocked · ${line}</b></div>`;
const out = ({ name, formats, ready, line, block, press, primary }) => `<section class="pb276-out"><div class="n">${name}</div><div class="f">${formats}</div>${state(ready, line)}${block ? `<div class="bl">${I.alert}<span>${block}</span><span class="pb276-btn sm">Go to</span></div>` : '<div class="sp"></div>'}<span class="pb276-btn sm${primary ? ' pri' : ''}">${press}</span></section>`;
const outs = list => `<div class="pb276-outs" style="--cols:${list.length}">${list.map(out).join('')}</div>`;
const where = w => w ? `<span class="w">${I.check}${w}</span>` : '<span class="w"></span>';
const made = rows => `<div class="pb276-madehead"><h2>Made</h2><span class="meta">${rows.length}</span></div><div class="pb276-made">${rows.map(([kind, title, data, date, size, went, sha]) => `<div class="row"><b class="kd">${kind}</b><div class="t"><span>${title}</span><i>${data}</i></div><span class="d">${date}</span><span class="z">${size}</span>${where(went)}<span class="acts">${sha ? `<span class="pb276-btn sm ghost">${I.copy}SHA-256</span>` : ''}<span class="pb276-btn sm ghost">${I.folder}Show</span></span></div>`).join('')}</div>`;
const head = (meta, acts = '') => `<div class="pb276-h1row"><h1>Publish</h1><span class="meta">${meta}</span>${acts ? `<span class="acts">${acts}</span>` : ''}</div>`;

const BOOK_OUTS = [
  { name: 'Edition', formats: 'EPUB · PDF · M4B', ready: true, line: '16 chapters', press: 'Create edition' },
  { name: 'Audiobook', formats: 'player · MP3 · video', ready: true, line: '16 of 16 read whole', press: 'Export' },
  { name: 'Arke Player', formats: 'package · part', ready: true, line: '2 chapters since 7 Nov', press: 'Make package', primary: true },
  { name: 'Manuscript', formats: 'Word · EPUB', ready: true, line: '52,140 words', press: 'Export' },
];
const BOOK_MADE = [
  ['Arke Player', 'Part 1', 'Chapters 13–14', '7 Nov', '41 MB', "On Arke's list", true],
  ['Arke Player', 'Edition', 'Chapters 1–12 · the book · the guide', '21 Oct', '228 MB', "On Arke's list", true],
  ['Edition', 'First edition', 'EPUB · M4B', '20 Oct', '312 MB', ''],
  ['Audiobook', 'Player', '12 chapters · 103 pictures', '19 Oct', '141 MB', ''],
  ['Manuscript', 'Word', '16 chapters', '12 Oct', '1.2 MB', ''],
];
const bookPage = label => desk(label, 'page', { context: 'The Ledger of Nights · story', rail: BOOK_RAIL('on') }, `${head('4 outputs · 5 made')}${outs(BOOK_OUTS)}${made(BOOK_MADE)}`);

const comicOuts = ready => outs([
  { name: 'Comic files', formats: 'CBZ · PDF · EPUB', ready, line: ready ? '112 of 112 accepted' : '3', block: ready ? '' : 'Pages 12–14 · not accepted', press: 'Export' },
  { name: 'Arke Player', formats: 'package', ready, line: ready ? '112 pages · 6 chapters' : '3', block: ready ? '' : 'Pages 12–14 · not accepted', press: 'Make package', primary: ready },
]);
const comicPage = (label, ready = false) => desk(label, 'page', { context: 'Neap Tide · graphic novel', rail: COMIC_RAIL('on') }, ready
  ? `${head('2 outputs · 1 made')}${comicOuts(true)}${made([['Arke Player', 'Package', '6 chapters · 112 pages', '11 Nov', '64 MB', '', true]])}`
  : `${head('2 outputs · nothing made')}${comicOuts(false)}<div class="pb276-madehead"><h2>Made</h2></div><div class="pb276-empty">Nothing made yet.</div>`);

// ---- The one Arke Player sheet -------------------------------------------------------------------
const dim = '<div class="pb276-dim"></div>';
const sheet = ({ title, sub, body, foot, top = 70, width = 766 }) => `<div class="pb276-sheet" style="top:${top}px;width:${width}px"><header><div class="titles"><h2>${title}</h2><p>${sub}</p></div><span class="x">${I.x}</span></header><div class="body">${body}</div><footer>${foot}</footer></div>`;
const opt = (label, middle, tail = '') => `<div class="pb276-opt"><b>${label}</b>${middle}<span class="grow"></span>${tail ? `<i>${tail}</i>` : ''}</div>`;
const madeBlock = ({ count, size, file, thumb, holds, sha, back, onList, owner = true, submit = true }) => `<div class="pb276-madeblock"><div class="est"><b>${count} · ${size}</b><span class="m">exports/${file}</span></div><div class="file"><img src="${thumb}" alt=""><div><div>${file}</div><div class="m">${holds}</div></div></div><div class="sha"><b>SHA-256</b><code>${sha}</code><span class="pb276-abtn">Copy</span></div><div class="back">${I.check}<b>Read back</b><span>${back}</span></div><div class="acts"><span class="pb276-abtn">${I.folder}Show in folder</span><span class="pb276-abtn">Make again</span><span class="grow"></span>${onList ? `<span class="listed">${I.check}On Arke's list · ${onList}</span>` : owner ? `<span class="pb276-abtn pri">${I.upload}Add to Arke's list</span>` : ''}</div>${submit ? `<details class="submit"><summary>Submit to Arke Player</summary></details>` : ''}</div>`;
const done = '<span class="grow"></span><span class="pb276-abtn pri">Done</span>';

const BOOK_MADE_BLOCK = (onList, owner = true) => madeBlock({ count: '1 package', size: '263 MB', file: BOOK, thumb: KEY_ART, holds: '16 chapters · 174 pictures · the book · the guide · 263 MB', sha: SHA, back: 'schema 3 · 1,486 files', onList, owner });
const bookSheet = (label, onList) => bookPage(label).replace(/<\/div>$/, `${dim}${sheet({ title: 'Arke Player', sub: 'The Ledger of Nights · made 11 Nov 2026 14:02', body: BOOK_MADE_BLOCK(onList), foot: done, top: 92 })}</div>`);

const comicSheet = label => comicPage(label, true).replace(/<\/div>$/, `${dim}${sheet({ title: 'Arke Player', sub: 'Neap Tide · made 11 Nov 2026 16:40', body: madeBlock({ count: '1 package', size: '64 MB', file: 'neap-tide-comic-2026-11-11.zip', thumb: COMIC, holds: '6 chapters · 112 pages · 64 MB', sha: SHA_COMIC, back: 'arke-comic 1 · 112 pages' }), foot: done, top: 104 })}</div>`);

// ---- Add to Arke's list (the owner's host) ------------------------------------------------------
const confirm = `<div class="pb276-dim2"></div><div class="pb276-confirm"><h3>Add to Arke's list</h3><div class="pb276-opts">${[
  opt('World', '<span>The Undersong</span>', 'the-undersong'),
  opt('As', '<span>Edition · Chapters 1–16</span>', 'replaces 21 Oct · gathers 1 part'),
  opt('File', `<span>${BOOK}</span>`, '263 MB'),
  opt('Release', '<span>undersong-player</span>', 'new file'),
  opt('List', '<span>53 → 54</span>', 'read 11 Nov 14:05'),
].join('')}</div><div class="foot"><span class="grow"></span><span class="pb276-abtn">Cancel</span><span class="pb276-abtn pri">Add to list</span></div></div>`;
const listConfirm = label => bookSheet(label).replace(/<\/div>$/, `${confirm}</div>`);

// ---- Guide alone, from the Guide page --------------------------------------------------------------
const worldBar = `<div class="pb276-bar"><div class="side"><span class="back">${I.left}Worlds</span><span class="ctx pb276-ctxw">The Undersong</span><span class="pb276-icon">${I.sparkle}</span></div><div class="brand"><b>Arke</b><span>Studio</span></div><div class="side r"><span class="pb276-icon">${I.message}</span><span class="pb276-icon">${I.cpu}</span><span class="pb276-icon">${I.bell}<i class="dot"></i></span><span class="pb276-icon">${I.cog}</span><span class="pb276-icon">${I.user}</span></div></div>`;
const worldNav = `<nav class="pb276-wnav">${['Overview', 'Art direction', 'Cast', 'Bible', 'Canon', 'World Chat', 'Artifacts', 'Productions', 'Guide'].map(n => `<span${n === 'Guide' ? ' class="on"' : ''}>${n}</span>`).join('')}</nav>`;
const gpanel = (title, count, rows) => `<section class="pb276-gp"><header><b>${title}</b><span>${count}</span></header>${rows.map(([m, n, s, on]) => `<div class="r">${m ? `<span class="mk">${m}</span>` : ''}<div><div class="nm">${n}</div><div class="sb">${s}</div></div><span class="ds">—</span><span class="grow"></span><span class="tg${on ? ' on' : ''}"></span></div>`).join('')}</section>`;
const guidePage = `<div class="pb276-guide">${worldNav}<div class="pb276-ghead"><div><h1>Guide</h1><div class="meta">5 of 6 teasers · 4 of 5 characters · 3 of 3 places · 2 of 3 lore</div></div><span class="grow"></span><span class="lbl">After the story</span><span class="pb276-sel">The Ledger of Nights${I.down}</span><span class="pb276-gbtn off">${I.sparkle}Draft 0</span><span class="pb276-gbtn">${I.phone}Preview</span><span class="pb276-gbtn new">${I.download}Export</span></div><section class="pb276-gp wide"><header><b>Teasers</b><span>5 of 6</span></header><div class="tz">${[1, 2, 3, 4, 5].map(() => `<div class="t"><img src="${KEY_ART}" alt=""></div>`).join('')}<div class="t add">+ Add</div></div></section><div class="pb276-gcols"><div>${gpanel('Characters', '4 of 5', [['MK', 'Maren Kest', 'Tide-caller', true], ['OV', 'Oren Vael', 'Keeper of the ledger', true]])}${gpanel('Places', '3 of 3', [['V', 'The Vigil', 'Harbour mouth', true], ['EC', 'The Ebb Council', 'Faction', true]])}</div><div>${gpanel('Lore', '2 of 3', [['', 'Tide-calling', 'Rule', true], ['', 'Who taught the Chorister?', 'Thread · open', false]])}</div></div></div>`;
const guideSheet = sheet({ title: 'Arke Player', sub: 'The Undersong · guide alone', top: 118, body: `<div class="pb276-opts">${[
  opt('World', `<img src="${KEY_ART}" alt=""><span>The Undersong</span>`, 'key art · logline'),
  opt('Characters', '<span>4 public</span>', '2 after a chapter'),
  opt('Places', '<span>3 public</span>'),
  opt('Lore', '<span>2 public</span>', '1 thread kept back'),
  opt('Teasers', '<span>5</span>', 'guide version 2'),
  opt('Edition', '<span class="pb276-field">11 Nov 2026</span>'),
].join('')}</div><div class="pb276-est"><b>~3.4 MB · ~5 s on this machine</b><span class="m">4 characters · 3 places · 2 lore · 5 teasers</span></div>`, foot: '<span class="grow"></span><span class="pb276-abtn">Cancel</span><span class="pb276-abtn pri">Make package</span>' });
const guide = label => `<div class="pb276 pb276--guide" data-screen-label="${label}" style="width:1360px;height:850px">${worldBar}<div class="pb276-body pb276-gbody">${guidePage}</div>${dim}${guideSheet}</div>`;

// ---- The phone ---------------------------------------------------------------------------------------
const phone = label => `<div class="pb276 pb276--phone" data-screen-label="${label}" style="width:390px;height:844px"><div class="pb276-pbar"><span class="back">${I.left}World</span><span class="pb276-icon">${I.sparkle}</span><span class="grow"></span><span class="pb276-icon">${I.message}</span><span class="pb276-icon">${I.cpu}</span><span class="pb276-icon">${I.bell}<i class="dot"></i></span><span class="pb276-icon">${I.cog}</span><span class="pb276-icon">${I.user}</span></div><div class="pb276-pswitch"><span class="mk">${I.book}</span><div class="c"><div class="n">The Ledger of Nights</div><div class="s">story · 16 chapters</div></div>${I.down}</div><div class="pb276-pages"><nav>${['Overview', 'Chapters', 'Audiobook', 'Artifacts', 'Publish'].map(n => `<span${n === 'Publish' ? ' class="on"' : ''}>${n}</span>`).join('')}</nav></div><main class="pb276-pmain"><div class="pb276-h1row"><h1>Publish</h1></div><div class="meta">4 outputs · 5 made</div><div class="pb276-pouts">${BOOK_OUTS.map(o => `<div class="po"><div><div class="n">${o.name}</div><div class="f">${o.formats} · ${o.line}</div></div><span class="pb276-btn sm${o.primary ? ' pri' : ''}">${o.press}</span></div>`).join('')}</div><div class="pb276-madehead"><h2>Made</h2><span class="meta">5</span></div><div class="pb276-pmade">${BOOK_MADE.slice(0, 3).map(([kind, title, data, date, size, went]) => `<div class="pr"><div class="t"><b>${kind} · ${title}</b><i>${date} · ${size}${went ? ` · ${went}` : ''}</i></div>${I.more}</div>`).join('')}</div></main></div>`;

export const FRAMES = [
  ['a', 'Publish · a book: its four outputs and everything it has made', 1360, 850, 'page', bookPage],
  ['b', 'Publish · a graphic novel not ready: Blocked · 3, with Go to', 1360, 850, 'page', comicPage],
  ['c', 'The Arke Player sheet, made: one block for every kind', 1360, 850, 'sheet', label => bookSheet(label)],
  ['d', 'The same block on a graphic novel: SHA-256, Make again and Submit', 1360, 850, 'sheet', comicSheet],
  ['e', 'Add to Arke’s list: what goes public, in one press', 1360, 850, 'sheet', listConfirm],
  ['f', 'On Arke’s list: the list read back', 1360, 850, 'sheet', label => bookSheet(label, '54')],
  ['g', 'Guide alone, from the Guide page', 1360, 850, 'sheet', guide],
  ['h', 'Publish on a phone', 390, 844, 'phone', phone],
];
