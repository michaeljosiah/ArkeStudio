// Turn 250 · Arke hears a read, revised 29 October 2026 and corrected the same day: the frames.
//
// Nothing that already exists is drawn from memory any more. The page beside the chat is a
// picture of today's app (main at 50b479f19), shot at 2x in light and dark with the Chat panel
// open, from a scratch dev root holding a stand-in for The Red Quiet (the six miners and First
// Contact's fifteen scenes, scenes 1 and 2 laid out as the table read checked them): the world
// home behind World Chat (250a–d), and scene 1's and scene 2's beats behind Builder Chat (250e,
// 250f). The panel itself is HTML, matched to the shipped panel's measured styles, because the
// new cards sit inside it; the same conversations, without the cards, were shot in the real
// panel to set beside these frames. New in each frame: the cards, and the words of the receipt
// line under a reply (the line exists in the client; World Chat shows none today).
//
// The samples are unchanged: the six miners as a Claude Code session auditioned them that
// morning (duration, words a minute, median pitch and its middle 80 % from that session's
// measures.json; the pauses at full stops measured again from the same audio), and scenes 1 and
// 2 as a second session voiced and checked them (narrate/checks.json, flags.json). Scene 1's
// wrong voice and missing words, and 250f's loudness, are samples. Every frame's root is .ah250
// with its data-screen-label.
const sv = (d, size = 16, fill = false) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="${fill ? 'none' : 'currentColor'}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  play: (s = 9) => sv('<path d="M7.5 4.9v14.2a.9.9 0 0 0 1.4.75l10.9-7.1a.9.9 0 0 0 0-1.5L8.9 4.15a.9.9 0 0 0-1.4.75z"></path>', s, true),
  check: (s = 13) => sv('<path d="M20 6 9 17l-5-5"></path>', s),
  ear: (s = 13) => sv('<path d="M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0"></path><path d="M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4"></path>', s),
  spark: (s = 14) => sv('<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"></path>', s),
  down: (s = 16) => sv('<path d="m6 9 6 6 6-6"></path>', s),
  upc: (s = 16) => sv('<path d="m18 15-6-6-6 6"></path>', s),
  redo: (s = 13) => sv('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path>', s),
};
// The shipped panel's own icons, copied from the running client's DOM.
const P = {
  more: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg>',
  close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>',
  speaker: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>',
  attach: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>',
  mic: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" x2="12" y1="19" y2="22"></line></svg>',
  send: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"></path></svg>',
};

// ---- the miners' auditions, as measured ---------------------------------------------------------
// s: seconds; wpm over the voiced span; brief: the pace the brief states; hz, lo, hi: median pitch and
// its 10th–90th percentile; stops: the pause at each full stop inside the read, in seconds, measured
// in the sound; words: the brief's own words for the voice, cut to fit a cell.
const MINERS = {
  'imani-okoro': { name: 'Imani Okoro', pick: 'B', words: 17,
    why: 'A runs “home. Dev.” together, so the meaning changes.',
    A: { s: 5.3, wpm: 207, brief: 150, says: 'mid, warm', hz: 148, lo: 126, hi: 213, stops: [0, 0.37], join: 'home. Dev.' },
    B: { s: 5.1, wpm: 213, brief: 160, says: 'lower, fuller', hz: 149, lo: 95, hi: 238, stops: [0.64, 0], join: 'Dev. Wait' } },
  'dev-malik': { name: 'Dev Malik', pick: 'A',
    A: { s: 10.0, wpm: 165, brief: 150, hz: 104, lo: 87, hi: 133 },
    B: { s: 8.4, wpm: 196, brief: 165, hz: 139, lo: 61, hi: 178 } },
  'lin-wei': { name: 'Lin Wei', pick: 'B', words: 26,
    why: 'A was briefed the higher voice and reads 10 Hz under B.',
    A: { s: 10.0, wpm: 166, brief: 160, says: 'light tenor', hz: 97, lo: 84, hi: 127, stops: [0, 0.27, 0.47, 0.17], join: 'channel. Local' },
    B: { s: 9.6, wpm: 171, brief: 145, says: 'light baritone', hz: 107, lo: 85, hi: 127, stops: [0.67, 0.46, 0.65, 0.64] } },
  'ana-lucia-reyes': { name: 'Ana Lucía Reyes', pick: 'A' },
  'elsie-ward': { name: 'Elsie Ward', pick: 'A' },
  'tomas-vale': { name: 'Tomas Vale', pick: 'A', A: { s: 11.2, wpm: 176, brief: 140, hz: 107, lo: 84, hi: 144 } },
};
const ORDER = ['imani-okoro', 'dev-malik', 'lin-wei', 'ana-lucia-reyes', 'elsie-ward', 'tomas-vale'];
const IMG = slug => `assets/t250-${slug}.jpg`;
const VOICE = { A: '--voice-1', B: '--voice-2' };

