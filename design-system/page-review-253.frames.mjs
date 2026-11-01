// Turn 253 · The page review (SPEC-064 R-67 – R-73, revision 8). The frames are turn 251's Pages in
// its own markup: the rail, head, strip, editor and side are 247's classes sized by 251's rule; only
// the second verdict, the review's findings and the cleared writing are new. The book is 247's
// sample, The Undersong's Low Water drawn, page 3 in the Feature layout. Counts are samples.
const svg = (d, w = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const CHECK = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 3);
const ALERT = svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>');
const X = svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>');
const DOWN = svg('<path d="m6 9 6 6 6-6"/>');
const PLUS = svg('<path d="M12 5v14M5 12h14"/>');

const rail = () => `<div class="gn247-rail"><div class="t">Low Water, drawn</div><div class="k">Graphic novel</div>${[
  ['Dashboard'], ['Cast', '4'], ['Develop'], ['Overview', 'v2'], ['Chapters', '6'], ['Pages', '24'],
].map(([label, n]) => `<a class="${label === 'Pages' ? 'on' : ''}">${label}${n ? `<span>${n}</span>` : ''}</a>`).join('')}<hr><a>Artifacts<span>31</span></a></div>`;
const head = () => `<div class="gn247-head"><h2>Pages</h2><span class="gn247-tabs"><span class="on">1 · The tide</span><span>2 · Salt</span><span>3 · The bell</span></span><span class="grow"></span><span class="gn247-sel"><b>Reading</b>Left to right${DOWN}</span><span class="gn247-btn">Read</span><span class="gn247-btn">Export</span></div>`;

const FEATURE = [{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }];
const PICS = ['assets/saltlight-shot15.png', 'assets/char-maren.png', 'assets/drowned-quarter.png'];
const pct = (n) => `${(n * 100).toFixed(2)}%`;
const at = (r) => `left:calc(${pct(r.x)} + 6px);top:calc(${pct(r.y)} + 6px);width:calc(${pct(r.w)} - 12px);height:calc(${pct(r.h)} - 12px)`;
const comic = (lettering, extra = '') => `<div class="gn247-comic">${FEATURE.map((r, i) => `<div class="p" style="${at(r)}"><img src="${PICS[i]}" alt=""></div>`).join('')}${lettering}${extra}</div>`;
const LETTERS = '<div class="gn247-bal cap" style="left:5%;top:4%;max-width:46%">The tide came in grey.</div><div class="gn247-bal" style="left:8%;top:55%;max-width:34%">Where are you?</div><div class="gn247-bal sfx" style="left:62%;top:80%">Hsssh</div>';
const hit = (label, box, warn) => `<div class="gn247-hit${warn ? ' w' : ''}" style="${box}"><span class="t">${label}</span></div>`;

