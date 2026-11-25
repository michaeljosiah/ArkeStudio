// Turn 288 · the screens Director's checks are drawn into, taken from the app itself, as turn 285
// took the Plan's. The real App, its real stylesheets and a synthetic world (285's Gold on Gold
// sample, location-plan-285.plan.mjs) run in an owned headless Chrome; no author world and no
// installed app is opened. Each screen is written out twice: as a PNG to look at, and as the page's
// own markup with the rules that style it, so the turn's frames hold today's production settings,
// Generate and Cut rather than a drawing of them.
//   node design-system/director-checks-288.capture.mjs [--look]
// --look writes the PNGs and an outline of each screen only (to .dev/director-checks-288/).
// Without it, it also writes director-checks-288.app.mjs (the markup) and director-checks-288.app.css
// (the client's rules that match it, scoped to .app288, with each @media settled for the desk).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openChrome, until } from '../scripts/lib/chrome.mjs';
import { clientStyles, urlAssets } from '../scripts/lib/client-page.mjs';
import { CAST, PLACE, SCENE, SHOTS } from './location-plan-285.plan.mjs';

const here = fileURLToPath(new URL('./', import.meta.url));
const root = resolve(here, '..');
const out = join(root, '.dev/director-checks-288');
await mkdir(out, { recursive: true });
const look = process.argv.includes('--look');

// A worktree may have no node_modules of its own: @arke-studio/* would resolve to the main
// checkout's packages, a different commit. Workspace packages that run from source are taken from
// this tree.
const workspace = { name: 'this-tree', setup(b) {
  b.onResolve({ filter: /^@arke-studio\/[a-z-]+$/ }, args => {
    const entry = join(root, 'packages', args.path.slice('@arke-studio/'.length), 'src/index.ts');
    return existsSync(entry) && !args.path.endsWith('/engine') ? { path: entry } : null;
  });
} };

// As in 285: a package the installed node_modules lacks is built as an empty module, and named.
const absent = new Set();
const missing = { name: 'missing-packages', setup(b) {
  const need = createRequire(join(root, 'packages/client/src/main.tsx'));
  b.onResolve({ filter: /^(pdfjs-dist|@fontsource\/)/ }, args => {
    try { need.resolve(args.path.replace(/\?url$/, '')); return null; } catch { absent.add(args.path.split('/').slice(0, args.path.startsWith('@') ? 2 : 1).join('/')); }
    return { path: args.path, namespace: args.path.endsWith('.css') ? 'missing-css' : 'missing-js' };
  });
  b.onLoad({ filter: /.*/, namespace: 'missing-css' }, () => ({ contents: '', loader: 'css' }));
  b.onLoad({ filter: /.*/, namespace: 'missing-js' }, () => ({ contents: 'export const getDocument = () => { throw new Error("pdfjs-dist is not installed"); }; export const GlobalWorkerOptions = {}; export class TextLayer {} export default "";', loader: 'js' }));
} };

// The turn's sample is 285's, with one change the turn needs: shot 13 is Tunde's single in the
// booth (position 2) and runs 8 s, so a take of it can be trimmed at 7.4 s; shot 12, the reverse,
// is Ade's (position 3). Everything else is 285's paper plan as it stands.
const SAMPLE_SHOTS = SHOTS.map(shot => shot.n === 12 ? { ...shot, position: 3, sec: 3, title: 'On Ade' } : shot.n === 13 ? { ...shot, position: 2, sec: 8, title: 'On Tunde' } : shot);

