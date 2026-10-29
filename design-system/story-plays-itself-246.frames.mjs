// Turn 246 · A story plays itself: the frames. The voiced samples are The Undersong's The Lantern
// Road, as 174 drew it (Maren, Bray and the narrator, its pictures already in assets/). The unvoiced
// samples are The Red Quiet: First Contact as it stands — no voices, its own stills (copied to
// assets/t246-fc-*.jpg; the world is not written), its scenes, lines, choices and its eight links.
// Progress, walked state and the not-walked count are samples. Every frame's root is .sp246 with its
// data-screen-label.
const sv = (d, size = 18, fill = false) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="${fill ? 'none' : 'currentColor'}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const PAUSE = sv('<rect x="6" y="4.5" width="4" height="15" rx="1.2"></rect><rect x="14" y="4.5" width="4" height="15" rx="1.2"></rect>', 20, true);
const PLAY = (size = 20) => sv('<path d="M7.5 4.9v14.2a.9.9 0 0 0 1.4.75l10.9-7.1a.9.9 0 0 0 0-1.5L8.9 4.15a.9.9 0 0 0-1.4.75z"></path>', size, true);
const BACK = sv('<path d="M18.5 19.2 9.6 12.6a.75.75 0 0 1 0-1.2l8.9-6.6a.75.75 0 0 1 1.2.6v13.2a.75.75 0 0 1-1.2.6z"></path><path d="M5 5v14"></path>', 20);
const SPEECH_HEAD = '<path d="M8.8 20v-4.1l1.9.2a2.3 2.3 0 0 0 2.164-2.1V8.3A5.37 5.37 0 0 0 2 8.25c0 2.8.656 3.054 1 4.55a5.77 5.77 0 0 1 .029 2.758L2 20"></path>';
const NARRATION = sv(SPEECH_HEAD + '<path d="M19.8 17.8a7.5 7.5 0 0 0 .003-10.603"></path><path d="M17 15a3.5 3.5 0 0 0-.025-4.975"></path>', 17);
const NARRATION_OFF = sv(SPEECH_HEAD + '<path d="m15.5 9 6 6"></path><path d="m21.5 9-6 6"></path>', 17);
const LOG = sv('<path d="M3 12h.01"></path><path d="M3 18h.01"></path><path d="M3 6h.01"></path><path d="M8 12h13"></path><path d="M8 18h13"></path><path d="M8 6h13"></path>', 16);
const ROUTE = sv('<line x1="6" x2="6" y1="3" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path>', 16);
const FULL = sv('<path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M21 8V5a2 2 0 0 0-2-2h-3"></path><path d="M3 16v3a2 2 0 0 0 2 2h3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path>');
const DOT = sv('<circle cx="12" cy="12" r="4"></circle>', 14, true);
const DOT_SM = sv('<circle cx="12" cy="12" r="4"></circle>', 10, true);
const MAP = sv('<rect width="7" height="7" x="3" y="3" rx="1"></rect><rect width="7" height="7" x="14" y="14" rx="1"></rect><path d="M10 6.5h4a3 3 0 0 1 3 3V14"></path>', 15);
const GRID = sv('<rect width="7" height="7" x="3" y="3" rx="1"></rect><rect width="7" height="7" x="14" y="3" rx="1"></rect><rect width="7" height="7" x="14" y="14" rx="1"></rect><rect width="7" height="7" x="3" y="14" rx="1"></rect>', 17);
const USERS = (size = 17) => sv('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>', size);
const CHAT = sv('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>', 17);
const BOOK = sv('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>', 17);
const BRANCH = (size = 17) => sv('<line x1="6" x2="6" y1="3" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path>', size);
const PLUS = sv('<path d="M5 12h14"></path><path d="M12 5v14"></path>', 17);
const CHEVRON_LEFT = sv('<path d="m15 18-6-6 6-6"></path>', 17);
const BELL = sv('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path>', 17);
const GEAR = sv('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle>', 17);
const USER = sv('<circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path>', 17);
const PLAY_OUTLINE = sv('<polygon points="6 3 20 12 6 21 6 3"></polygon>', 16);
const X = sv('<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>', 18);
const ARROW = sv('<path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path>', 14);
const DIAMOND = sv('<path d="M12 4 20 12 12 20 4 12z"></path>', 12);
const MORE = sv('<circle cx="5" cy="12" r="1.2"></circle><circle cx="12" cy="12" r="1.2"></circle><circle cx="19" cy="12" r="1.2"></circle>', 14);

