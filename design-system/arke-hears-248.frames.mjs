// Turn 248 · Arke hears a read: the frames. The samples are The Red Quiet: First Contact's six miners
// as a Claude Code session auditioned them on 29 October 2026: two designed voices each, every
// read measured (duration, words a minute, median pitch and its middle 80 % from that session's
// measures.json), the pauses at full stops measured again from the same audio the way the
// coordinator finds a pause, and loudness from the same files. Scene 1's lines (248g, 248h) are a
// second session's check of its nine voiced lines the same day; 248g's wrong voice (beat 4) and
// missing words (beat 9), and 248h's loudness, are samples. Portraits and scene 1's stills are
// copied into assets/t248-*.jpg; the world is not read or written. Every frame's root is .ah248
// with its data-screen-label.
const sv = (d, size = 16, fill = false) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="${fill ? 'none' : 'currentColor'}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  play: (s = 10) => sv('<path d="M7.5 4.9v14.2a.9.9 0 0 0 1.4.75l10.9-7.1a.9.9 0 0 0 0-1.5L8.9 4.15a.9.9 0 0 0-1.4.75z"></path>', s, true),
  check: (s = 13) => sv('<path d="M20 6 9 17l-5-5"></path>', s),
  ear: (s = 14) => sv('<path d="M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0"></path><path d="M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4"></path>', s),
  spark: (s = 15) => sv('<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"></path>', s),
  wave: (s = 17) => sv('<path d="M2 13a2 2 0 0 0 2-2V7a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0V4a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0v-4a2 2 0 0 1 2-2"></path>', s),
  mic: (s = 17) => sv('<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><path d="M12 19v3"></path>', s),
  upload: (s = 17) => sv('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="m17 8-5-5-5 5"></path><path d="M12 3v12"></path>', s),
  video: (s = 17) => sv('<path d="m16 13 5.22 3.48a.5.5 0 0 0 .78-.42V7.87a.5.5 0 0 0-.75-.43L16 10.5"></path><rect x="2" y="6" width="14" height="12" rx="2"></rect>', s),
  chat: (s = 17) => sv('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>', s),
  inbox: (s = 17) => sv('<path d="M22 12h-6l-2 3h-4l-2-3H2"></path><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>', s),
  bell: (s = 17) => sv('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path>', s),
  gear: (s = 17) => sv('<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>', s),
  user: (s = 17) => sv('<circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path>', s),
  users: (s = 17) => sv('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>', s),
  grid: (s = 17) => sv('<rect width="7" height="7" x="3" y="3" rx="1"></rect><rect width="7" height="7" x="14" y="3" rx="1"></rect><rect width="7" height="7" x="14" y="14" rx="1"></rect><rect width="7" height="7" x="3" y="14" rx="1"></rect>', s),
  book: (s = 17) => sv('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>', s),
  film: (s = 17) => sv('<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"></path><path d="m6.2 5.3 3.1 3.9"></path><path d="m12.4 3.4 3.1 4"></path><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path>', s),
  branch: (s = 17) => sv('<path d="M6 3v12"></path><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path>', s),
  plus: (s = 17) => sv('<path d="M5 12h14"></path><path d="M12 5v14"></path>', s),
  folder: (s = 17) => sv('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path>', s),
  x: (s = 17) => sv('<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>', s),
  down: (s = 17) => sv('<path d="m6 9 6 6 6-6"></path>', s),
  right: (s = 16) => sv('<path d="m9 18 6-6-6-6"></path>', s),
  redo: (s = 14) => sv('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path>', s),
  up: (s = 15) => sv('<path d="m5 12 7-7 7 7"></path><path d="M12 19V5"></path>', s),
  speaker: (s = 15) => sv('<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"></path><path d="M16 9a5 5 0 0 1 0 6"></path>', s),
  alert: (s = 13) => sv('<circle cx="12" cy="12" r="10"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path>', s),
};

