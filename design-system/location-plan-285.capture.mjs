// Turn 285 · the screens the Plan stands in, taken from the app itself. The real App, its real
// stylesheets and a synthetic world (the turn's sample, location-plan-285.plan.mjs) run in an owned
// headless Chrome; no author world and no installed app is opened. Each screen is written out
// twice: as a PNG to look at, and as the page's own markup with the rules that style it, so the
// turn's frames hold today's scene page, Stage and location sheet rather than a drawing of them.
//   node design-system/location-plan-285.capture.mjs [--look]
// --look writes the PNGs and an outline of each screen only (to .dev/location-plan-285/).
// Without it, it also writes location-plan-285.app.mjs (the markup) and location-plan-285.app.css
// (the client's rules that match it, scoped to .app285 at the desk and .app285p on a phone, with
// each @media settled for the size the screen was taken at).
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
import { CAST, PLACE, SCENE, SETS, SHOTS, POSITIONS } from './location-plan-285.plan.mjs';

const here = fileURLToPath(new URL('./', import.meta.url));
const root = resolve(here, '..');
const out = join(root, '.dev/location-plan-285');
await mkdir(out, { recursive: true });
const look = process.argv.includes('--look');

// A worktree has no node_modules of its own: @arke-studio/* would resolve to the main checkout's
// packages, a different commit. Workspace packages that run from source are taken from this tree.
const workspace = { name: 'this-tree', setup(b) {
  b.onResolve({ filter: /^@arke-studio\/[a-z-]+$/ }, args => {
    const entry = join(root, 'packages', args.path.slice('@arke-studio/'.length), 'src/index.ts');
    return existsSync(entry) && !args.path.endsWith('/engine') ? { path: entry } : null;
  });
} };

// The main checkout's node_modules may lag this tree's package.json (on 20 November 2026 it had no
// pdfjs-dist, @fontsource/comic-neue or @fontsource/bangers). None of the three reaches the scene
// page, the Stage or a location sheet, so a package that will not resolve is built as an empty
// module rather than installed from a design script. Listed so a stand-in is never silent.
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

