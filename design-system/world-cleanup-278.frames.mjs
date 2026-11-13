// Turn 278 · Clean up (SPEC-066, issue 3044): the frames. Studio Storage is drawn as it ships
// (packages/client/src/components/studio-storage.tsx, inside turn 239's Studio assistant, whose
// shell and backdrop this reuses from the master's own references), with one new button and the
// Held row. Everything else is the new Clean up sheet, a PageSheet over the same page: the
// assistant is put away while it is open, as a later sheet puts an earlier one away today.
// The sample is the owner's Na Love or Juju world as SPEC-066 Appendix A measured it on
// 12 November 2026; where Appendix A gives no figure, the split is illustrative and the notes
// say which.
//
// State is carried in classes and aria, never in boolean attributes: the master's dc runtime
// re-makes every frame from a template and drops `open`, `disabled` and `checked`, which once
// drew 278a's card shut and 278m's Clean up… live.
import { references, nativeIcons } from './global-chat-239.references.mjs';
import { drawComposer } from './global-chat-224.composer.mjs';

export const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

// --- sizes, as Studio Storage labels them (storageByteLabel, contracts storage-health.ts) -------
const size = v => v < 1024 ? `${v} bytes` : v < 1024 ** 2 ? `${Number((v / 1024).toFixed(1))} KiB`
  : v < 1024 ** 3 ? `${Number((v / 1024 ** 2).toFixed(1))} MiB` : `${Number((v / 1024 ** 3).toFixed(1))} GiB`;
const mib = m => Math.round(m * 1024 ** 2);
const gib = g => Math.round(g * 1024 ** 3);
const n = v => v.toLocaleString('en-GB');

// --- the sample: Appendix A, bytes counted once per file --------------------------------------
const WORLD = 'Na Love or Juju';
const WORLD_BYTES = 20_577_163_240;
const MIX = 2_058_868_264;                  // .cache/audiobook-mix, 26 renders, one per chapter
const STALE = Math.round(MIX * 11 / 26);    // illustrative: Appendix A did not split stale from current
// SPEC-066 revision 2: only a current block's lost narration keeps a render back (R-34). Juju's
// 216 missing takes are former shapes and its 7 empty ones were filed empty, so none is kept back.
const CURRENT_CH = MIX - STALE; // the 15 chapters' current renders
const S = {
  bench: { items: 1111, bytes: 2_609_690_507 },
  refs: { items: 214, bytes: 25_441_138 + 471_360_027 },
  stale: { items: 11, bytes: STALE },
  current: { items: 17, bytes: CURRENT_CH + 384_891_057 },
  exports: { items: 15, bytes: 2_008_003_476 },
  unkept: { items: 208, bytes: 912_565_470 },
  artifacts: { items: 31, bytes: 31_200_000 + 18_000_000 },
  narration: { items: 317, bytes: 233_524_754 },
};
const NOW_DEFAULT = S.bench.bytes + S.refs.bytes + S.stale.bytes;
// The fifteen old exports, sized to Appendix A's 2,008,003,476 bytes. Every partial audiobook
// package holds chapters 1–6 only: Appendix A finds no package but the 11 Oct book holding a
// chapter whose kept takes are gone, and one that did would be a last copy (R-42), never offered.
const EXPORTS = [
  ['Audiobook · chapter 1', '28 Sep', 'Book · 11 Oct', 64.4], ['Audiobook · chapters 1–2', '30 Sep', 'Book · 11 Oct', 118.9],
  ['Audiobook · chapters 1–4', '2 Oct', 'Book · 11 Oct', 236.0, true], ['Audiobook · chapter 5', '3 Oct', 'Book · 11 Oct', 58.7],
  ['Audiobook · chapters 1–6', '4 Oct', 'Book · 11 Oct', 352.3, true], ['Audiobook · chapter 3', '6 Oct', 'Book · 11 Oct', 63.0],
  ['Audiobook · chapter 6', '7 Oct', 'Book · 11 Oct', 60.0], ['Audiobook · chapter 2', '8 Oct', 'Book · 11 Oct', 60.1],
  ['Audiobook · chapter 1', '21 Oct', 'Chapter 1 · 6 Nov', 64.2], ['Chapter film · chapter 1', '24 Oct', 'Chapter film · 3 Nov', 288.4],
  ['Chapter film · chapter 1', '29 Oct', 'Chapter film · 3 Nov', 291.0], ['Music video', '26 Oct', 'Music video · 9 Nov', 61.2],
  ['Music video', '28 Oct', 'Music video · 9 Nov', 63.9], ['Music video', '30 Oct', 'Music video · 9 Nov', 65.0],
  ['Music video', '2 Nov', 'Music video · 9 Nov', 67.9],
];
if (EXPORTS.length !== S.exports.items) throw new Error('fifteen exports');
const PICKED = EXPORTS.filter(e => e[4]).reduce((sum, e) => sum + mib(e[3]), 0);
const DATE = { short: '20 Nov', long: '13 Dec' };
// A hold's end reads one way everywhere it is a date alone.
const until = date => `Until ${date}`;
// The run that 278g shows and 278p stops: every Bench copy linked, 88 of 214 reference copies.
const REFS_DONE = Math.round(S.refs.bytes * 88 / 214);