const LANTERN = 'The Lantern Road';
const FIRST_CONTACT = 'The Red Quiet: First Contact';

const player = (label, inner) => `<div class="sp246 sp246-pl" data-screen-label="${label}" style="width:1280px;height:776px">${inner}</div>`;
const strip = (from, notWalked) => `<div class="sp246-strip"><span class="t">Preview</span><span class="m">from ${from}</span><span class="sp"></span><span class="n">${DOT}${notWalked} choices not walked</span><span class="sp246-sbtn">${MAP}Branch map</span><span class="sp246-sbtn">Close preview <span class="sp246-kbd">Esc</span></span></div>`;
const stage = (inner) => `<div class="sp246-stage">${inner}</div>`;
const pic = (src, position = '50% 50%') => `<img class="sp246-pic" src="${src}" alt="" style="object-position:${position}">`;
const top = (eyebrow, scene) => `<div class="sp246-scrim-top"></div><div class="sp246-top"><div class="sp246-eyebrow">${eyebrow}</div><div class="sp246-scene">${scene}</div></div>`;
const box = (who, line, { lift = false, nar = false } = {}) => `<div class="sp246-box${lift ? ' lift' : ''}">${who ? `<span class="sp246-who">${who}</span>` : ''}<div class="sp246-line${nar ? ' nar' : ''}">${line}</div></div>`;
// The beat ticks: beats read are full, the current one fills as it plays, the rest wait.
const ticks = (count, current, pct, inbar = false) => `<div class="sp246-ticks${inbar ? ' inbar' : ''}">${Array.from({ length: count }, (_, i) => i < current ? '<i class="done"></i>' : i === current ? `<i><b style="width:${pct}%"></b></i>` : '<i></i>').join('')}</div>`;
// 156a's film bar, for a visual novel: Play/Pause, Back, Narration where there are voices, the
// ticks at its centre, then Log, Route and Full screen.
const bar = ({ paused = false, narration = 'on' } = {}) => `<div class="sp246-bar"><span class="sp246-ib" title="${paused ? 'Play' : 'Pause'}">${paused ? PLAY() : PAUSE}</span><span class="sp246-ib" title="Back">${BACK}</span>${narration ? `<span class="sp246-pill ${narration}" title="Narration">${narration === 'on' ? NARRATION : NARRATION_OFF}Narration</span>` : ''}<span class="sp"></span><span class="sp246-pill">${LOG}Log</span><span class="sp246-pill">${ROUTE}Route</span><span class="sp246-ib" title="Full screen">${FULL}</span></div>`;

const MAREN = 'Somebody lit a window down there. <span class="rest">Nobody lives in the quarter now.</span>';
const lantern = (shown, over, after) => stage(`${pic('assets/art-direction-illustrated.png', '30% 30%')}${over}${shown ? top(LANTERN, 'The drowned quarter') : ''}<div class="sp246-scrim-bot"></div>${after}`);