// Pictures the fixture names, as files already in design-system/assets. A take's poster is the
// picture of the position its shot is taken from; nothing new is made.
const POSTER = { 0: 'assets/juju-ade-house.jpg', 1: 'assets/location-plan-285-pic-1.jpg', 2: 'assets/juju-tunde.jpg', 3: 'assets/juju-ade.jpg', 4: 'assets/juju-ife.jpg', 5: 'assets/location-plan-285-pic-5.jpg', 6: 'assets/juju-w-table.jpg', 7: 'assets/juju-ife.jpg', 8: 'assets/juju-ade.jpg', 9: 'assets/location-plan-285-pic-6.jpg', 10: 'assets/juju-tunde.jpg' };
const pictureFor = path => {
  if (/\/world-art\./.test(path)) return 'assets/juju-w-table.jpg';
  if (/references\/ade\//.test(path)) return 'assets/juju-ade.jpg';
  if (/references\/ife\//.test(path)) return 'assets/juju-ife.jpg';
  if (/references\/tunde\//.test(path)) return 'assets/juju-tunde.jpg';
  if (/artifacts\/s2-setup/.test(path)) return 'assets/juju-tunde.jpg';
  const take = /takes\/tk_01JA0+(\d\d)\d\//.exec(path);
  if (take) { const shot = SAMPLE_SHOTS.find(s => s.n === Number(take[1])); return shot ? POSTER[shot.position] : null; }
  return null;
};
const served = new Map();

const fixture = { CAST, PLACE, SCENE, SHOTS: SAMPLE_SHOTS };
await build({
  stdin: { resolveDir: join(root, 'packages/client/src'), loader: 'tsx', contents: `
import React from 'react'; import { createRoot } from 'react-dom/client'; import { flushSync } from 'react-dom'; import { MemoryRouter } from 'react-router';
import { App } from './App'; import { __setStateForTest, __setBridgeForTest, __connectionStatusForTest } from './lib/store';
import { seedStoryPictureTimeline } from '@arke-studio/contracts';
import { FIXTURE_STATE } from '../test/fixture-state';
${await clientStyles()}
const plan = ${JSON.stringify(fixture)};
const AT = '2026-11-24T09:00:00Z';
const id26 = (prefix, n, k) => prefix + '_01JA' + '0'.repeat(19) + String(n).padStart(2, '0') + k;
// variant: 'before' (shots 1 to 12 accepted, nothing made of 13), 'after' (13's first take back),
// 'cut' (every shot accepted).
function sample(variant) {
  const state = structuredClone(FIXTURE_STATE);
  const world = state.world;
  Object.assign(world.meta, { name: plan.SCENE.world, slug: 'na-love-or-juju', logline: 'The sample world of design turn 288.' });
  Object.assign(state.worlds[0], { name: plan.SCENE.world, slug: 'na-love-or-juju', counts: { characters: 3, locations: 1, factions: 0, canonEntries: 0, productions: 1 } });
  world.proposals = []; world.canon = []; world.changes = [];
  const person = world.sheets.find(sheet => sheet.type === 'character'), place = world.sheets.find(sheet => sheet.type === 'location');
  world.sheets = [
    ...plan.CAST.map(member => ({ ...structuredClone(person), id: member.id, name: member.name, role: 'In the scene', billing: 'lead', voice: undefined, canonRules: [], links: ['the-club'], version: 3,
      sections: [{ heading: 'Essence', body: 'In the scene.' }] })),
    { ...structuredClone(place), id: 'the-club', name: plan.PLACE.name, region: 'One room', version: plan.PLACE.version, canonRules: [], links: plan.CAST.map(member => member.id),
      sections: [{ heading: 'Look', body: 'One room at night.' }] },
  ];
  const photo = { file: 'head-front.png', source: 'legacy', sheetVersion: 3, artDirectionVersion: 3, acceptedAt: AT };
  world.referenceKits = plan.CAST.map(member => ({ sheetId: member.id, anchor: 'head-front.png', mainPhoto: photo, tiles: [{ angle: 'head-front', status: 'locked', file: 'head-front.png', sheetVersion: 3 }], compilations: [], looks: [] }));
  // Shot 13's start: the S2 set-up's frame, a picture the dispatch can send.
  world.artifacts = [{ id: 'ar_01JA00000000000000000S2SET', kind: 'image', file: 's2-setup.jpg', hash: 'sha256:5e2b7c1d9a0f4e38', origin: { by: 'user' }, links: ['tunde'], created: AT }];
  const production = world.productions[0];
  Object.assign(production.meta, { id: 'the-film', title: plan.SCENE.production, logline: 'The sample production of design turn 288.', aspect: plan.SCENE.aspect });
  production.sceneFiles = { sc_02: '02-gold-on-gold' };
  production.treatment = '';
  const shots = plan.SHOTS.map(shot => ({ id: 'sh_' + String(shot.n).padStart(2, '0'), number: shot.n, title: shot.title, durationSec: shot.sec,
    description: shot.n === 13 ? '@tunde, over @ade.' : shot.title + '.' }));
  production.scenes = [{ id: 'sc_02', number: 2, slug: 'gold-on-gold', title: plan.SCENE.title, status: 'accepted', version: 6,
    inherits: { location: 'the-club', timeOfDay: 'night' }, cast: { ade: { added: AT }, ife: { added: AT }, tunde: { added: AT } }, shots }];
  const made = variant === 'cut' ? plan.SHOTS : plan.SHOTS.filter(shot => shot.n <= 12);
  const take = (shot, k, done) => ({ id: id26('tk', shot.n, k), jobId: id26('jb', shot.n, k), coversShots: ['sh_' + String(shot.n).padStart(2, '0')], kind: 'clip', provider: 'fal', model: 'seedance-2.0',
    provenance: { canonRevision: 42, sheets: { ade: 3, tunde: 3 } }, prompt: shot.title, references: [], params: { aspect: '16:9', durationSec: shot.sec },
    cost: { estimatedMicroUsd: Math.round(shot.sec * 303400), actualMicroUsd: Math.round(shot.sec * 303400), actualSource: 'provider-reported' },
    dispatchedAt: '2026-11-24T09:' + String(10 + (shot.n % 40)).padStart(2, '0') + ':00Z', completedAt: done, media: 'clip.mp4' });
  production.takes = made.map(shot => take(shot, 1, '2026-11-24T10:' + String(shot.n % 60).padStart(2, '0') + ':00Z'));
  production.reviews = made.map(shot => ({ ts: AT, takeId: id26('tk', shot.n, 1), shotId: 'sh_' + String(shot.n).padStart(2, '0'), decision: 'accept', by: 'user' }));
  production.selections = Object.fromEntries(made.map(shot => ['sh_' + String(shot.n).padStart(2, '0'), { acceptedTakeId: id26('tk', shot.n, 1), trimInSec: 0 }]));
  if (variant !== 'cut') production.selections.sh_13 = { startFrameArtifactId: 'ar_01JA00000000000000000S2SET', trimInSec: 0 };
  if (variant === 'after') production.takes.push(take(plan.SHOTS.find(shot => shot.n === 13), 1, '2026-11-25T10:14:00Z'));
  production.takeMediaInfo = {};
  // The scene is on the Cut in story order, as the first placement saves it: a shot with no
  // accepted take plays as its gap.
  production.timeline = { status: 'ready', timeline: seedStoryPictureTimeline(production) };
  // The fixture's model, with the first-frame route the real Seedance 2.0 entry carries
  // (providers' fal catalogue), so a shot's start frame travels as the bench says it does.
  const model = state.app.manifest.models[0];
  Object.assign(model, { accepts: { referenceImages: 9, referenceRoles: false, startFrame: false, endFrame: false },
    limits: { ...model.limits, aspects: ['16:9', '9:16', '1:1'] }, pricing: { kind: 'perSecond', microUsdPerSecond: 303400, byResolution: { '1080p': 682000 } },
    modes: { generate: { locked: [] }, 'first-frame': { route: 'bytedance/seedance-2.0/image-to-video', locked: ['aspect'] } } });
  state.app.jobs = []; state.app.ledger = [];
  return state;
}
let renderer;
window.worldId = FIXTURE_STATE.world.meta.worldId;
window.settle = async () => { await new Promise(r => setTimeout(r, 600)); await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode().catch(() => {})));
  for (const a of document.getAnimations()) { if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.finish(); else { a.pause(); a.currentTime = 0; } } };
window.mountAt = async (path, dark = false, variant = 'before') => {
  renderer?.unmount(); document.documentElement.classList.toggle('dark', dark);
  const bridge = { platform: 'test', appVersion: 'design-capture', connect() {}, subscribe() { return () => {}; }, send() {}, coordinatorHttpBase: () => location.origin };
  window.arke = bridge; __setBridgeForTest(bridge); __setStateForTest(sample(variant)); __connectionStatusForTest('open');
  renderer = createRoot(document.getElementById('root'));
  flushSync(() => renderer.render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>)); await window.settle();
};
` },
  bundle: true, platform: 'browser', format: 'esm', define: { 'import.meta.env': '{}' }, external: ['/*.webp', '/*.png'], loader: { '.woff': 'file', '.woff2': 'file' },
  outfile: join(out, 'view.js'), plugins: [missing, urlAssets, workspace], logLevel: 'error',
});
if (absent.size) console.log(`Not installed, built as empty modules: ${[...absent].join(', ')}`);
await writeFile(join(out, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="view.css"></head><body><div id="root"></div><script type="module" src="view.js"></script></body></html>');

// A take's video is an 8 s dark clip made here for the capture only, so the bench's player is taken
// in its ordinary state (its play disc and transport) rather than "Could not play video". It is
// never written into design-system: in the frames the player keeps its poster and loses its source.
const CLIP = join(out, 'clip.mp4');
if (!existsSync(CLIP)) {
  const installed = join(process.env.LOCALAPPDATA ?? '', 'Programs/Arke Studio/resources/ffmpeg/ffmpeg.exe');
  execFileSync(process.env.ARKE_FFMPEG ?? (existsSync(installed) ? installed : 'ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x16161a:s=1280x720:r=24:d=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', CLIP]);
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let file;
    if (path.startsWith('/media/') && path.endsWith('.mp4')) {
      const bytes = await readFile(CLIP);
      const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '');
      response.setHeader('Content-Type', 'video/mp4'); response.setHeader('Accept-Ranges', 'bytes');
      if (!range) { response.end(bytes); return; }
      const from = Number(range[1]), to = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      response.writeHead(206, { 'Content-Range': `bytes ${from}-${to}/${bytes.length}`, 'Content-Length': to - from + 1 });
      response.end(bytes.subarray(from, to + 1)); return;
    } else if (path.startsWith('/media/')) {
      const hit = pictureFor(path);
      if (!hit) throw new Error('no picture');
      served.set(path, hit); file = join(here, hit);
    } else {
      file = resolve(out, path.slice(1) || 'index.html');
      const inside = relative(out, file);
      if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('outside');
    }
    response.setHeader('Content-Type', TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
const origin = `http://127.0.0.1:${server.address().port}`;

// The page's own markup and the rules that style it, as 285 takes them, with one addition: a sheet
// the page raises is a <dialog> in the top layer, outside #root, so open dialogs are taken too, each
// behind a box painted as its ::backdrop was.
const SNAP = String.raw`
window.cssTree = async () => {
  if (window.cssTreeMade) return window.cssTreeMade;
  let id = 0; const odd = [];
  const parse = (text, i, depth) => {
    const rules = [];
    for (;;) {
      for (;;) { while (i < text.length && /\s/.test(text[i])) i++; if (text.startsWith('/*', i)) { i = text.indexOf('*/', i) + 2; continue; } break; }
      if (i >= text.length) return [rules, i];
      if (text[i] === '}') return [rules, i + 1];
      let j = i, round = 0;
      for (; j < text.length; j++) { const c = text[j]; if (c === '"' || c === "'") { j = text.indexOf(c, j + 1); continue; } if (c === '(' || c === '[') round++; else if (c === ')' || c === ']') round--; else if ((c === '{' || c === ';') && round === 0) break; }
      const prelude = text.slice(i, j).trim();
      if (text[j] === ';') { i = j + 1; continue; }
      const at = /^@([a-z-]+)/.exec(prelude)?.[1];
      if (at === 'media' || at === 'supports' || at === 'container' || at === 'layer' || at === 'scope') {
        const [children, end] = parse(text, j + 1, depth + 1);
        rules.push({ at, condition: prelude.slice(at.length + 1).trim(), children }); i = end; continue;
      }
      let k = j + 1, curly = 1, nested = false;
      for (; k < text.length && curly > 0; k++) { const c = text[k]; if (c === '"' || c === "'") { k = text.indexOf(c, k + 1); continue; } if (text.startsWith('/*', k)) { k = text.indexOf('*/', k) + 1; continue; } if (c === '{') { curly++; nested = true; } else if (c === '}') curly--; }
      if (!at) { if (nested) odd.push('nested: ' + prelude.slice(0, 80)); rules.push({ id: id++, selector: prelude, body: text.slice(j + 1, k - 1).trim() }); }
      i = k;
    }
  };
  const tree = [];
  for (const sheet of document.styleSheets) { if (!sheet.href) continue; tree.push(...parse(await (await fetch(sheet.href)).text(), 0, 0)[0]); }
  return (window.cssTreeMade = { tree, odd });
};
const DYNAMIC = /:(hover|active|focus|focus-visible|focus-within|target|visited)\b/;
const splitList = text => { const parts = []; let depth = 0, from = 0; for (let i = 0; i < text.length; i++) { const c = text[i]; if (c === '(' || c === '[') depth++; else if (c === ')' || c === ']') depth--; else if (c === ',' && depth === 0) { parts.push(text.slice(from, i).trim()); from = i + 1; } } parts.push(text.slice(from).trim()); return parts; };
const holds = rule => rule.at === 'media' ? matchMedia(rule.condition).matches : rule.at === 'supports' ? CSS.supports(rule.condition) : true;
window.layers = () => [...document.querySelectorAll('body > dialog')].filter(d => d.open);
window.snapRules = async () => {
  const root = document.getElementById('root'); const kept = [];
  const hits = selector => { const test = selector.replace(/::?(before|after|placeholder|selection|marker|backdrop|file-selector-button|first-line|first-letter|-webkit-[a-z-]+|-moz-[a-z-]+)(\([^)]*\))?/g, '').trim() || '*';
    try { return document.documentElement.matches(test) || document.body.matches(test) || root.matches(test) || root.querySelector(test) !== null || window.layers().some(l => l.matches(test) || l.querySelector(test) !== null); } catch { return true; } };
  const walk = rules => { for (const rule of rules) { if (rule.children) { if (holds(rule)) walk(rule.children); } else if (splitList(rule.selector).some(s => !DYNAMIC.test(s) && hits(s))) kept.push(rule.id); } };
  walk((await window.cssTree()).tree);
  return kept;
};
window.snapCss = async (keptList, scope, vw, vh) => {
  const kept = new Set(keptList); const out = []; const { tree, odd } = await window.cssTree(); const strange = [...odd];
  const S = '.' + scope;
  const scoped = selector => {
    let s = selector.replace(/:disabled\b/g, '[data-s-off]').replace(/:enabled\b/g, ':not([data-s-off])').replace(/:checked\b/g, '[data-s-on]').replace(/\[open\]/g, '[data-s-open]');
    let dark = false, weight = '';
    for (;;) {
      const m = /^(html|body|:root|#root)?((?:\.dark|\.light)?)((?:\[[^\]]*\])*)(\s*>\s*|\s+|$)/.exec(s);
      if (!m || (m[1] === undefined && m[2] === '')) break;
      if (m[2] === '.dark') dark = true;
      if (m[1] === '#root') weight += ':is(#_,*)'; else if (m[1] === ':root') weight += ':is(._,*)'; else if (m[1]) weight += ':is(q,*)';
      weight += ':is(._,*)'.repeat((m[3].match(/\[/g) ?? []).length);
      s = s.slice(m[0].length);
      if (s === '') break;
    }
    const root = (dark ? '.dark ' : '') + S + weight;
    if (s === '') return root;
    if (/^(::|:(before|after)\b)/.test(s)) return root + s;
    return root + ' ' + s;
  };
  const units = text => text.replace(/(-?\d*\.?\d+)(dvh|svh|lvh|vh)\b/g, (_, n) => (Number(n) * vh / 100) + 'px').replace(/(-?\d*\.?\d+)(dvw|svw|lvw|vw)\b/g, (_, n) => (Number(n) * vw / 100) + 'px');
  const walk = (rules, sink) => { for (const rule of rules) {
    if (rule.children) {
      if (!holds(rule)) continue;
      if (rule.at === 'container') { const inner = []; walk(rule.children, inner); if (inner.length) sink.push('@container ' + rule.condition + '{' + inner.join('') + '}'); }
      else walk(rule.children, sink);
    } else if (kept.has(rule.id) && rule.body) {
      sink.push([...new Set(splitList(rule.selector).filter(s => !DYNAMIC.test(s)).map(scoped))].join(',') + '{' + units(rule.body) + '}');
    }
  } };
  walk(tree, out);
  return { css: out.join('\n'), odd: [...new Set(strange)].slice(0, 40) };
};
window.snapDom = () => {
  const root = document.getElementById('root');
  const layers = window.layers();
  const all = selector => [root, ...layers].flatMap(source => [...(source !== root && source.matches(selector) ? [source] : []), ...source.querySelectorAll(selector)]);
  const marks = [];
  all('*').forEach(el => {
    if (el.matches(':disabled')) marks.push([el, 'data-s-off']);
    if (el.matches(':checked')) marks.push([el, 'data-s-on']);
    if (el.hasAttribute('open')) marks.push([el, 'data-s-open']);
  });
  for (const [el, name] of marks) el.setAttribute(name, '');
  all('input').forEach(el => { if (el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'file') el.setAttribute('value', el.value); });
  all('textarea').forEach(el => { el.textContent = el.value; });
  const selectEls = all('select');
  const selects = selectEls.map(el => el.selectedIndex);
  const selectWidths = selectEls.map(el => el.getBoundingClientRect().width);
  const canvases = all('canvas').map(el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), cls: el.className }; });
  const clone = root.cloneNode(true);
  for (const layer of layers) {
    const backdrop = document.createElement('div'); const s = getComputedStyle(layer, '::backdrop');
    backdrop.className = 'app288-backdrop'; backdrop.setAttribute('style', 'position:fixed;inset:0;background-color:' + s.backgroundColor + ';background-image:' + s.backgroundImage);
    clone.append(backdrop, layer.cloneNode(true));
  }
  for (const [el, name] of marks) el.removeAttribute(name);
  clone.querySelectorAll('select').forEach((el, i) => { const chosen = el.options[selects[i]]; if (chosen) { [...el.options].forEach(o => { if (o !== chosen) o.remove(); }); } el.style.width = selectWidths[i].toFixed(1) + 'px'; el.style.flex = 'none'; });
  clone.querySelectorAll('canvas').forEach((el, i) => { const box = document.createElement('div'); box.className = 'app288-canvas ' + el.className; box.setAttribute('data-canvas', String(i)); box.setAttribute('style', (el.getAttribute('style') ?? '') + ';width:' + canvases[i].w + 'px;height:' + canvases[i].h + 'px'); el.replaceWith(box); });
  clone.querySelectorAll('script,style,link,[hidden],dialog:not([open])').forEach(el => el.remove());
  clone.querySelectorAll('*').forEach(el => { for (const name of ['id', 'for', 'href', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'data-testid', 'data-discover', 'disabled', 'checked', 'open', 'tabindex', 'draggable', 'loading']) el.removeAttribute(name); });
  return { html: clone.innerHTML, canvases };
};
window.outline = () => { const lines = []; const walk = (el, depth) => { if (depth > 11) return; const r = el.getBoundingClientRect(); const cls = typeof el.className === 'string' ? el.className.split(' ').slice(0, 3).join('.') : '';
  const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue.trim()).join(' ').slice(0, 50);
  if (r.width > 0 && (cls || own)) lines.push(' '.repeat(depth) + el.tagName.toLowerCase() + (cls ? '.' + cls : '') + ' [' + Math.round(r.x) + ',' + Math.round(r.y) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ']' + (own ? ' "' + own + '"' : ''));
  for (const child of el.children) walk(child, depth + 1); }; walk(document.getElementById('root'), 0); for (const l of window.layers()) walk(l, 0); return lines.join('\n'); };
`;

// Parts of the client the turn draws with that a screen does not show today: they are put into
// the page for a moment while its rules are read, so their rules come with the screen's, and are
// gone before its markup is taken. Each is the client's own markup for the control.
const CHECK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>';
const KIT_SHEET = `<div class="fy-models__row"><span class="fy-models__what">Look</span><span class="ui-select"><select class="ui-select__control" aria-label="kit"><option>kit</option></select></span></div><input class="ui-input"><textarea class="ui-input ui-textarea"></textarea><label class="ui-check"><span class="ui-check__box"><input type="checkbox" checked>${CHECK}</span><span class="ui-check__label">kit</span></label><label class="ui-check"><span class="ui-check__box"><input type="checkbox">${CHECK}</span><span class="ui-check__label">kit</span></label><button type="button" class="ui-btn ui-btn--secondary ui-btn--sm">a</button><span class="fy-seg"><span class="fy-seg__item fy-seg__item--active">a</span><button type="button" class="fy-seg__item">b</button></span><span class="fy-takechips"><button type="button" class="fy-takechip fy-takechip--on">a</button><button type="button" class="fy-takechip">b</button></span><button type="button" class="ui-btn ui-btn--outline ui-btn--sm">a</button><button type="button" class="ui-btn ui-btn--ghost ui-btn--sm">a</button><span class="fy-dot fy-dot--ok"></span><span class="fy-dot fy-dot--warn"></span><span class="fy-dot fy-dot--sketch"></span><span class="fy-mono">a</span><button type="button" class="fy-linkbtn">a</button><span class="fy-listhead">a</span>`;
const KIT_WORK = `<button type="button" class="ui-btn ui-btn--primary ui-btn--default">a</button><button type="button" class="ui-btn ui-btn--primary ui-btn--default" disabled>a</button><button type="button" class="ui-btn ui-btn--primary ui-btn--sm" disabled>a</button><button type="button" class="ui-btn ui-btn--secondary ui-btn--default">a</button><button type="button" class="ui-btn ui-btn--outline ui-btn--default">a</button><button type="button" class="ui-btn ui-btn--ghost ui-btn--sm">a</button><button type="button" class="ui-btn ui-btn--secondary ui-btn--sm">a</button><button type="button" class="ui-btn ui-btn--outline ui-btn--sm">a</button><button type="button" class="ui-btn ui-btn--primary ui-btn--sm">a</button><span class="fy-dot fy-dot--ok"></span><span class="fy-dot fy-dot--warn"></span><span class="fy-dot fy-dot--sketch"></span><span class="fy-mono">a</span><button type="button" class="fy-linkbtn">a</button><span class="fy-modelchip">a<span class="fy-mono">b</span></span><span class="fy-param">a</span><span class="fy-takechips"><button type="button" class="fy-takechip fy-takechip--on"><span class="fy-dot fy-dot--warn"></span>a</button><button type="button" class="fy-takechip"><span class="fy-dot fy-dot--ok"></span>b</button></span>`;

const press = selector => `document.querySelector(${JSON.stringify(selector)})?.click()`;
// (A step may also be { press: script returning {x, y} }: a real pointer press there, through CDP.)
const SCREENS = [
  // The production's front page with its settings sheet up: Delivery, Clips and the models.
  { name: 'settings', route: '/p/the-film', variant: 'before', steps: [press('[aria-label="Delivery and models"]')], kit: ['.fy-production-settings-sheet .fy-page-sheet__body', KIT_SHEET] },
  // Generate on the bench lens, shot 13 asked for: the shot's references, frames and its press.
  { name: 'before', route: '/p/the-film/generate?view=bench&shot=sh_13', variant: 'before', kit: ['.fy-gen', KIT_WORK] },
  // The same with the shot's first take back, chosen.
  { name: 'after', route: '/p/the-film/generate?view=bench&shot=sh_13', variant: 'after', kit: ['.fy-gen', KIT_WORK] },
  // The Cut, every shot accepted, as the story orders it.
  // The Cut, every shot accepted, as the story orders it, with the playhead put on shot 21 (the
  // two-shot at her table) by a press on the ruler a quarter of the way into that clip.
  { name: 'cut', route: '/p/the-film/cut', variant: 'cut', kit: ['.fy-cutmain', KIT_WORK],
    steps: [{ press: `(() => { const clip = document.querySelector('.fy-cutseg[data-clip="cl_sh-21"]').getBoundingClientRect(), ruler = document.querySelector('.fy-timeline__ruler').getBoundingClientRect(); return { x: clip.left + clip.width / 4, y: ruler.top + ruler.height / 2 }; })()` }] },
  ...(look ? [
    { name: 'takes-before', route: '/p/the-film/generate?shot=sh_13', variant: 'before' },
    { name: 'takes-after', route: '/p/the-film/generate?shot=sh_13', variant: 'after' },
    { name: 'dashboard', route: '/p/the-film', variant: 'before' },
    { name: 'shot', route: '/p/the-film/scenes/sc_02/shots/sh_13', variant: 'before' },
  ] : []),
];
const SIZE = [1360, 850, 'app288'];
const kitIn = kit => `(() => { const into = document.querySelector(${JSON.stringify(kit?.[0] ?? '')}); if (!into) return false; const box = document.createElement('div'); box.id = 'dc288-kit'; box.style.cssText = 'position:absolute;left:-9999px;top:0'; box.innerHTML = ${JSON.stringify(kit?.[1] ?? '')}; into.append(box); return true; })()`;
const kitOut = `document.getElementById('dc288-kit')?.remove()`;

const browser = await openChrome({ args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const snapshots = {}; const report = [];
let css = '';
try {
  const { cdp, evaluate: js } = browser;
  await cdp('Page.enable');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const [width, height, scope] = SIZE;
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: origin + '/?desk' });
  await until(() => js('typeof mountAt === "function"'));
  await js(SNAP + ';true');
  const base = '/w/' + await js('window.worldId');
  const keptAll = new Set();
  for (const { name, route, variant, steps = [], kit } of SCREENS) {
    let dom;
    for (const dark of [true, false]) {
      await js(`mountAt(${JSON.stringify(base + route)}, ${dark}, ${JSON.stringify(variant)})`);
      for (const step of steps) {
        // A step is script run in the page, or a real press of the pointer at a point the page names.
        if (typeof step === 'string') await js(step + ';true');
        else { const { x, y } = await js(step.press); for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); }
        await js('window.settle()');
      }
      await js('window.settle()');
      const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(out, `app-${name}-${dark ? 'dark' : 'light'}.png`), Buffer.from(data, 'base64'));
      if (!dark) await writeFile(join(out, `app-${name}.outline.txt`), await js('outline()'));
      if (!dark) await writeFile(join(out, `app-${name}.type.txt`), await js(`[...document.querySelectorAll('h1, h2, .fy-seg__item, .ui-btn, .fy-mono, .fy-models__row > *')].slice(0, 60).map(el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return [el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0], el.textContent.trim().slice(0, 24), Math.round(r.x * 10) / 10 + ',' + Math.round(r.y * 10) / 10 + ' ' + Math.round(r.width * 10) / 10 + 'x' + Math.round(r.height * 10) / 10, s.fontFamily.split(',')[0], s.fontWeight, s.fontSize].join(' | '); }).join('\\n')`));
      if (kit) { const placed = await js(kitIn(kit)); if (!placed) report.push({ name, kit: 'no ' + kit[0] }); }
      for (const id of await js('snapRules()')) keptAll.add(id);
      await js(kitOut);
      if (!dark) dom = await js('snapDom()');
    }
    snapshots[name] = { width, height, scope, route: base + route, variant, html: dom.html, canvases: dom.canvases };
    report.push({ name, route, variant, bytes: dom.html.length, canvases: dom.canvases.length });
  }
  const made = await js(`snapCss(${JSON.stringify([...keptAll])}, ${JSON.stringify(scope)}, ${width}, ${height})`);
  css = made.css;
  report.push({ scope, rules: keptAll.size, bytes: made.css.length, odd: made.odd });
} finally { await browser.close(); await new Promise(closed => server.close(closed)); }

console.log(JSON.stringify(report, null, 1));
if (look) process.exit(0);

// Pictures come from the coordinator in the app; in the master they are files beside it.
const media = html => html.replace(/ src="http:\/\/127\.0\.0\.1:\d+\/media\/[^"?]+\.mp4[^"]*"/g, '').replace(/(src|href|poster)="http:\/\/127\.0\.0\.1:\d+(\/media\/[^"?]+)[^"]*"/g, (whole, attr, path) => {
  const file = served.get(decodeURIComponent(path)) ?? served.get(path) ?? pictureFor(decodeURIComponent(path));
  return file ? `${attr}="${file}"` : whole;
}).replace(/url\(&quot;http:\/\/127\.0\.0\.1:\d+(\/media\/[^&?]+)[^)]*?&quot;\)/g, (whole, path) => {
  const file = served.get(decodeURIComponent(path)) ?? served.get(path) ?? pictureFor(decodeURIComponent(path));
  return file ? `url(&quot;${file}&quot;)` : whole;
});
// A provider's mark is served from the client's public folder; the master keeps the same marks.
const marks = html => html.replace(/src="\.\/marks\/([a-z0-9-]+\.(?:ico|png|svg))"/g, (whole, file) => {
  if (!existsSync(join(here, 'assets/logos', file))) throw new Error(`no assets/logos/${file} for the captured mark`);
  return `src="assets/logos/${file}"`;
});
// The Cut draws a filmstrip over each clip from its video's frames. The video here is the capture's
// dark stand-in, so its strip would draw every clip black; it is left out, and each clip shows the
// poster under it, as the Cut does before a strip is drawn.
const strips = html => html.replace(/<span class="fy-filmstrip"[^>]*>(?:<span class="fy-filmstrip__frame"[^>]*><img alt="" src="data:[^"]*"><\/span>)*<\/span>/g, '');
// From turn 139 a frame sets type through the tokens only. A few of the app's controls carry their
// size inline (Delivery's select: 500 12px); the same size is written as the token that holds it.
const TOKEN_PX = { 11: '--text-2xs', 12: '--text-xs', 13: '--text-sm', 14: '--text-base', 15: '--text-md', 18: '--text-lg', 20: '--text-xl', 24: '--text-2xl', 30: '--text-3xl', 36: '--text-4xl', 48: '--text-5xl' };
const tokens = html => html.replace(/\b(font(?:-size)?\s*:\s*(?:[0-9]{3}\s+)?)([0-9]+(?:\.[0-9]+)?)px/g, (whole, lead, px) => {
  if (!TOKEN_PX[px]) throw new Error(`an inline ${px}px font size has no token: ${whole}`);
  return `${lead}var(${TOKEN_PX[px]})`;
});
for (const snap of Object.values(snapshots)) snap.html = tokens(strips(marks(media(snap.html))));
const leftover = Object.entries(snapshots).flatMap(([name, s]) => (s.html.match(/http:\/\/127\.0\.0\.1:\d+[^"&)]*/g) ?? []).map(url => name + ' ' + url));
if (leftover.length) console.log('Addresses left in the markup (no picture for them):\n' + [...new Set(leftover)].slice(0, 20).join('\n'));
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const head = `// Written by director-checks-288.capture.mjs: do not edit. The app's own screens at commit ${commit},\n// rendered from the turn's sample world; markup only, styled by director-checks-288.app.css.\n`;
await writeFile(join(here, 'director-checks-288.app.mjs'), head + `export const receipt = ${JSON.stringify({ commit, client: 'packages/client/src', screens: Object.fromEntries(Object.entries(snapshots).map(([name, s]) => [name, { route: s.route.replace(/^\/w\/[^/]+/, '/w/…'), variant: s.variant, width: s.width, height: s.height }])) }, null, 1)};\nexport const screens = ${JSON.stringify(Object.fromEntries(Object.entries(snapshots).map(([name, s]) => [name, { width: s.width, height: s.height, scope: s.scope, canvases: s.canvases, html: s.html }])))};\n`);
// As 285: last, and two ids' worth, so the page's own html and body rules cannot resize the frame.
const frame = (scope, width, height) => `.${scope}:is(#_,*):is(#_,*){position:relative;box-sizing:border-box;width:${width}px;height:${height}px;min-height:0;margin:0;overflow:hidden;contain:layout paint;text-align:left}\n.${scope},.${scope} *,.${scope} *::before,.${scope} *::after{animation:none!important;transition:none!important}\n`;
await writeFile(join(here, 'director-checks-288.app.css'), `/* Written by director-checks-288.capture.mjs: do not edit. The client's own rules at commit ${commit} that match\n   the screens turn 288 stands in, scoped so they reach nothing else in the master. Each @media is\n   settled for the desk (1360 × 850); viewport units are the frame's. */\n` + css + '\n' + frame(...[SIZE[2], SIZE[0], SIZE[1]]));
console.log('Wrote director-checks-288.app.mjs and director-checks-288.app.css');