const chip = (name, img) => `<span class="gn247-chip${img ? '' : ' plain'}">${img ? `<img src="${img}" alt="">` : ''}${name}</span>`;
const line = (kind, who, words) => `<div class="gn247-row"><span class="gn247-kind">${kind}${DOWN}</span><span class="gn247-who">${who}</span><span class="gn247-words">${words}</span></div>`;
const lay = (label, rects, on) => `<div class="gn247-lay${on ? ' on' : ''}"><i>${rects.map((r) => `<u style="left:${2 + r.x * 32}px;top:${2 + r.y * 50}px;width:${r.w * 32 - 2}px;height:${r.h * 50 - 2}px"></u>`).join('')}</i>${label}</div>`;
const grid = (c, r) => Array.from({ length: c * r }, (_, i) => ({ x: (i % c) / c, y: Math.floor(i / c) / r, w: 1 / c, h: 1 / r }));
const LAYOUTS = `<div class="gn247-layouts">${[
  ['Grid', grid(2, 2)], ['Feature', FEATURE], ['Wide', grid(1, 3)], ['Splash', [{ x: 0, y: 0, w: 1, h: 1 }]],
  ['Manga', [{ x: 0, y: 0, w: .4, h: .35 }, { x: .4, y: 0, w: .6, h: .35 }, { x: 0, y: .35, w: 1, h: .3 }, { x: 0, y: .65, w: .6, h: .35 }, { x: .6, y: .65, w: .4, h: .35 }]],
  ['Webtoon', grid(1, 3)],
].map(([label, rects]) => lay(label, rects, label === 'Feature')).join('')}</div>`;
const editor = (p1 = 'Maren alone on the flooded pier at dawn, the lighthouse beam in the fog.', l1 = line('Caption', '—', 'The tide came in grey.')) => `<div class="gn247-edit"><h3>Page 3</h3>${LAYOUTS}
<div class="gn247-panel"><div class="gn247-ph"><b>Panel 1</b><span class="m">wide</span><span class="grow"></span><span class="m">1 line</span></div><div class="gn247-desc">${p1}</div><div class="gn247-row"><b>Shows</b>${chip('Maren', 'assets/char-maren.png')}${chip('The pier', 'assets/saltlight-shot15.png')}</div>${l1}<div class="gn247-more">+ Line</div></div>
<div class="gn247-panel"><div class="gn247-ph"><b>Panel 2</b><span class="grow"></span><span class="m">1 line</span></div><div class="gn247-desc">Maren close, collar up, calling out over the water.</div><div class="gn247-row"><b>Shows</b>${chip('Maren', 'assets/char-maren.png')}${chip('The pier', 'assets/saltlight-shot15.png')}</div>${line('Speech', 'Maren', 'Where are you?')}<div class="gn247-more">+ Line</div></div>
<div class="gn247-panel"><div class="gn247-ph"><b>Panel 3</b><span class="grow"></span><span class="m">1 line</span></div><div class="gn247-desc">The empty water. Something moves under the surface.</div>${line('Sound', '—', 'Hsssh')}<div class="gn247-more">+ Line</div></div>
<span class="gn247-btn sm" style="align-self:flex-start">${PLUS}Panel</span></div>`;

const strip = (three) => `<div class="gn247-strip">${[1, 2, 3, 4].map((n) => {
  if (n === 4) return `<div class="gn247-thumb empty"><span class="m">4</span></div>`;
  const pic = ['assets/scene4-shot13.png', 'assets/scene4-shot14.png', 'assets/saltlight-shot15.png'][n - 1];
  if (n < 3) return `<div class="gn247-thumb"><img src="${pic}" alt=""><span class="s">${CHECK}</span><span class="n">${n}</span></div>`;
  const mark = three === 'bad' ? `<span class="s x">${X}</span>` : three === 'warn' ? `<span class="s w">${ALERT}</span>` : `<span class="s">${CHECK}</span>`;
  return `<div class="gn247-thumb on"><img src="${pic}" alt="">${mark}<span class="n">${n}</span></div>`;
}).join('')}<div class="gn247-add">+ Page</div></div>`;

const takes = (n, on, marks) => `<div class="gn247-takes">${Array.from({ length: n }, (_, i) => `<div class="gn247-take${i === on ? ' on' : ''}"><img src="assets/saltlight-shot15.png" alt="">${marks[i] ? `<span class="k${marks[i] === 'w' ? ' w' : ''}"></span>` : ''}</div>`).join('')}<span class="m">Take ${on + 1} of ${n}</span></div>`;

// Two verdicts, one per check, stacked as one block: Lettering, then Picture.
const verdicts = (rows) => `<div class="gn253-verdicts">${rows.map(([tone, icon, label, count, by]) => `<div class="gn253-v ${tone}">${icon}<b>${label}</b><span>${count}</span><span class="grow"></span><span class="m">${by}</span></div>`).join('')}</div>`;
const finds = (rows) => `<div class="gn247-finds">${rows.map(([kind, what, tail = '', cls = '']) => `<div class="gn247-find${cls ? ' ' + cls : ''}"><span class="k${kind.w ? ' w' : ''}">${kind.label}</span><span class="gn253-what">${what}</span>${tail}</div>`).join('')}</div>`;
const B = (label) => ({ label });
const W = (label) => ({ label, w: true });

// The page column is as wide as the page needs to stand at full height above its controls (251's rule).
const screen = (label, side, three, controls, edit = editor()) => {
  const width = 1360; const height = 850;
  const pageH = height - 56 - 32 - controls;
  const sideW = Math.round(pageH * 2 / 3) + 36;
  return `<div class="gn247 gn251 gn253" data-screen-label="${label}" style="width:${width}px;height:${height}px">${rail()}<div class="gn247-main">${head()}<div class="gn247-body" style="grid-template-columns:136px minmax(440px,1fr) ${sideW}px">${strip(three)}${edit}<div class="gn247-side gn251-side">${side}</div></div></div></div>`;
};

