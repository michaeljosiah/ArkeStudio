// Turn 233 · Export → Arke Player: the frames. The sample is The Undersong's The Ledger of Nights,
// 16 chapters written and 12 read whole, as published on 20 October 2026; sizes and counts are
// samples. Every frame's root is .ap233 with its data-screen-label.
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
const ALERT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';

const PAGE = '<div class="ap233-page">' + [28, 92, 88, 95, 60, 90, 84, 93, 70, 89, 91, 55, 80, 66].map((w) => `<i style="width:${w}%"></i>`).join('') + '</div>';
const KEY_ART = 'assets/world-undersong.png';
const SHA = '9c41d0b27a5e3f8812c6d94b0e7a51f3c2d8846b19a0e5f7c3b61d2e48a97e07';
const FILE = 'the-undersong-player-2026-10-21.zip';

const box = (on = true) => `<span class="ap233-box${on ? ' on' : ''}">${on ? CHECK : ''}</span>`;
const opt = (label, middle, tail = '', width = 96) => `<div class="ap233-opt"><b style="width:${width}px">${label}</b>${middle}<span class="grow"></span>${tail ? `<i>${tail}</i>` : ''}</div>`;
const kinds = `<div class="ap233-kinds">${[
  ['Audiobook player', 'player.html &#183; web package'],
  ['Chapter files', 'Retail &#183; no pictures'],
  ['Video', 'MP4 &#183; pictures &#183; captions'],
  ['Arke Player', 'phone &#183; pictures &#183; the book', true],
].map(([name, line, on]) => `<div class="ap233-kind${on ? ' on' : ''}"><span class="r"></span><div><b>${name}</b><span>${line}</span></div></div>`).join('')}</div>`;
const root = (label, width, height, inner) => `<div class="ap233" data-screen-label="${label}" style="width:${width}px;height:${height}px">${inner}</div>`;