// The Branch Map, First Contact's first six scenes. Canvas coordinates; nodes are 182 × 112.
const NODES = [
  ['01', 'Six places at the table', 40, 56, '9 beats'],
  ['02', 'Open hands', 385, 56, '9 beats'],
  ['03', 'The last ordinary shift', 730, 56, '8 beats'],
  ['04', 'Something below the floor', 40, 340, '7 beats'],
  ['05 &#183; C1', 'The first name on the board', 385, 340, '2 choices'],
  ['06', 'The second lift', 730, 340, '10 beats'],
];
// A link: the line and its note, small and muted beside it, no pill.
const LINKS = [
  ['M222,112 L383,112', 303.5, 104, 'Go to the landing markers'],
  ['M567,112 L728,112', 648.5, 104, 'Several weeks later', true],
  ['M821,168 C821,268 131,240 131,338', 476, 246, 'Check the lower inspection wall'],
  ['M222,396 L383,396', 303.5, 388, 'Reach the evacuation landing'],
];
// Choices keep 240's pills.
const CHOICES = [
  ['M567,376 C620,270 680,270 728,374', 648, 296, 'Return with Ana for Elsie', '', false],
  ['M567,416 C620,522 680,522 728,418', 648, 496, 'Seal the shaft and leave Elsie', `${DIAMOND}<small>1 value</small>`, true],
];
const branchMap = () => {
  const edges = `<svg class="sp246-edges" width="952" height="640" viewBox="0 0 952 640"><defs><marker id="sp246-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z" fill="currentColor"></path></marker><marker id="sp246-arrow-sel" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 10 5 0 10z" style="fill:var(--foreground)"></path></marker></defs>${[
    ...LINKS.map(([d, , , , sel]) => `<path d="${d}"${sel ? ' class="sel" marker-end="url(#sp246-arrow-sel)"' : ' marker-end="url(#sp246-arrow)"'}></path>`),
    ...CHOICES.map(([d, , , , , not]) => `<path d="${d}"${not ? ' class="not"' : ''} marker-end="url(#sp246-arrow)"></path>`),
  ].join('')}</svg>`;
  const nodes = NODES.map(([num, title, x, y, foot]) => `<div class="sp246-node" style="left:${x}px;top:${y}px"><div class="num"><span>${num}</span>${MORE}</div><strong>${title}</strong><div class="foot">${foot}</div></div>`).join('');
  const links = LINKS.map(([, x, y, note, sel]) => `<div class="sp246-link${sel ? ' sel' : ''}" style="left:${x}px;top:${y}px">${note}</div>`).join('');
  const pills = CHOICES.map(([, x, y, label, extra]) => `<div class="sp246-edge" style="left:${x}px;top:${y}px">${label}${extra}</div>`).join('');
  return `<div class="sp246-canvas">${edges}${nodes}${links}${pills}<div class="sp246-mapfoot"><span>&#8211;</span><span>Fit</span><span>100%</span><span>+</span><span style="color:var(--muted-foreground)">Solid: walked &#183; dashed: not walked</span></div></div>`;
};