// ---- the real measures --------------------------------------------------------------------------
// s: seconds; wpm over the voiced span; brief: the pace the brief states; hz, lo, hi: median pitch
// and its 10th–90th percentile; lufs, peak: integrated loudness and sample peak; stops: the pause
// at each full stop inside the read, in seconds, measured in the sound.
const MINERS = {
  'imani-okoro': { name: 'Imani Okoro', first: 'Imani', pick: 'B', chosen: 'B',
    lines: [['Scene 8', 'A light with nobody carrying it', 'You can complain about my workmanship when we get home.'], ['Scene 12', 'The warm point', 'Dev. Wait for me to tell you.']],
    why: 'A runs “home. Dev.” together',
    A: { s: 5.3, wpm: 207, brief: 150, words: 'mid pitch, warm, dry', hz: 148, lo: 126, hi: 213, lufs: -18.5, peak: -2.1, stops: [0, 0.37] },
    B: { s: 5.1, wpm: 213, brief: 160, words: 'lower, fuller', hz: 149, lo: 95, hi: 238, lufs: -15.0, peak: -1.6, stops: [0.64, 0] } },
  'dev-malik': { name: 'Dev Malik', first: 'Dev', pick: 'A',
    lines: [['Scene 7', 'The service ladder', 'Imani. The hatch is open. Tell me whether to close it.'], ['Scene 13', 'Six seats', 'I fired. Put that down. I thought if we stood there they would reach us.']],
    why: 'B cuts the stop after “I fired.”',
    A: { s: 10.0, wpm: 165, brief: 150, words: 'warm, steady baritone', hz: 104, lo: 87, hi: 133, lufs: -17.4, peak: -0.9, stops: [0.59, 0.56, 0.94, 0.9, 0.73] },
    B: { s: 8.4, wpm: 196, brief: 165, words: 'lighter, harder', hz: 139, lo: 61, hi: 178, lufs: -16.2, peak: -1.3, stops: [0.55, 0.66, 0.63, 0.22, 0.78] } },
  'lin-wei': { name: 'Lin Wei', first: 'Lin Wei', pick: 'B', chosen: 'B',
    lines: [['Scene 2', 'Open hands', 'I have the whole channel. Local picture and sound. I have it.'], ['Scene 13', 'Six seats', 'I kept another copy. Whatever you put in the packet, I am keeping mine.']],
    why: 'A, briefed the higher, reads lower',
    A: { s: 10.0, wpm: 166, brief: 160, words: 'light, clear tenor', hz: 97, lo: 84, hi: 127, lufs: -18.7, peak: -1.7, stops: [0, 0.27, 0.47, 0.17] },
    B: { s: 9.6, wpm: 171, brief: 145, words: 'light baritone, lower, softer', hz: 107, lo: 85, hi: 127, lufs: -21.1, peak: -1.8, stops: [0.67, 0.46, 0.65, 0.64] } },
  'ana-lucia-reyes': { name: 'Ana Lucía Reyes', first: 'Ana', pick: 'A',
    lines: [['Scene 1', 'Six places at the table', 'Probably is doing a lot of work in this room.'], ['Scene 15', 'The manifest', 'Read the splint label before you give her anything. And check your own seals.']],
    why: 'B, briefed brighter, reads no higher',
    A: { s: 8.0, wpm: 196, brief: 155, words: 'low-mid alto, dry', hz: 168, lo: 151, hi: 222, lufs: -15.4, peak: -0.9, stops: [0.38, 0.75] },
    B: { s: 8.2, wpm: 187, brief: 165, words: 'brighter, firmer', hz: 165, lo: 132, hi: 251, lufs: -17.0, peak: -1.7, stops: [0.54, 0.63] } },
  'elsie-ward': { name: 'Elsie Ward', first: 'Elsie', pick: 'A',
    lines: [['Scene 4', 'Something below the floor', 'Imani. They cut these. I have the service route. The numbers on our survey are wrong.'], ['Scene 10', 'The room that went quiet', 'Half a metre left. The wheel is below your knee. Not the hot one. The lower wheel.']],
    why: 'B sits close to Ana’s pitch',
    A: { s: 12.4, wpm: 168, brief: 160, words: 'bright, light mezzo', hz: 210, lo: 163, hi: 262, lufs: -16.6, peak: -1.4, stops: [0.57, 0.57, 0.62, 0.8, 0.71, 0.49, 0.5] },
    B: { s: 12.0, wpm: 173, brief: 160, words: 'lower, drier', hz: 180, lo: 148, hi: 223, lufs: -15.8, peak: 0.4, stops: [0.51, 0.65, 0.15, 0.72, 0.79, 0.77, 0.59] } },
  'tomas-vale': { name: 'Tomas Vale', first: 'Tomas', pick: 'A',
    lines: [['Scene 1', 'Six places at the table', 'Check the launch connection as well. That collar sticks. You need somebody in the outside pit if the remote lets go.'], ['Scene 7', 'The service ladder', 'Go on. Get to the landing. I can hold this.']],
    why: 'B runs “Go on. Get to the landing.”',
    A: { s: 11.2, wpm: 176, brief: 140, words: 'low, gravelly baritone', hz: 107, lo: 84, hi: 144, lufs: -20.3, peak: -1.7, stops: [0.7, 0.52, 1.71, 0.18, 0.55] },
    B: { s: 8.9, wpm: 220, brief: 150, words: 'drier, slightly higher', hz: 94, lo: 60, hi: 162, lufs: -20.0, peak: -1.4, stops: [0.5, 0.51, 1.02, 0, 0] } },
};
const ORDER = ['imani-okoro', 'dev-malik', 'lin-wei', 'ana-lucia-reyes', 'elsie-ward', 'tomas-vale'];
const IMG = slug => `assets/t248-${slug}.jpg`;
const A_C = '--voice-1', B_C = '--voice-2';

// The rules the frames draw: under PAUSE_SEC (0.15 s) a stop has no pause, a run-on; under half the
// read's usual stop it is short. More than a fifth over the brief's pace is Fast.
const PAUSE_SEC = 0.15;
const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const stopKinds = stops => { const half = median(stops) / 2; return stops.map(p => p < PAUSE_SEC ? 'none' : p < half ? 'short' : 'ok'); };
const fast = c => c.wpm > c.brief * 1.2;
const minus = n => (n < 0 ? '−' : n > 0 ? '+' : '') + Math.abs(n).toFixed(1);
const sec = n => n.toFixed(2) + ' s';
const script = slug => MINERS[slug].lines.map(l => l[2]).join(' ');
const wordCount = text => text.split(/\s+/).filter(Boolean).length;