// --- glyphs: client icons.tsx paths, 1.75 stroke --------------------------------------------
const svg = (paths, px = 16, stroke = 1.75) => `<svg width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const WARN = '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>';
const G = {
  tick: svg('<path d="M20 6 9 17l-5-5"/>', 11, 3),
  dash: svg('<path d="M6 12h12"/>', 11, 3),
  done: svg('<path d="M20 6 9 17l-5-5"/>', 14, 3),
  down: svg('<path d="m6 9 6 6 6-6"/>'),
  right: svg('<path d="m9 18 6-6-6-6"/>'),
  back: svg('<path d="m15 18-6-6 6-6"/>', 20),
  x: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 20),
  lock: svg('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>', 14),
  warn: svg(WARN),
  // The warning colour marks a reason with its glyph; the words stay in a readable colour.
  flag: svg(WARN, 12, 2),
  wait: svg('<circle cx="12" cy="12" r="9"/>', 14, 2),
};
const icon = name => nativeIcons[name];
const reason = text => `<span class="cu-reason">${G.flag}<span>${text}</span></span>`;
// A label's words hold together between its middots, so a phone wraps it only at a middot.
const keep = label => label.split(' · ').map(part => part.replaceAll(' ', '&nbsp;')).join(' · ');

// --- the page behind: the master's own 227 drawings, as turn 239 captured them ----------------
function scene({ device = 'desktop', width, height, label, over }) {
  const page = references[device === 'phone' ? 'phone' : 'desktop'];
  return `<div class="g239-scene ch227 cu278${device === 'phone' ? ' phone' : ''}" data-device="${device}" data-screen-label="${esc(label)}" style="width:${width}px;height:${height}px"><div class="g239-page">${page}</div>${over}</div>`;
}

// --- Studio Storage, as shipped -----------------------------------------------------------------
// The Studio assistant's shell is turn 239's drawing of it; the reply inside is StudioMessage and
// StudioStorageReadingsView drawn with the shipped class names and stylesheet.
function composer() {
  const state = { page: 'world', chat: 'studio', drafts: { studio: '' }, attachments: {}, refusals: {}, running: {}, worldChanged: false, voice: null, readReplies: false, label: 'studio-278' };
  const contexts = { studio: { title: 'Arke', subject: 'Studio', hint: 'Ask Arke about your studio…' } };
  const button = (label, action, extra = '', body = esc(label)) => `<button type="button" data-action="${action}" aria-label="${esc(label)}" ${extra}>${body}</button>`;
  // An empty draft's Send is off; aria carries that into the master, which drops `disabled`.
  return drawComposer(state, { esc, button, icon, contexts }).replace('class="gc224-send" disabled', 'class="gc224-send" disabled aria-disabled="true"');
}
const ib = (name, label) => `<button class="g239-icon" type="button" aria-label="${label}" title="${label}">${icon(name)}</button>`;
// Illustrative split of the inventory; the open world's total, 19.2 GiB, is measured.
const CATEGORIES = [['Artifacts', gib(5.3)], ['Generated takes', gib(4.1)], ['Published outputs', gib(6.9)], ['Models', gib(41.7)], ['Downloads', 0], ['Temporary files', gib(2.4)]];
function storageReply({ held = 0 } = {}) {
  const facts = rows => `<dl class="fy-studio-facts">${rows.map(([dt, dd, cls = '']) => `<dt class="${cls}">${dt}</dt><dd class="${cls}">${dd}</dd>`).join('')}</dl>`;
  // Files in Arke folders is a <details> the person has opened. It is drawn as an opened one, the
  // summary's disclosure marker and all, so that it stays open in the master (see the head).
  return `<div class="fy-studio-user">Review storage</div>