// The rules the cards draw: under PAUSE_SEC (0.15 s) a stop has no pause, a run-on; under half the
// read's usual stop it is short. More than a fifth over the brief's pace is Fast. Two medians within
// 8 % of each other are Close.
const PAUSE_SEC = 0.15;
const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const stopKinds = stops => { const half = median(stops) / 2; return stops.map(p => p < PAUSE_SEC ? 'none' : p < half ? 'short' : 'ok'); };
const fast = c => c.wpm > c.brief * 1.2;
for (const slug of ['imani-okoro', 'lin-wei']) for (const l of ['A', 'B']) {
  const c = MINERS[slug][l], runs = stopKinds(c.stops).filter(k => k === 'none').length;
  if (Boolean(c.join) !== runs > 0) throw new Error(`${slug} ${l}: a run-on drawn without the measure, or the reverse`);
}

// ---- today's page, as a picture per theme --------------------------------------------------------
const CTX = { world: 'the world home', scene1: 'scene 1’s beats', scene2: 'scene 2’s beats, at shot 2' };
const ctx = name => `<div class="ah250-ctx"><img class="lt" src="assets/t250-ctx-${name}-light.jpg" alt="Today’s ${CTX[name]}"><img class="dk" src="assets/t250-ctx-${name}-dark.jpg" alt="Today’s ${CTX[name]}"></div>`;
const frame = (label, inner) => `<div class="ah250" data-screen-label="${label}" style="width:1360px;height:850px">${inner}</div>`;
const btn = (label, cls = '', icon = '') => `<span class="ah250-btn ${cls}">${icon}${label}</span>`;
const chip = (label, cls = '', icon = '') => `<span class="ah250-chip ${cls}">${icon}${label}</span>`;
const pb = (cls = '') => `<span class="ah250-pb ${cls}">${I.play(cls ? 8 : 9)}</span>`;
const playPill = (l, s, c, played = false) => `<span class="ah250-play" style="--c:var(${c})"><span class="pl">${I.play(8)}</span><span class="l">${l}</span><span class="s">${s}</span></span>${played ? `<span class="ah250-heard">${I.check(14)}</span>` : ''}`;

