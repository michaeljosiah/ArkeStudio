// Capture inspectable HTML from the interactive fixture and register the numbered design turn.
// Requires Playwright (or PLAYWRIGHT_MODULE pointing to an installed package); CHROME may select a browser.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { baseline, audioScreen } from './audio-studio-226.view.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const write = (name, content) => fs.writeFileSync(path.join(here, name), content);
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
write('audio-studio.review.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Audio Studio · Turn 226 · Revision 2</title>${['fonts','colors','typography','spacing','effects'].map(name=>`<link rel="stylesheet" href="${tokens}/${name}.css">`).join('')}<link rel="stylesheet" href="air-particles-220.css"><link rel="stylesheet" href="air-particles-220.native.css"><link rel="stylesheet" href="audio-studio.review.css"><script src="audio-studio.review.js" defer></script></head><body class="audio-review"><header class="review-head"><span>DESIGN TURN 226 · REVISION 2 · APPROVED · IMPLEMENTATION STARTING</span><h1>The existing editor, with the script in the preview</h1><p>Compare the approved Cut shell with Audio Studio. The wordmark, navigation, Library, timeline and Inspector / Arke structure come from turns 220–223; Chat entry follows turn 225.</p><nav aria-label="Design comparison"><button data-review-view="video" aria-pressed="false">Existing video editor</button><button data-review-view="audio" aria-pressed="true">Audio Studio</button><button id="review-replacement">Replacement review</button><button data-review-view="fold" aria-pressed="false">Fold</button><button data-review-view="phone" aria-pressed="false">Phone</button><a href="Arke%20Studio.dc.html#t226">Design master ↗</a><a href="audio-studio.notes.md">Proposal notes ↗</a></nav></header><div id="video-view" class="review-canvas" hidden>${baseline()}</div><div id="studio-view" class="review-canvas">${audioScreen()}</div><footer class="review-footer">Isolated design fixture. Try script/clip selection, Library search, Inspector / Arke, attachment, replacement review, Apply, Undo/Redo, loop and silent transport. Import/export dialogs show placement only; file selection, audio, generation, drag editing and application writes are not connected. The video reference is an unchanged source-backed drawing.</footer></body></html>`);
const css = read('audio-studio.review.css').replace(/#([a-z][\w-]*)/g, '[data-as-id="$1"]');
write('audio-studio-226.frames.css', `@import url("air-particles-220.css");\n@import url("air-particles-220.native.css");\n.as226 { color:var(--foreground); background:var(--background); font:var(--type-body); }\n${css}\n`);

export const rules = [
  ['Review status', '15 October 2026. Revision 2 approved by the author on 15 October 2026; implementation is authorised. It replaces the alternative shell in revision 1 with the existing Cut shell from turns 220–223. These drawings define the implementation target; the fixture does not change production data.'],
  ['Story entry', 'Keep Audiobook in the production rail. Open Audio Studio from that book page or the chapter view switch. Evolve Timing into Audio Studio, retaining old timing links and the selected chapter and passage. Opening is read-only and never generates audio.'],
  ['One chapter arrangement', 'Manuscript and casting retain their existing owners. One versioned arrangement per chapter owns clip placement and mixing. Existing simple timing controls and Audio Studio must address that same authority after migration.'],
  ['Workspace', 'Use the existing Cut columns: Library at left, central preview and timeline, Inspector / Arke at right. Put the script in the video preview area; do not create a second Script sidebar or new passage-detail panel. Selecting script and clips locates the same passage. Recasting never happens by moving recorded audio between tracks.'],
  ['Attachment', 'Default to following a passage boundary or range with an explicit offset. Fix at this time detaches a cue deliberately. Fixed cues never silently ripple. Word anchors require verified alignment for the exact source; repeated or edited words must not trigger guessed remapping.'],
  ['Independent clips', 'Move, trim, split, duplicate and remove source windows non-destructively. Preserve passage and artifact identity. Repeated or omitted speech is visible. A grouped recording is not presented as independently editable isolated voices.'],
  ['Replacement review', 'A candidate take does not replace Current on arrival. Current and Suggested expose changed duration, dependent cues, fixed cues and trim invalidation. Apply binds the exact reviewed take and placements in one durable Undo entry. A changed base requires fresh review.'],
  ['Missing and ambiguous sources', 'Keep labelled unresolved clips and repair actions. Do not silently drop missing media or attach to a different matching phrase. Unresolved material blocks publication until repaired or explicitly omitted; incomplete draft listening is labelled.'],
  ['One audible result', 'Preview, Listen, captions, player/video exports and publication consume the same resolved chapter audio plan and exact source bindings. Master the summed mix once. Preview solo is audition state; an exported mute is explicit.'],
  ['Video editor reuse', 'Share lane geometry, selection, gestures, Library/import, transport controls and review/history patterns through small extracted controls. Preserve the frame-based video domain. Add an audio clock adapter and chapter arrangement reducer rather than a hidden Picture lane or a second writable timeline.'],
  ['Audio engineering', 'The current audiobook renderer is 24 kHz mono. Sample-based scheduling, stereo preservation, panning and a new advanced mix plan require implementation and real-media parity checks. The proposed new-arrangement format is 48 kHz stereo. Do not advertise it as existing capability.'],
  ['Migration and durability', 'Opening derives a read-only legacy arrangement. The first accepted edit migrates atomically and retains recovery data; legacy timing stops being a second write target. Refuse stale revisions and unsupported schemas. Undo changes authored content, not schema version.'],
  ['Compact layout', 'Retain the existing Cut phone structure: chapter header, preview area containing script, compact transport, timeline and Library / Inspect / Arke toolbar. Inspect opens the existing Details sheet with its fixed Done footer. Fold retains the compact editor and Arke rail; Library uses its established drawer. Do not substitute a new stacked page or permanent clip-list layout.'],
  ['Delivery scope', 'Chapter export defaults to the current chapter. Book publishing names included chapters, unresolved cues and acknowledged omissions and captures the exact arrangement revision. Cross-chapter mixing is later work.'],
  ['Implementation boundary', 'Prove migration, stable passage identity and stereo preview/export parity before expanding shared controls. Amend SPEC-047’s no-timeline and mono-mix boundaries, preserve SPEC-043’s video editing contracts and reconcile publication capture with SPEC-048. This design-only turn makes no private specification amendment.'],
  ['Existing identity and menus', 'Preserve the centred Arke Studio wordmark and titlebar utility order, with the Chat entry from turn 225, the folded production navigation and established story destinations. Keep Media / Effects / Transitions in Library; Inspector / Arke are the only permanent right-panel tabs. No new logo, book badge, expanded custom rail or extra editing destination is introduced.'],
  ['Additions within existing controls', 'Keep Import media, Listen from top in the Watch action position, Export audio in the Export action position, selection/split/hand tools, Loop, Undo/Redo, zoom and track mute/solo. Attachment belongs below Start / End / Move to in Placement. Take replacement belongs in Source and the existing Current / Suggested review bar; detailed changes belong in Arke. Fades, Audio and Protection retain scrolling Inspector sections. Audio uses seconds instead of film frames.'],
];
const frames = [];
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : process.platform === 'win32' ? { channel: 'msedge' } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.goto(pathToFileURL(path.join(here, 'audio-studio.review.html')).href);
  await page.evaluate(() => document.fonts.ready);
  const capture = async (letter, title, note, mode = 'audio') => {
    const id = '226' + letter;
    const markup = await page.locator(`${mode === 'video' ? '#video-view' : '#studio-view'} > .native220`).evaluate((node, prefix) => {
      const clone = node.cloneNode(true);
      clone.removeAttribute('data-screen-label');
      // Form property values are not necessarily reflected in outerHTML.
      const originalControls = node.querySelectorAll('input, select');
      const cloneControls = clone.querySelectorAll('input, select');
      // Identify by id because removing hidden views may shorten the clone's control list.
      for (const control of cloneControls) {
        const original = [...originalControls].find(el => el.id === control.id);
        if (!original) continue;
        if (control.tagName === 'INPUT') control.setAttribute('value', original.value);
        else [...control.options].forEach(option => option.toggleAttribute('selected', option.value === original.value));
      }
      clone.querySelectorAll('[id]').forEach(el => { const old = el.id; el.dataset.asId = old; el.id = prefix + '-' + old; });
      clone.querySelectorAll('[for]').forEach(el => el.setAttribute('for', prefix + '-' + el.getAttribute('for')));
      clone.querySelectorAll('[aria-labelledby]').forEach(el => el.setAttribute('aria-labelledby', prefix + '-' + el.getAttribute('aria-labelledby')));
      return clone.outerHTML.replace(/[ \t]+\n/g, '\n');
    }, id);
    const width = mode === 'phone' ? 390 : mode === 'fold' ? 984 : 1360;
    frames.push({ id, title, note, width, markup: `<div class="as226" data-screen-label="${id} ${esc(title)}" style="width:${width}px">${markup}</div>` });
  };
  await page.evaluate(() => window.audioFixture.view('video'));
  await capture('a', 'Existing video editor · layout reference', 'The source-backed Cut drawing from turns 220–223 supplies the existing wordmark, navigation, Library, preview, timeline and Inspector structure.', 'video');
  await page.evaluate(() => { window.audioFixture.view('audio'); window.audioFixture.selection('mara'); });
  await capture('b', 'Chapter studio · script and performance', 'Script selection locates Mara’s performance. Narrator and cast tracks sit beside Effects, Music and Ambience. The Inspector names the chosen source.');
  await page.locator('[data-clip="door"]').click();
  await capture('c', 'Sound cue · follow the passage', 'Cabin door follows the end of Mara’s line. The Inspector shows the resulting time and the attachment rule.');
  await page.locator('#attachment').selectOption('fixed');
  await capture('d', 'Sound cue · explicit fixed time', 'Fix at this time detaches the cue from narration. It stays at twelve seconds when the performance changes.');
  await page.locator('#attachment').selectOption('linked');
  await page.locator('#try-replacement').click();
  await capture('e', 'Longer take · review dependent changes', 'Suggested is two seconds longer. The attached cue and following dialogue move; beds grow to the chapter end. Current remains unchanged until Apply.');
  await page.locator('#studio-view [data-native-act="apply"]').click();
  await capture('f', 'Applied replacement · one Undo', 'The chosen replacement and dependent placements become Current in one transaction. Undo restores the prior arrangement.');
  await page.locator('#undo').click();
  await page.evaluate(() => { window.audioFixture.view('phone'); window.audioFixture.panel(false); document.querySelector('#studio-view .n-inspector').classList.add('is-open'); });
  await capture('g', 'Phone · existing Details sheet', 'The same compact editor opens its scrolling Details sheet with a fixed Done footer. Attachment sits in Placement beneath the numerical times.', 'phone');
  await page.evaluate(() => { document.querySelector('#studio-view .n-inspector').classList.remove('is-open'); window.audioFixture.view('fold'); });
  await capture('h', 'Fold · existing compact workspace', 'Keep the compact Cut layout, Library drawer and Arke rail. The script replaces the preview; selection and arrangement stay on the same timeline.', 'fold');
  await page.evaluate(() => window.audioFixture.view('phone'));
  await capture('i', 'Phone · script above the timeline', 'Use the existing chapter header, preview slot, transport, timeline and Library / Inspect / Arke toolbar.', 'phone');
  await page.evaluate(() => { window.audioFixture.view('audio'); window.audioFixture.panel(true); });
  await capture('j', 'Arke · proposal in the existing panel', 'Review dependent cue changes in the existing Arke panel. Current / Suggested and Apply remain in the shared review bar.');
} finally { await browser.close(); }

const turn = `<section class="dv-turn" id="t226"><div class="dv-thd"><a class="dv-tid" href="#t226">226</a><span class="dv-tname">Audio Studio · the existing editor with a script preview</span></div><p class="dv-next">15 October 2026 · Revision 2 · Approved · implementation starting · ten HTML drawings. <a href="audio-studio.review.html">Interactive comparison</a> · <a href="audio-studio.notes.md">Full proposal</a></p><div class="dv-opts">${frames.map(f => `<div class="dv-opt" id="${f.id}"><div class="dv-olabel"><a class="dv-oid" href="#${f.id}">${f.id}</a>${esc(f.title)}</div><div class="dv-card" style="width:${f.width}px;max-width:none">${f.markup}</div></div>`).join('\n')}</div>${rules.map(([title, body], i) => `<p class="dv-rule"><b>${i + 1} · ${esc(title)}.</b> ${esc(body)}</p>`).join('\n')}</section>\n`;
let master = read('Arke Studio.dc.html');
const start = master.indexOf('<section class="dv-turn" id="t226">');
if (start >= 0) {
  const next = master.indexOf('<section class="dv-turn"', start + 1);
  if (next < 0) throw new Error('Cannot safely replace final turn');
  master = master.slice(0, start) + master.slice(next);
}
const first = [...master.matchAll(/<section class="dv-turn" id="t(\d+)"/g)].find(m => Number(m[1]) > 0);
if (!first) throw new Error('No master turns');
master = master.slice(0, first.index) + turn + master.slice(first.index);
const styleLink = '<link rel="stylesheet" href="audio-studio-226.frames.css">';
if (!master.includes(styleLink)) master = master.replace('<helmet>', '<helmet>\n' + styleLink);
write('Arke Studio.dc.html', master);
let build = read('build-review.mjs').replace(/\r?\n  \/\/ BEGIN AUDIO STUDIO 226[\s\S]*?  \/\/ END AUDIO STUDIO 226(?:\r?\n)*/g, '\n');
const entries = frames.map(f => `  { group: "Audio Studio · turn 226 · revision 2 · approved", screen: ${JSON.stringify(f.title)}, frame: "${f.id}", route: "Story / Audiobook / Audio Studio", status: "drawn", checked: "2026-10-15", controls: [], notes: [${JSON.stringify(f.note + ' Approved design; implementation tracked separately.')} ] },`);
build = build.replace('const SCREENS = [', 'const SCREENS = [\n  // BEGIN AUDIO STUDIO 226\n' + entries.join('\n') + '\n  // END AUDIO STUDIO 226\n');
const pageEntry = '{ file: "audio-studio.review.html", what: "Turn 226 revision 2: existing video editor comparison, script preview, chapter arrangement, replacement review and compact layouts.", state: "approved; implementation starting" }';
if (build.includes('file: "audio-studio.review.html"')) build = build.replace(/\{ file: "audio-studio\.review\.html",[^\n]+?\}/, pageEntry);
else build = build.replace('const PAGES = [', 'const PAGES = [\n  ' + pageEntry + ',');
if (!build.includes(styleLink)) build = build.replace('<link rel="stylesheet" href="${TOKENS}/fonts.css">', styleLink + '\n<link rel="stylesheet" href="${TOKENS}/fonts.css">');
write('build-review.mjs', build);
console.log('Registered turn 226 revision 2: 10 inspectable HTML frames, 17 proposed rules. Run check-master --record and build-review next.');