<article class="fy-studio-answer" aria-label="Arke"><div class="fy-studio-answer-label">Arke</div><p>The drive that holds ${WORLD} is below its warning level.</p>
<div class="fy-studio-fact-card"><div class="fy-studio-fact-head">Operational findings</div><p class="fy-studio-note">Observed 13/11/2026, 10:41:52. Findings describe that observation.</p><b>Possible causes</b><ul><li>Media in the open world</li></ul></div>
<section aria-label="Latest storage readings"><div class="fy-studio-fact-card"><div class="fy-studio-fact-head">${icon('warning')}Storage needs attention</div><div class="fy-studio-meta">Local models · World media · Working files · Downloads · Exports</div><p class="fy-studio-meta">Measured 13/11/2026, 10:41:52</p>${facts([['Available', '7.8 GiB'], ['Drive capacity', '476.3 GiB'], ['Working reserve', '1 GiB']])}<p class="fy-studio-note">Available space is below the warning threshold. Existing artwork, recordings and exports are kept.</p></div>
<p class="fy-studio-note">These readings alone do not confirm that an export or other operation will fit.</p>
<div class="fy-studio-fact-card cu-details" role="group" aria-label="Files in Arke folders"><div class="cu-summary" role="button" aria-expanded="true">Files in Arke folders</div><p class="fy-studio-note">Size estimates for Arke’s managed folders and the open world. Other locations and closed worlds are not included.</p>${facts([...CATEGORIES, ['Held', held], ['Other or unmeasured', mib(512)]].map(([dt, bytes]) => [dt, size(bytes)]))}<p class="fy-studio-note">File sizes do not explain all used drive space. Shared files may be counted more than once. Recoverable space is unknown. Removing an artifact from the shelf keeps its files.</p></div>
<div class="fy-studio-work-actions"><button type="button" class="fy-studio-button">Clean up world</button><a class="fy-studio-button" href="#278a">Review installed models</a></div></section>
<div class="fy-studio-fact-card fy-studio-remedies"><div class="fy-studio-fact-head">Current remedies</div><p class="fy-studio-note">These controls use the current measured status. Reviewing a plan does not approve it.</p><a class="fy-studio-button" href="#278a">Open Diagnostics</a></div></article>`;
}
function assistant(scroll) {
  return `<section class="gc224 gc224-panel g239-dialog" role="dialog" aria-label="Arke · Studio assistant"><header class="gc224-panel-head g239-head"><div><p>Arke</p><span>Studio assistant</span></div>${ib('history', 'Studio conversations')}${ib('close', 'Close Studio assistant')}</header><div class="g239-scope">Studio <span>Setup, local AI &amp; help</span></div><div class="gc224-messages g239-messages cu-studio" role="log" aria-label="Studio conversation"><div class="cu-scrolled" style="margin-top:-${scroll}px">${storageReply()}</div></div>${composer()}</section>`;
}

// --- the Clean up sheet ---------------------------------------------------------------------
const btn = (label, kind = 'outline', off = false) => `<button type="button" class="cu-btn cu-btn--${kind}"${off ? ' aria-disabled="true"' : ''}>${label}</button>`;
const check = (state, name, off = false) => `<label class="cu-check${off ? ' off' : ''}" aria-label="${esc(name)}"><span class="cu-box${state === true ? ' on' : state === 'mixed' ? ' mixed' : ''}"><input type="checkbox" aria-checked="${state === 'mixed' ? 'mixed' : state === true}"${off ? ' aria-disabled="true"' : ''}>${state === 'mixed' ? G.dash : G.tick}</span></label>`;
const WORLD_SUB = `${WORLD} · ${size(WORLD_BYTES)}`;
// sum: the tabs, the totals and the column heads, which stay in sight while the body scrolls.
function sheet({ sum = '', body, foot = '', back = false, cls = '', sub = WORLD_SUB, scroll = 0 }) {
  return `<div class="cu-scrim"></div><section class="cu-sheet${cls ? ' ' + cls : ''}" role="dialog" aria-label="Clean up"><header class="cu-head">${back ? `<button type="button" class="cu-iconbtn" aria-label="Back">${G.back}</button>` : ''}<div class="cu-titles"><h2>Clean up</h2><p>${sub}</p></div><button type="button" class="cu-iconbtn" aria-label="Close">${G.x}</button></header>${sum ? `<div class="cu-sum">${sum}</div>` : ''}<div class="cu-body">${scroll ? `<div class="cu-scrolled" style="margin-top:-${scroll}px">` : ''}${body}${scroll ? '</div>' : ''}</div>${foot ? `<footer class="cu-foot">${foot}</footer>` : ''}</section>`;
}
const tabs = (on, held) => `<div class="cu-tabs" role="tablist"><button type="button" role="tab" aria-selected="${on === 'plan'}">Plan</button><button type="button" role="tab" aria-selected="${on === 'held'}">Held <span>${held}</span></button></div>`;
const totals = (pairs, right = '') => `<div class="cu-totals">${pairs.map(([label, value, note = '']) => `<div><span>${label}</span><b>${value}</b>${note ? `<i>${note}</i>` : ''}</div>`).join('')}${right ? `<span class="cu-made">${right}</span>` : ''}</div>`;

// A class: name, consequence (R-16), its figures, its action, ticked by default (R-32 – R-40).
const CLASSES = {
  bench: ['Bench copies', 'Same files · one copy · Explorer sizes stay', S.bench, 'link', true],
  refs: ['Reference copies', 'Same files · one copy · Explorer sizes stay', S.refs, 'link', true],
  stale: ['Old chapter mixes', 'Made again when played', S.stale, 'evict', true],
  current: ['Current mixes', 'Made again when played', S.current, 'evict', false],
  exports: ['Old exports', `Back until ${DATE.short} · marked in Made`, S.exports, 'hold7', false],
  unkept: ['Unkept Bench takes', `Back until ${DATE.short}`, S.unkept, 'hold7', false],
  artifacts: ['Unused artifacts', `Back until ${DATE.long}`, S.artifacts, 'hold30', false],
  narration: ['Unkept narration', `Back until ${DATE.long} · $3.40 to read again`, S.narration, 'hold30', false],
};
const openButton = (name, open) => `<button type="button" class="cu-open" aria-label="${open ? 'Hide' : 'Show'} ${esc(name)}" aria-expanded="${open}">${open ? G.down : G.right}</button>`;
// Now and After hold both count what the ticked items leave with no file: a link or a cleared mix
// has its size in both, a hold none now and its size once the hold ends (R-9, R-10, R-14).
function classRow(key, { tick, open = false, count, stopped, mobile = false, disabled = false } = {}) {
  const [name, consequence, { items, bytes }, action, def] = CLASSES[key];
  const state = tick ?? def;
  const held = action.startsWith('hold'), date = action === 'hold7' ? DATE.short : DATE.long;
  const shown = count ?? n(items);
  if (stopped) return `<div class="cu-row cu-class stopped"><span class="cu-tick">${check(false, name, true)}</span><div class="cu-name"><b>${name}</b>${reason(stopped)}</div>${mobile ? '<span class="cu-sz cu-none">—</span>' : '<span class="cu-n"></span><span class="cu-sz cu-none">—</span><span class="cu-sz cu-none">—</span>'}<span></span></div>`;
  const nowCell = held ? '<span class="cu-sz cu-none">—</span>' : `<span class="cu-sz">${size(bytes)}</span>`;
  const afterCell = `<span class="cu-sz">${size(bytes)}${held ? `<i>${until(date)}</i>` : ''}</span>`;
  const phoneCell = `<span class="cu-sz">${size(bytes)}<i>${held ? until(date) : shown}</i></span>`;
  return `<div class="cu-row cu-class${open ? ' open' : ''}"><span class="cu-tick">${check(state, name, disabled)}</span><div class="cu-name"><b>${name}</b><span>${keep(consequence)}</span></div>${mobile ? phoneCell : `<span class="cu-n">${shown}</span>${nowCell}${afterCell}`}${openButton(name, open)}</div>`;
}
const colhead = '<div class="cu-row cu-colhead" aria-hidden="true"><span></span><span></span><span>Items</span><span>Now</span><span>After hold</span><span></span></div>';
// An item: its tick (or the lock of a protected one), its picture, label and meta, and its sizes.
function item({ tick = false, img, label, meta, now = '', after = '', date = '', tag = '', lock = false, action = '', disabled = false, mobile = false, noTick = false }) {
  const pic = img ? `<img src="assets/${img}" alt="">` : '';
  const tickCell = noTick ? '' : lock ? `<span class="cu-lock" title="Protected">${G.lock}</span>` : check(tick, label, disabled);
  const sizes = mobile ? `<span class="cu-sz">${now || after}${date ? `<i>${date}</i>` : ''}</span>` : `<span class="cu-n"></span><span class="cu-sz${now ? '' : ' cu-none'}">${now || '—'}</span><span class="cu-sz cu-after${after ? '' : ' cu-none'}">${after || '—'}${date ? `<i>${date}</i>` : ''}</span>`;
  return `<div class="cu-row cu-item${lock ? ' locked' : ''}"><span class="cu-tick">${tickCell}</span><div class="cu-name${pic ? ' cu-pic' : ''}">${pic}<div><b>${label}</b><span>${meta}${tag ? ` <em class="cu-tag">${tag}</em>` : ''}</span></div></div>${sizes}<span class="cu-act">${action}</span></div>`;
}
const group = name => `<div class="cu-group">${name}</div>`;

// Problems (R-42 – R-44): below the plan, counted apart, in no total. Narration before joins is
// listed apart and holds nothing back (R-42, revision 2).
function problems({ open = false, mobile = false } = {}) {
  const row = (name, meta, count, bytes, action = '', isOpen = false) => `<div class="cu-row cu-prob${isOpen ? ' open' : ''}"><div class="cu-name"><b>${name}</b><span>${keep(meta)}</span></div><span class="cu-n">${count}</span><span class="cu-sz${bytes === '—' ? ' cu-none' : ''}">${bytes}</span>${mobile ? '' : `<span class="cu-act">${action}</span>`}${openButton(name, isOpen)}</div>`;
  // Two of the 137 opened, so that 278e reaches the end of the list: the mixes kept back included.
  const pictures = [['juju-m-car.jpg', 'Ade and Tunde, car', 'take 3', 2.9], ['nloj-booth.jpg', 'Club booth', 'take 6', 3.1]];
  const opened = open ? `<div class="cu-items cu-items--prob">${pictures.map(([img, label, take, mb]) => `<div class="cu-row cu-prob"><div class="cu-name cu-pic"><img src="assets/${img}" alt=""><div><b>${label}</b><span>Bench · ${take}</span></div></div><span class="cu-n"></span><span class="cu-sz">${size(mib(mb))}</span><span class="cu-act">${btn('Put back', 'sm')}</span><span></span></div>`).join('')}<div class="cu-more">135 more</div></div>` : '';
  return `<section class="cu-problems"><h3>Problems <span class="cu-count">499</span></h3>