// ---- the Chat panel, as it ships -------------------------------------------------------------------
// World Chat names its model (read-only) and, with the chip in the row, Read replies keeps only its
// icon. A scene's Builder Chat has no model chip (turn 143) and offers the scene's two prompts.
const WORLD = { kind: 'w', title: 'World Chat', label: 'The Red Quiet / Voices for the miners', ph: 'Keep going…' };
const scene = n => ({ kind: 'b', title: 'Builder Chat', label: `The Red Quiet / First Contact / Scene ${n}`, ph: 'Ask Arke about this scene…' });
const composer = c => `<div class="ah250-cx"><div class="ed">${c.ph}</div><div class="bar"><div class="left"><span class="ic att">${P.attach}</span><span class="ic">${P.mic}</span>${c.kind === 'w' ? `<span class="chip">GPT-5.4</span><span class="tool">${P.speaker}</span>` : `<span class="tool">${P.speaker}Read replies</span>`}</div><span class="send">${P.send}</span></div></div>`;
const chat = (c, msgs) => {
  const head = `<div class="ah250-ph"><div><h2>${c.title}</h2><p>${c.label}</p></div><span>${P.more}</span><span>${P.close}</span></div>`;
  // Scrolled to its end, as a transcript is: a conversation shorter than the panel starts at the
  // top; a longer one shows its last turns, the earlier ones under the head.
  const body = `<div class="ah250-body"><i class="sp"></i><div class="ah250-tx">${msgs}</div></div>`;
  return c.kind === 'w'
    ? `<div class="ah250-panel w">${head}<div class="ah250-main">${body}<div class="ah250-foot">${composer(c)}</div></div></div>`
    : `<div class="ah250-panel b">${head}<div class="ah250-well">${body}<div class="ah250-foot"><div class="ah250-prompts"><span>What is missing from this scene?</span><span>Which shots need a frame?</span></div>${composer(c)}</div></div></div>`;
};
const user = text => `<div class="ah250-turn u"><div class="ah250-bubble">${text}</div></div>`;
/** A reply: its words, the receipt line inside it where there is one, Listen and Copy, then any card. */
const arke = (paras, { receipt = '', cards = [] } = {}) => `<div class="ah250-turn s${cards.length ? ' act' : ''}"><div class="ah250-bubble">${paras.join('<br><br>')}${receipt ? `<div class="ah250-rc">✓ ${receipt}</div>` : ''}</div><div class="ah250-acts"><span>${P.speaker}Listen</span><span>Copy</span></div>${cards.join('')}</div>`;

// ---- the cards (new) ------------------------------------------------------------------------------
// The design's quote, approved: the author's Design is the gesture design-voice already requires.
const quote = () => `<div class="ah250-card"><div class="ah250-quote"><div class="t"><b>Design 12 voices</b><small>6 characters · 2 lines each · Gemini 3.8 Flash TTS · ~$1.86</small></div><span class="ah250-done">${I.check(14)}Designed</span></div></div>`;

/** One character's two voices, open: the compact measure, Arke's pick and Use. */
function opened(slug, played, extra = {}) {
  const m = MINERS[slug];
  const cell = (l, fn) => fn(m[l], l);
  const stops = c => { const k = stopKinds(c.stops), kept = k.filter(x => x !== 'none').length; return c.join ? `${chip('Run-on', 'warn')}<span class="q">${c.join}</span>` : `<span class="v">${kept} of ${k.length}</span>`; };
  const row = (k, fn, cls = '') => `<span class="k${cls}">${k}</span><span class="${cls.trim()}">${cell('A', fn)}</span><span class="${cls.trim()}">${cell('B', fn)}</span>`;
  const use = l => played[l] ? btn(`Use ${l}`, l === m.pick ? 'primary' : '') : `${btn(`Use ${l}`, 'off')}<span>play first</span>`;
  return `<div class="ah250-vrow open"><div class="rh"><img class="ah250-avatar" src="${IMG(slug)}" alt=""><b>${m.name}</b><span class="st">Pick ${m.pick}</span><span class="chev">${I.upc()}</span></div>
<div class="ah250-mt"><span class="hd"></span><span class="hd">${playPill('A', `${m.A.s.toFixed(1)} s`, VOICE.A, played.A)}</span><span class="hd">${playPill('B', `${m.B.s.toFixed(1)} s`, VOICE.B, played.B)}</span>
${row('Brief', c => `${c.brief} a min · ${c.says}`, ' br')}
${row('Pace', c => `<span class="v">${c.wpm} a min</span>${fast(c) ? chip('Fast', 'warn') : ''}`)}
${row('Stops', stops)}
${row('Words', () => `<span class="v">${m.words} of ${m.words}</span>`)}
${row('Pitch', (c, l) => `<span class="v">${c.hz} Hz</span>${extra.pitch?.[l] ?? ''}`)}
<span class="k">Accent</span><span class="span2">${I.ear(13)}not measured</span></div>
<div class="ah250-pk">${I.spark()}<span><b>Arke’s pick: ${m.pick}.</b> ${m.why}</span></div>
<div class="ah250-use"><span></span><span>${use('A')}</span><span>${use('B')}</span></div></div>`;
}
const closed = (slug, using = '') => `<div class="ah250-vrow"><div class="rh"><img class="ah250-avatar" src="${IMG(slug)}" alt=""><b>${MINERS[slug].name}</b>${using ? `<span class="using">${I.check(14)}Using ${using}</span>` : `<span class="st">Pick ${MINERS[slug].pick}</span>`}<span class="chev">${I.down()}</span></div></div>`;
const stack = rows => `<div class="ah250-card">${rows.join('')}</div>`;

