// Turn 271 · Panels and Words, the shorter path (SPEC-064; amends 269). From round 95 on 0.5.99: the
// review's words sat under the model picker and were cut off, Accept stayed on the same panel, a
// flagged panel stayed red once accepted, Place with Arke greyed out with no reason, two Undos, Accept
// page pushed off screen, and a Noir page printed orange sound words and cream captions.
import { ALERT, CHECK, DOWN, MAREN, NOIR, PIER, RIGHT, SPARK, STYLE, UNDO, WARN, WATER, art, bad, cell, faultSide, findings, head, held, ok, rail, script, strip, tabs, thumb } from './comic-arke-270.frames.mjs';

const screen = (label, main, height = 850) => `<div class="gn247 gn251 gn253 gn269 gn270 gn271" data-screen-label="${label}" style="width:1360px;height:${height}px">${rail}<div class="gn247-main">${main}</div></div>`;
const panelsBody = (...columns) => `<div class="gn247-body" style="grid-template-columns:136px minmax(440px,1fr) 372px">${columns.join('')}</div>`;
const wordsBody = (...columns) => `<div class="gn247-body" style="grid-template-columns:136px 440px minmax(0,1fr)">${columns.join('')}</div>`;

const balloon = (kind, left, top, width, words, n, picked = false) => `<div class="gn269-bal ${kind}${picked ? ' picked' : ''}" style="left:${left}%;top:${top}%;width:${width}%">${words}${n ? `<i class="ord">${n}</i>` : ''}</div>`;
const tails = list => `<svg class="gn269-tails" viewBox="0 0 100 100" preserveAspectRatio="none">${list.map(p => `<polygon points="${p}"/>`).join('')}</svg>`;
const lineCard = (n, kind, who, words, placed, panel) => `<div class="gn269-line"><i class="ord">${n}</i><div class="body"><div class="top"><span class="gn247-kind">${kind}${DOWN}</span><span class="gn247-who">${who}</span><span class="grow"></span><span class="m">Panel ${panel}</span>${placed ? `<span class="gn269-mark ok">${CHECK}</span>` : '<span class="gn269-mark none"></span>'}</div><span class="gn247-words">${words}</span></div></div>`;
const lines = placed => `<div class="gn271-scroll">${lineCard(1, 'Caption', '—', 'She stopped the pen before the hook.', placed, 1)}${lineCard(2, 'Speech', 'Maren', 'Where are you?', placed, 2)}${lineCard(3, 'Sound', '—', 'Hsssh', placed, 3)}</div>`;
const lettering = `<div class="gn269-tool"><span class="grow"></span><span class="gn247-sel"><b>Lettering</b>Comic${DOWN}</span></div>`;
// Clean crops of the style sample: its own lettering stays outside them, so no words but the placed ones show.
const crop = (size, x, y) => `<div class="gn271-crop" style="background-image:url(${NOIR});background-size:${size}%;background-position:${x}% ${y}%"></div>`;
const noirCells = `${cell(0, crop(106, 50, 3))}${cell(1, crop(333, 5, 88))}${cell(2, crop(600, 74, 96))}`;
const NOIR_SPEECH = [5, 87, '19,87.5 24,87.5 32,71'];
const paintedCells = `${cell(0, art(PIER))}${cell(1, art(MAREN))}${cell(2, art(WATER))}`;
// The speech balloon sits clear of the face in each sample, as 271's rule asks of the placer.
const placed = (marks = true, speech = [7, 53, '18,57.5 22,57.5 25,61']) => `${tails([speech[2]])}${balloon('cap', 4, 3, 50, 'She stopped the pen before the hook.', marks ? 1 : 0)}${balloon('speech', speech[0], speech[1], 34, 'Where are you?', marks ? 2 : 0)}${balloon('sfx', 70, 82, 15, 'Hsssh', marks ? 3 : 0)}`;

const movedSide = `<div class="gn247-side gn251-side">${tabs('panels')}<div class="gn247-comic gn271-page">${cell(0, art(PIER))}${cell(1, art(MAREN))}${cell(2, art(WATER), 'picked')}<div class="gn247-hit" style="left:62%;top:70%;width:24%;height:14%"><span class="t">Detail</span></div></div>
<div class="gn271-verdict bad"><div class="top">${ALERT}<b>Panel 3</b><span>1 to fix</span><span class="grow"></span><span class="m">1 of 1</span></div>${findings([['Detail', 'A second bell on the desk. The script has one, on the wall.']])}</div>
<div class="gn269-taking"><div class="gn247-takes"><div class="gn247-take gn269-wide on"><img src="${WATER}" alt=""><span class="k w"></span></div><span class="m">Take 1 of 1</span></div></div>
<div class="gn247-acts"><span class="gn247-btn pri">${SPARK}Make again</span><span class="gn247-btn">Accept anyway</span><span class="gn247-btn">Change with Arke</span></div>
<div class="gn271-foot"><span class="m">3 of 3</span><span class="gn271-model">GPT Image 2${DOWN}</span><span class="grow"></span><span class="gn247-btn ghost sm">Brief</span></div></div>`;