${row('Bench pictures', 'Last copy · artifact gone', '137', size(384_311_071), btn('Put back on shelf', 'sm'), open)}${opened}
${row('Narration before joins', 'No audio · 8 chapters', '216', '—')}
${row('Narration, chapter 1', 'Empty audio', '7', size(7 * 44))}
${row('Artifacts', 'File gone', '139', '—')}
<p class="cu-apart">Retired, no file · 1,178</p></section>`;
}

// held: the bytes of the holds ticked by hand, which After hold adds to Now.
function plan({ ticks = {}, open = '', opened = '', stopped = {}, mobile = false, disabled = false, held = 0, openProblems = false } = {}) {
  const rows = Object.keys(CLASSES).map(key => classRow(key, { tick: ticks[key], open: open === key, count: key === 'exports' && ticks.exports === 'mixed' ? `2 of ${S.exports.items}` : undefined, stopped: stopped[key], mobile, disabled }) + (open === key ? `<div class="cu-items">${opened}</div>` : '')).join('');
  return {
    sum: totals([['Now', size(NOW_DEFAULT)], ['After hold', size(NOW_DEFAULT + held), held ? until(DATE.short) : '']], 'Plan · 10:42') + (mobile ? '' : colhead),
    body: `<div class="cu-classes">${rows}</div>${problems({ mobile, open: openProblems })}`,
  };
}
const planFoot = (count = '1,336 ticked', button = btn('Clean up…', 'primary')) => `<span>${count}</span>${button}`;

// --- frames -----------------------------------------------------------------------------------
const W = 1360, H = 900, PW = 390, PH = 844;
const desk = (label, over) => scene({ width: W, height: H, label, over });
const phone = (label, over) => scene({ device: 'phone', width: PW, height: PH, label, over });

const exportsOpened = EXPORTS.map(([label, made, newer, mb, picked]) => item({ tick: !!picked, label, meta: `${made} · Newer: ${newer}`, after: size(mib(mb)), date: until(DATE.short) })).join('');
const artifactsOpened = [
  group('Na Love or Juju'),
  item({ img: 'nloj-ade-look.jpg', label: 'Ade, first look', meta: 'Picture · 2 Oct', tag: 'Change log only', after: '1.9 MiB', date: until(DATE.long) }),
  item({ img: 'nloj-booth.jpg', label: 'Club booth, take 4', meta: 'With its Bench take', after: '3.0 MiB', date: until(DATE.long) }),
  item({ img: 'nloj-eyes.jpg', label: 'Ife, eyes', meta: 'Source of 3 pictures', lock: true, action: btn('Include', 'sm') }),
  group('Promo'),
  item({ img: 'juju-m-hand.jpg', label: 'Hand on the gear stick', meta: 'Picture · 30 Oct', tag: 'Change log only', after: '2.2 MiB', date: until(DATE.long) }),
  item({ img: 'juju-m-car.jpg', label: 'Car at night, wide', meta: 'With its Bench take', after: '2.6 MiB', date: until(DATE.long) }),
  group('World'),
  item({ img: 'nloj-cover.jpg', label: 'Key art, draft 3', meta: 'Picture · 9 Oct', tag: 'Change log only', after: '2.4 MiB', date: until(DATE.long) }),
].join('');
const benchOpened = [
  ['juju-m-car.jpg', 'Ade and Tunde, car', 'take 3', 2.9], ['nloj-booth.jpg', 'Club booth', 'take 6', 3.1],
  ['juju-w-table.jpg', 'Table at the club', 'take 2', 3.4], ['juju-ade-house.jpg', 'Ade’s house', 'take 5', 1.8],
].map(([img, label, take, mb]) => item({ tick: true, img, label, meta: `Bench · ${take}`, now: size(mib(mb)), mobile: true, disabled: true })).join('') + '<div class="cu-more">1,107 more</div>';

const confirmRows = rows => `<div class="cu-confirm">${rows.map(([verb, what, bytes, when]) => `<div class="cu-crow"><b>${verb}</b><span>${what}</span><span class="cu-sz">${bytes}</span><span class="cu-when">${when}</span></div>`).join('')}</div>`;
const runRows = rows => `<div class="cu-run">${rows.map(([state, name, progress, value]) => `<div class="cu-rrow ${state}"><span class="cu-rmark">${state === 'done' ? G.done : state === 'now' ? '<i class="cu-spin"></i>' : G.wait}</span><b>${name}</b><span class="cu-n">${progress}</span><span class="cu-sz">${value}</span></div>`).join('')}</div>`;
// A result row: done (ticked) or not run (the waiting ring), what happened, and any skip's reason.
const resultRows = rows => `<div class="cu-result">${rows.map(([name, line, why, state = 'done']) => `<div class="cu-rrow ${state}"><span class="cu-rmark">${state === 'done' ? G.done : G.wait}</span><b>${name}</b><span class="cu-res">${line}${why ? reason(why) : ''}</span></div>`).join('')}</div>`;
const drive = (after, gained) => `<dl class="cu-drive"><dt>Available before</dt><dd>7.8 GiB</dd><dt>Available after</dt><dd>${after}</dd><dt>Drive gained</dt><dd>${gained}</dd></dl>`;

// Held, opened on 21 Nov at 09:40: the 13 Nov plan ended on 20 Nov and this is the first Studio
// opening to list it so, so it goes on a Studio opening a day or more later (R-30).
function held({ mobile = false } = {}) {
  const acts = (...labels) => mobile ? '' : `<div class="cu-plan-acts">${labels.map(l => btn(l, l === 'Empty now' ? 'sm cu-btn--danger' : 'sm')).join('')}</div>`;
  const restore = (off = false) => mobile ? '' : btn('Restore', 'sm', off);
  const heldItem = o => item({ ...o, mobile, noTick: true });
  return {
    sum: tabs('held', 2) + totals([['Held', size(mib(588.3) + mib(104.6) + mib(46.9))]]),
    body: `<div class="cu-plan"><div class="cu-plan-head"><div class="cu-name"><b>Plan of 13 Nov</b><span>2 old exports</span></div><em class="cu-tag cu-tag--ended">Ended 20 Nov</em><span class="cu-sz">${size(PICKED)}<i>Goes after 22 Nov 09:40</i></span>${openButton('Plan of 13 Nov', false)}</div>${acts('Restore all', 'Empty now')}</div>
