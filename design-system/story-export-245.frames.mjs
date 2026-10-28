// Turn 245 · Export → Arke Player for an interactive story: the frames. The samples are The
// Undersong's Low Water (an interactive movie, 16:9, 14 scenes) and The Lantern Road (a visual
// novel, 9 scenes), as Player P18 draws them on a phone; counts, sizes, facts and findings are
// samples. Every frame's root is .ap245 with its data-screen-label.
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
const ALERT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';

const PAGE = '<div class="ap245-page">' + [28, 92, 88, 95, 60, 90, 84, 93, 70, 89, 91, 55, 80, 66].map((w) => `<i style="width:${w}%"></i>`).join('') + '</div>';
const KEY_ART = 'assets/world-undersong.png';
const SHA = '4be1c07d93a2f58e16c0b7d42e9a3f61d85c2b04a7e19f3c60d8b25e1f4a97c3';
const FILE = 'low-water-story-2026-10-28.zip';
const root = (label, width, height, inner) => `<div class="ap245" data-screen-label="${label}" style="width:${width}px;height:${height}px">${inner}</div>`;
const opt = (label, middle, tail = '') => `<div class="ap245-opt"><b>${label}</b>${middle}<span class="grow"></span>${tail}</div>`;
const i = (text) => `<i>${text}</i>`;
// 174h's web package stays beside Arke Player: one sheet, two kinds (call 4).
const kinds = `<div class="ap245-kinds">${[
  ['Web package', 'player.html &#183; any browser'],
  ['Arke Player', 'phone &#183; offline &#183; remembers choices', true],
].map(([name, line, on]) => `<div class="ap245-kind${on ? ' on' : ''}"><span class="r"></span><div><b>${name}</b><span>${line}</span></div></div>`).join('')}</div>`;
const world = opt('World', `<img src="${KEY_ART}" alt=""><span>The Undersong</span>`, i('key art &#183; logline'));
const edition = opt('Edition', '<span class="ap245-field">28 Oct 2026</span>');
const block = (clause, press) => `<div class="ap245-block">${ALERT}<span class="c">${clause}</span><span class="ap245-btn sm">${press}</span></div>`;
const foot = (press, off = false) => `<div class="ap245-foot"><span class="grow"></span><span class="ap245-btn">Cancel</span><span class="ap245-btn pri${off ? ' off' : ''}">${press}</span></div>`;