export const FRAMES = [
  ['a', 'Two checks: the words and the picture', () => screen("253a The lettering passes but the picture review finds two faults: a caption about a pen drawn over Maren at the rail, and faces in the water no panel asks for. Both are boxed on the page and listed; Accept waits; Make again and Accept anyway stay",
    `${comic(LETTERS.replace('The tide came in grey.', 'She stopped the pen before the hook.'), hit('Caption', 'left:2%;top:5%;width:96%;height:43%') + hit('Defect', 'left:52%;top:56%;width:44%;height:22%'))}
${verdicts([['ok', CHECK, 'Lettering', '3 of 3', 'Claude Opus 5.5'], ['bad', X, 'Picture', '2 to fix', 'Claude Opus 5.5']])}
${finds([[B('Caption'), 'Panel 1 &#183; a pen, but the pier'], [B('Defect'), 'Panel 3 &#183; faces in the water']])}
${takes(2, 1, ['w', 'w'])}
<div class="gn247-acts"><span class="gn247-btn pri">Make again</span><span class="gn247-btn">Accept anyway</span></div>`, 'bad', 318,
    editor('Maren alone on the flooded pier at dawn, the lighthouse beam in the fog.', line('Caption', '—', 'She stopped the pen before the hook.')))],

  ['b', 'Writing in the scene is part of the picture', () => screen("253b The ledger's own handwriting in panel 1 reads as text the script did not letter; the review finds the panel's description calls for the ledger, so the line is cleared and shown struck through with the reason. Both checks pass and Accept is offered",
    `${comic(LETTERS, '<div class="gn253-ink" style="left:58%;top:20%">neap &#8212; called it back</div>' + hit('Writing', 'left:56%;top:17%;width:38%;height:9%', true))}
${verdicts([['ok', CHECK, 'Lettering', '3 of 3', 'Claude Opus 5.5'], ['ok', CHECK, 'Picture', 'as written', 'Claude Opus 5.5']])}
${finds([[W('Writing'), '<s>neap &#8212; called it back</s>', '<span class="m">the ledger, in the scene</span>', 'gn253-clear']])}
${takes(1, 0, ['ok'])}
<div class="gn247-acts"><span class="gn247-btn pri">Accept</span><span class="gn247-btn">Make again</span></div>`, 'ok', 282,
    editor('The 1820 ledger open on the desk under the lamp, its March page in brown ink; Maren’s hand flat beside it.', line('Caption', '—', 'The tide came in grey.')))],

  ['c', 'Warnings: looked at, not fixed', () => screen("253c Both checks pass with two warnings: Maren's collar differs from the page before, and Bray's face is unlike his reference. Each has Seen; Accept is offered and the warnings stay on the page record until seen",
    `${comic(LETTERS, hit('Continuity', 'left:6%;top:56%;width:38%;height:30%', true) + hit('Likeness', 'left:62%;top:8%;width:30%;height:30%', true))}
${verdicts([['ok', CHECK, 'Lettering', '3 of 3', 'Claude Opus 5.5'], ['warn', ALERT, 'Picture', '2 to look at', 'Claude Opus 5.5']])}
${finds([[W('Continuity'), 'Panel 2 &#183; Maren&#8217;s collar, page 2', '<span class="gn247-btn sm">Seen</span>'], [W('Likeness'), 'Panel 1 &#183; Bray', '<span class="gn247-btn sm">Seen</span>']])}
${takes(1, 0, ['w'])}
<div class="gn247-acts"><span class="gn247-btn pri">Accept</span><span class="gn247-btn">Make again</span></div>`, 'warn', 318)],

  ['d', 'The picture is not checked, and says why', () => screen("253d No picture reviewer is set: the Picture line says Not checked and why, beside a passing Lettering line. Choose reviewer opens Settings at the page reviewer; Check again reads it once one is set; Accept anyway stays",
    `${comic(LETTERS)}
${verdicts([['ok', CHECK, 'Lettering', '3 of 3', 'Claude Opus 5.5'], ['warn', ALERT, 'Picture', 'not checked', 'no reviewer']])}
${takes(1, 0, ['w'])}
<div class="gn247-acts"><span class="gn247-btn pri">Choose reviewer</span><span class="gn247-btn">Accept anyway</span><span class="gn247-btn ghost">Check again</span></div>`, 'warn', 236)],
];
