// Turn 230 · Audio drama. Pure functions returning frame markup; audio-drama-230.mjs places the
// frames in the master, the review page and the prototype.
// Illustrative content: Low Water, a novel invented for this turn and set in The Undersong, the
// public design world. None of it is taken from a manuscript of the author's. Durations, prices and
// voices are fixtures; nothing here is heard, generated or charged.
const A = 'assets/';
const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const I = {
  panel: svg('<path d="M3 4h18v16H3z M9 4v16"/>'),
  home: svg('<path d="M3 10l9-7 9 7v11h-7v-7h-4v7H3z"/>'),
  cast: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M18 8a3 3 0 0 1 0 6 M22 21v-2a4 4 0 0 0-3-4"/>'),
  chat: svg('<path d="M21 11a9 9 0 0 1-9 9H3l2-5a9 9 0 1 1 16-4"/>'),
  overview: svg('<path d="M8 3h11v18H7V7H3V3h5 M7 7h8 M10 11h6 M10 15h6"/>'),
  map: svg('<path d="M3 5h4 M3 12h4 M3 19h4 M17 6h4 M17 17h4 M7 5c6 0 4 12 10 12 M7 12c5 0 5-6 10-6 M7 19c4 0 6-2 10-2"/>'),
  episodes: svg('<path d="M4 6h16 M4 12h10 M4 18h7 M17 15v6l5-3z"/>'),
  folder: svg('<path d="M3 6h7l2 3h9v12H3z"/>'),
  inbox: svg('<path d="M4 4h16l2 12v4H2v-4z M2 16h6l2 2h4l2-2h6"/>'),
  bell: svg('<path d="M5 16l2-3V9a5 5 0 0 1 10 0v4l2 3z M10 20h4"/>'),
  gear: svg('<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 2h6l1 4 4 1 2 5-2 5-4 1-1 4H9l-1-4-4-1-2-5 2-5 4-1z"/>'),
  user: svg('<path d="M5 21v-3a7 7 0 0 1 14 0v3 M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8"/>'),
  left: svg('<path d="M15 5l-7 7 7 7"/>'),
  right: svg('<path d="M9 5l7 7-7 7"/>'),
  down: svg('<path d="M6 9l6 6 6-6"/>'),
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4v16H6z M14 4h4v16h-4z" fill="currentColor"/></svg>',
  more: svg('<path d="M5 12h.01 M12 12h.01 M19 12h.01" stroke-width="3"/>'),
  close: svg('<path d="M6 6l12 12 M18 6L6 18"/>'),
  check: svg('<path d="M5 12l5 5L20 7"/>'),
  wave: svg('<path d="M3 12h1 M7 8v8 M11 5v14 M15 8v8 M19 10v4 M22 12h-1"/>'),
  hear: svg('<path d="M4 15v-3a8 8 0 0 1 16 0v3 M4 15h3v5H5a1 1 0 0 1-1-1z M20 15h-3v5h2a1 1 0 0 0 1-1z"/>'),
  sound: svg('<path d="M11 5 6 9H2v6h4l5 4z M15.5 8.5a5 5 0 0 1 0 7"/>'),
  amb: svg('<path d="M2 9c3-3 5 3 8 0s5 3 8 0 3 0 4 0 M2 15c3-3 5 3 8 0s5 3 8 0 3 0 4 0"/>'),
  music: svg('<path d="M9 18V5l11-2v13 M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0"/>'),
  silence: svg('<path d="M4 12h2 M9 12h2 M14 12h2 M19 12h1"/>'),
  radio: svg('<path d="M4 9h16v11H4z M8 9l9-5 M8 15a1 1 0 1 0 0 .01 M13 13h4 M13 16h4"/>'),
  mic: svg('<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3 M5 11a7 7 0 0 0 14 0 M12 18v3"/>'),
  lock: svg('<path d="M6 11h12v10H6z M8 11V7a4 4 0 0 1 8 0v4"/>'),
  book: svg('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
  review: svg('<path d="M4 4h12l4 4v12H4z M8 12l3 3 5-6"/>'),
  plus: svg('<path d="M12 5v14 M5 12h14"/>'),
  arrow: svg('<path d="M12 19V5 M5 12l7-7 7 7"/>'),
  clip: svg('<path d="M21 12l-8.5 8.5a6 6 0 0 1-8.5-8.5L13 3a4 4 0 0 1 5.7 5.7L10 17.4a2 2 0 0 1-2.8-2.8L15 7"/>'),
  stack: svg('<path d="M12 3l9 5-9 5-9-5z M3 13l9 5 9-5"/>'),
  export: svg('<path d="M12 3v12 M7 8l5-5 5 5 M4 15v5h16v-5"/>'),
  doc: svg('<path d="M6 3h9l4 4v14H6z M14 3v5h5 M9 13h7 M9 17h5"/>'),
  scissors: svg('<path d="M6 7a2.5 2.5 0 1 0 0 .01 M6 17a2.5 2.5 0 1 0 0 .01 M8 8l12 10 M8 16l12-10"/>'),
  undo: svg('<path d="M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  redo: svg('<path d="M15 14l5-5-5-5 M20 9H10a6 6 0 0 0 0 12h3"/>'),
  search: svg('<path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M20 20l-4-4"/>'),
  keyboard: svg('<path d="M3 6h18v12H3z M7 10h.01 M11 10h.01 M15 10h.01 M7 14h10"/>'),
};
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const go = to => to ? ` data-go="${to}"` : '';

// ===== The world, the novel and its people =====
export const P = {
  nar: { name: 'Narrator', first: 'Narrator', v: 'v6', voice: 'Wren', model: 'ElevenLabs v3', nar: true },
  maren: { name: 'Maren Kest', first: 'Maren', img: A + 'char-maren.png', v: 'v1', voice: 'Coral', model: 'ElevenLabs v3' },
  bray: { name: 'Bray', first: 'Bray', img: A + 'char-bray.png', v: 'v3', voice: 'Bram', model: 'ElevenLabs v3' },
  odile: { name: 'Odile Sarn', first: 'Odile', img: A + 'char-odile.png', v: 'v2', voice: 'Odile', model: 'designed · ElevenLabs v3' },
  sereth: { name: 'Sereth', first: 'Sereth', img: A + 'char-sereth.png', v: 'v5', voice: null },
  ilo: { name: 'Ilo Kest', first: 'Ilo', img: A + 'char-ilo.png', v: 'v4', voice: 'Recorded', model: '2 files' },
  singer: { name: 'The Singer', first: 'The Singer', img: A + 'char-chorister.png', v: 'v4', voice: 'Ilo', model: 'recorded · sung', lock: 'Ilo Kest until episode 5' },
};
export const face = (k, cls = '') => { const p = P[k]; return p.nar ? `<span class="face nar ${cls}">${I.wave}</span>` : `<img class="face ${cls}" src="${p.img}" alt="">`; };

// ===== Chrome =====
export const titlebar = ({ chat = false, crumb = 'Low Water · audio drama' } = {}) => `<header class="tb"><span class="crumb">‹ World <span>${crumb}</span></span><b>Arke <small>Studio</small></b><span class="util">${chat ? `<span class="uon">${I.chat}</span>` : I.chat}${I.inbox}${I.bell}${I.gear}${I.user}</span></header>`;
// The production rail for an audio drama: Story's, with Adaptation (only when it adapts something)
// and Episodes where Story has Chapters and Audiobook.
const RAIL = [['panel', 'Collapse navigation'], ['home', 'Dashboard'], ['cast', 'Cast', 'cast'], ['chat', 'Develop'], ['overview', 'Overview'], ['map', 'Adaptation', 'map'], ['episodes', 'Episodes', 'episodes'], ['folder', 'Artifacts']];
export const rail = (on = 'Episodes') => `<nav class="crail" aria-label="Production navigation">${RAIL.map(([i, n, to]) => `<button type="button" aria-label="${n}" title="${n}"${n === on ? ' class="on" aria-current="page"' : ''}${go(to)}>${I[i]}</button>`).join('')}</nav>`;
export const shell = ({ inner, on = 'Episodes', chatPanel = '', crumb } = {}) => `${titlebar({ chat: !!chatPanel, crumb })}<div class="body">${rail(on)}<main class="main">${inner}</main>${chatPanel}</div>`;

// The bar over an episode: episode arrows, the three views, the scene, the listening estimate
// against the target, the side columns, Hear, ⋯. Turn 227's writing bar, for a script.
export const wbar = ({ ep = 1, view = 'Script', scene = '4 · The tide turns', est = '21:40', of = '25:00', p = 87, side = '', sides = true, to = { Source: 'source', Cast: 'castcol', Review: 'review' } } = {}) => `<div class="wbar"><button type="button" class="ib" aria-label="Episodes" title="Episodes"${go('episodes')}>${I.panel}</button><div class="navs"><button type="button" aria-label="Previous episode"${ep === 1 ? ' disabled style="opacity:.35"' : ''}>${I.left}</button><button type="button" aria-label="Next episode">${I.right}</button></div><div class="seg" role="tablist" aria-label="Episode ${ep} views">${['Episode', 'Script', 'Audio Studio'].map(v => `<button type="button" role="tab" aria-selected="${v === view}"${v === view ? ' class="on"' : ''}${go(v === 'Audio Studio' ? 'studio' : v === 'Script' ? 'script' : 'episodes')}>${v}</button>`).join('')}</div>${view === 'Script' ? `<button type="button" class="scenepick"><small>Episode ${ep}</small>${scene}${I.down}</button>` : ''}<span class="gap"></span><span class="ring" title="Estimated listening time against the episode's target" style="--p:${p}"><i></i>${est} <small>/ ${of}</small></span>${sides ? `<span class="sep"></span><div class="sides">${[['Source', 'book'], ['Cast', 'cast'], ['Review', 'review']].map(([n, i]) => `<button type="button" aria-pressed="${side === n}"${side === n ? ' class="on"' : ''}${go(to[n])}>${I[i]}${n}</button>`).join('')}</div>` : ''}<span class="sep"></span><button type="button" class="ib" aria-label="Hear from here" title="Hear from here">${I.hear}</button><button type="button" class="ib" aria-label="More">${I.more}</button></div>`;
export const foot = (l = 'Saved · script v6', r = '') => `<div class="foot"><span>${l}</span><span class="gap"></span>${r}</div>`;

// ===== Scripts =====
// A block: head | fx | nar | dlg | sil | note. Beds are [kind, label, firstRow, lastRow, ends].
export const S4 = [
  { k: 'head', n: 4, title: 'The bell tower, inside', time: 'Night', heard: 'Narrated', src: 'Chapter 3', est: '3:05' },
  { k: 'amb', text: 'Inside the tower: water on stone, a slow drip, wind in the louvres.', tk: 'kept' },
  { k: 'fx', text: 'Two divers break the surface. Gasps. Water streams off brass.', tk: 'kept' },
  { k: 'nar', say: 'The bell tower had stood in the sea for forty years. Tonight it stood in air.' },
  { k: 'dlg', who: 'maren', dir: 'breathless, delighted', say: 'Bray. Bray, look — the stairs go all the way up.' },
  { k: 'dlg', who: 'bray', ch: 'off-mic', dir: 'below her', say: 'I see them. I also see the water line on the wall.' },
  { k: 'fx', text: 'Far off, one deep stroke of the harbour bell.', why: 'Sereth’s signal: the tide has turned', need: true },
  { k: 'dlg', who: 'sereth', ch: 'radio', dir: 'thin, through static', say: 'Turn of tide. All divers out. Turn of tide.' },
  { k: 'dlg', who: 'bray', say: 'That’s the turn.' },
  { k: 'dlg', who: 'maren', say: 'The log said two hours.' },
  { k: 'dlg', who: 'bray', say: 'The log’s wrong.', nw: true },
  { k: 'sil', dur: '1.5 s', w: 90 },
  { k: 'fx', text: 'Water finds the first stair. A soft, hungry slap.', why: 'starts the count', tk: 'kept' },
  { k: 'dlg', who: 'bray', dir: 'steady, counting', say: 'One.' },
  { k: 'dlg', who: 'maren', say: 'Ilo’s lantern is up here. He said it was', cut: true },
  { k: 'dlg', who: 'bray', dir: 'cuts in', say: 'Two. Climb.', over: true },
  { k: 'mus', text: 'Low drone enters, under.', tk: 'kept' },
  { k: 'nar', say: 'She climbed. Behind her the water took the stairs the way a clock takes minutes.' },
  { k: 'fx', text: 'Water takes the third stair.', tk: 'kept' },
  { k: 'dlg', who: 'bray', say: 'Three.' },
];
export const S4BEDS = [['amb', 1, 19], ['mus', 16, 19]];

// Episode 2, scene 3: the quiet scene. After a review note, Maren now cuts Odile off before she
// can say what she knows; the two changed lines' takes are out of date.
export const S23 = [
  { k: 'head', n: 3, title: 'The lamp room', time: 'After midnight', heard: 'In the room', src: 'Chapter 6', est: '2:40' },
  { k: 'amb', text: 'Lamp room: the lamp’s clockwork turning, rain on the glass.', tk: 'kept' },
  { k: 'fx', text: 'A kettle lifted off the stove before it can whistle.', tk: 'kept' },
  { k: 'dlg', who: 'odile', dir: 'not turning round', say: 'You went into the tower.', tk: 'kept' },
  { k: 'dlg', who: 'maren', say: 'Somebody had to.', tk: 'kept' },
  { k: 'sil', dur: '3 s', w: 160, note: 'Odile pours. Neither speaks.' },
  { k: 'dlg', who: 'odile', dir: 'quiet, careful', say: 'Your brother hated that tower.', tk: 'kept' },
  { k: 'dlg', who: 'maren', say: 'Then why did he go in?', tk: 'kept' },
  { k: 'dlg', who: 'odile', say: 'He didn’t go in, love. He', cut: true, tk: 'stale' },
  { k: 'dlg', who: 'maren', dir: 'cuts in, on “He”', say: 'Don’t. Not tonight.', over: true, tk: 'stale' },
  { k: 'mus', text: 'Cello, solo, enters under and ends the scene.', tk: 'kept' },
  { k: 'fx', text: 'The lamp completes a turn. One soft click.', tk: 'kept' },
  { k: 'sil', dur: '2 s', w: 110 },
  { k: 'dlg', who: 'odile', dir: 'after a long breath', say: 'Drink your tea.', tk: 'kept' },
];
export const S23BEDS = [['amb', 1, 13], ['mus', 10, 13, true]];

const tkGlyph = (b, mark = {}) => {
  const m = mark.tk ?? b.tk;
  if (!m) return `<span class="tkd" title="Not performed"></span>`;
  if (m === 'kept') return `<span class="tkd kept" title="Kept take"></span>`;
  if (m === 'stale') return `<span class="tkd stale" title="Take out of date"></span><small class="warn">out of date</small>`;
  if (m === 'cand') return `${b.tk === 'kept' ? '<span class="tkd kept" title="Kept take"></span>' : ''}<span class="tkd cand" title="Audition take"></span><small>${mark.lbl || 'A1'}</small>`;
  if (m === 'flag') return `<span class="tkd flag" title="Check"></span><small class="warn">${mark.lbl || 'check'}</small>`;
  return '';
};

/**
 * The score. `from`/`to` bound the rows shown (a frame is a scrolled page). `sel` is a block index
 * or [first, last]; `marks` maps a block index to { tk, lbl, q, sup }; `ghost` greys the drafted rows.
 */
export const script = (blocks, beds = [], { from = 0, to = blocks.length, sel, marks = {}, ghost = false, top = '', topRows = 1, srcSel, edits = {} } = {}) => {
  let out = top, row = top ? topRows + 1 : 1;
  const rows = {};
  const range = Array.isArray(sel) ? sel : sel != null ? [sel, sel] : null;
  blocks.slice(from, to).forEach((b, j) => {
    const i = from + j, r = row++, mk = marks[i] || {}, on = range && i >= range[0] && i <= range[1] && !Array.isArray(sel);
    rows[i] = r;
    const gh = ghost ? ' ghost' : '';
    const sup = mk.sup ? `<sup>${mk.sup}</sup>` : '';
    const ed = edits[i];
    if (b.k === 'head') {
      out += `<div class="hd" style="grid-row:${r}"><span class="n">${b.n}</span><h2>${b.title} <small>${b.time}</small></h2><div class="props"><span class="chip">${b.heard === 'Narrated' ? I.wave : b.heard === 'A recording' ? I.mic : I.cast}${b.heard}</span><span class="chip"${go('source')}>${I.book}${b.src}</span><span class="chip">≈ ${b.est}</span></div></div>`;
      return;
    }
    if (b.k === 'fx' || b.k === 'amb' || b.k === 'mus') {
      const lbl = b.k === 'fx' ? `${I.sound}Sound` : b.k === 'amb' ? `${I.amb}Ambience` : `${I.music}Music`;
      out += `<div class="who cue" style="grid-row:${r}">${lbl}</div><div class="tx fx${b.need ? ' need' : ''}${gh}${on ? ' sel' : ''}" style="grid-row:${r}"${go(b.need ? 'cue' : '')}>${esc(b.text)}${b.why ? `<span class="why">${b.need ? '<b>No sound yet</b> · ' : ''}${esc(b.why)}</span>` : ''}</div><div class="tk" style="grid-row:${r}">${ghost ? '' : tkGlyph(b, mk)}</div>`;
      return;
    }
    if (b.k === 'sil') {
      out += `<div class="who cue" style="grid-row:${r}">${I.silence}Silence</div><div class="tx sil${gh}" style="grid-row:${r};--w:${b.w || 100}px">${b.dur}${b.note ? ` <small>${esc(b.note)}</small>` : ''}</div>`;
      return;
    }
    if (b.k === 'note') { out += `<div class="tx note" style="grid-row:${r}">${esc(b.text)}</div>`; return; }
    const p = P[b.k === 'nar' ? 'nar' : b.who];
    const chan = b.ch ? `<small>${b.ch === 'radio' ? I.radio : b.ch === 'recording' ? I.mic : ''}${b.ch}</small>` : '';
    const lock = p.lock ? `<small>${I.lock}hidden</small>` : '';
    const say = ed ? ed : `${mk.q ? `<span class="q">${esc(b.say)}</span>` : esc(b.say)}${b.cut ? '<i class="cutm" title="Cut off here">—</i>' : ''}`;
    out += `<div class="who ${p.v}${p.lock ? ' lock' : ''}" style="grid-row:${r}"><b>${p.first}</b>${chan}${lock}</div><div class="tx${b.k === 'nar' ? ' nar' : ''}${b.over ? ' over' : ''}${gh}${on ? ' sel' : ''}${srcSel === i ? ' sel' : ''}" style="grid-row:${r}"${go(mk.go)}>${b.dir ? `<span class="dir">(${esc(b.dir)})</span>` : ''}<span class="say">${say}${sup}${b.nw ? '<span class="new" title="Not in the novel">new</span>' : ''}</span></div><div class="tk" style="grid-row:${r}">${ghost ? '' : tkGlyph(b, mk)}</div>`;
  });
  if (Array.isArray(sel)) out = `<div class="rangesel" style="grid-row:${rows[sel[0]]} / ${rows[sel[1]] + 1}"></div>` + out;
  for (const [kind, a, b, ends] of beds) {
    if (b < from || a >= to) continue;
    const s = rows[Math.max(a, from)], e = rows[Math.min(b, to - 1)] + 1;
    out += `<div class="bed ${kind}${a < from ? ' cont' : ''}${ends && b < to ? ' out' : ''}" style="grid-row:${s} / ${e}" title="${kind === 'amb' ? 'Ambience' : 'Music'} under these lines"></div>`;
  }
  return `<div class="sc">${out}</div>`;
};
export const epTop = (n, t) => `<div class="ep" style="grid-row:1"><span>Episode ${n}</span><h1>${t}</h1></div>`;

// ===== The novel, as the Source column shows it: read-only, versioned, quoted by paragraph =====
export const CH3 = [
  [14, 'Far off — so far it might have been memory — the harbour bell struck once. Sereth’s signal. The turn.'],
  [15, '“The log said two hours,” Maren said, and hated how young it sounded.'],
  [16, 'Bray did not answer. He was looking at the first stair, where the water had come back and was feeling for it like a hand in the dark.'],
  [17, '<span class="hl">She counted what the water had taken — one stair, then two —</span> and the lantern still three flights above her. Ilo had told her once that the tower ate stairs. She had thought it was a joke.'],
  [18, '“Climb,” Bray said.'],
];
export const sourceCol = ({ paras = CH3, head = 'Chapter 3 · The bell tower', ver = 'Low Water v14', verdict = 'hear', title = 'Hear', why = 'Maren counts in silence. Bray counts out loud, so the listener has a clock.', from = '¶17 → Bray, “One.” and “Two. Climb.”' } = {}) => `<aside class="side" aria-label="Source"><header><b>Source</b><small>${ver}</small><span class="gap"></span><button type="button" class="ib" aria-label="Close source"${go('script')}>${I.close}</button></header><div class="in"><div class="srchead">${I.book}${head}</div>${paras.map(([n, t]) => `<p class="srcp"><span class="pn">¶${n}</span>${t}</p>`).join('')}<div class="decision"><div class="r"><span class="verdict ${verdict}">${title}</span><small class="mut">${from}</small></div><p>${why}</p><div class="acts"><button type="button" class="btn sm">Change</button><button type="button" class="btn sm ghost">Ask Arke</button></div></div><span class="lnk">${I.book}Open in Low Water</span></div></aside>`;

// ===== Review: the read-through reads the script; only a listen-through hears audio =====
export const reviewCol = ({ notes, title = 'Read-through', data = 'Script v6 · audio not heard' } = {}) => `<aside class="side" aria-label="Review"><header><b>${title}</b><small>${notes.filter(n => !n.done).length} open</small><span class="gap"></span><button type="button" class="ib" aria-label="Previous note">${I.left}</button><button type="button" class="ib" aria-label="Next note">${I.right}</button></header><div class="in"><div class="rhead"><div class="row">${I.doc}<span>${data}</span></div></div>${notes.map(n => `<div class="rnote${n.open ? ' open' : ''}"><div class="k"><b>${n.n}</b> ${n.cat} · ${n.kind}</div><p>${n.text}</p>${n.open ? `<div class="acts"><button type="button" class="btn sm pri"${go(n.fix)}>Fix</button><button type="button" class="btn sm">Intentional</button><button type="button" class="btn sm ghost">Dismiss</button></div>` : ''}</div>`).join('')}<button type="button" class="btn sm" style="align-self:flex-start"${go('studio')}>${I.hear}Listen-through in Audio Studio</button></div></aside>`;

// ===== Cast in a scene: the side column =====
export const castCol = ({ sel = 'odile', scene = 'Scene 3 · no narrator', close = 'quiet', roles = [['odile', 'Unhurried. Affection she won’t say.', 'A little of her slowness. Never her accent.', 'Tired; after midnight'], ['maren', 'Quick, bright; jokes when afraid.', 'Her quickness only.', 'Raw; too tired to joke']] } = {}) => {
  const card = (k, dir, por, sc) => { const p = P[k]; return `<div class="decision"${k === sel ? ' style="border-color:var(--foreground)"' : ''}><div class="r">${face(k)}<b>${p.name}</b><span class="gap"></span><small class="mut">${p.voice || '<span class="warn">no voice</span>'}</small></div><div class="layers"><div><span>Actor</span>${dir}</div><div><span>This scene</span>${sc}</div><div><span>Narrator’s take</span><span class="mut">${por}</span></div></div><div class="acts"><button type="button" class="btn sm"${go('cast')}>Open in Cast</button><button type="button" class="btn sm ghost">${I.hear}Hear ${p.first}’s lines</button></div></div>`; };
  return `<aside class="side" aria-label="Cast in this scene"><header><b>Cast</b><small>${scene}</small><span class="gap"></span><button type="button" class="ib" aria-label="Close cast"${go(close)}>${I.close}</button></header><div class="in">${roles.map(r => card(...r)).join('')}</div></aside>`;
};

// ===== Held bars and popovers =====
export const held = inner => `<div class="held" role="region" aria-label="Waiting for a decision">${inner}</div>`;

// ===== Chat: turn 225's panel and composer, borrowed whole =====
export const makeChat = ({ drawComposer, gIcon }) => {
  const gEsc = v => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const gButton = (label, action, extra = '', content = gEsc(label)) => `<button type="button" data-act="${action}" aria-label="${gEsc(label)}" ${extra}>${content}</button>`;
  const CTX = sub => ({ chapter: { title: 'Builder Chat', label: `Low Water / ${sub}`, subject: sub, hint: `Work on ${sub} with Arke…` } });
  const composer = (sub, st = {}) => drawComposer({ page: 'production', chat: 'chapter', drafts: { chapter: st.draft || '' }, attachments: { chapter: [] }, refusals: {}, uploadNotice: {}, running: {}, voice: null, readReplies: false, worldChanged: false, label: 'ad230 x' }, { esc: gEsc, button: gButton, icon: gIcon, contexts: CTX(sub) });
  const panel = ({ sub = 'Episode 1', body = '', st = {} } = {}) => `<aside class="gc224 gc224-panel" aria-label="Builder Chat"><header class="gc224-panel-head"><div><p>Builder Chat</p><span>Low Water / ${sub}</span></div>${gButton('Conversations', 'history', 'aria-expanded="false"', gIcon('chevron'))}${gButton('Close chat', 'close', '', gIcon('close'))}</header><div class="gc224-messages">${body}</div>${composer(sub, st)}</aside>`;
  const human = t => `<div class="gc224-human">${t}</div>`;
  const answer = (t, extra = '') => `<article class="gc224-answer"><b>Arke</b><p>${t}</p>${extra}</article>`;
  const wait = (name, meta) => `<div class="gc224-proposal waitcard"><div><b>${name}</b><span>${meta}</span></div>${gButton('Show in page', 'show')}</div>`;
  return { panel, human, answer, wait };
};

// ===== The adaptation map =====
// Chapters of the novel (words) on the left, episodes and their scenes (minutes) on the right.
// A ribbon is one decision: its left end the words it takes, its right end the time it becomes.
export const CHAPTERS = [
  [1, 'The tide log', 4100, 'Merge'], [2, 'Low water', 5200, 'Keep'], [3, 'The bell tower', 4800, 'Hear'], [4, 'Bray', 3900, 'Keep', 'moved'],
  [5, 'Market day', 3600, 'Cut'], [6, 'The lamp room', 4400, 'Keep', 'changed'], [7, 'Sereth’s ledger', 4700, 'Merge'], [8, 'Under the arches', 5000, 'Keep'],
  [9, 'The second dive', 4900, 'Hear'], [10, 'Letters', 4300, 'Merge'], [11, 'The wax cylinder', 3800, 'Hear', 'moved'],
  [12, 'The arches flood', 4600], [13, 'Sereth', 4200], [14, 'What Odile kept', 4500], [15, 'The Singer', 4700], [16, 'Low water again', 4400], [17, 'The bell', 4300], [18, 'High water', 4800],
];
// [episode, title, scenes as [title, seconds]]; planned:false draws a dashed placeholder.
export const EPISODES = [
  [1, 'Low Water', [['The recording', 70], ['The harbour at dusk', 280], ['The streets come up', 450], ['The tide turns', 185], ['The lantern', 465]]],
  [2, 'The Tide Log', [['The morning after', 320], ['Sereth’s office', 430], ['The lamp room', 160], ['Letters', 390], ['The Singer', 260]]],
  [3, 'Bray', [['Bray at nine', 420], ['Under the arches', 520], ['The second dive', 400], ['What the letters say', 190]]],
  [4, 'Not planned', null], [5, 'Not planned', null], [6, 'Not planned', null],
];
// [chapter, episode, scene index, share of the chapter's words]; scene -1 is Cut.
const FLOWS = [[1, 1, 1, 1], [2, 1, 2, 1], [3, 1, 3, .7], [3, 1, 4, .3], [4, 3, 0, 1], [5, 0, -1, .85], [5, 2, 0, .15], [6, 2, 2, 1], [7, 2, 0, .3], [7, 2, 1, .7], [8, 3, 1, 1], [9, 3, 2, 1], [10, 2, 3, .6], [10, 3, 3, .4], [11, 1, 0, .5], [11, 2, 4, .5]];

export const amap = ({ sel = 5, W = 880, H = 690 } = {}) => {
  const total = CHAPTERS.reduce((s, c) => s + c[2], 0), gapL = 4, Lh = H - gapL * (CHAPTERS.length - 1) - 40;
  const lx = 210, rx = W - 250, bw = 12;
  let y = 6; const L = {};
  CHAPTERS.forEach(c => { const h = (c[2] / total) * Lh; L[c[0]] = { y, h, used: 0 }; y += h + gapL; });
  // Right side: planned episodes scaled by seconds, unplanned as fixed placeholders, then Cut.
  const secs = EPISODES.filter(e => e[2]).flatMap(e => e[2].map(s => s[1])).reduce((a, b) => a + b, 0);
  const R = {}; let ry = 6; const rH = H - 230, gapE = 14;
  EPISODES.forEach(e => {
    if (!e[2]) { R[e[0]] = { y: ry, h: 30, plan: true }; ry += 30 + 8; return; }
    const sc = []; let sy = ry;
    e[2].forEach(s => { const h = (s[1] / secs) * rH; sc.push({ y: sy, h, used: 0 }); sy += h + 2; });
    R[e[0]] = { y: ry, h: sy - ry - 2, sc }; ry = sy + gapE;
  });
  const cut = { y: ry + 6, h: 18, used: 0 };
  // Each scene's height is shared among the decisions feeding it, by the words each one brings.
  const wordsOf = f => CHAPTERS.find(c => c[0] === f[0])[2] * f[3];
  for (const f of FLOWS) if (f[2] >= 0) { const t = R[f[1]].sc[f[2]]; t.inW = (t.inW || 0) + wordsOf(f); }
  let paths = '', labs = '';
  const selFlows = FLOWS.filter(f => f[0] === sel), others = FLOWS.filter(f => f[0] !== sel);
  for (const [group, list] of [['o', others], ['s', selFlows]]) for (const [c, e, s, share] of list) {
    const a = L[c], lh = a.h * share, y0 = a.y + a.used; a.used += lh;
    let tgt;
    if (s < 0) { tgt = cut; } else tgt = R[e].sc[s];
    const th = s < 0 ? Math.max(2, lh * .25) : Math.max(2, tgt.h * wordsOf([c, e, s, share]) / tgt.inW);
    const ty = tgt.y + tgt.used; tgt.used += th;
    const x0 = lx + bw, x1 = rx, mx = (x0 + x1) / 2;
    const d = `M${x0},${y0} C${mx},${y0} ${mx},${ty} ${x1},${ty} L${x1},${ty + th} C${mx},${ty + th} ${mx},${y0 + lh} ${x0},${y0 + lh} Z`;
    const on = group === 's';
    paths += `<path d="${d}" fill="${on ? 'var(--foreground)' : 'color-mix(in srgb,var(--foreground) 13%,transparent)'}"${on ? ` fill-opacity="${s < 0 ? '.3' : '.82'}"` : ''}/>`;
  }
  // Bars and labels.
  let bars = '';
  CHAPTERS.forEach(c => {
    const a = L[c[0]], planned = !!c[3], on = c[0] === sel;
    bars += `<rect x="${lx}" y="${a.y}" width="${bw}" height="${Math.max(2, a.h)}" rx="2" fill="${planned ? (on ? 'var(--foreground)' : 'color-mix(in srgb,var(--foreground) 55%,transparent)') : 'none'}" stroke="${planned ? 'none' : 'var(--muted-foreground)'}" stroke-dasharray="3 2"/>`;
    labs += `<div class="lab${planned ? '' : ' dim'}${on ? ' sel' : ''}" style="left:32px;top:${a.y + a.h / 2 - 8}px;width:${lx - 40}px;justify-content:flex-end"${go(c[0] === 6 ? 'changed' : '')}><small>${c[0]}</small><b style="font-weight:${on ? 'var(--weight-semibold)' : 'var(--weight-medium)'}">${c[1]}</b>${c[3] ? `<span class="vt">${c[3]}${c[4] === 'moved' ? ' · moved' : ''}</span>` : ''}${c[4] === 'changed' ? '<span class="dot" title="Changed since adapted"></span>' : ''}</div>`;
  });
  EPISODES.forEach(e => {
    const r = R[e[0]];
    if (r.plan) {
      bars += `<rect x="${rx}" y="${r.y}" width="${bw}" height="${r.h}" rx="2" fill="none" stroke="var(--muted-foreground)" stroke-dasharray="3 2"/>`;
      labs += `<div class="lab dim" style="left:${rx + 32 + 20}px;top:${r.y + r.h / 2 - 8}px"><b style="font-weight:var(--weight-medium)">Episode ${e[0]}</b><small>not planned</small></div>`;
      return;
    }
    r.sc.forEach((s, i) => { bars += `<rect x="${rx}" y="${s.y}" width="${bw}" height="${s.h}" rx="2" fill="color-mix(in srgb,var(--foreground) 55%,transparent)"/>`; });
    const mins = Math.round(e[2].reduce((a, s) => a + s[1], 0) / 60);
    labs += `<div class="lab" style="left:${rx + 32 + 20}px;top:${r.y - 2}px;flex-direction:column;align-items:flex-start;gap:3px"><b>Episode ${e[0]} · ${e[1]}</b><small>${mins} min · ${e[2].length} scenes</small></div>`;
  });
  bars += `<rect x="${rx}" y="${cut.y}" width="${bw}" height="${cut.h}" rx="2" fill="none" stroke="var(--foreground)" stroke-dasharray="2 2"/>`;
  labs += `<div class="lab" style="left:${rx + 32 + 20}px;top:${cut.y + 1}px"><b>Cut</b><small>3,060 words</small></div>`;
  return `<div class="amap" style="height:${H}px"><svg class="ribbons" viewBox="0 0 ${W} ${H}" style="left:32px;top:4px;width:${W}px;height:${H}px" role="img" aria-label="Chapters of Low Water flowing into episodes">${paths}${bars}</svg>${labs}</div>`;
};

// ===== The show page (turn 199's audiobook page, for episodes) =====
export const castRow = (keys = ['nar', 'maren', 'bray', 'odile', 'sereth', 'ilo', 'singer']) => `<div class="polys">${keys.map(k => { const p = P[k]; return `<div class="poly"${go('cast')}><div class="ph" style="${p.img ? `background-image:url('${p.img}')` : ''}">${p.nar ? I.wave : ''}${p.lock ? `<span class="badge" title="Identity hidden">${I.lock}</span>` : ''}</div><b>${p.first}</b>${p.voice ? `<small>${p.voice}</small>` : '<small class="warn">no voice</small>'}</div>`; }).join('')}</div>`;
const stepsOf = s => `<div class="steps">${[['Script', s[0]], ['Cast', s[1]], ['Performed', s[2]], ['Mixed', s[3]]].map(([n, v]) => `<span class="${v === true ? 'y' : ''}">${v === true ? I.check : v === false ? '<span class="dot idle"></span>' : `<span class="dot"></span>`}${n}${typeof v === 'string' ? ` <b class="warn" style="font-weight:var(--weight-medium)">${v}</b>` : ''}</span>`).join('')}</div>`;
const stripOf = (e, st) => e[2] ? `<span class="strip">${e[2].map((s, i) => `<i class="${st[i] || ''}" style="flex:${s[1]}"></i>`).join('')}</span>` : '';
export const epRows = ({ phone = false } = {}) => {
  const rows = [
    { e: EPISODES[0], cur: true, num: 'play', t: 'Low Water', m: '24:10', ends: 'Ends on: the lantern speaks.', st: ['done', 'done', 'done', 'done', 'done'], steps: [true, true, true, true] },
    { e: EPISODES[1], t: 'The Tide Log', m: '≈ 26 min', ends: '', st: ['done', 'work', 'done', 'work', ''], steps: [true, '1 missing', '14 of 52', false], act: 'Performing 14 of 52 lines' },
    { e: EPISODES[2], t: 'Bray', m: '≈ 25 min', ends: 'Ends on: Bray goes back under.', st: ['work', '', '', ''], steps: ['draft', false, false, false] },
  ];
  return `<div class="eps">${rows.map((r, i) => `<div class="eprow${r.cur ? ' cur' : ''}"${go(i === 0 ? 'script' : '')}><span class="num${r.num ? ' play' : ''}">${r.num ? I.play : i + 1}</span><div class="t"><b>Episode ${i + 1} · ${r.t} <small>${r.m}</small></b>${r.act ? `<span class="activity"><i></i>${r.act}</span>` : `<span>${r.ends}</span>`}${stripOf(r.e, r.st)}</div>${phone ? '' : stepsOf(r.steps)}${phone ? '' : `<button type="button" class="ib" aria-label="Open episode ${i + 1}">${I.right}</button>`}</div>`).join('')}<div class="eprow plan"${go('map')}><span class="num">${I.plus}</span><div class="t"><b>Episodes 4–6 <small>chapters 12–18</small></b><span>Not planned</span></div>${phone ? '' : '<span></span><button type="button" class="btn sm" style="justify-self:end">Plan with Arke</button>'}</div></div>`;
};
export const showHero = ({ phone = false } = {}) => `<div class="shero"><div class="art" style="background-image:url('${A}banner-audio.png')"></div><h1>Low Water</h1><div class="meta">Audio drama · 6 episodes · from Low Water, the novel</div><div class="acts"><button type="button" class="btn pri">${I.play}Episode 1 <small>24:10</small></button>${phone ? '' : `<button type="button" class="btn"${go('publish')}>Publish…</button><button type="button" class="btn">Export</button>`}<button type="button" class="btn icon" aria-label="More">${I.more}</button></div></div>`;

// ===== Audio Studio for an episode (turn 226's shell; scenes are regions of one arrangement) =====
const LANES = [['Narrator', 'nar', 'v6'], ['Maren', '', 'v1'], ['Bray', '', 'v3'], ['Sereth', 'radio', 'v5'], ['Ilo', 'recording', 'v4'], ['Sound', '', ''], ['Ambience', '', ''], ['Music', '', '']];
export const studio = () => {
  // Episode 1 runs 24:10 (1450 s); scene 4 starts at 13:20. The timeline is zoomed to 13:46–14:10,
  // where Bray cuts in over Maren; the overview above it is the whole episode.
  const T = 1450, t0 = 826, t1 = 850, x = s => ((s - t0) / (t1 - t0)) * 100, X = s => (s / T) * 100;
  const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  const clip = (a, b, label, cls = '') => `<div class="clip ${cls}" style="left:${x(a)}%;width:${x(b) - x(a)}%" title="${label}">${label}</div>`;
  const C = {
    Narrator: clip(840, 845.5, 'She climbed. Behind her…'),
    Maren: clip(826.7, 828.4, 'The log said…') + clip(835, 838.2, 'Ilo’s lantern is up here…'),
    Bray: clip(825, 826.2, 'turn') + clip(828.9, 830, 'The log’s…') + clip(833.8, 834.5, 'One.') + clip(837.8, 839.4, 'Two. Climb.', 'sel') + clip(848, 848.6, 'Three.'),
    Sereth: '', Ilo: '',
    Sound: clip(831.5, 833.3, 'First stair') + clip(846, 847.5, 'Third stair'),
    Ambience: `<div class="clip bedc" style="left:0;width:100%">Tower: water on stone, wind in the louvres</div>`,
    Music: `<div class="clip bedc" style="left:${x(837.8)}%;width:${100 - x(837.8)}%">Low drone</div>`,
  };
  const lanes = LANES.map(([n, sub, v]) => `<div class="ln ${v}">${n}${sub ? ` <small>${sub}</small>` : ''}</div><div class="lt ${v}">${C[n] || ''}</div>`).join('');
  const ticks = [830, 835, 840, 845].map(s => `<span class="tm" style="left:${x(s)}%">${mmss(s)}</span>`).join('');
  // The whole episode: scenes as segments, what has been heard solid, the rest hatched, notes pinned.
  let acc = 0; const scenes = EPISODES[0][2].map(([t, d], i) => { const a = acc; acc += d; return `<span class="osc${i === 3 ? ' on' : ''}" style="left:${X(a)}%;width:${X(d)}%" title="${i + 1} · ${t}">${i + 1}</span>`; }).join('');
  const overview = `<div class="ov"><div class="ovbar">${scenes}<span class="win" style="left:${X(t0)}%;width:${X(t1 - t0)}%"></span></div><div class="heard"><i style="left:0;width:${X(880)}%"></i><s style="left:${X(880)}%;width:${100 - X(880)}%"></s></div><span class="pin" style="left:${X(838)}%" title="Note 1">1</span><span class="pin" style="left:${X(212)}%" title="Note 2">2</span></div>`;
  return `<div class="as"><aside class="lib" aria-label="Library"><div style="display:flex;align-items:center"><h3>Library</h3><span class="gap"></span><button type="button" class="ib" aria-label="Import media">${I.export}</button></div><div class="seg sm" style="align-self:flex-start"><button type="button" class="on">Media</button><button type="button">Effects</button><button type="button">Transitions</button></div><div class="search">${I.search}&nbsp; Find a take, sound or line…</div><div style="display:flex;gap:6px;flex-wrap:wrap"><span class="chip on">Scene 4</span><span class="chip">Not placed</span><span class="chip warnc">Missing 1</span></div>${[['wave', 'Bray · “Two. Climb.”', 'Kept · audition 1 · 1.6 s'], ['wave', 'Bray · “Two. Climb.”', 'Alternate · A2 · 1.4 s'], ['amb', 'Tower interior', 'Ambience · loop · 0:48'], ['music', 'Low drone', 'Music · 1:30'], ['sound', 'First stair', 'Sound · 1.8 s'], ['sound', 'Harbour bell, one stroke', 'Required · no sound yet', 'miss'], ['mic', 'Ilo · cold open', 'Your recording · 1:04']].map(([i, t, s, c], n) => `<div class="litem${n === 0 ? ' on' : ''}${c ? ' ' + c : ''}"><span class="ic">${I[i]}</span><div><b style="font-weight:var(--weight-medium)">${t}</b><small>${s}</small></div></div>`).join('')}</aside>
<section class="ctr"><div class="ah"><button type="button" class="btn sm">${I.export}Import media</button><div class="t"><b>Audio Studio</b><small>Low Water · Episode 1 · 24:10</small></div><span class="gap"></span><button type="button" class="btn sm">${I.play}Listen from top</button><button type="button" class="btn sm pri"${go('publish')}>${I.export}Export audio</button></div>
<div class="panel prev"><header><b>Script</b><span class="mut">4 · The tide turns</span>${I.down}<span class="gap"></span><button type="button" class="btn sm">Follow playhead</button></header><div class="lines"><span>Bray</span><p>One.</p><span>Maren</span><p>Ilo’s lantern is up here. He said it was —</p><span>Bray</span><p class="on">(cuts in) Two. Climb.</p><span>Music</span><p class="cue">Low drone enters, under.</p></div></div>
<div class="panel tl"><div class="review"><b style="font-weight:var(--weight-semibold)">Listen-through</b><small>heard 0:00–14:40 of 24:10</small>${overview}<span class="chip warnc">2 notes</span><button type="button" class="btn sm">Hear the rest</button></div><header><b>Timeline</b><span class="mut">8 lanes · 13:46–14:10</span><span class="gap"></span><button type="button" class="ib" aria-label="Split">${I.scissors}</button><button type="button" class="ib" aria-label="Undo">${I.undo}</button><button type="button" class="ib" aria-label="Redo">${I.redo}</button><span class="chip">4.0×</span></header><div class="lanes"><div class="ln" style="height:34px"></div><div class="ruler"><span class="rg on" style="left:0;width:100%">4 · The tide turns</span><span class="nint" style="left:${x(837.8)}%;width:${x(839.4) - x(837.8)}%" title="Note 1, heard"></span>${ticks}</div>${lanes}<div class="playhead" style="left:calc(96px + (100% - 96px) * ${(x(838.1) / 100).toFixed(4)})"></div></div><div class="transport"><button type="button" aria-label="Back">${I.left}</button><button type="button" aria-label="Play">${I.play}</button><span>13:58.100 / 24:10.000</span><span class="gap"></span><span class="mut">Seconds · episode audio</span></div></div></section>
<aside class="insp" aria-label="Inspector"><div class="tabs"><button type="button" class="on">Inspector</button><button type="button">Arke</button></div><div class="sec"><span class="mut" style="font:var(--type-label)">Listen-through · note 1</span><h4>“Two. Climb.” under the water</h4><div class="kv"><span>Heard</span>13:57.8–13:59.4<span>Observed</span>Bray 4 dB under the tower bed and drone<span>Kind</span>Intelligibility</div><div style="display:flex;gap:6px"><button type="button" class="btn sm pri">Fix</button><button type="button" class="btn sm">Intentional</button><button type="button" class="btn sm ghost">Dismiss</button></div></div><div class="sec"><h4>Dialogue · Bray</h4><div class="kv"><span>Source</span>Audition 1 · kept<span>Placement</span><span class="fld" style="color:var(--foreground)">Cuts in 0.4 s before Maren ends</span><span>Channel</span>In the room<span>Level</span>−3 dB</div></div><div class="sec"><h4>Fix · proposed</h4><div class="kv"><span>Current</span>Beds at −12 dB<span>Suggested</span>Duck beds 6 dB under Bray, 13:57–14:00</div><div style="display:flex;gap:6px"><button type="button" class="btn sm">Show</button><button type="button" class="btn sm">Keep current</button><button type="button" class="btn sm pri">Apply</button></div></div></aside></div>`;
};