/** A line with its stops marked: the pause after each full stop inside it; a run-on underlines the two words it joins. */
function said(text, stops, kinds = stopKinds(stops)) {
  const words = text.split(' ');
  const out = [];
  let k = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const isStop = /[.?!]$/.test(w) && i < words.length - 1;
    if (!isStop) { out.push(w); continue; }
    const kind = kinds[k], pause = stops[k];
    k += 1;
    const mark = `<span class="ah248-stop ${kind}">${kind === 'none' ? 'no pause' : sec(pause)}</span>`;
    if (kind === 'none') {
      let next = words[i + 1];
      i += 1;
      let tail = '';
      if (/[.?!]$/.test(next) && i < words.length - 1) { const kind2 = kinds[k], p2 = stops[k]; k += 1; tail = `<span class="ah248-stop ${kind2}">${kind2 === 'none' ? 'no pause' : sec(p2)}</span>`; }
      out.push(`<span class="ah248-join">${w}${mark}${next}</span>${tail}`);
    } else out.push(`<span class="ah248-wm">${w}${mark}</span>`);
  }
  return out.join(' ');
}
const stopWord = (text, n) => text.split(' ').filter((w, i, all) => /[.?!]$/.test(w) && i < all.length - 1)[n];

/** The pitch band on an axis from min to max Hz. */
const pct = (hz, min, max) => Math.max(0, Math.min(100, ((hz - min) / (max - min)) * 100));
const band = (lo, hi, md, min, max, c, cls = '') => `<span class="ah248-band ${cls}" style="--l:${pct(lo, min, max).toFixed(1)}%;--r:${(100 - pct(hi, min, max)).toFixed(1)}%;--m:${pct(md, min, max).toFixed(1)}%;--c:var(${c})"><i></i><b></b></span>`;
const axis = (min, max, step) => { const t = []; for (let h = Math.ceil(min / step) * step; h <= max; h += step) t.push(`<span style="left:${pct(h, min, max).toFixed(1)}%">${h}</span>`); return `<div class="ah248-axis">${t.join('')}</div>`; };

// ---- chrome -------------------------------------------------------------------------------------
const top = (where, chatOn = false) => `<div class="ah248-top"><span class="where">${where}</span><span class="brand"><b>Arke</b><span>Studio</span></span><span class="tools"><span${chatOn ? ' class="on"' : ''}>${I.chat()}</span><span>${I.inbox()}</span><span>${I.bell()}</span><span>${I.gear()}</span><span>${I.user()}</span></span></div>`;
const rail = on => `<div class="ah248-rail"><span class="mark">R</span>${[['grid', I.grid()], ['users', I.users()], ['chat', I.chat()], ['book', I.book()], ['film', I.film()], ['branch', I.branch()], ['plus', I.plus()]].map(([k, g]) => `<span${k === on ? ' class="on"' : ''}>${g}</span>`).join('')}<span class="grow"></span><hr><span>${I.folder()}</span><span>${I.spark()}</span></div>`;
const frame = (label, inner, w = 1360, h = 850) => `<div class="ah248" data-screen-label="${label}" style="width:${w}px;height:${h}px">${inner}</div>`;
const btn = (label, cls = '', icon = '') => `<span class="ah248-btn ${cls}">${icon}${label}</span>`;
const chip = (label, cls = '', icon = '') => `<span class="ah248-chip ${cls}">${icon}${label}</span>`;
const letter = (l, c, cls = '') => `<span class="ah248-letter ${cls}" style="--c:var(${c})">${l}</span>`;
const play = (label, played = false) => `<span class="ah248-play"><span class="dot">${I.play(9)}</span>${label}</span>${played ? `<span class="ah248-heard">${I.check(12)}played</span>` : ''}`;
const tabs = () => `<span class="ah248-tabs"><span>Overview</span><span>Reference</span><span>More looks</span><span class="on">Voice</span></span>`;
const vhead = slug => `<div class="ah248-vhead"><img class="ah248-avatar" src="${IMG(slug)}" alt=""><div class="grow"><div class="ah248-h1">${MINERS[slug].name}</div></div>${tabs()}</div>`;

