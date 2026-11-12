// Turn 235 · Picture shapes: the frames. The sample is The Undersong's The Ledger of Nights, 23
// chapters and 290 pictures as published on 22 October 2026. The pictures are real: block p004
// (Maren at the ledger) made Wide, and its Tall made on 23 October through the ChatGPT route with
// the Wide riding as the reference. Every frame's root is .ap235 with its data-screen-label.
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

const PAGE = '<div class="ap235-page">' + [28, 92, 88, 95, 60, 90, 84, 93, 70, 89, 91, 55, 80, 66, 88, 74].map((w) => `<i style="width:${w}%"></i>`).join('') + '</div>';
const WIDE = 'assets/t235-maren-wide.jpg';
const TALL = 'assets/t235-maren-tall.jpg';
const MAREN = 'assets/t235-maren-tall.jpg';
const KEY_ART = 'assets/world-undersong.png';
const PLAN = 'ChatGPT plan &#183; uses Codex allowance';
const PROMPT = 'Maren Kest at the Vigil&#8217;s desk by lamplight, writing in the ledger, rain on the window and the harbour light beyond; wet oilskin, salt in her braids.';

const box = (on = true) => `<span class="ap235-box${on ? ' on' : ''}">${on ? CHECK : ''}</span>`;
const root = (label, width, height, inner) => `<div class="ap235" data-screen-label="${label}" style="width:${width}px;height:${height}px">${inner}</div>`;
const fact = (label, value) => `<div class="ap235-fact"><span>${label}</span><b>${value}</b></div>`;

// A block's picture card as 194g and 209 draw it, the picture slot now one per shape on.
const card = ({ tall, press, mark }) => `<div class="ap235-card">
<div class="ap235-top"><div class="ap235-shapes">
<figure><img class="ap235-wide" src="${WIDE}" alt=""><figcaption>Wide</figcaption></figure>
<figure>${tall ? `<img class="ap235-tall" src="${TALL}" alt="">` : '<span class="ap235-tall ap235-slot">9:16</span>'}<figcaption>Tall</figcaption></figure>
</div><div class="ap235-facts">${fact('Frame', 'Medium &#183; at the desk')}${fact('Rides', '1 reference')}${fact('Model', `Codex Image &#183; ${PLAN}`)}</div></div>
<div class="ap235-sec"><span class="ap235-h">In frame</span><div class="ap235-who"><img src="${MAREN}" alt=""><div><b>Maren Kest</b><span>Vigil night watch</span></div><span class="ap235-view">medium</span>${CHEVRON}</div></div>
<div class="ap235-sec"><span class="ap235-h">Prompt</span><p class="ap235-prompt">${PROMPT}</p></div>
${mark ? `<div class="ap235-mark"><i>!</i><span>${mark}</span></div>` : ''}
<div class="ap235-foot"><span class="ap235-btn">Remove</span><span class="grow"></span><span class="ap235-btn">Edit prompt</span><span class="ap235-btn pri">${press} &#183; ChatGPT plan</span></div>
</div>`;

const chapterWith = (inner) => `<div class="ap235-chapter">${PAGE}<aside class="ap235-panel"><div class="ap235-tabs"><span>Read</span><span class="on">Picture</span><span>Motion</span></div>${inner}</aside></div>`;

export const FRAMES = [
  ['a', 'Pictures: the shapes a production&#8217;s pictures are made in', 1360, 480, () => root(
    '235a Pictures, from the audiobook page: Wide and Tall each on or off, what is made in each, and Make 290 tall for every picture without one',
    1360, 480,
    `${PAGE}<div class="ap235-dim"></div><div class="ap235-sheet" style="top:56px;width:640px"><h3>Pictures &#183; The Ledger of Nights</h3><div class="sub">290 pictures</div><div class="ap235-opts">${[
      `<div class="ap235-opt"><span class="ap235-chk">${box()}<b>Wide</b></span><span class="ap235-ratio">16:9</span><span class="grow"></span><i>desktop &#183; tablet</i><em>290 made</em></div>`,
      `<div class="ap235-opt"><span class="ap235-chk">${box()}<b>Tall</b></span><span class="ap235-ratio">9:16</span><span class="grow"></span><i>phone</i><em>0 made</em></div>`,
      `<div class="ap235-opt"><b class="ap235-k">Model</b><span>Codex Image</span><span class="grow"></span><i>${PLAN}</i></div>`,
    ].join('')}</div><div class="ap235-make"><b>Tall &#183; 290 to make</b><span class="grow"></span><span class="ap235-btn pri">Make 290 tall</span></div><div class="ap235-foot"><span class="grow"></span><span class="ap235-btn">Done</span></div></div>`,
  )],

  ['b', 'A block&#8217;s picture in both shapes', 1360, 560, () => root(
    '235b The picture panel: the block&#8217;s picture made Wide and Tall, side by side, each the press that picks another; Make again makes both, Tall from the new Wide',
    1360, 560,
    chapterWith(card({ tall: true, press: 'Make again' })),
  )],

  ['c', 'Tall not made yet', 1360, 560, () => root(
    '235c The same block before its Tall is made: the Tall slot is dashed with its ratio, and the press reads Make tall',
    1360, 560,
    chapterWith(card({ tall: false, press: 'Make tall' })),
  )],

  ['d', 'Export &#8594; Arke Player: both shapes, and the picture size', 1360, 820, () => root(
    '235d The Export sheet with Arke Player chosen: Pictures counts each shape, and Size picks the long side every picture ships at, re-estimating the package',
    1360, 820,
    `${PAGE}<div class="ap235-dim"></div><div class="ap235-sheet" style="top:36px;width:720px"><h3>Export audiobook &#183; The Ledger of Nights</h3><div class="sub">23 of 23 chapters read &#183; 5:33:30</div><div class="ap235-opts">${[
      `<div class="ap235-opt"><b class="ap235-k">World</b><img class="ap235-art" src="${KEY_ART}" alt=""><span>The Undersong</span><span class="grow"></span><i>key art &#183; logline</i></div>`,
      `<div class="ap235-opt"><b class="ap235-k">Book</b><span class="ap235-chk">${box()}The book</span><span class="grow"></span><i>23 chapters &#183; EPUB</i></div>`,
      `<div class="ap235-opt"><b class="ap235-k">Narration</b><span>23 of 23 &#183; read whole</span><span class="grow"></span><i>Chapters 1&#8211;23</i></div>`,
      `<div class="ap235-opt"><b class="ap235-k">Pictures</b><span>290 wide &#183; 290 tall</span><span class="grow"></span><i>cover before the first</i></div>`,
      `<div class="ap235-opt"><b class="ap235-k">Size</b><span class="ap235-seg"><span>Full</span><span class="on">1280 px</span><span>960 px</span></span><span class="grow"></span><i>long side</i></div>`,
      `<div class="ap235-opt"><b class="ap235-k">Text</b><span>Phrases, timed</span><span class="grow"></span><i>words timed in 23 of 23</i></div>`,
      `<div class="ap235-opt"><b class="ap235-k">Edition</b><span class="ap235-field">23 Oct 2026</span><span class="grow"></span></div>`,
    ].join('')}</div><div class="ap235-est"><b style="font-weight:600">~432 MB &#183; ~5 min on this machine</b><span class="m">23 chapters &#183; 580 pictures &#183; the book</span></div><div class="ap235-foot"><span class="grow"></span><span class="ap235-btn">Cancel</span><span class="ap235-btn pri">Make package</span></div></div>`,
  )],
];