// Pictures the fixture names, as files already in design-system/assets (and this turn's renders).
const MEDIA = [
  [/references\/ade\//, 'assets/juju-ade.jpg'], [/references\/ife\//, 'assets/juju-ife.jpg'], [/references\/tunde\//, 'assets/juju-tunde.jpg'],
  [/references\/the-club\/.*booth/, 'assets/location-plan-285-pic-1.jpg'], [/references\/the-club\/.*table/, 'assets/location-plan-285-pic-6.jpg'],
  [/references\/the-club\//, 'assets/location-plan-285-pic-5.jpg'],
];
const served = new Map();

const fixture = { CAST, PLACE, SCENE, SETS, SHOTS, POSITIONS };
await build({
  stdin: { resolveDir: join(root, 'packages/client/src'), loader: 'tsx', contents: `
import React from 'react'; import { createRoot } from 'react-dom/client'; import { flushSync } from 'react-dom'; import { MemoryRouter } from 'react-router';
import { App } from './App'; import { __setStateForTest, __setBridgeForTest, __connectionStatusForTest } from './lib/store';
import { stageShot } from '@arke-studio/contracts';
import { FIXTURE_STATE } from '../test/fixture-state';
${await clientStyles()}
const plan = ${JSON.stringify(fixture)};
const AT = '2026-11-20T09:00:00Z';
function sample() {
  const state = structuredClone(FIXTURE_STATE);
  const world = state.world;
  // The world is a stand-in that carries the sample's names and nothing of the film's words.
  Object.assign(world.meta, { name: plan.SCENE.world, slug: 'na-love-or-juju', logline: 'The sample world of design turn 285.' });
  Object.assign(state.worlds[0], { name: plan.SCENE.world, slug: 'na-love-or-juju', counts: { characters: 3, locations: 1, factions: 0, canonEntries: 0, productions: 1 } });
  world.proposals = []; world.canon = []; world.artifacts = []; world.changes = [];
  const person = world.sheets.find(sheet => sheet.type === 'character'), place = world.sheets.find(sheet => sheet.type === 'location');
  world.sheets = [
    ...plan.CAST.map(member => ({ ...structuredClone(person), id: member.id, name: member.name, role: 'In the scene', billing: 'lead', voice: undefined, canonRules: [], links: ['the-club'], version: 3,
      sections: [{ heading: 'Essence', body: 'In the scene.' }] })),
    { ...structuredClone(place), id: 'the-club', name: plan.PLACE.name, region: 'One room', version: plan.PLACE.version, canonRules: [], links: plan.CAST.map(member => member.id),
      sections: [{ heading: 'Look', body: 'One room at night: a booth on the west wall, the bar to the north, the DJ to the south, a table in the far corner across the floor.' }] },
  ];
  const photo = { file: 'main.jpg', source: 'legacy', sheetVersion: 3, artDirectionVersion: 3, acceptedAt: AT };
  const view = (id, name, file, at) => ({ id, name, file, sourceTakeId: 'tk_01J8A0000000000000000000A1', sheetVersion: plan.PLACE.version, artDirectionVersion: 3, acceptedAt: at, status: 'active' });
  world.referenceKits = [
    ...plan.CAST.map(member => ({ sheetId: member.id, anchor: 'main.jpg', mainPhoto: photo, tiles: [{ angle: 'head-front', status: 'locked', file: 'main.jpg', sheetVersion: 3 }], compilations: [], looks: [] })),
    { sheetId: 'the-club', tiles: [], compilations: [], looks: [], locationViews: [view('lv_wide', 'The wide', 'wide.jpg', '2026-11-18T09:00:00Z'), view('lv_booth', 'The booth', 'booth.jpg', '2026-11-18T09:05:00Z'), view('lv_table', 'Her table', 'table.jpg', '2026-11-18T09:10:00Z')] },
  ];
  const production = world.productions[0];
  Object.assign(production.meta, { id: 'the-film', title: plan.SCENE.production, logline: 'The sample production of design turn 285.', aspect: plan.SCENE.aspect });
  production.sceneFiles = { sc_02: '02-gold-on-gold' };
  production.treatment = '';
  production.takes = []; production.reviews = []; production.selections = {};
  // A shot is its position's name and its length; the storyboard it would fill is cut from every frame.
  const shots = plan.SHOTS.map(shot => ({ id: 'sh_' + String(shot.n).padStart(2, '0'), number: shot.n, title: shot.title, description: shot.title + '.', durationSec: shot.sec }));
  // The Stage opens on shot 3, which the turn's last frame shows on position 3: Ade and Tunde in the booth.
  const stand = member => ({ sheetId: member.id, x: member.marks[0].x, z: member.marks[0].z, facing: member.marks[0].facing, pose: 'sit' });
  const third = plan.POSITIONS[2];
  try {
    // All three are staged, in the scene's order, so each wears on the Stage the colour the Plan gives them.
    const staged = stageShot(shots[2], { cast: plan.CAST.map(member => member.id), sets: ['booth'], durationSec: 3, aspect: plan.SCENE.aspect });
    staged.sets = plan.SETS.map(set => ({ ...set, solid: true }));
    staged.cast = plan.CAST.map(stand);
    const frame = { subject: 'ade', size: 'close-up', angle: 'eye', side: 'over', over: 'tunde', focalMm: third.mm };
    staged.keys = [{ t: 0, p: third.at, l: third.aim, frame }, { t: 3, p: third.at, l: third.aim, frame }];
    shots[2].staging = staged;
    shots[2].framing = { size: 'Close-up', angle: 'Eye level', lens: third.mm + 'mm', movement: 'Locked off' };
  } catch (error) { window.stagingError = String(error); }
  production.scenes = [{ id: 'sc_02', number: 2, slug: 'gold-on-gold', title: plan.SCENE.title, status: 'accepted', version: 6,
    inherits: { location: 'the-club', timeOfDay: 'night' }, cast: { ade: { added: AT }, ife: { added: AT }, tunde: { added: AT } }, shots }];
  state.app.jobs = []; state.app.ledger = [];
  return state;
}
let renderer;
window.worldId = FIXTURE_STATE.world.meta.worldId;
window.settle = async () => { await new Promise(r => setTimeout(r, 500)); await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode().catch(() => {})));
  for (const a of document.getAnimations()) { if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.finish(); else { a.pause(); a.currentTime = 0; } } };
window.mountAt = async (path, dark = false) => {
  renderer?.unmount(); document.documentElement.classList.toggle('dark', dark);
  const bridge = { platform: 'test', appVersion: 'design-capture', connect() {}, subscribe() { return () => {}; }, send() {}, coordinatorHttpBase: () => location.origin };
  window.arke = bridge; __setBridgeForTest(bridge); __setStateForTest(sample()); __connectionStatusForTest('open');
  renderer = createRoot(document.getElementById('root'));
  flushSync(() => renderer.render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>)); await window.settle();
};
` },
  bundle: true, platform: 'browser', format: 'esm', define: { 'import.meta.env': '{}' }, external: ['/*.webp', '/*.png'], loader: { '.woff': 'file', '.woff2': 'file' },
  outfile: join(out, 'view.js'), plugins: [missing, urlAssets, workspace], logLevel: 'error',
});
if (absent.size) console.log(`Not installed, built as empty modules: ${[...absent].join(', ')}`);
await writeFile(join(out, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="view.css"></head><body><div id="root"></div><script type="module" src="view.js"></script></body></html>');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let file;
    if (path.startsWith('/media/')) {
      const hit = MEDIA.find(([pattern]) => pattern.test(path));
      if (!hit) throw new Error('no picture');
      served.set(path, hit[1]); file = join(here, hit[1]);
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

// The page's own markup and the rules that style it. Run in the page: the browser is the only
// honest judge of which selector matches what and which @media holds at this size.
const SNAP = String.raw`
// The stylesheet is read as text, not through the CSSOM: the CSSOM writes a shorthand that holds a
// var() back as empty longhands (font: var(--type-meta) beside a later line-height), which loses the
// rule. A small reader is enough for what esbuild writes: comments, strings, and nested blocks.
window.cssTree = async () => {
  if (window.cssTreeMade) return window.cssTreeMade;
  let id = 0; const odd = [];
  const parse = (text, i, depth) => {
    const rules = [];
    for (;;) {
      // Skip space and comments between rules.
      for (;;) { while (i < text.length && /\s/.test(text[i])) i++; if (text.startsWith('/*', i)) { i = text.indexOf('*/', i) + 2; continue; } break; }
      if (i >= text.length) return [rules, i];
      if (text[i] === '}') return [rules, i + 1];
      // The prelude runs to the first { or ; outside a string or a bracket.
      let j = i, round = 0;
      for (; j < text.length; j++) { const c = text[j]; if (c === '"' || c === "'") { j = text.indexOf(c, j + 1); continue; } if (c === '(' || c === '[') round++; else if (c === ')' || c === ']') round--; else if ((c === '{' || c === ';') && round === 0) break; }
      const prelude = text.slice(i, j).trim();
      if (text[j] === ';') { i = j + 1; continue; }
      const at = /^@([a-z-]+)/.exec(prelude)?.[1];
      if (at === 'media' || at === 'supports' || at === 'container' || at === 'layer' || at === 'scope') {
        const [children, end] = parse(text, j + 1, depth + 1);
        rules.push({ at, condition: prelude.slice(at.length + 1).trim(), children }); i = end; continue;
      }
      // Anything else is a block of declarations: find its end.
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
window.snapRules = async () => {
  const root = document.getElementById('root'); const kept = [];
  const hits = selector => { const test = selector.replace(/::?(before|after|placeholder|selection|marker|backdrop|file-selector-button|first-line|first-letter|-webkit-[a-z-]+|-moz-[a-z-]+)(\([^)]*\))?/g, '').trim() || '*';
    try { return document.documentElement.matches(test) || document.body.matches(test) || root.matches(test) || root.querySelector(test) !== null; } catch { return true; } };
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
    // Leading ancestors that are the document itself: html, body, :root, #root, the theme class on
    // them and any attribute the page set on them. They are true of the frame, so they go; but
    // their weight stays, or a rule that won by naming #root would lose to a plainer one after it.
    // :is(#_,*) matches anything and weighs what an id weighs; likewise a class and a tag.
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
      // A @container still asks its question in the frame, of a box the same size; the rest are settled here.
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
  const marks = [];
  root.querySelectorAll('*').forEach(el => {
    if (el.matches(':disabled')) marks.push([el, 'data-s-off']);
    if (el.matches(':checked')) marks.push([el, 'data-s-on']);
    if (el.hasAttribute('open')) marks.push([el, 'data-s-open']);
  });
  for (const [el, name] of marks) el.setAttribute(name, '');
  root.querySelectorAll('input').forEach(el => { if (el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'file') el.setAttribute('value', el.value); });
  root.querySelectorAll('textarea').forEach(el => { el.textContent = el.value; });
  // A select is as wide as its widest choice; with only the chosen one kept it would shrink, so its width is kept too.
  const selects = [...root.querySelectorAll('select')].map(el => el.selectedIndex);
  const selectWidths = [...root.querySelectorAll('select')].map(el => el.getBoundingClientRect().width);
  const canvases = [...root.querySelectorAll('canvas')].map(el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), cls: el.className }; });
  const clone = root.cloneNode(true);
  for (const [el, name] of marks) el.removeAttribute(name);
  clone.querySelectorAll('select').forEach((el, i) => { const chosen = el.options[selects[i]]; if (chosen) { [...el.options].forEach(o => { if (o !== chosen) o.remove(); }); } el.style.width = selectWidths[i].toFixed(1) + 'px'; el.style.flex = 'none'; });
  clone.querySelectorAll('canvas').forEach((el, i) => { const box = document.createElement('div'); box.className = 'app285-canvas ' + el.className; box.setAttribute('data-canvas', String(i)); box.setAttribute('style', (el.getAttribute('style') ?? '') + ';width:' + canvases[i].w + 'px;height:' + canvases[i].h + 'px'); el.replaceWith(box); });
  // What is not shown is not kept, and a link in the master must lead nowhere.
  clone.querySelectorAll('script,style,link,[hidden],dialog:not([open])').forEach(el => el.remove());
  clone.querySelectorAll('*').forEach(el => { for (const name of ['id', 'for', 'href', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'data-testid', 'data-discover', 'disabled', 'checked', 'open', 'tabindex', 'draggable', 'loading']) el.removeAttribute(name); });
  return { html: clone.innerHTML, canvases };
};
window.outline = () => { const lines = []; const walk = (el, depth) => { if (depth > 9) return; const r = el.getBoundingClientRect(); const cls = typeof el.className === 'string' ? el.className.split(' ').slice(0, 3).join('.') : '';
  const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue.trim()).join(' ').slice(0, 50);
  if (r.width > 0 && (cls || own)) lines.push(' '.repeat(depth) + el.tagName.toLowerCase() + (cls ? '.' + cls : '') + ' [' + Math.round(r.x) + ',' + Math.round(r.y) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ']' + (own ? ' "' + own + '"' : ''));
  for (const child of el.children) walk(child, depth + 1); }; walk(document.getElementById('root'), 0); return lines.join('\n'); };
`;

// Each screen: its route under the world, where it is taken, the presses that bring it to the state
// the turn starts from, the part the turn replaces (left out of the markup as <!--slot:name-->, so
// its rules are left out too), and where the Stage's own canvas is kept as a picture.
const press = text => `[...document.querySelectorAll('button,[role=radio]')].find(el => el.textContent.trim() === ${JSON.stringify(text)} || el.getAttribute('aria-label') === ${JSON.stringify(text)})?.click()`;
const SCREENS = [
  // The scene page on Flow: the view whose toolbar the Plan's is drawn from (its Full screen press).
  { name: 'scene', route: '/p/the-film/scenes/sc_02', device: 'desk', steps: [press('Flow')], slots: { body: '.fy-swcanvas' } },
  // The Stage in the page on shot 3, the camera selected, so its form shows the camera in words.
  { name: 'stage', route: '/p/the-film/scenes/sc_02/shots/sh_03?view=stage', device: 'desk', steps: [`[...document.querySelectorAll('.fy-swstage__item')].find(el => el.textContent.trim().startsWith('camera'))?.click()`], canvas: 'assets/location-plan-285-stage.jpg' },
  // The Reference tab: its head and tabs stay; its views are replaced, but their rules are kept,
  // because the Plan tab's cards are drawn as Reference's cards are.
  { name: 'reference', route: '/locations/the-club/reference', device: 'desk', slots: { body: 'main.fy-locref' }, rules: 'whole' },
  { name: 'scene-phone', route: '/p/the-film/scenes/sc_02', device: 'phone', slots: { body: 'ol.fy-swrows' } },
  ...(look ? [
    { name: 'scene-storyboard', route: '/p/the-film/scenes/sc_02', device: 'desk' },
    { name: 'scene-flow-full', route: '/p/the-film/scenes/sc_02', device: 'desk', steps: [press('Flow'), press('Full screen')] },
    { name: 'place', route: '/locations/the-club', device: 'desk' },
    { name: 'stage-grey', route: '/p/the-film/scenes/sc_02/shots/sh_03?view=stage', device: 'desk', steps: [press('Greybox')] },
    { name: 'stage-phone', route: '/p/the-film/scenes/sc_02/shots/sh_03?view=stage', device: 'phone' },
  ] : []),
];
const SIZE = { desk: [1360, 850, false, 'app285'], phone: [390, 844, true, 'app285p'] };
const cut = slots => `(() => { window.cutBack = []; const was = {}; for (const [name, selector] of Object.entries(${JSON.stringify(slots ?? {})})) { const el = document.querySelector(selector); if (!el) throw new Error('no ' + selector); was[name] = el.outerHTML.slice(0, 60000); const mark = document.createComment('slot:' + name); el.replaceWith(mark); window.cutBack.push([mark, el]); } return was; })()`;
const mend = `(() => { for (const [mark, el] of window.cutBack ?? []) mark.replaceWith(el); window.cutBack = []; })()`;

const browser = await openChrome({ args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const snapshots = {}; const css = {}; const report = [];
try {
  const { cdp, evaluate: js } = browser;
  await cdp('Page.enable');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  for (const [device, [width, height, mobile, scope]] of Object.entries(SIZE)) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: mobile });
    await cdp('Page.navigate', { url: origin + '/?' + device });
    await until(() => js('typeof mountAt === "function"'));
    await js(SNAP + ';true');
    const base = '/w/' + await js('window.worldId');
    const keptAll = new Set();
    for (const { name, route, steps = [], slots, canvas, rules } of SCREENS.filter(screen => screen.device === device)) {
      let dom;
      for (const dark of [true, false]) {
        await js(`mountAt(${JSON.stringify(base + route)}, ${dark})`);
        for (const step of steps) { await js(step + ';true'); await js('window.settle()'); }
        await js('window.settle()');
        const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
        await writeFile(join(out, `app-${name}-${dark ? 'dark' : 'light'}.png`), Buffer.from(data, 'base64'));
        if (!dark) await writeFile(join(out, `app-${name}.outline.txt`), await js('outline()'));
        // How the type is set on the page itself, to hold a frame's against (see the shoot's report).
        if (!dark) await writeFile(join(out, `app-${name}.type.txt`), await js(`[...document.querySelectorAll('h1, .fy-sw__tab, .fy-seg__item, .fy-titlebar, .fy-swstage__item, .fy-pillnav__item, .ui-btn')].slice(0, 40).map(el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return [el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0], el.textContent.trim().slice(0, 24), Math.round(r.x * 10) / 10 + ',' + Math.round(r.y * 10) / 10 + ' ' + Math.round(r.width * 10) / 10 + 'x' + Math.round(r.height * 10) / 10, s.fontFamily.split(',')[0], s.fontWeight, s.fontSize, s.letterSpacing, s.fontFeatureSettings, s.fontVariationSettings].join(' | '); }).join('\\n')`));
        if (!dark && canvas) {
          // The viewport's pixels alone: its labels, tools and caption are markup and stay markup.
          const box = await js(`(() => { const r = document.querySelector('canvas').getBoundingClientRect(); const s = document.createElement('style'); s.id = 'only-canvas'; s.textContent = '*{visibility:hidden!important}canvas{visibility:visible!important}'; document.head.append(s); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
          await new Promise(r => setTimeout(r, 300));
          const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 90, clip: { ...box, scale: 1 } });
          await js(`document.getElementById('only-canvas').remove()`);
          if (!look) await writeFile(join(here, canvas), Buffer.from(shot.data, 'base64'));
        }
        if (rules === 'whole') for (const id of await js('snapRules()')) keptAll.add(id);
        // What was cut is kept beside the PNGs, to draw from; it is not part of the turn.
        for (const [slot, was] of Object.entries(await js(cut(slots)))) if (!dark) await writeFile(join(out, `app-${name}.${slot}.html`), was);
        for (const id of await js('snapRules()')) keptAll.add(id);
        // Light is mounted last, so the markup is the light theme's; the rules carry both.
        if (!dark) dom = await js('snapDom()');
        await js(mend);
      }
      const error = await js('window.stagingError ?? null');
      snapshots[name] = { width, height, scope, route: base + route, html: dom.html, canvases: dom.canvases, ...(canvas ? { canvas } : {}) };
      report.push({ name, route, width, height, bytes: dom.html.length, canvases: dom.canvases.length, ...(error ? { stagingError: error } : {}) });
    }
    const made = await js(`snapCss(${JSON.stringify([...keptAll])}, ${JSON.stringify(scope)}, ${width}, ${height})`);
    css[scope] = made.css;
    report.push({ scope, rules: keptAll.size, bytes: made.css.length, odd: made.odd });
  }
} finally { await browser.close(); await new Promise(closed => server.close(closed)); }

console.log(JSON.stringify(report, null, 1));
if (look) process.exit(0);

// Pictures come from the coordinator in the app; in the master they are files beside it.
const media = html => html.replace(/(src|href)="http:\/\/127\.0\.0\.1:\d+(\/media\/[^"?]+)[^"]*"/g, (whole, attr, path) => {
  const file = served.get(decodeURIComponent(path)) ?? served.get(path);
  return file ? `${attr}="${file}"` : whole;
});
for (const snap of Object.values(snapshots)) snap.html = media(snap.html);
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const head = `// Written by location-plan-285.capture.mjs: do not edit. The app's own screens at commit ${commit},\n// rendered from the turn's sample world; markup only, styled by location-plan-285.app.css.\n`;
await writeFile(join(here, 'location-plan-285.app.mjs'), head + `export const receipt = ${JSON.stringify({ commit, client: 'packages/client/src', screens: Object.fromEntries(Object.entries(snapshots).map(([name, s]) => [name, { route: s.route.replace(/^\/w\/[^/]+/, '/w/…'), width: s.width, height: s.height }])) }, null, 1)};\nexport const screens = ${JSON.stringify(Object.fromEntries(Object.entries(snapshots).map(([name, s]) => [name, { width: s.width, height: s.height, scope: s.scope, canvases: s.canvases, ...(s.canvas ? { canvas: s.canvas } : {}), html: s.html }])))};\n`);
// Last, so the page's own html and body rules (which now land on the frame) cannot resize it. A
// frame is a still: nothing in it moves, and what the page fixed to the window is fixed to the frame.
// The frame's own box is written to outweigh them all: two ids' worth.
const frame = (scope, width, height) => `.${scope}:is(#_,*):is(#_,*){position:relative;box-sizing:border-box;width:${width}px;height:${height}px;min-height:0;margin:0;overflow:hidden;contain:layout paint;text-align:left}\n.${scope},.${scope} *,.${scope} *::before,.${scope} *::after{animation:none!important;transition:none!important}\n`;
await writeFile(join(here, 'location-plan-285.app.css'), `/* Written by location-plan-285.capture.mjs: do not edit. The client's own rules at commit ${commit} that match\n   the screens turn 285 stands in, scoped so they reach nothing else in the master. Each @media is\n   settled for the size the screen was taken at; viewport units are the frame's. */\n` +
  Object.entries(SIZE).map(([, [width, height, , scope]]) => css[scope] + '\n' + frame(scope, width, height)).join('\n'));
console.log('Wrote location-plan-285.app.mjs and location-plan-285.app.css');
