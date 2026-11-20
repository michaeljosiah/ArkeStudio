// Turn 285 · renders the Plan's pictures from location-plan-285.render.mjs into assets/ and writes
// each plan's frame (where a metre falls in the picture) to location-plan-285.labels.json, so the
// frames can set a number or a name on the spot it belongs to. Deterministic: rerun after a change
// to the sample (location-plan-285.plan.mjs) or to the kit.
//   node design-system/location-plan-285.renders.mjs   (ARKE_CHROME=<path> if Chrome is elsewhere)
// The render page imports the kit from packages/contracts, which is TypeScript, so it is bundled
// first (esbuild, into .dev/) and served from there with the assets beside it.
import { build } from 'esbuild';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openChrome, until } from '../scripts/lib/chrome.mjs';
import { POSITIONS, CROSSING, DRAWN } from './location-plan-285.plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../.dev/location-plan-285/render');
fs.mkdirSync(out, { recursive: true });
await build({ entryPoints: [path.join(here, 'location-plan-285.render.mjs')], bundle: true, platform: 'browser', format: 'esm', outfile: path.join(out, 'render.js'), logLevel: 'error' });
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Plan renders · Turn 285</title><style>body{margin:0;background:#111}canvas{display:block}</style></head><body><script type="module" src="render.js"></script></body></html>');

// Each plan is rendered at twice the size its frame shows it. [name, options]
const PLANS = [
  ['plan-scene', { w: 1334, h: 880 }],
  ['plan-selected', { w: 1334, h: 880, selected: 5 }],
  ['plan-crossing', { w: 1334, h: 880, crossing: true, warn: CROSSING.n }],
  ['plan-place', { w: 1564, h: 656, cast: false }],
  // A phone shows the room 350 px wide, so its lines are heavier and each camera's body is big enough to hold its number.
  ['plan-phone', { w: 700, h: 400, margin: 0.25, weight: 1.8, body: 0.38 }],
];
const VIEW = [640, 360];

const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).slice(1) || 'index.html';
  const file = path.resolve(out, name);
  if (path.relative(out, file).startsWith('..')) { res.writeHead(404).end(); return; }
  fs.readFile(file, (error, data) => { if (error) { res.writeHead(404).end(); return; } res.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript' : 'text/html', 'Cache-Control': 'no-store' }); res.end(data); });
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
const browser = await openChrome({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const { cdp, evaluate } = browser;
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await until(() => evaluate('!!window.plan285ready'), { ms: 40_000, what: 'the render page' });
  const save = (name, png) => { fs.writeFileSync(path.join(here, 'assets', `location-plan-285-${name}.jpg`), Buffer.from(png.split(',')[1], 'base64')); console.log(`assets/location-plan-285-${name}.jpg`); };
  const labels = {};
  for (const [name, options] of PLANS) {
    const r = await evaluate(`plan285.render(${JSON.stringify({ view: 'plan', ...options })})`);
    save(name, r.png);
    // The frame in the picture's own pixels, halved: the frames lay it out at half size.
    labels[name] = { w: r.frame.w / 2, h: r.frame.h / 2, x0: r.frame.x0, z0: r.frame.z0, s: r.frame.s / 2 };
  }
  for (const position of [...POSITIONS, CROSSING]) {
    save(`grey-${position.n}`, (await evaluate(`plan285.render(${JSON.stringify({ view: 'grey', n: position.n, w: VIEW[0], h: VIEW[1] })})`)).png);
    if (DRAWN.includes(position.n)) save(`pic-${position.n}`, (await evaluate(`plan285.render(${JSON.stringify({ view: 'picture', n: position.n, w: VIEW[0], h: VIEW[1] })})`)).png);
  }
  fs.writeFileSync(path.join(here, 'location-plan-285.labels.json'), JSON.stringify(labels, null, 1) + '\n');
} finally { await browser.close(); await new Promise(closed => server.close(closed)); }