/** The pitch axis and a read's band on it: the middle 80 % of its voiced frames, the median a tick. */
const pct = (hz, min, max) => Math.max(0, Math.min(100, ((hz - min) / (max - min)) * 100));
const band = (lo, hi, md, min, max, c, cls = '') => `<span class="ah250-band ${cls}" style="--l:${pct(lo, min, max).toFixed(1)}%;--r:${(100 - pct(hi, min, max)).toFixed(1)}%;--m:${pct(md, min, max).toFixed(1)}%;--c:var(${c})"><i></i><b></b></span>`;
const axis = (min, max, step) => { const t = []; for (let h = Math.ceil(min / step) * step; h <= max; h += step) t.push(`<span style="left:${pct(h, min, max).toFixed(1)}%">${h}</span>`); return `<span class="ah250-axis">${t.join('')}</span>`; };

// The three men's picks and Dev's B, from measure_read's receipt; Close when within 8 %.
const MEN = [['Dev Malik', 'A · using', MINERS['dev-malik'].A, '--voice-2', ''], ['Lin Wei', 'B · using', MINERS['lin-wei'].B, '--voice-3', ''], ['Tomas Vale', 'A · using', MINERS['tomas-vale'].A, '--voice-6', ''], ['Dev Malik', 'B', MINERS['dev-malik'].B, '--voice-2', 'dim']];
const close = (a, b) => Math.abs(a - b) / Math.min(a, b) <= 0.08;
if (!(close(104, 107) && !close(104, 139))) throw new Error('Close is drawn against the 8 % rule');
const evidence = () => `<div class="ah250-card"><div class="ah250-chd"><b>Pitch and pace</b>${chip('Close · 104–107', 'warn')}</div><div class="ah250-ev"><div class="ah250-evrow hd"><span></span><span></span>${axis(60, 180, 40)}<span>Hz</span><span>a min</span></div>${MEN.map(([n, s, c, col, dim]) => `<div class="ah250-evrow ${dim}">${pb('sm')}<span class="n">${n}<small>${s}</small></span>${band(c.lo, c.hi, c.hz, 60, 180, col, dim)}<span class="v">${c.hz}</span><span class="v">${c.wpm}</span></div>`).join('')}</div></div>`;

// What Arke cannot hear, then what it measured.
const notMeasured = () => `<div class="ah250-card"><div class="ah250-chd"><b>Not measured</b></div><div class="ah250-not">${chip('Accent', 'line', I.ear(12))}${chip('Emotion', 'line')}${chip('How a name is said', 'line')}</div><div class="ah250-sub">Measured · Imani Okoro</div>${['A', 'B'].map(l => { const c = MINERS['imani-okoro'][l]; return `<div class="ah250-mrow">${playPill(l, `${c.s.toFixed(1)} s`, VOICE[l])}<div class="b"><b>${c.hz} Hz</b> · ${c.wpm} a min · 17 of 17 words<small>${chip('Run-on', 'warn')}${c.join}</small></div></div>`; }).join('')}</div>`;