export const frames = [
  {
    id: '271a', title: 'Panels: the fault, whole, under the page', width: 1360, height: 850,
    markup: screen('271a The review sits straight under the page and its words wrap in full. A count steps to the next fault. Model and Brief drop to one line at the foot', `${head()}${panelsBody(strip([thumb(1, 'assets/scene4-shot13.png', 'ok'), thumb(2, PIER, 'x', true), thumb(3), thumb(4)]), script(2, [ok, bad, bad], 2), faultSide())}`),
  },
  {
    id: '271b', title: 'Accept anyway: on to the next fault', width: 1360, height: 850,
    markup: screen('271b Accept anyway moves to the next fault on the page. The accepted panel turns from red to an amber mark, with what was found kept on the record', `${head()}${panelsBody(strip([thumb(1, 'assets/scene4-shot13.png', 'ok'), thumb(2, PIER, 'x', true), thumb(3), thumb(4)]), script(2, [ok, held, bad], 3), movedSide)}`),
  },
  {
    id: '271c', title: 'Words: says what is in the way', width: 1360, height: 850,
    markup: screen('271c Until every panel is accepted, the row says how many are left and goes to them, in place of a greyed Place with Arke', `${head()}${wordsBody(strip([thumb(1, 'assets/scene4-shot13.png', 'ok'), thumb(2, PIER, 'x', true), thumb(3), thumb(4)]), `<div class="gn247-edit gn269-lines"><h3>Page 2<span class="grow"></span><span class="m">0 of 3 placed</span>${tabs('words')}</h3><div class="gn271-blocked">${ALERT}<b>2 panels to accept</b><span class="grow"></span><span class="gn247-btn pri">Panels${RIGHT}</span></div>${lines(false)}${lettering}<div class="gn269-verdict"><span class="gn269-mark none"></span><b>3 lines to place</b><span class="grow"></span><span class="gn247-btn off">Accept page</span></div></div>`, `<div class="gn269-stage"><div class="gn247-comic gn269-big">${paintedCells}</div></div>`)}`),
  },
  {
    id: '271d', title: 'Words: one Undo, Accept page stays put', width: 1360, height: 850,
    markup: screen('271d After placing there is one Undo and it steps back the last change, whether Arke made it or the author did. The lines scroll; Accept page stays at the foot. A black-and-white style prints black-and-white words', `${head('Panel by panel', ['Noir', NOIR])}${wordsBody(strip([thumb(1, NOIR, 'ok'), thumb(2, NOIR, '', true), thumb(3), thumb(4)]), `<div class="gn247-edit gn269-lines"><h3>Page 2<span class="grow"></span><span class="m">3 of 3 placed</span>${tabs('words')}</h3><div class="gn269-placed">${SPARK}<b>Arke placed 3 lines</b><span class="grow"></span><span class="gn247-btn sm">${UNDO}Undo</span></div>${lines(true)}${lettering}<div class="gn269-verdict"><span class="gn269-mark ok">${CHECK}</span><b>Every line placed</b><span class="grow"></span><span class="gn247-btn pri">Accept page</span></div></div>`, `<div class="gn269-stage"><div class="gn247-comic gn269-big gn271-mono">${noirCells}${placed(true, NOIR_SPEECH)}</div></div>`)}`),
  },
  {
    id: '271e', title: 'Lettering follows the style', width: 1360, height: 600,
    markup: `<div class="gn247 gn269 gn271 gn271-pair" data-screen-label="271e Two pages side by side. Noir prints white captions and black sound words; Painted keeps cream captions and orange sound words" style="width:1360px;height:600px"><figure><div class="gn247-comic gn271-pairpage gn271-mono">${noirCells}${placed(false, NOIR_SPEECH)}</div><figcaption>Noir</figcaption></figure><figure><div class="gn247-comic gn271-pairpage">${paintedCells}${placed(false)}</div><figcaption>Painted</figcaption></figure></div>`,
  },
];
