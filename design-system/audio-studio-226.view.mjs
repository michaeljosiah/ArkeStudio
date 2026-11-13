// Turn 226 revision 2 composes the approved 220–223 Cut drawing. The shell is not redrawn.
import { nativeScreen } from './air-particles-220.native.mjs';
import { reviewBar } from './air-particles-220.native-panels.mjs';
const b = (label, act, extra = '') => `<button type="button" data-audio-act="${act}" ${extra}>${label}</button>`;
const section = (title, body) => `<section class="n-section"><h3>${title}</h3>${body}</section>`;
const time = (label, id, value) => `<label class="n-time">${label}<input id="${id}" aria-label="${label}" value="${value}" readonly></label>`;
export const baseline = () => nativeScreen({ overlay: true, highlight: false, values: { added: true }, label: 'Existing video editor · reference from turns 220–223' });
const passages = [
  ['narrator', 'Narrator', 'The harbour had gone quiet. Only the rain knew what was coming.'],
  ['mara', 'Mara', '“We should leave. Before he comes back.”'],
  ['elias', 'Elias', '“Then tell me what you found.”'],
  ['closing', 'Narrator', 'She closed the door, and the harbour disappeared.'],
];
const assets = [
  ['narrator', 'Opening narration', 'Dialogue · 7s'], ['mara', 'Mara · chosen take', 'Dialogue · 5s'],
  ['elias', 'Elias · chosen take', 'Dialogue · 4.5s'], ['door', 'Cabin door', 'SFX · 2s'],
  ['music', 'Low tide', 'Music · looped bed'], ['ambience', 'Rain on the quay', 'Ambience · looped bed'],
];
function library() {
  return `<aside class="n-library"><button type="button" class="n-close-library" data-audio-act="close-library" aria-label="Close Library">×</button>
  <header class="n-library-head"><b>Library</b>${b('↥', 'import', 'aria-label="Import media"')}</header>
  <nav class="n-library-tabs" aria-label="Library collections">${b('Media', 'media', 'class="selected"')}${b('Effects', 'effects')}${b('Transitions', 'transitions')}</nav>
  <div class="n-library-content n-media-list"><input id="library-search" aria-label="Search Library" placeholder="Find a take, upload or line…"><div class="n-actions">${b('All', 'all', 'class="selected"')}${b('Not in the cut', 'unused')}${b('All kinds ▾', 'kinds')}</div>
  <div id="audio-assets">${assets.map(([id, name, info]) => `<button type="button" class="n-media-row as-asset" data-select="${id}"><span class="as-audio-thumb" aria-hidden="true">♪</span><span><b>${name}</b><small>${info}</small></span></button>`).join('')}</div>
  <div id="library-collection-note" hidden></div></div><footer>drag onto a lane to place</footer></aside>`;
}
function script() {
  return `<div class="n-preview-wrap"><div class="n-viewer as-script">
  <header class="as-script-head"><strong>Script</strong><select aria-label="Chapter"><option>01 · The harbour</option></select><span class="n-spacer"></span>${b('Follow playhead', 'follow', 'aria-pressed="true"')}</header>
  <div class="as-passages" aria-label="Chapter script">${passages.map(([id, name, words]) => `<button type="button" class="as-passage" data-select="${id}"><span class="as-speaker">${name}</span><span>${words}</span></button>`).join('')}</div>
  <div class="as-script-transport">${b('◀', 'previous', 'aria-label="Previous passage"')}${b('▷', 'play', 'aria-label="Play"')}${b('▶', 'next', 'aria-label="Next passage"')}<span class="as-clock" data-clock>00:12.000</span><span class="as-total">/ 00:24.000</span><span class="n-spacer"></span><label>Text <select aria-label="Script text scale" id="text-scale"><option>100%</option><option>125%</option><option>150%</option></select></label></div>
  </div></div>`;
}
function inspector() {
  return `<div id="inspector-content"><header class="n-effect-title"><span id="clip-role">SFX</span><h2 id="clip-title">Cabin door</h2><p id="clip-source">World artifact · cabin-door.wav</p></header>
  ${section('Source', `<p id="source-context">Attached to the end of Mara’s line.</p>${b('Review longer take…', 'replacement', 'id="try-replacement"')}<p class="as-fixture-hint">Example: Mara’s replacement is 2s longer.</p>`)}
  ${section('Placement', `${time('Start', 'start-value', '00:12.000')}${time('End', 'end-value', '00:14.000')}${time('Move to', 'move-value', '00:12.000')}<label class="n-select">Attachment<select id="attachment"><option value="linked">Follow Mara’s line end</option><option value="fixed">Fixed at 00:12.000</option></select></label><p id="anchor-note">Follows the passage when its timing changes.</p>`)}
  ${section('Audio', `<div class="n-number"><label><span>Volume</span><span id="gain-value">−6 dB</span></label><input id="gain" type="range" aria-label="Volume" min="-30" max="0" value="-6"></div><label class="n-select">Role<select id="audio-role" disabled><option>SFX</option></select></label><label class="n-check"><input type="checkbox" id="duck" disabled>Duck under speech</label>`)}
  ${section('Fades', `${time('Fade in', 'fade-in', '00:00.050')}${time('Fade out', 'fade-out', '00:00.100')}`)}
  ${section('Protection', '<p>Keep authored placement when Arke suggests an arrangement.</p><label class="n-check"><input type="checkbox" checked disabled>Placement protected</label>')}</div>
  <div id="arke-content" hidden><header class="n-effect-title"><span>UNDERSONG · CHAPTER 01</span><h2>Arke</h2><p>The harbour · audio arrangement</p></header><article class="n-proposal"><h3>Longer performance for Mara</h3><p>5s → 7s. Following dialogue and passage-linked cues move +2s. Fixed cues stay at their times.</p><div class="n-bindings"><p>Cabin door: <b id="change-door">12.000 → 14.000s</b></p><p>Chapter and beds: <b>24.000 → 26.000s</b></p></div>${b('Review in timeline', 'replacement', 'class="n-primary"')}</article><p>Fixture proposal · no model call or generation.</p></div>`;
}
function timeline() {
  return `<div class="n-timeline"><header><b>TIMELINE</b><small>6 lanes · 7 clips</small><span class="as-tools">${b('↖', 'select', 'aria-label="Select tool" aria-pressed="true"')}${b('✂', 'split', 'aria-label="Split tool"')}${b('♧', 'hand', 'aria-label="Hand tool"')}</span><span class="n-spacer"></span>${b('Loop', 'loop', 'aria-pressed="false"')}${b('↶', 'undo', 'id="undo" aria-label="Undo" disabled')}${b('↷', 'redo', 'id="redo" aria-label="Redo" disabled')}${b('−', 'zoom-out', 'aria-label="Zoom out"')}<span id="zoom-value">1.0×</span>${b('+', 'zoom-in', 'aria-label="Zoom in"')}</header>
  <div class="n-timeline-canvas"><div class="as-timeline-content"><div class="n-ruler" id="ticks"></div><div id="lanes"></div><div class="n-playhead" id="playhead"></div></div></div><footer><span id="revision-label">Current</span><span class="n-spacer"></span>Seconds · chapter audio</footer></div>`;
}
export function audioScreen() {
  let html = baseline().replace('native220 desktop', 'native220 desktop audio226').replace('data-screen-label="Existing video editor · reference from turns 220–223"', 'data-screen-label="Audio Studio · existing Cut shell"');
  html = html.replace('Harbour lights · film', 'Undersong · story');
  // Use the same titlebar and native icon shapes. Chat was added to this utility group in turn 225.
  const rail = html.match(/<nav class="n-rail"[\s\S]*?<\/nav>/)[0];
  const icons = [...rail.matchAll(/<svg[\s\S]*?<\/svg>/g)].map(m => m[0]);
  // Story destinations and the Speaker mark follow production-shell.tsx / icons.tsx.
  icons[9] = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07 M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
  icons[10] = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
  const routes = [[0, 'Collapse navigation'], [1, 'Dashboard'], [2, 'Cast'], [3, 'Develop'], [4, 'Overview'], [10, 'Chapters'], [9, 'Audiobook'], [7, 'Artifacts']];
  html = html.replace(rail, `<nav class="n-rail" aria-label="Production navigation">${routes.map(([i, name]) => `<button type="button" aria-label="${name}" title="${name}" ${name === 'Audiobook' ? 'class="selected" aria-current="page"' : ''}>${icons[i]}</button>`).join('')}</nav>`);
  html = html.replace('<span class="n-utilities">', `<span class="n-utilities">${b(icons[3], 'arke', 'aria-label="Open Chat"')}`);
  html = html.replace(/<aside class="n-library[\s\S]*?<\/aside>/, library());
  html = html.replace(/<header class="n-cuthead">[\s\S]*?<\/header>/, `<header class="n-cuthead">${b('↥ Import media', 'import')}<div><h1>Audio Studio</h1><small>The harbour · Chapter 01 · <span id="chapter-duration">24s</span></small></div><span class="n-spacer"></span>${b('▷ Listen from top', 'listen')}${b('⇩ Export audio', 'export', 'class="n-primary"')}</header>`);
  html = html.replace(/<header class="n-phone-head">[\s\S]*?<\/header>/, `<header class="n-phone-head">${b('‹', 'back', 'aria-label="Back to chapter"')}<span>Undersong<b>Audio Studio · The harbour</b></span>${b('↥ Export', 'export', 'class="n-primary"')}</header>`);
  const review = reviewBar({ flow: { review: true, version: 1, comparison: 'suggested' }, changeCount: 3 }).replace('Effects arrangement review', 'Audio arrangement review');
  const previewStart = html.indexOf('<div class="n-preview-wrap">');
  const previewEnd = html.indexOf('<div class="n-phone-clock">', previewStart);
  html = html.slice(0, previewStart) + `<div id="change-panel" hidden>${review}</div>` + script() + html.slice(previewEnd);
  html = html.replace(/<div class="n-phone-clock">[\s\S]*?<\/div>/, `<div class="n-phone-clock"><span data-clock>00:12.000</span>${b('◀', 'previous', 'aria-label="Previous passage"')}${b('▷', 'play', 'aria-label="Play"')}${b('▶', 'next', 'aria-label="Next passage"')}<span class="as-total">/ 00:24.000</span></div>`);
  const timelineStart = html.indexOf('<div class="n-timeline">');
  const timelineEnd = html.indexOf('<p class="n-message"', timelineStart);
  html = html.slice(0, timelineStart) + timeline() + html.slice(timelineEnd);
  const inspectorStart = html.indexOf('<div class="n-inspector-scroll">');
  const inspectorEnd = html.indexOf('<footer class="n-sheet-foot">', inspectorStart);
  html = html.slice(0, inspectorStart) + `<div class="n-inspector-scroll">${inspector()}</div>` + html.slice(inspectorEnd);
  html = html.replace('± one frame · 24 fps', 'Chapter audio · seconds');
  html = html.replace('<p class="n-message" role="status">', '<p class="n-message" id="status" role="status">');
  return html;
}