// ---- the measure --------------------------------------------------------------------------------
function measure(c, text, { pitchFlag = '', pitchDetail = '' } = {}) {
  const kinds = stopKinds(c.stops);
  const kept = kinds.filter(k => k !== 'none').length;
  const bad = kinds.map((k, i) => [k, i]).filter(([k]) => k !== 'ok');
  const worst = bad.find(([k]) => k === 'none') ?? bad[0];
  const stopD = worst ? `“${stopWord(text, worst[1])}” ${worst[0] === 'none' ? 'no pause' : sec(c.stops[worst[1]])}` : 'all kept';
  const stopF = bad.some(([k]) => k === 'none') ? chip(bad.filter(([k]) => k === 'none').length > 1 ? `${bad.filter(([k]) => k === 'none').length} run-ons` : 'Run-on', 'warn') : bad.length ? chip('Short stop', 'warn') : '';
  const n = wordCount(text);
  return `<div class="ah248-mx">
<div><span class="k">Pace</span><span class="v">${c.wpm} a minute</span><span class="d">brief ${c.brief}</span>${fast(c) ? chip('Fast', 'warn') : ''}</div>
<div><span class="k">Stops</span><span class="v">${kept} of ${kinds.length}</span><span class="d">${stopD}</span>${stopF}</div>
<div><span class="k">Words</span><span class="v">${n} of ${n}</span><span class="d">as written</span></div>
<div><span class="k">Pitch</span><span class="v">${c.hz} Hz</span><span class="d">${pitchDetail || `middle ${c.lo}–${c.hi}`}</span>${pitchFlag}</div>
<div><span class="k">Loudness</span><span class="v">${minus(c.lufs)} LUFS</span><span class="d">peak ${minus(c.peak)} dBFS</span></div>
</div>`;
}

function candidate(slug, l, { played = true, use = true, why = '', pitchFlag = '' } = {}) {
  const m = MINERS[slug], c = m[l], text = script(slug), pick = m.pick === l;
  return `<div class="ah248-cand${pick ? ' pick' : ''}"><div class="ah248-chead">${letter(l, l === 'A' ? A_C : B_C)}<span class="n">${m.name} · ${l}</span>${pick ? chip('Arke’s pick', 'ink') : ''}${play(`${c.s.toFixed(1)} s`, played)}</div>
<div class="ah248-brief">Brief · ${c.words} · ${c.brief} a minute</div>
<div class="ah248-said">${said(text, c.stops)}</div>
${measure(c, text, { pitchFlag })}
<div class="ah248-cfoot"><span class="why">${why}</span>${btn(`Use ${l}`, use ? '' : 'off')}</div></div>`;
}

function pitchStrip(slug, min, max, step, labels) {
  const m = MINERS[slug];
  const row = l => `<div class="n">${letter(l, l === 'A' ? A_C : B_C, 'sm')}${m.first} · ${l} <small>${labels[l]}</small></div>${band(m[l].lo, m[l].hi, m[l].hz, min, max, l === 'A' ? A_C : B_C)}<div class="hz">${m[l].hz} Hz <small>${m[l].lo}–${m[l].hi}</small></div>`;
  return `<div class="ah248-strip"><div class="t">Pitch</div>${axis(min, max, step)}<div class="t" style="text-align:right">median · middle 80%</div>${row('A')}${row('B')}</div>`;
}

const pickStrip = (body, side = chip('Not measured: accent', '', I.ear(13))) => `<div class="ah248-pick"><span class="who">${I.spark()}</span><div class="body">${body}</div><div class="side">${side}</div></div>`;

function audition(slug, { pickBody, played = { A: true, B: true }, use = { A: true, B: true }, why = { A: '', B: '' }, flags = { A: '', B: '' }, strip = '', pad = 90, meta }) {
  return `<div class="ah248-vp" style="left:0;right:0;padding:0 ${pad}px">${vhead(slug)}
<div class="ah248-shead"><h2>Audition</h2><span class="m">${meta}</span>${btn('Design again', '', '')}</div>
${pickStrip(pickBody)}
<div class="ah248-pair">${candidate(slug, 'A', { played: played.A, use: use.A, why: why.A, pitchFlag: flags.A })}${candidate(slug, 'B', { played: played.B, use: use.B, why: why.B, pitchFlag: flags.B })}</div>
${strip}</div>`;
}

// ---- World Chat (225b) --------------------------------------------------------------------------
const chat = (msgs) => `<div class="ah248-chat"><div class="ah248-chathead"><div class="grow"><b>World Chat</b><small>The Red Quiet</small></div><span>${I.down()}</span><span>${I.x()}</span></div><div class="ah248-msgs">${msgs}</div><div class="ah248-compose"><div class="scope">World</div><div class="ah248-cbox"><div class="ph">Ask about your world…</div><div class="bar">${I.plus(16)}${I.mic(16)}<span>GPT-5.4</span><span class="grow"></span>${I.speaker(15)}<span>Read replies</span><span class="ah248-send">${I.up()}</span></div></div></div></div>`;
const user = text => `<div class="ah248-user">${text}</div>`;
const answer = (receipt, paras, card = '') => `<div class="ah248-ans"><div class="lab">Arke</div><div class="ah248-rcpt">${I.check(13)}${receipt}</div>${paras.map(p => `<p>${p}</p>`).join('')}${card}</div>`;