<div class="cu-plan open"><div class="cu-plan-head"><div class="cu-name"><b>Plan of 18 Nov</b><span>24&nbsp;takes · 31&nbsp;artifacts</span></div><span class="cu-notag"></span><span class="cu-sz">${size(mib(104.6) + mib(46.9))}<i>${until('25 Nov')} · 18 Dec</i></span>${openButton('Plan of 18 Nov', true)}</div>
<div class="cu-items">${group(`Unkept Bench takes · ${until('25 Nov')}`)}${heldItem({ img: 'juju-zee.jpg', label: 'Zee at the door', meta: 'Bench · take 4', now: '4.6 MiB', action: restore() })}${heldItem({ img: 'juju-kemi.jpg', label: 'Kemi, kitchen', meta: 'Bench · take 2', now: '4.1 MiB', action: restore() })}<div class="cu-more">22 more</div>
${group(`Unused artifacts · ${until('18 Dec')}`)}${heldItem({ img: 'nloj-ade-look.jpg', label: 'Ade, first look', meta: 'Na Love or Juju', now: '1.9 MiB', action: restore() })}${heldItem({ img: 'nloj-cover.jpg', label: 'Key art, draft 3', meta: 'World', tag: 'Name taken', now: '2.4 MiB', action: restore(true) })}<div class="cu-more">29 more</div></div>${acts('Restore all', 'Empty now')}</div>`,
  };
}

const state = (glyph, title, line, action = '') => `<div class="cu-state"><span class="cu-state-mark">${glyph}</span><b>${title}</b><span>${line}</span>${action}</div>`;
const twoTotals = (now, after, note) => totals([['Now', now], ['After hold', after, note]], 'Plan · 10:42');

const DESKTOP = [
  ['a', 'The way in: Studio Storage, with Held and Clean up world', W, H, 'desk',
    () => desk('278a Studio Storage as it ships, in the Studio assistant’s storage reply, plus the Held row and Clean up world beside Files in Arke folders', assistant(600))],
  ['b', 'The plan: eight classes, two totals, problems apart', W, H, 'desk',
    () => desk('278b The Clean up sheet with its plan: each class with its items, size now and after hold, ticked by default where the spec ticks it; problems apart, in no total', sheet({ ...plan(), foot: planFoot() }))],
  ['c', 'A class opened: old exports, each with the newer one that covers it', W, H, 'desk',
    () => desk('278c Old exports opened; two ticked by hand, so After hold rises by their size, with the date their hold ends', sheet({ ...plan({ ticks: { exports: 'mixed' }, open: 'exports', opened: exportsOpened, held: PICKED }), foot: planFoot('1,338 ticked'), scroll: 168 }))],
  ['d', 'Unused artifacts, grouped by production', W, H, 'desk',
    () => desk('278d Unused artifacts opened, grouped under the production that owns them, then the world’s; a source of other pictures is protected until Include', sheet({ ...plan({ open: 'artifacts', opened: artifactsOpened }), foot: planFoot(), scroll: 280 }))],
  ['e', 'Problems apart, with Put back on shelf', W, H, 'desk',
    () => desk('278e Problems below the plan, counted apart; the 137 Bench pictures whose artifact is gone open with Put back on shelf', sheet({ ...plan({ openProblems: true }), foot: planFoot(), scroll: 449 }))],
  ['f', 'The confirm', W, H, 'desk',
    () => desk('278f Clean up… pressed: what will happen, by action, with the hold’s date; Clean up runs it', sheet({ back: true, sum: twoTotals(size(NOW_DEFAULT), size(NOW_DEFAULT + PICKED), until(DATE.short)), body: confirmRows([['Link', `${n(S.bench.items + S.refs.items)} copies`, size(S.bench.bytes + S.refs.bytes), 'Now'], ['Clear', `${S.stale.items} old chapter mixes`, size(S.stale.bytes), 'Now'], ['Hold', '2 old exports', size(PICKED), until(DATE.short)]]), foot: `<span>1,338 items</span><div class="cu-foot-acts">${btn('Back')}${btn('Clean up', 'primary')}</div>` }))],
  ['g', 'The run, with Stop', W, H, 'desk',
    () => desk('278g Running: each class in turn, the one under way with its count; Stop ends it before the next item', sheet({ sum: totals([['Cleared so far', size(S.bench.bytes + REFS_DONE)], ['Items', '1,199 of 1,338']]) + '<div class="cu-bar"><i style="width:89.6%"></i></div>', body: runRows([['done', 'Bench copies', '1,111 of 1,111', size(S.bench.bytes)], ['now', 'Reference copies', '88 of 214', ''], ['wait', 'Old chapter mixes', '0 of 11', ''], ['wait', 'Old exports', '0 of 2', until(DATE.short)]]), foot: `<span>Running · 10:44</span>${btn('Stop')}` }))],
  ['h', 'The result', W, H, 'desk',
    () => desk('278h The run ended: what each class did, what was skipped and why, and the drive measured before and after', sheet({ sum: totals([['Cleared', '3.6 GiB'], ['Held', size(PICKED), until(DATE.short)]]), body: drive('11.4 GiB', '3.6 GiB') + resultRows([['Bench copies', '1,109 linked · 2 skipped', 'Changed since plan'], ['Reference copies', '214 linked', ''], ['Old chapter mixes', '10 cleared · 1 skipped', 'In use'], ['Old exports', `2 held · ${until(DATE.short)}`, '']]), foot: `<span>10:47</span>${btn('Done', 'primary')}` }))],
  ['i', 'Held plans: Restore, Empty now, an ended hold', W, H, 'desk',
    () => desk('278i Held, opened in the Studio on 21 Nov: the 13 Nov plan has ended and goes on a Studio opening a day later; the 18 Nov plan opened, each item with Restore', sheet(held()))],
  ['j', 'Empty now, the second confirm', W, H, 'desk',
    () => desk('278j Empty now pressed: the plan, its size, and that it cannot be undone', sheet({ back: true, body: `<div class="cu-empty"><b>Empty now</b><dl class="cu-drive"><dt>Plan of 13 Nov</dt><dd>2 old exports</dd><dt>Size</dt><dd>${size(PICKED)}</dd></dl><p class="cu-final">${G.warn}Can’t be undone</p></div>`, foot: `<span>Ended 20 Nov</span><div class="cu-foot-acts">${btn('Keep')}${btn('Empty now', 'destructive')}</div>` }))],
  ['k', 'Refused: a read-only world', W, H, 'desk',
    () => desk('278k The world is open read-only: no plan, and a run left unsettled is reported, not recovered', sheet({ body: state(G.lock, 'Read-only world', 'Unsettled run · 13 Nov') }))],
  ['l', 'Refused: outside edits, Adopt first', W, H, 'desk',
    () => desk('278l Files changed outside Arke: no plan until they are adopted; Review edits opens the world where Adopt is', sheet({ body: state(G.warn, 'Outside edits', '3 files · Adopt first', btn('Review edits')) }))],
  ['m', 'Refused: an export running; classes stopped by a holder', W, H, 'desk',
    () => desk('278m An export is running, so the plan cannot run; a Publish draft will not read, so every class that reads drafts is stopped and the rest are offered', sheet({ ...plan({ stopped: { exports: 'Stopped · Publish draft unreadable', artifacts: 'Stopped · Publish draft unreadable', narration: 'Stopped · Publish draft unreadable' } }), foot: planFoot('1,336 ticked', `<div class="cu-foot-acts"><span class="cu-busy">Export running · Book</span>${btn('Clean up…', 'primary', true)}</div>`) }))],
];
const PHONE = [
  ['n', 'Phone, paired: the plan, shown and not run', PW, PH, 'phone',
    () => phone('278n Phone, a paired browser: the plan as the desk would open it, Bench copies opened; ticks are off and the foot says where it runs', sheet({ cls: 'cu-sheet--phone', ...plan({ open: 'bench', opened: benchOpened, mobile: true, disabled: true }), foot: '<span class="cu-only">Studio only</span>' }))],
  ['o', 'Phone, paired: held plans', PW, PH, 'phone',
    () => phone('278o Phone, a paired browser: held plans with their sizes and dates; Restore and Empty now are the Studio’s', sheet({ cls: 'cu-sheet--phone', ...held({ mobile: true }), foot: '<span class="cu-only">Studio only</span>' }))],
];
// Drawn after the phone frames so that 278a–o keep the letters the review used.
const LATER = [
  ['p', 'The run stopped: outside edits mid-run', W, H, 'desk',
    () => desk('278p A file was edited outside Arke during the run: it stopped before its next item; what was done stays done and the rest did not run', sheet({ sum: totals([['Cleared', size(S.bench.bytes + REFS_DONE)], ['Items', '1,199 of 1,338']]), body: `<p class="cu-stopline">${G.warn}<b>Stopped · Outside edits</b></p>` + drive('10.4 GiB', '2.6 GiB') + resultRows([['Bench copies', '1,111 linked', ''], ['Reference copies', '88 linked · 126 not run', ''], ['Old chapter mixes', 'Not run', '', 'wait'], ['Old exports', 'Not run', '', 'wait']]), foot: `<span>10:45</span><div class="cu-foot-acts">${btn('Review edits')}${btn('Done', 'primary')}</div>` }))],
];

export const FRAMES = [...DESKTOP, ...PHONE, ...LATER];