export const FRAMES = [
  ['a', 'Export &#8594; Arke Player: an interactive movie', 1360, 720, 'sheet', () => root(
    '245a Export on an interactive movie gains Arke Player beside the web package: the story compiled from routing, its closed choices, one clip a scene at its shape, priced as a package',
    1360, 720,
    `${PAGE}<div class="ap245-dim"></div><div class="ap245-sheet" style="top:36px;width:720px"><h3>Export &#183; Low Water</h3><div class="sub">Interactive movie &#183; 14 scenes &#183; 16:9</div>${kinds}<div class="ap245-opts">${[
      world,
      opt('Story', '<span>14 scenes &#183; 22 choices</span>', i('3 facts &#183; 2 endings')),
      opt('Closed choices', '<span>3 &#183; 1 with a reason</span>', i('2 hidden')),
      opt('Clips', '<span>14 &#183; 47:12</span>', i('1920 &#215; 1080 &#183; as made')),
      opt('Shape', '<span>16:9</span>'),
      opt('Format', '<span>arke-story 1</span>', i('from routing')),
      edition,
    ].join('')}</div><div class="ap245-est"><b style="font-weight:600">~1.1 GB &#183; ~4 min on this machine</b><span class="m">14 clips &#183; 1 story</span></div>${foot('Make package')}</div>`,
  )],

  ['b', 'Export &#8594; Arke Player: a visual novel', 1360, 760, 'sheet', () => root(
    '245b Export on a visual novel: its beats&#8217; pictures counted wide and tall, Make tall for the rest, its voiced lines, and the picture size',
    1360, 760,
    `${PAGE}<div class="ap245-dim"></div><div class="ap245-sheet" style="top:36px;width:720px"><h3>Export &#183; The Lantern Road</h3><div class="sub">Visual novel &#183; 9 scenes &#183; 86 beats</div>${kinds}<div class="ap245-opts">${[
      world,
      opt('Story', '<span>9 scenes &#183; 14 choices</span>', i('2 facts &#183; 3 endings')),
      opt('Closed choices', '<span>1 &#183; 1 with a reason</span>'),
      opt('Pictures', '<span>86 wide &#183; 52 tall</span>', `${i('34 wide only')}<span class="ap245-btn sm">Make tall</span>`),
      opt('Size', '<span class="ap245-seg"><span class="on">Full</span><span>1280 px</span><span>960 px</span></span>', i('long side')),
      opt('Voices', '<span>61 of 86 lines</span>', i('25 as text')),
      opt('Format', '<span>arke-story 1</span>', i('from routing')),
      edition,
    ].join('')}</div><div class="ap245-est"><b style="font-weight:600">~212 MB &#183; ~1 min on this machine</b><span class="m">86 beats &#183; 138 pictures &#183; 61 lines</span></div>${foot('Make package')}</div>`,
  )],

  ['c', 'Not made: each blocker in one clause', 1360, 660, 'sheet', () => root(
    '245c Blocked: a scene with no clip, a dead end that one remembered value causes, and a picture that disagrees with a fact, each with the press that clears it; a closed choice with no reason is hidden, never a blocker',
    1360, 660,
    `${PAGE}<div class="ap245-dim"></div><div class="ap245-sheet" style="top:36px;width:720px"><h3>Export &#183; Low Water</h3><div class="sub">Interactive movie &#183; 14 scenes &#183; 16:9</div>${kinds}<div class="ap245-opts">${[
      opt('Story', '<span>14 scenes &#183; 22 choices</span>', i('2 to clear')),
      opt('Closed choices', '<span>3 &#183; 1 with a reason</span>', i('2 hidden')),
      opt('Clips', '<span>13 of 14</span>', i('1 to clear')),
    ].join('')}</div>${block('Under the pier &#183; no clip', 'Go to')}${block('The weigh house &#183; a dead end when Key is Left', 'Show')}${block('The drowned quarter &#183; Maren in the picture when Maren is Lost', 'Go to')}${foot('Make package', true)}</div>`,
  )],

  ['d', 'The package made, read back, beside the world&#8217;s releases', 1360, 560, 'sheet', () => root(
    '245d Made: the story package with its size and SHA-256, read back with every route replayed, and the world&#8217;s releases in order, the story a package of its own beside the edition',
    1360, 560,
    `${PAGE}<div class="ap245-dim"></div><div class="ap245-sheet" style="top:40px;width:720px"><h3>Export &#183; Low Water</h3><div class="sub">arke player &#183; story &#183; made 2026-10-28 09:12</div><div class="ap245-est"><b style="font-weight:600">1 package &#183; 1.1 GB</b><span class="m">exports/${FILE}</span><span class="grow"></span><span class="ap245-btn">${FOLDER}Show in folder</span></div><div class="ap245-sha"><b>SHA-256</b><code>${SHA}</code><span class="ap245-btn">Copy</span></div><div class="ap245-back">${CHECK}<b style="font-weight:500">Read back</b><span>37 of 37 routes &#183; 2 endings</span><span class="grow" style="flex:1"></span><span class="m">arke-story 1</span></div><div class="ap245-opts">${[
      ['26 Oct 2026', 'Edition', 'The Undersong &#183; Chapters 1&#8211;3 &#183; the book', '412 MB'],
      ['25 Oct 2026', 'Album', 'Songs of the Drowned Quarter &#183; 9 tracks', '66 MB'],
      ['28 Oct 2026', 'Story', 'Low Water &#183; 14 scenes', '1.1 GB', true],
    ].map(([d, k, what, size, now]) => `<div class="ap245-rel${now ? ' now' : ''}"><span class="d">${d}</span><span class="k">${k}</span><span>${what}</span><span class="grow" style="flex:1"></span><span class="m">${size}</span></div>`).join('')}</div><div class="ap245-foot" style="margin-top:4px"><span class="grow"></span><span class="ap245-btn">Make again</span><span class="ap245-btn pri">Done</span></div></div>`,
  )],
];