// ---- the cast (248d, 248e) ----------------------------------------------------------------------
function castCell(slug, l) {
  const m = MINERS[slug], c = m[l], kinds = stopKinds(c.stops);
  const runs = kinds.filter(k => k === 'none').length, shorts = kinds.filter(k => k === 'short').length;
  const flags = [fast(c) ? chip('Fast', 'warn') : '', runs ? chip(runs > 1 ? `${runs} run-ons` : 'Run-on', 'warn') : shorts ? chip('Short stop', 'warn') : ''].join('');
  return `<div class="ah248-cell${m.pick === l ? ' pick' : ''}"><div class="top"><span class="ah248-play" style="height:24px;padding:0 8px 0 3px"><span class="dot" style="width:18px;height:18px">${I.play(8)}</span>${l}</span>${c.hz} Hz <small>· ${c.wpm}</small></div><div class="flags">${flags || '<span class="ah248-heard">' + I.check(12) + 'clean</span>'}</div></div>`;
}
function castTable(cols, withAction = true) {
  const head = `<div class="ah248-tr th" style="grid-template-columns:${cols}"><span>Character</span><span>A</span><span>B</span><span>Arke’s pick</span>${withAction ? '<span></span>' : ''}</div>`;
  const rows = ORDER.map(slug => {
    const m = MINERS[slug];
    const act = m.chosen ? `<span class="ah248-chose">${I.check(15)}Using ${m.chosen}</span>` : btn('Choose', 'sm');
    return `<div class="ah248-tr" style="grid-template-columns:${cols}"><div class="ah248-who"><img class="ah248-avatar sm" src="${IMG(slug)}" alt=""><b>${m.name}</b></div>${castCell(slug, 'A')}${castCell(slug, 'B')}<div class="ah248-why"><b>${m.pick}</b> · ${m.why}</div>${withAction ? `<div style="text-align:right">${act}</div>` : ''}</div>`;
  }).join('');
  return `<div class="ah248-table">${head}${rows}</div>`;
}
const castHead = (right = '') => `<div class="ah248-phead"><div class="grow"><div class="ah248-crumb">First Contact / Cast</div><div class="ah248-h1">Cast voices</div><div class="meta">6 characters · 12 auditions · est. $1.86 · 2 chosen</div></div>${right}</div>`;
// Arke's picks on one axis, the narrator beside them: Imani and the narrator, and the three men, are close.
const PICKS = [['Elsie', 'A', 210, 163, 262, '--voice-5'], ['Ana', 'A', 168, 151, 222, '--voice-4'], ['Imani', 'B', 149, 95, 238, '--voice-1'], ['Narrator', '', 148, 148, 148, '--foreground'], ['Lin Wei', 'B', 107, 85, 127, '--voice-3'], ['Tomas', 'A', 107, 84, 144, '--voice-6'], ['Dev', 'A', 104, 87, 133, '--voice-2']];
function pitchPanel() {
  const row = ([n, l, md, lo, hi, c]) => `<div class="ah248-prow"><span class="n">${n}${l ? ` · ${l}` : ''}</span>${band(lo, hi, md, 80, 270, c, l ? '' : 'only')}<span class="v">${md}</span></div>`;
  const close = text => `<div class="ah248-close">${chip(text, 'warn', I.alert(12))}</div>`;
  return `<div class="ah248-panel"><h3>Pitch</h3><div class="m">Arke’s picks · Hz</div><div class="ah248-prow"><span></span>${axis(80, 270, 40)}<span></span></div>${PICKS.slice(0, 4).map(row).join('')}${close('Close · 148–149')}${PICKS.slice(4).map(row).join('')}${close('Close · 104–107')}</div>`;
}

// ---- scene 1, as voiced (248g, 248h) -----------------------------------------------------------
// Durations, speakers and lines are scene 1's own; beat 7's run-on is measured (0.06 s of quiet
// after "shuttle."); beat 4's pitch and beat 9's missing words are samples.
const BEATS = [
  [1, 'tool-roll', 'Narrator', 'Tomas puts my tool roll on the meal table with the buckle repaired. I tell him I had not asked. He says that was why it got done.', '0:12', { listen: '“Tomas” heard as Thomas' }],
  [2, 'tool-roll', 'Dev Malik', 'Eat before the next clearance. The officer wants the plain signed off by six.', '0:05'],
  [3, 'wrapper', 'Narrator', 'Elsie draws the proposed bore on the back of her meal wrapper. The straight line crosses three warm patches on the survey. I have already initialled the clearance beside them.', '0:11'],
  [4, 'wrapper', 'Elsie Ward', 'They moved between passes. Probably heat shedding through the crust.', '0:05', { flag: 'Wrong voice', detail: '158 Hz · near Ana', redo: '~$0.002' }],
  [5, 'wrapper', 'Ana Lucía Reyes', 'Probably is doing a lot of work in this room.', '0:03'],
  [6, 'message', 'Narrator', 'Wei plays a message from his mother. Traffic horns crowd the little speaker. He apologises for the noise. Nobody asks him to stop it.', '0:10'],
  [7, 'message', 'Lin Wei', 'Six seats in the service <span class="ah248-join">shuttle. Programmed</span> rendezvous with the supply tender. I checked the navigation yesterday.', '0:07', { flag: 'Run-on', detail: '“shuttle.” no pause', redo: '~$0.002' }],
  [8, 'message', 'Tomas Vale', 'Check the launch connection as well. That collar sticks. You need somebody in the outside pit if the remote lets go.', '0:07'],
  [9, 'fire', 'Narrator', 'Dev collects our empty plates. Through the mess window a white line <span class="ah248-miss">of fire</span> passes over the landing ground. Beyond it, the warm patches are moving east. I put my name beside the clearance.', '0:15', { flag: 'Missing words', detail: '“of fire” not heard', redo: '~$0.005' }],
];
function beats(sel = 0) {
  return `<div class="ah248-beats">${BEATS.map(([n, pic, who, line, dur, f = {}]) => `<div class="ah248-beat${n === sel ? ' sel' : ''}"><span class="num">${n}</span><img src="assets/t248-fc1-${pic}.jpg" alt=""><div class="txt"><div class="sp">${who}</div><div class="ln${who === 'Narrator' ? ' nar' : ''}">${line}</div></div><div class="vc"><div class="r1"><i${f.flag ? ' class="w"' : ''}></i>voiced ${dur} · after the line</div>${f.flag ? `<div class="r2">${chip(f.flag, 'warn')}${f.detail}</div>` : f.listen ? `<div class="r2">${I.ear(12)}${f.listen}</div>` : '<div class="r2"></div>'}</div><div class="act">${f.flag ? btn(`Redo <small>${f.redo}</small>`, 'sm', I.redo(13)) : `<span style="color:var(--muted-foreground)">${I.right()}</span>`}</div></div>`).join('')}</div>`;
}
const sceneHead = () => `<div class="ah248-shd"><div class="grow"><div class="ah248-crumb">First Contact / Scenes</div><div class="ah248-h1" style="font:var(--type-h2)">Scene 1 · Six places at the table</div><div class="meta">9 beats · 4 pictures · 9 voiced · 1:13 read aloud</div></div>${btn('Voice lines', '', I.mic(15))}</div><div class="ah248-bar"><span class="ah248-seg"><span class="on">Beats</span><span>Preview</span></span><span class="grow"></span>${chip('3 to check', 'warn')}<span class="m">Narrator · Ines Marr</span></div>`;
const status = () => `<div class="ah248-status"><span class="dot"></span>Connected · First Contact<span class="grow"></span>The Red Quiet</div>`;