export const FRAMES = [
  ['a', 'Preview plays: the controls hidden', 1280, 776, 'player', () => player(
    '246a Preview plays by itself: the picture, the line as its voice reads it, and the beat&#8217;s tick filling; no controls, no tap',
    strip('The drowned quarter', 3) + lantern(false, '', box('Maren', MAREN) + ticks(6, 2, 55)),
  )],

  ['b', 'A click shows the controls', 1280, 776, 'player', () => player(
    '246b A click shows the controls as a film&#8217;s: Pause, Back, Narration, the ticks, Log, Route and Full screen; the line sits above the bar',
    strip('The drowned quarter', 3) + lantern(true, '', box('Maren', MAREN, { lift: true }) + ticks(6, 2, 55, true) + bar()),
  )],

  ['c', 'Paused', 1280, 776, 'player', () => player(
    '246c Paused: the bar stays, with Play, and a Play at the centre; the line waits where it stopped',
    strip('The drowned quarter', 3) + lantern(true, '<div class="sp246-dim deep"></div>', `<span class="sp246-big" title="Play">${PLAY(30)}</span>` + box('Maren', MAREN, { lift: true }) + ticks(6, 2, 55, true) + bar({ paused: true })),
  )],

  ['d', 'Narration off: each beat holds for its reading time', 1280, 776, 'player', () => player(
    '246d Narration off: the line is read, not heard, and the beat holds for its reading time before the story moves on',
    strip('The drowned quarter', 3) + stage(`${pic('assets/world-undersong.png', '50% 40%')}${top(LANTERN, 'The drowned quarter')}<div class="sp246-scrim-bot"></div>${box('', 'Far out, past the bell towers, the lighthouse turned once and went dark.', { lift: true, nar: true })}${ticks(6, 4, 35, true)}${bar({ narration: 'off' })}`),
  )],

  ['e', 'It stops for a choice of two', 1280, 776, 'player', () => player(
    '246e First Contact stops at The first name on the board: two ways on, the last line kept, nothing counting down',
    strip('Six places at the table', 24) + stage(`${pic('assets/t246-fc-first-name.jpg')}<div class="sp246-dim"></div>${top(FIRST_CONTACT, 'The first name on the board')}<div class="sp246-scrim-bot"></div><div class="sp246-choices" style="bottom:200px"><div class="sp246-choice focus"><span class="k">1</span><span class="l">Return with Ana for Elsie</span></div><div class="sp246-choice"><span class="k">2</span><span class="l">Seal the shaft and leave Elsie</span><span class="sp246-chip">${DOT_SM}not walked</span></div></div>${box('', 'Dev puts his hand on the emergency barrier. Ana waits beside me with the trauma case. The telemetry gives Elsie&#8217;s name in full.', { nar: true })}${ticks(5, 5, 0)}`),
  )],

  ['f', 'A story without voices: no Narration', 1280, 776, 'player', () => player(
    '246f First Contact has no voices: the bar has no Narration, and each beat holds for its reading time',
    strip('Six places at the table', 24) + stage(`${pic('assets/t246-fc-open-hands.jpg')}${top(FIRST_CONTACT, 'Open hands')}<div class="sp246-scrim-bot"></div>${box('', 'They come across the cleared plain in a loose line. Through the scope I can see their hands. Every hand I can see is empty.', { lift: true, nar: true })}${ticks(9, 0, 40, true)}${bar({ narration: null })}`),
  )],

  ['g', 'Branch Map: a lone link drawn plainly', 1360, 850, 'map', () => `<div class="sp246 sp246-bm" data-screen-label="246g Branch Map: a lone way on is a link, drawn as a plain line with its note; its inspector says Plays through" style="width:1360px;height:850px"><div class="sp246-head"><span class="where">The Red Quiet &#183; First Contact</span><span class="brand"><b>Arke</b><span>Studio</span></span><span class="tools">${CHAT}${BELL}${GEAR}${USER}</span></div><div class="sp246-bmbody"><div class="sp246-rail"><span class="mark">R</span><span class="ri">${GRID}</span><span class="ri">${USERS()}</span><span class="ri">${CHAT}</span><span class="ri">${BOOK}</span><span class="cur">${BRANCH()}</span><span class="ri">${PLUS}</span><span class="grow"></span><span class="ri">${CHEVRON_LEFT}</span></div><div class="sp246-main"><div class="sp246-mhead"><div class="grow"><div class="sp246-h1">Branch map</div><p>First Contact &#183; 15 scenes &#183; 31 choices &#183; 8 links</p></div><span class="sp246-btn">${USERS(16)}Story facts</span><span class="sp246-btn">${PLAY_OUTLINE}Preview</span><span class="sp246-btn primary">Export</span></div><div class="sp246-context">${BRANCH(16)}Story rules &#183; authored values and conditions<span class="grow"></span>Inspect route</div>${branchMap()}</div><div class="sp246-insp"><div class="sp246-tabs"><span class="on">Link</span><span>Arke</span><span class="x">${X}</span></div><div class="sp246-ipad"><div class="eb">Open hands</div><div class="sp246-h2">Several weeks later</div><div class="ft">Open hands &#8594; The last ordinary shift</div><span class="sp246-plays">${ARROW}Plays through</span><hr><div class="sp246-field"><b>Note</b><div class="sp246-input">Several weeks later</div></div><hr><div class="sp246-kv"><span>Available when</span>Always</div><div class="sp246-kv"><span>Remember</span>Nothing</div><div class="sp246-kv"><span>Preview</span>Walked</div></div><div class="sp246-ifoot"><span class="sp246-btn">Edit link</span></div></div></div><div class="sp246-status"><span class="dot"></span>Connected &#183; First Contact<span class="grow"></span>The Red Quiet &#183; production-scoped</div></div>`],

  ['h', 'A beat&#8217;s Advance: no On tap', 480, 612, 'beat', () => `<div class="sp246 sp246-bt" data-screen-label="246h A beat&#8217;s Advance keeps After the line and Hold; On tap goes" style="width:480px;height:612px"><div class="crumb">First Contact / Open hands</div><div class="sp246-h3">Beat 1 of 9</div><div class="lab">Who speaks</div><div class="sp246-who2"><span class="on">Narrator</span><span>Imani</span><span>Wei</span></div><div class="lab">Line</div><div class="sp246-text">They come across the cleared plain in a loose line. Through the scope I can see their hands. Every hand I can see is empty.</div><div class="sp246-meta">From the scene&#8217;s script &#183; narration</div><div class="lab">Voice</div><div class="sp246-voice">Not voiced</div><div class="lab">Advance</div><div class="sp246-seg"><span class="on">After the line</span><span>Hold 4s</span></div><div class="lab">Movement</div><div class="sp246-seg"><span>Slow push</span><span>Drift</span><span class="on">None</span></div></div>`],
];