export const FRAMES = [
  ['a', 'The Export sheet with Arke Player chosen', 1360, 780, 'sheet', () => root(
    '233a Export gains Arke Player: the world, the book, the narration read whole, its pictures fitted for a phone, Text timed and motion loops, one edition, priced in size and time',
    1360, 780,
    `${PAGE}<div class="ap233-dim"></div><div class="ap233-sheet" style="top:36px;width:720px"><h3>Export audiobook &#183; The Ledger of Nights</h3><div class="sub">12 of 16 chapters read &#183; 3:49:26</div>${kinds}<div class="ap233-opts">${[
      opt('World', `<img src="${KEY_ART}" alt=""><span>The Undersong</span>`, 'key art &#183; logline'),
      opt('Book', `<span class="ap233-chk">${box()}The book</span>`, '16 chapters &#183; EPUB'),
      opt('Narration', '<span>12 of 16 &#183; read whole</span>', 'Chapters 1&#8211;12'),
      opt('Pictures', '<span>131 &#183; fitted for a phone</span>', '2048 px &#183; cover before the first'),
      opt('Text', '<span>Phrases, timed</span>', 'words timed in 9 of 12'),
      opt('Motion', `<span class="ap233-chk">${box()}Loops</span>`, '3 &#183; each with its still'),
      opt('Edition', '<span class="ap233-field">21 Oct 2026</span>'),
    ].join('')}</div><div class="ap233-est"><b style="font-weight:600">~228 MB &#183; ~3 min on this machine</b><span class="m">12 chapters &#183; 131 pictures &#183; the book</span></div><div class="ap233-foot"><span class="grow"></span><span class="ap233-btn">Cancel</span><span class="ap233-btn pri">Make package</span></div></div>`,
  )],

  ['b', 'Making it, in Activity', 1360, 420, 'activity', () => root(
    '233b Making the package: one Activity row with its step, a percent across all of it, an estimate and Cancel',
    1360, 420,
    `${PAGE}<div class="ap233-dim" style="opacity:.4"></div><div class="ap233-act" style="right:24px;top:56px"><div class="hd">Activity<span class="grow"></span><span class="ap233-note">1 running</span></div><div class="ap233-row"><div class="t"><b>Arke Player &#183; The Ledger of Nights</b><span class="m">41%</span><span class="ap233-btn" style="height:26px">Cancel</span></div><div class="ap233-prog"><i style="width:41%"></i></div><span class="m">Fitting pictures &#183; 54 of 131 &#183; ~2 min left</span></div><div class="ap233-row"><div class="t"><b>Read the chapter &#183; Chapter 12</b><span class="m">done</span></div><span class="m">143 blocks &#183; $0.0009</span></div><div class="ap233-row"><div class="t"><b>Illustrate &#183; Chapter 12</b><span class="m">done</span></div><span class="m">11 pictures &#183; $0.55</span></div></div>`,
  )],

  ['c', 'The package made: its file, size and SHA-256', 1360, 440, 'sheet', () => root(
    '233c Made: the package with its size, Show in folder, and its SHA-256 in full with Copy; Make again makes a new file',
    1360, 440,
    `${PAGE}<div class="ap233-dim"></div><div class="ap233-sheet" style="top:40px;width:720px"><h3>Export audiobook &#183; The Ledger of Nights</h3><div class="sub">arke player &#183; made 2026-10-21 09:12</div><div class="ap233-est"><b style="font-weight:600">1 package &#183; 228 MB</b><span class="m">exports/${FILE}</span><span style="flex:1"></span><span class="ap233-btn">${FOLDER}Show in folder</span><span class="ap233-btn">Make again</span></div><div class="ap233-file"><img src="${KEY_ART}" alt=""><div><div>${FILE}</div><div class="m">12 chapters &#183; 131 pictures &#183; the book &#183; 228 MB</div></div><div class="ap233-acts"><span class="ap233-btn">${FOLDER}Show in folder</span></div></div><div class="ap233-sha"><b>SHA-256</b><code>${SHA}</code><span class="ap233-btn">Copy</span></div><div class="ap233-foot" style="margin-top:4px"><span class="grow"></span><span class="ap233-btn pri">Done</span></div></div>`,
  )],

  ['d', 'Not made: each blocker in one clause', 1360, 620, 'sheet', () => root(
    '233d Blocked: a loop that will not play and a picture outside the world, each one clause with the press that clears it; Make package waits',
    1360, 620,
    `${PAGE}<div class="ap233-dim"></div><div class="ap233-sheet" style="top:36px;width:720px"><h3>Export audiobook &#183; The Ledger of Nights</h3><div class="sub">12 of 16 chapters read &#183; 3:49:26</div>${kinds}<div class="ap233-opts">${[
      opt('Narration', '<span>12 of 16 &#183; read whole</span>', 'Chapters 1&#8211;12'),
      opt('Pictures', '<span>131 &#183; fitted for a phone</span>', '2 to clear'),
    ].join('')}</div><div class="ap233-block">${ALERT}<span class="c">Chapter 4 &#183; The Weir &#183; its loop won&#8217;t play</span><span class="ap233-btn" style="height:28px">Use still</span></div><div class="ap233-block">${ALERT}<span class="c">Chapter 9 &#183; a picture outside this world</span><span class="ap233-btn" style="height:28px">Show</span></div><div class="ap233-foot"><span class="grow"></span><span class="ap233-btn">Cancel</span><span class="ap233-btn pri off">Make package</span></div></div>`,
  )],

  ['e', 'Publications · Other exports: the package with its size and SHA-256', 1120, 540, 'page', () => root(
    '233e Publications, Other exports: the Arke Player package beside the player and the video, newest first, with Copy SHA-256 and Show in folder',
    1120, 540,
    `<div class="ap233-pub"><nav>${['Overview', 'Manuscript', 'Audiobook', 'Publish'].map((n) => `<span${n === 'Publish' ? ' class="on"' : ''}>${n}</span>`).join('')}</nav><main><div class="h">Publications</div><div class="ap233-tabs"><span>Editions</span><span class="on">Other exports</span><span>Open publication</span></div><div class="ap233-list">${[
      [KEY_ART, 'Arke Player &#183; The Undersong', '21 Oct 2026 &#183; 12 chapters &#183; 131 pictures &#183; the book &#183; 228 MB', true],
      ['assets/banner-story.png', 'Audiobook player &#183; The Ledger of Nights', '19 Oct 2026 &#183; 6 chapters &#183; 103 pictures &#183; 141 MB'],
      ['assets/scene4-shot15.png', 'Video &#183; Chapter 1', '4 Oct 2026 &#183; 31:40 &#183; 1920 &#215; 1080 &#183; 338 MB'],
    ].map(([img, title, line, sha]) => `<div class="ap233-file"><img src="${img}" alt=""><div><b>${title}</b><div class="m">${line}</div></div><div class="ap233-acts">${sha ? '<span class="ap233-btn">Copy SHA-256</span>' : ''}<span class="ap233-btn">${FOLDER}Show in folder</span></div></div>`).join('')}</div></main></div>`,
  )],

  ['f', 'From a phone: made on the desktop, then Download or Share', 900, 920, 'phone', () => root(
    '233f On a phone: Export makes the package on the desktop; the phone watches the row, can cancel it, and downloads or shares the finished package, which Arke Player takes',
    900, 920,
    `<div style="display:flex;gap:40px;justify-content:center;padding:38px 0;background:var(--secondary);height:100%;box-sizing:border-box"><div class="ap233-phone"><div class="bar">The Ledger of Nights &#183; Audiobook</div><div class="ap233-scrim"></div><div class="ap233-psheet" style="top:200px"><div class="ap233-grab"></div><h3 style="margin:0;font:var(--type-ui);font-weight:600">Export &#183; Arke Player</h3><div class="ap233-opts">${[
      opt('Book', `<span class="ap233-chk">${box()}The book</span>`, '', 72),
      opt('Narration', '<span>12 of 16</span>', '', 72),
      opt('Pictures', '<span>131</span>', '', 72),
      opt('Text', '<span>Timed</span>', '', 72),
      opt('Motion', `<span class="ap233-chk">${box()}Loops</span>`, '', 72),
    ].join('')}</div><div class="ap233-est" style="flex-direction:column;align-items:flex-start;gap:2px"><b style="font-weight:600">~228 MB &#183; ~3 min</b><span class="m">on the desktop</span></div><span class="ap233-btn pri" style="height:44px;justify-content:center">Make package</span></div></div><div class="ap233-phone"><div class="bar">Activity</div><div style="padding:4px 0"><div class="ap233-row"><div class="t"><b>Arke Player &#183; 41%</b><span class="ap233-btn" style="height:36px">Cancel</span></div><div class="ap233-prog"><i style="width:41%"></i></div><span class="m">Fitting pictures &#183; 54 of 131 &#183; on the desktop</span></div><div class="ap233-row"><div class="t"><b>Arke Player &#183; The Undersong</b><span class="m">done &#183; 228 MB</span></div><div class="ap233-acts"><span class="ap233-btn" style="height:44px">Download</span><span class="ap233-btn" style="height:44px">Share</span></div><span class="m">${FILE}</span></div></div></div></div>`,
  )],
];