// The table read's check: scene 1's flagged lines, each numbered by the shot it sits in, as the
// scene's page numbers them (lines 4, 7 and 9 of the scene are in shots 2, 3 and 4). Shot 3's
// run-on is measured (0.06 s of quiet after "shuttle."); shot 2's wrong voice and shot 4's missing
// words are samples.
const CHECK = [
  [2, 'Elsie Ward', '', 'They moved between passes. Probably heat shedding through the crust.', 'Wrong voice', '158 Hz · Elsie 210 · Ana 168', 4.52, '~$0.002'],
  [3, 'Lin Wei', '', 'Six seats in the service <span class="ah250-join">shuttle. Programmed</span> rendezvous with the supply tender.…', 'Run-on', '“shuttle.” 0.06 s', 6.6, '~$0.002'],
  [4, 'Narrator', ' nar', '…Through the mess window a white line <span class="ah250-miss">of fire</span> passes over the landing ground.…', 'Missing words', '“of fire” not heard', 14.56, '~$0.005'],
];
const clock = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const tableRead = () => `<div class="ah250-card"><div class="ah250-chd"><b>Scene 1 · 9 lines read · ${CHECK.length} to check</b></div>${CHECK.map(([n, who, nar, line, flag, d, s, price]) => `<div class="ah250-tri"><div class="h"><span class="num">${n}</span><b>${who}</b>${chip(flag, 'warn')}</div><div class="ln${nar}">${line}</div><div class="d">${d}</div><div class="a">${playPill('', clock(s), '--foreground')}<span class="grow"></span>${btn(`Redo <small>${price}</small>`, '', I.redo())}${btn('Keep')}</div></div>`).join('')}</div>`;

// One read, measured: scene 2's shot 2, Imani's line as voiced (2.8 s, 133 a minute, 197 Hz, 0.54 s
// after "Stop.", every word heard); loudness is a sample.
const oneRead = () => `<div class="ah250-card ah250-rd"><div class="ah250-chd">${playPill('', '0:03', '--voice-2')}<b>Imani Okoro · shot 2</b></div><div class="said"><span>Stop. They are not shooting.</span><span class="m">Gemini 3.8 Flash TTS</span></div><div class="ah250-mx">
<span class="k">Pace</span><span class="v">133 a min</span><span class="d">audition 213</span>
<span class="k">Stops</span><span class="v">1 of 1</span><span class="d">“Stop.” 0.54 s</span>
<span class="k">Words</span><span class="v">5 of 5</span><span class="d">as written</span>
<span class="k">Pitch</span><span class="v">197 Hz</span><span class="d">audition 149 · in her range</span>
<span class="k">Loudness</span><span class="v">−17.4 LUFS</span><span class="d">peak −1.6 dBFS</span>
</div><div class="ah250-foot2"><span class="grow"></span>${btn('Redo <small>~$0.002</small>', '', I.redo())}</div></div>`;