// ---- the frames ---------------------------------------------------------------------------------
const IMANI_A_BRIEF = 'A Nigerian woman in her mid-thirties, a maintenance engineer on a mining colony. A natural, educated Nigerian English accent from the south-east, worn lightly and never exaggerated: even syllable timing, clear open vowels and firm consonants. Mid pitch, warm but dry, with a little grain from long shifts in cold, recycled air. Practical and plain: she speaks to get a job done, asks for a number before she offers comfort, and a quiet, deadpan humour sits under ordinary lines. Under pressure she gets lower and steadier rather than louder. Close to the microphone and conversational, at about 150 words a minute. No sing-song lilt, no performed emotion, no breathiness.';
const IMANI_B_BRIEF = 'A thirty-four-year-old Nigerian woman from Enugu, a mechanic used to being heard over running machinery. A clear Nigerian English accent with a light Igbo colouring, natural and unforced, the way she speaks at work every day. A slightly lower, fuller voice with a firm chest tone and crisp, clipped consonants. Composed and economical with management, warmer and quicker with her own crew, with a hint of a dry smile in throwaway lines. When frightened she becomes terse and exact, never shrill. Direct and grounded, at a brisk conversational pace of about 160 words a minute. Not theatrical, not breathy, never a caricature.';

function voicePageEmpty(slug) {
  const ways = [[I.wave(), 'Design two voices', 'from the sheet', 'Gemini · ~$0.31'], [I.wave(), 'Choose a voice', 'the catalogue', 'cloud and on this machine'], [I.mic(), 'Clone a voice', 'record · 3 seconds or more', 'wav · mp3'], [I.upload(), 'Upload a recording', 'a file on this machine', 'wav · mp3'], [I.video(), 'Generate a speaking sample', 'from the accepted photo', 'priced before it runs']];
  return `<div class="ah248-vp" style="left:0;right:0;padding:0 90px">${vhead(slug)}<div class="ah248-hero"><img src="${IMG(slug)}" alt=""><div class="b"><div class="nm">No voice yet</div><div class="ah248-use"><span class="k">Reads lines</span><span class="v">not set · the narrator reads her lines</span>${btn('Set')}</div><div class="ah248-use"><span class="k">On screen</span><span class="v">not set</span>${btn('Set')}</div></div></div>
<div class="ah248-shead" style="margin-top:22px"><h2>Get a voice</h2><span class="m"></span></div><div class="ah248-ways">${ways.map(([g, t, a, b]) => `<div class="ah248-way"><span class="i">${g}</span><b>${t}</b><span>${a}</span><span>${b}</span></div>`).join('')}</div></div>`;
}

