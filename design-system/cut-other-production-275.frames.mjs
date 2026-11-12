// Turn 275 · The Cut's Library, another production's shots (issue 2953): the frames. The editor is
// turn 220's source-backed Cut shell, drawn by its own script and unchanged outside the Library
// column, so the page behind the new rows is the one the master already holds. The sample is
// Harbour lights, a film with no story of its own, borrowing from Saltlight in the same world.
import { nativeScreen } from './air-particles-220.native.mjs';

const A = 'assets/';
const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';
const FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h7l2 3h9v11H3z"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const b = (label, cls = '') => `<button type="button" class="${cls}">${label}</button>`;

// Harbour lights' own Library, as turn 220 draws it.
const OWN = [
  ['Harbour lights.wav', 'audio · 72s', 'launch-harbour.webp'],
  ['Harbour', 'image', 'launch-plate.webp'],
  ['Coast', 'image', 'saltlight-shot15.png'],
  ['Boat video', 'video · 18s', 'launch-harbour.webp'],
  ['Evening', 'image', 'launch-plate.webp'],
];
// Saltlight's shots with an accepted take. Shot 3 of scene 4 has none and is not listed.
const SHOTS = [
  ['Shot 1 · The harbour before light', 'SC 1 · 6s', 'launch-harbour.webp'],
  ['Shot 2 · Maren at the rail', 'SC 1 · 4s', 'saltlight-shot15.png'],
  ['Shot 1 · The lamp room', 'SC 4 · 5s', 'scene4-shot12.png'],
  ['Shot 2 · Her hand on the glass', 'SC 4 · 3s', 'scene4-shot12b-detail.png'],
  ['Shot 4 · The light turns', 'SC 4 · 8s', 'scene4-shot14.png'],
  ['Shot 5 · The tide answers', 'SC 4 · 6s', 'scene4-shot15.png'],
];

const row = ([name, meta, img], { picked = false, actions = '' } = {}) => `<div class="n-media-row${picked ? ' selected cb275-picked' : ''}"><img src="${A}${img}" alt=""><span><b>${name}</b><small>${meta}</small></span></div>${picked ? `<div class="cb275-acts">${actions}</div>` : ''}`;
const filters = (browse) => `<div class="n-actions">${b('All', 'selected')}${b('Not in the cut')}${b('Audio')}${b(`${browse} ▾`, 'cb275-browse')}${b('All kinds ▾')}</div>`;
const menu = () => `<div class="cb275-menu" role="listbox" aria-label="Browse"><span class="it on">${CHECK}This production</span><span class="gp">This world&#8217;s productions</span><span class="it">Saltlight</span><span class="it">Undertow</span><span class="gp">Other worlds</span><span class="it">The Red Quiet</span><span class="it">Na Love or Juju</span></div>`;
const library = (browse, body, extra = '') => `<header class="n-library-head"><b>Library</b><span>↥</span></header><nav class="n-library-tabs" aria-label="Library collections">${b('Media', 'selected')}${b('Effects')}${b('Transitions')}</nav><div class="n-library-content n-media-list cb275-list"><input placeholder="Find a take, upload or line…" readonly>${filters(browse)}${extra}${body}</div><footer>drag onto a lane to place</footer>`;

// The shell with its Library column swapped for the turn's. Everything else is 220's markup.
function screen(label, lib) {
  const shell = nativeScreen({ overlay: true, highlight: false, values: { added: true }, label });
  const start = shell.indexOf('<header class="n-library-head">');
  const end = shell.indexOf('</aside>', start);
  if (start < 0 || end < 0) throw new Error('turn 220 shell: Library column not found');
  return (shell.slice(0, start) + lib + shell.slice(end)).replace('class="air220 native220 ', 'class="air220 native220 cb275 ');
}

const own = OWN.map((r) => row(r)).join('');
const borrowed = ['Saltlight · SC 4 · Shot 4', 'video · 8s · from Saltlight', 'scene4-shot14.png'];

export const FRAMES = [
  ['a', 'The Library’s select lists the world’s other productions', 1360, 900, 'screen',
    () => screen('275a The Cut’s Library with its select open: This production, then the world’s other productions, then other worlds', library('This production', own, menu()))],
  ['b', 'Saltlight chosen: its shots that have an accepted take', 1360, 900, 'screen',
    () => screen('275b Another production chosen: each of its shots with an accepted take, by scene and shot, with its length; a picked row offers Add to Library', library('Saltlight', SHOTS.map((r, i) => row(r, { picked: i === 4, actions: b(`${PLUS}Add to Library`) })).join('')))],
  ['c', 'Added: the shot is a file in this production’s Library', 1360, 900, 'screen',
    () => screen('275c Back on this production: the added shot is a file in the Library, named for where it came from, and places like any other', library('This production', row(borrowed, { picked: true, actions: b(`${PLUS}Place at playhead`) + b('Append to timeline') + b('Remove from library') }) + own))],
  ['d', 'A production with no accepted takes', 1360, 900, 'screen',
    () => screen('275d Another production chosen that has no accepted take', library('Undertow', `<div class="cb275-empty"><span class="mk">${FOLDER}</span><span>No accepted takes</span></div>`))],
];