// ---- the conversation, as it grows ---------------------------------------------------------------
const askDesign = () => user('Design voices for the miners.') + arke(['Two voices each, from their sheets, reading two of their own lines.'], { cards: [quote()] });
const designed = rows => arke(['Twelve voices, two a character. Play each before you choose.'], { receipt: 'Designed 12 voices · $1.86', cards: [stack(rows)] });
const voicesA = () => designed([opened('imani-okoro', { A: false, B: true }), ...ORDER.slice(1).map(slug => closed(slug))]);
const voicesB = () => designed([closed('imani-okoro', 'B'), closed('dev-malik', 'A'), opened('lin-wei', { A: true, B: false }, { pitch: { A: chip('Lower than B', 'warn') } }), ...ORDER.slice(3).map(slug => closed(slug))]);
const voicesAll = () => designed(ORDER.map(slug => closed(slug, MINERS[slug].pick)));
const askMen = () => user('Do Dev, Lin Wei and Tomas sound different enough?') + arke([
  'Not by pitch. All three sit at 104 to 107 Hz.',
  'Pace parts them a little. Accent has to do the rest, and I can’t judge accent.',
  'Dev’s B, at 139 Hz, would stand apart, but it cuts the stop after “I fired.”',
], { receipt: 'Read 4 measures', cards: [evidence()] });
const askAccent = () => user('Is Imani’s accent right?') + arke([
  'I can’t tell. I measure pace, stops, words and pitch, not how an accent sounds.',
  'Both reads keep every word, at the same pitch. Play them and trust your ear.',
], { receipt: 'Read 2 measures', cards: [notMeasured()] });
const sceneEarlier = n => user('Break the scene into beats.') + arke([n === 1 ? 'Nine beats from the script: four read by the narrator, five spoken.' : 'Eleven beats from the script: eight read by the narrator, three spoken.']);

export const FRAMES = [
  ['a', 'Design voices for the miners: six in one card, Imani open · new: the voices card · beside today’s world home', () => frame(
    '250a World Chat: “Design voices for the miners.” Twelve voices, one card; Imani’s row open with both reads measured, Arke’s pick and Use; the other five closed. Beside it, today’s world home',
    ctx('world') + chat(WORLD, askDesign() + voicesA()),
  )],
  ['b', 'Lin Wei: briefed a tenor, reads lower; Use B waits for a play · new: the voices card · beside today’s world home', () => frame(
    '250b World Chat: Lin Wei’s row open; A was briefed the higher voice and reads 10 Hz under B; Arke picks B; Use B waits until B is played; Imani and Dev already chosen',
    ctx('world') + chat(WORLD, askDesign() + voicesB()),
  )],
  ['c', 'Different enough? A judgement, then its evidence · new: the evidence card and ✓ Read 4 measures · beside today’s world home', () => frame(
    '250c World Chat: “Do Dev, Lin Wei and Tomas sound different enough?” A plain answer first, then the evidence card from measure_read’s receipt, Play on each read',
    ctx('world') + chat(WORLD, askDesign() + voicesAll() + askMen()),
  )],
  ['d', 'What Arke cannot hear: accent · new: the not-measured card and ✓ Read 2 measures · beside today’s world home', () => frame(
    '250d World Chat: “Is Imani’s accent right?” Arke can’t tell; it names what it did measure and offers both reads to play',
    ctx('world') + chat(WORLD, askDesign() + voicesAll() + askMen() + askAccent()),
  )],
  ['e', 'After a table read: one card, three to check · new: Arke’s post and its card · beside today’s scene 1', () => frame(
    '250e Builder Chat: when Voice lines finishes scene 1, Arke posts one card unprompted; each flagged line has Play, a priced Redo and Keep; the scene’s beats beside it are today’s',
    ctx('scene1') + chat(scene(1), sceneEarlier(1) + arke(['Voice lines finished: 9 lines read, 3 to check.'], { cards: [tableRead()] })),
  )],
  ['f', 'Check this take: one read’s measure · new: the one-read card and ✓ Read 1 measure · beside today’s scene 2, at shot 2', () => frame(
    '250f Builder Chat: “Check Imani’s line in shot 2.” Nothing to fix by measure, pitch and pace set against her audition, the feeling left to the author; the scene’s beats beside it are today’s',
    ctx('scene2') + chat(scene(2), sceneEarlier(2) + user('Check Imani’s line in shot 2.') + arke([
      'Nothing to fix by measure. Every word is there, and the stop after “Stop.”',
      'She reads it higher and slower than her audition. If that is the fear you want, keep it. I can’t judge feeling.',
    ], { receipt: 'Read 1 measure', cards: [oneRead()] })),
  )],
];