export const FRAMES = [
  ['a', 'Design a voice makes two, priced', 1360, 850, () => frame(
    '248a Design a voice makes two: briefs drafted from Imani’s sheet, two of her own lines, one price',
    top('The Red Quiet · cast · Imani Okoro') + voicePageEmpty('imani-okoro') + `<div class="ah248-scrim"></div><div class="ah248-dialog"><div class="ah248-dhead"><img class="ah248-avatar sm" src="${IMG('imani-okoro')}" alt=""><span class="t">Design two voices</span><span style="color:var(--muted-foreground)">${I.x(18)}</span></div><div class="ah248-dbody"><div class="ah248-eb">Drafted from Imani’s sheet</div><div class="ah248-cols">${[['A', A_C, IMANI_A_BRIEF, 150], ['B', B_C, IMANI_B_BRIEF, 160]].map(([l, c, text, pace]) => `<div class="ah248-col"><div class="h">${letter(l, c)}Imani Okoro · ${l}<span class="grow"></span>${chip('en-NG', 'line')}${chip(`${pace} a minute`, 'line')}</div><div class="ah248-area">${text}</div></div>`).join('')}</div>
<div class="ah248-lines">${MINERS['imani-okoro'].lines.map(([s, t, l]) => `<div><span class="s">${s}</span><span class="l">${l}</span><span class="ah248-heard" style="color:var(--muted-foreground)">${t}</span></div>`).join('')}</div></div>
<div class="ah248-dfoot"><span class="m">Gemini 3.8 Flash TTS · 2 voices · 2 reads</span>${btn('Cancel', 'ghost')}${btn('Design both · ~$0.31', 'primary')}</div></div>`,
  )],

  ['b', 'Imani: both reads measured, Arke picks B', 1360, 850, () => frame(
    '248b Imani’s audition: both reads measured; A runs “home. Dev.” together, so Dev joins the first line; Arke picks B and says why',
    top('The Red Quiet · cast · Imani Okoro') + audition('imani-okoro', {
      meta: '2 voices · 2 lines · Gemini 3.8 Flash TTS · $0.31',
      pickBody: '<b>Arke’s pick: B.</b> A runs “home. Dev.” together, so Dev joins the first line. B’s run-on, “Dev, wait”, keeps the meaning. Both read fast for their briefs.',
      strip: pitchStrip('imani-okoro', 80, 260, 20, { A: 'mid pitch', B: 'lower, fuller' }),
    }),
  )],

  ['c', 'Lin Wei: briefed a tenor, read lower', 1360, 850, () => frame(
    '248c Lin Wei: A was briefed the higher voice, a light tenor, and reads 10 Hz under B; Use B waits until B has been played',
    top('The Red Quiet · cast · Lin Wei') + audition('lin-wei', {
      meta: '2 voices · 2 lines · Gemini 3.8 Flash TTS · $0.31',
      pickBody: '<b>Arke’s pick: B.</b> A was briefed the higher voice, a light tenor, and reads at 97 Hz, 10 Hz under B. A also runs “channel. Local” together. B keeps every stop.',
      played: { A: true, B: false }, use: { A: true, B: false }, why: { A: '', B: 'Play B first' },
      flags: { A: chip('Lower than B', 'warn'), B: '' },
      strip: pitchStrip('lin-wei', 70, 150, 10, { A: 'light tenor', B: 'light baritone' }),
    }),
  )],

  ['d', 'The cast: a pick each, chosen one by one', 1360, 850, () => frame(
    '248d The six miners: twelve reads measured, a pick and a reason for each, two chosen so far; Imani and the narrator, and the three men, close in pitch',
    top('The Red Quiet · First Contact · Cast') + rail('users') + `<div class="ah248-main" style="left:56px;right:0">${castHead(btn('Play the picks', '', I.play(11)))}<div style="display:flex;gap:24px;padding:8px 24px 0"><div style="flex:1;min-width:0">${castTable('186px 164px 164px 1fr 96px')}</div><div style="width:352px;flex:none;padding-top:10px">${pitchPanel()}</div></div></div>`,
  )],

  ['e', 'World Chat: a judgement and its evidence', 1360, 850, () => frame(
    '248e World Chat: “Do they sound different enough?” A plain answer first, then the evidence card drawn from the measure',
    top('The Red Quiet · First Contact · Cast', true) + rail('users') + `<div class="ah248-main" style="left:56px;right:420px">${castHead()}<div style="padding:8px 24px 0">${castTable('172px 146px 146px 1fr', false)}</div></div>` + chat(
      user('Do Dev, Lin Wei and Tomas sound different enough?') + answer('Measured 4 reads', [
        'Not by pitch. All three read at 104 to 107 Hz.',
        'Pace parts them a little. Accent has to do the rest, and I can’t judge accent.',
        'Dev’s B reads at 139 Hz and would stand apart, but it cuts the stop after “I fired.”',
      ], `<div class="ah248-ev"><div class="ah248-evh"><b>Pitch and pace</b><span>4 reads · on this machine</span></div><div class="ah248-evrow"><span></span>${axis(70, 180, 20)}<span></span></div>${[
        ['Dev Malik', 'A · pick', 104, 87, 133, 165, '--voice-2', ''],
        ['Lin Wei', 'B · using', 107, 85, 127, 171, '--voice-3', ''],
        ['Tomas Vale', 'A · pick', 107, 84, 144, 176, '--voice-6', ''],
        ['Dev Malik', 'B', 139, 61, 178, 196, '--voice-2', 'dim'],
      ].map(([n, s, md, lo, hi, w, c, dim]) => `<div class="ah248-evrow ${dim}"><span class="n">${n}<small>${s}</small></span>${band(lo, hi, md, 70, 180, c, dim)}<span class="v">${md} Hz<small>${w} a minute</small></span></div>`).join('')}<div class="ah248-evact">${btn('Play the three', 'sm', I.play(10))}${btn('Hear Dev B', 'sm', I.play(10))}${chip('Close · 104–107', 'warn')}</div></div>`)),
  )],

  ['f', 'What Arke cannot hear: accent', 1360, 850, () => frame(
    '248f World Chat: Arke cannot judge an accent; it says so in a sentence, gives what it did measure, and offers both reads to play',
    top('The Red Quiet · cast · Imani Okoro', true) + `<div style="position:absolute;left:0;right:420px;top:0;bottom:0">${audition('imani-okoro', {
      pad: 36,
      meta: '2 voices · 2 lines',
      pickBody: '<b>Arke’s pick: B.</b> A runs “home. Dev.” together, so Dev joins the first line.',
    })}</div>` + chat(
      user('Is Imani’s accent right?') + answer('Read 2 measures', [
        'I can’t tell. I measure pace, stops, words and pitch, not how an accent sounds.',
        'Both reads have every word at the same pitch, so accent is the real choice here. Play A and B and trust your ear, or someone who knows Enugu English.',
      ], `<div class="ah248-ev"><div class="ah248-evh"><b>Not measured</b></div><div class="ah248-evnot">${chip('Accent', 'line', I.ear(12))}${chip('Emotion', 'line')}${chip('How a name is said', 'line')}</div><div class="ah248-evsep"></div><div class="ah248-evh"><b>Measured</b><span>Imani Okoro</span></div><dl class="ah248-evkv"><dt>${letter('A', A_C, 'sm')}</dt><dd>148 Hz · 207 a minute<small>run-on: “home. Dev.”</small></dd><dt>${letter('B', B_C, 'sm')}</dt><dd>149 Hz · 213 a minute<small>run-on: “Dev, wait”</small></dd></dl><div class="ah248-evact">${btn('Play A', 'sm', I.play(10))}${btn('Play B', 'sm', I.play(10))}</div></div>`)),
  )],

  ['g', 'Table read: three lines to check, each with Redo', 1360, 850, () => frame(
    '248g Scene 1’s voiced lines: a run-on, a wrong voice and missing words flagged, each with a priced Redo; a name heard close is listed to listen for',
    top('The Red Quiet · First Contact · visual novel') + rail('film') + `<div class="ah248-scene" style="right:330px">${sceneHead()}${beats()}</div><div class="ah248-side" style="width:330px"><div class="h">Arke · Scene 1</div><div class="msgs"><div class="ah248-bub me">Voice the lines.</div><div class="ah248-bub arke"><p>Nine lines voiced, 1:13. Three to check.</p><p>Beat 7: Lin Wei runs “shuttle. Programmed” together.</p><p>Beat 4: Elsie’s line sits at Ana’s pitch.</p><p>Beat 9: “of fire” is missing.</p><p>Beat 1: listen to how “Tomas” is said.</p></div><div class="acts">${btn('Redo 3 · ~$0.01', '', I.redo(13))}${btn('Play the scene', '', I.play(10))}</div></div><div class="ask">Ask Arke about this scene…</div></div>` + status(),
  )],

  ['h', 'A take’s measure: Redo with a pause', 1360, 850, () => frame(
    '248h Beat 7’s voice opened: what was heard, its measure, and Redo with a pause at “shuttle.”',
    top('The Red Quiet · First Contact · visual novel') + rail('film') + `<div class="ah248-scene" style="right:440px">${sceneHead()}${beats(7)}</div><div class="ah248-side" style="width:440px"><div class="ah248-insp"><div class="crumb">Scene 1 / Beat 7</div><div class="t">Lin Wei</div><div class="lab">Voice</div><div class="ah248-take"><span class="ah248-play" style="padding:0 6px"><span class="dot">${I.play(9)}</span></span><span class="grow">Lin Wei · B<small>Gemini 3.8 Flash TTS · 0:07</small></span>${chip('Run-on', 'warn')}</div><div class="lab">Heard</div><div class="ah248-said">${said('Six seats in the service shuttle. Programmed rendezvous with the supply tender. I checked the navigation yesterday.', [0.06, 0.38])}</div>
<div class="ah248-mx"><div><span class="k">Pace</span><span class="v">170 a minute</span><span class="d">audition 171</span></div><div><span class="k">Stops</span><span class="v">1 of 2</span><span class="d">“shuttle.” 0.06 s</span>${chip('Run-on', 'warn')}</div><div><span class="k">Words</span><span class="v">17 of 17</span><span class="d">as written</span></div><div><span class="k">Pitch</span><span class="v">83 Hz</span><span class="d">audition 107</span></div><div><span class="k">Loudness</span><span class="v">−19.6 LUFS</span><span class="d">peak −2.0 dBFS</span></div></div>
<div class="lab">Redo sends</div><div class="ah248-sent">Six seats in the service shuttle. <code>&lt;short pause&gt;</code> Programmed rendezvous with the supply tender. I checked the navigation yesterday.<br><span style="color:var(--muted-foreground)">Gemini 3.8 Flash TTS · ~$0.002</span></div></div><div class="ah248-ifoot">${btn('Keep')}${btn('Redo')}${btn('Redo with a pause', 'primary')}</div></div>` + status(),
  )],
];
