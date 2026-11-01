// Synthetic review fixture. No author world, provider request or historical prompt is read.
export const current = 'Maren stands at the harbour rail, holding the folded signal. Her plain oilskin coat catches the grey dawn light. The harbour lies behind her.';
export const older = 'Close on the folded signal in Maren’s hands. Her plain oilskin coat fills the edge of the frame. The harbour stays soft behind her.';
export const draft = 'Close on the folded signal in Maren’s hands. Pull back slowly to reveal Bray beside her at the harbour rail. She turns toward the water. One shot, six seconds. Silent.';
const preamble = 'Image 1: Maren Kest — main photo, identity and appearance.\nImage 2: The Vigil — location plate, the harbour.\nVideo 1: Stage blockout — camera path and timing.';
const negatives = 'Do not render captions or subtitles. No audio. Keep the coat plain.';
export const compiled = [preamble, draft, negatives].join('\n\n');
export const references = [
  { lane: 'Images', slot: 'Image 1', subject: 'Maren Kest', role: 'Main photo · identity', file: 'references/maren-kest/main-photo.png', version: 'Sheet v4', hash: '3bd9…701c' },
  { lane: 'Images', slot: 'Image 2', subject: 'The Vigil', role: 'Location plate · setting', file: 'references/the-vigil/harbour-wide.png', version: 'Sheet v7', hash: '82c1…9a0f' },
  { lane: 'Video', slot: 'Video 1', subject: 'Shot 12 · Stage blockout', role: 'Camera and action · 0–6 s', file: 'productions/saltlight/stage/shot-12.mp4', version: 'Current Stage', hash: 'f20a…4e63' },
];
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const route = letter => `shot-prompts-257.review.html#257${letter}`;
const go = (letter, label, cls = '') => `<a class="ph257-btn ${cls}" href="${route(letter)}">${label}</a>`;
const icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>';
const tag = label => `<span class="ph257-tag">${label}</span>`;
const photo = '<img src="assets/saltlight-shot15.png" alt="A storyboard frame, used as an illustrative shot-page fixture">';
const section = (label, content, action = '') => `<section class="ph257-field"><header><h3>${label}</h3><span class="grow"></span>${action}</header>${content}</section>`;
function shell(content) {
  return `<div class="ph257"><header class="ph257-apphead"><b class="ph257-logo">arke</b><span>The Undersong</span><span class="muted">/</span><span>Saltlight</span><span class="grow"></span><span class="muted">Activity</span><span>◉</span></header><div class="ph257-work"><aside class="ph257-rail"><b>Saltlight</b><span>Dashboard</span><span>Develop</span><span class="selected">Scenes</span><span>Cut</span><span>Cast</span></aside><main class="ph257-page">${content}</main></div><footer class="ph257-appfoot"><span>Connected · v21</span><span class="grow"></span><span>Ask Arke…</span></footer></div>`;
}
function entry() {
  return shell(`<div class="ph257-crumb">Saltlight / Scene 1 · The tide</div><div class="ph257-pagehead"><h1>12 · Maren at the rail</h1><span class="grow"></span>${tag('Frame ready')}${go('d', 'Open in generator ' + icon)}</div><div class="ph257-shot"><div class="ph257-image">${photo}<span>${tag('Shot 12')}${tag('6 s')}</span></div><div class="ph257-fields">${section('Script', '<p>Maren holds the folded signal beside Bray at the harbour rail.</p>')}${section('Frame prompt', `${tag('Authored · image')}<p>${current}</p><div class="ph257-actions">${go('b', 'History')}${go('k', 'Inspect request ' + icon)}<span class="grow"></span><button class="ph257-text" type="button">Rebuild</button></div><p class="ph257-meta">Maren Kest · look &nbsp; The Vigil · place</p>`, '<button class="ph257-text" type="button">View full prompt</button>')}${section('Notes', '<p class="muted">The signal should remain legible.</p>')}${section('Camera', '<p>Medium close-up · eye level · 50 mm</p>')}${section('Timing', '<p>6 seconds</p>')}</div></div>`);
}
function historyList(partial = false) {
  return `<nav class="ph257-versions" aria-label="Retained prompt versions"><a href="${route('b')}"><strong>Scene v21 <span>Current</span></strong><small>Saved image prompt</small></a><a class="selected" href="${route('b')}" aria-current="true"><strong>Scene v19</strong><small>Saved image prompt</small></a>${partial ? '<div class="ph257-version-unreadable"><strong>Scene v16</strong><small>Could not read this version</small></div>' : `<a href="${route('j')}"><strong>Scene v16</strong><small>No saved override</small></a>`}<p class="ph257-meta">Unrelated scene changes are hidden.${partial ? ' Earlier history may be missing.' : ''}</p></nav>`;
}
function changes() {
  return `<div class="ph257-diff"><div><span class="ph257-eyebrow">Current · v21</span><p>${current}</p></div><div><span class="ph257-eyebrow">Selected · v19</span><p><mark>Close on the folded signal in Maren’s hands.</mark> Her plain oilskin coat <mark>fills the edge of the frame.</mark> The harbour <mark>stays soft behind her.</mark></p></div></div>`;
}
function sheet(title, content, { phone = false, footer = '', subtitle = '', close = 'a', narrow = false } = {}) {
  return `<div class="ph257${phone ? ' ph257-phone' : ''}"><div class="ph257-overlay"><div class="ph257-backdrop-copy"><b>12 · Maren at the rail</b><p>Saltlight / The tide</p></div><section class="ph257-sheet${narrow ? ' ph257-sheet-narrow' : ''}" aria-label="${esc(title)}"><header class="ph257-sheethead"><div><h2>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}</div><span class="grow"></span><a class="ph257-close" href="${route(close)}" aria-label="Close ${esc(title)}">✕</a></header><div class="ph257-sheetbody">${content}</div><footer class="ph257-sheetfoot">${footer || `<span class="ph257-meta">Read-only inspection</span><span class="grow"></span>${go(close, 'Done')}`}</footer></section></div></div>`;
}
function history(phone = false) {
  const selected = `<div class="ph257-selected-head"><div><h3>Saved image prompt · v19</h3><p class="ph257-meta">Compared with the current saved prompt at v21</p></div>${tag('Image')}</div>${phone ? '<div class="ph257-notice"><b>Some history is unavailable</b><p>The current prompt and v19 can be read. Other changes may be missing.</p></div>' : ''}${changes()}<details class="ph257-details"><summary>Source versions recorded with v19</summary><p>Maren Kest v3 · The Vigil v7</p><p>Maren is now v4. Restoring these words keeps their older source record visible.</p></details><p class="ph257-note">Only this prompt will be restored. The script, camera and chosen take keep their current values.</p>`;
  return sheet('Prompt history · Shot 12', `<div class="ph257-scope">${tag('Frame · image')}<span class="ph257-meta">Current scene v21</span></div><div class="ph257-history">${historyList(phone)}<article class="ph257-versionbody">${selected}</article></div>`, { phone, subtitle: 'Saved shot prompts · generator drafts are separate', footer: `<span class="ph257-meta">v19 selected${phone ? '' : ' · saved image prompt'}</span><span class="grow"></span>${go('c', 'Review restore', 'primary')}` });
}
function restore() {
  return sheet('Restore this prompt?', `<div class="ph257-scope">${tag('Frame · image')}<span>Scene v19 → new scene v22</span></div><p class="ph257-intro">The saved image prompt from v19 will replace the current image prompt. The scene is still at v21.</p><div class="ph257-promptblock"><span class="ph257-eyebrow">Prompt to save</span><p>${older}</p></div><div class="ph257-notice"><b>The source record is older</b><p>This prompt recorded Maren Kest v3. Her current sheet is v4. Restoring does not update or reground its words.</p></div><p class="ph257-note">This saves one new scene version. The original versions remain in history. The script, framing and selected take are unchanged.</p>`, { narrow: true, close: 'b', footer: `${go('b', 'Cancel')}<span class="grow"></span>${go('b', 'Restore image prompt', 'primary')}` });
}
function referenceRows() {
  return references.map(ref => `<article class="ph257-ref"><span class="ph257-ref-slot">${ref.slot}</span><div><strong>${ref.subject}</strong><p>${ref.role}</p><small>${ref.version}</small><details><summary>Source</summary><p>${ref.file}</p><p>Content hash ${ref.hash} · shortened for this drawing</p></details></div></article>`).join('');
}
function omitted() {
  return `<div class="ph257-omitted"><h3>Not sent</h3><p><strong>Bray Half-Hitch · look</strong><br>Image limit reached · this route carries two images.</p><p><strong>Cast voice sample</strong><br>This route does not carry audio references.</p></div>`;
}
function requestHeader() {
  return `<div class="ph257-scope">${tag('Video')}<span>Video model · reference route</span><span class="grow"></span><span class="ph257-meta">Scene v21</span></div><div class="ph257-notice"><b>Current generator draft</b><p>These words are edited in the generator. They have not replaced the saved shot prompt.</p></div><div class="ph257-controls"><span>6 seconds</span><span>16:9</span><span>Silent</span></div>`;
}
function promptParts() {
  return `<div class="ph257-promptblock"><span class="ph257-eyebrow">Reference bindings · added by Studio</span><p>${preamble.replaceAll('\n', '<br>')}</p></div><div class="ph257-promptblock"><span class="ph257-eyebrow">Current generator brief</span><p>${draft}</p></div><div class="ph257-promptblock"><span class="ph257-eyebrow">Delivery constraints · added by Studio</span><p>${negatives}</p></div>`;
}
function inspect(phone = false) {
  return sheet('Inspect request · Shot 12', `${requestHeader()}<div class="ph257-inspection"><section><div class="ph257-sectionhead"><h3>Compiled prompt</h3><span class="grow"></span><button class="ph257-text" type="button">Copy full prompt</button></div>${promptParts()}<p class="ph257-note">Shown in compiled order. Inspecting does not generate or upload anything.</p></section><aside class="ph257-inspector-refs"><div class="ph257-sectionhead"><h3>References</h3>${go('e', 'Details', 'text')}</div><p class="ph257-meta">Order within each input kind</p>${referenceRows()}${omitted()}</aside></div>`, { phone, subtitle: 'From the generator · video draft', footer: `<span class="ph257-meta">Preview · no work submitted</span><span class="grow"></span>${go('a', 'Done')}` });
}
function referenceInspection() {
  return sheet('Request references · Shot 12', `${requestHeader()}<div class="ph257-reference-wide"><section><h3>Carried by this route</h3><p class="ph257-note">Image and video numbers belong to their own input fields. They are not one combined order.</p>${referenceRows()}</section><aside>${omitted()}<div class="ph257-notice"><b>Prepared from the current draft</b><p>If the model, references or their bytes change, this preview must be prepared again. An approved frozen request keeps its own recorded version.</p></div></aside></div>`, { close: 'd', subtitle: 'Current draft · same request as the prompt preview' });
}
function inspectFrame() {
  return sheet('Inspect request · Shot 12', `<div class="ph257-scope">${tag('Frame · image')}<span>Image model · reference route</span><span class="grow"></span><span class="ph257-meta">Scene v21</span></div><p class="ph257-intro">From the current saved shot. The prompt editor has no unsaved text.</p><div class="ph257-controls"><span>1 image</span><span>16:9</span><span>Saved prompt · v21</span></div><div class="ph257-inspection"><section><div class="ph257-sectionhead"><h3>Compiled prompt</h3><button class="ph257-text" type="button">Copy full prompt</button></div><div class="ph257-promptblock"><span class="ph257-eyebrow">Reference bindings · added by Studio</span><p>Image 1: Maren Kest — main photo, identity and appearance.<br>Image 2: The Vigil — location plate, the harbour.</p></div><div class="ph257-promptblock"><span class="ph257-eyebrow">Current saved shot prompt</span><p>${current}</p></div><div class="ph257-promptblock"><span class="ph257-eyebrow">Delivery constraints · added by Studio</span><p>Do not render captions or subtitles. Keep the coat plain.</p></div></section><aside class="ph257-inspector-refs"><h3>References</h3><p class="ph257-meta">Image input order</p>${referenceRows().split('<article class="ph257-ref">').slice(1, 3).map(row => '<article class="ph257-ref">' + row).join('')}</aside></div>`, { subtitle: 'From the shot · saved image prompt' });
}
function stale() {
  return sheet('Restore needs a fresh review', `<div class="ph257-scope">${tag('Frame · image')}<span>v19 selected</span></div><div class="ph257-notice"><b>The scene changed from v21 to v22</b><p>The restore has not been saved. Read the current prompt again before comparing it with v19.</p>${go('b', 'Reload current prompt')}</div><div class="ph257-promptblock"><span class="ph257-eyebrow">Historical text is still available · v19</span><p>${older}</p></div><p class="ph257-note">A saved video override or a competing draft also blocks a frame restore. The history can still be read; the hidden prompt is never replaced.</p>`, { narrow: true, close: 'b', footer: `${go('b', 'Back to history')}<span class="grow"></span><button type="button" class="ph257-btn" disabled>Restore image prompt</button>` });
}
function unavailable() {
  return sheet('Inspect request · Shot 12', `<div class="ph257-scope">${tag('Video')}<span>Current saved shot</span></div><div class="ph257-empty"><h3>No available video model</h3><p>Choose an available model in the generator to prepare the prompt and reference order.</p>${go('a', 'Back to shot')}</div><p class="ph257-note">No request has been compiled. The saved body is still available in the shot’s prompt history.</p>`, { narrow: true, subtitle: 'Request preview unavailable', footer: `<span class="ph257-meta">Nothing generated or changed</span><span class="grow"></span>${go('a', 'Done')}` });
}
function emptyHistory() {
  return sheet('Prompt history · Shot 12', `<div class="ph257-scope">${tag('Frame · image')}<span class="ph257-meta">Current scene v21</span></div><div class="ph257-promptblock"><span class="ph257-eyebrow">Current saved prompt</span><p>${current}</p></div><div class="ph257-empty"><h3>No earlier prompts available</h3><p>The current prompt is known. Earlier scene versions are not retained here.</p></div><details class="ph257-details"><summary>When a version has no override</summary><p>Use assembled prompt shows what today’s sources produce. It cannot recover historical words that were never recorded.</p></details>`, { phone: true, subtitle: 'Current value only', footer: `<span class="ph257-meta">Earlier history unavailable</span><span class="grow"></span>${go('a', 'Done')}` });
}
export const frames = [
  { id: '257a', title: 'Shot page · two small entry points', width: 1360, height: 820, markup: entry() },
  { id: '257b', title: 'History · compare one retained prompt with today', width: 1100, height: 800, markup: history() },
  { id: '257c', title: 'Restore · one prompt, saved as a new scene version', width: 1100, height: 800, markup: restore() },
  { id: '257d', title: 'Inspect · the compiled prompt from the current generator draft', width: 1360, height: 820, markup: inspect() },
  { id: '257e', title: 'References · actual input order and omission reasons', width: 1100, height: 800, markup: referenceInspection() },
  { id: '257f', title: 'Stale restore · read again before saving', width: 1100, height: 800, markup: stale() },
  { id: '257g', title: 'Phone history · retained text and explicit gaps', width: 390, height: 844, markup: history(true) },
  { id: '257h', title: 'Phone inspector · the same request in one scrolling column', width: 390, height: 844, markup: inspect(true) },
  { id: '257i', title: 'Unavailable route · no invented prompt or reference order', width: 900, height: 650, markup: unavailable() },
  { id: '257j', title: 'Current only · no fabricated prompt history', width: 390, height: 844, markup: emptyHistory() },
  { id: '257k', title: 'Frame inspection · the saved image context stays image', width: 1360, height: 820, markup: inspectFrame() },
];
for (const frame of frames) frame.markup = frame.markup.replace('<div class=', `<div data-screen-label="${esc(frame.id + ' ' + frame.title)}" style="width:${frame.width}px;height:${frame.height}px" class=`);
export { esc };
