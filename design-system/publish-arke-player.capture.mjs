// The publishing screens as they ship, for the design turn on publishing to Arke Player: the real
// App, its stylesheets and a synthetic world, in an owned headless Chrome. No author world is opened.
//   node --import tsx design-system/publish-arke-player.capture.mjs [output-directory] [route ...]
// VIEWPORT=390x844 for a phone. Writes one PNG per route, width and theme, and shell.json: the production shell's measured rail, header
// and page so the turn's frames can be held to them.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productionsLayoutFixture } from '../packages/client/test/productions-layout-fixture.ts';
import { openChrome, until } from '../scripts/lib/chrome.mjs';
import { buildClientPage, clientStyles, servePage } from '../scripts/lib/client-page.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] ?? join(root, 'output/publish-arke-player'));
await mkdir(output, { recursive: true });
const state = productionsLayoutFixture();
const world = state.world;
const wid = world.meta.worldId;
const extra = process.argv.slice(3);
const routes = extra.length ? extra : [
  `/w/${wid}/p/ledger`,
  `/w/${wid}/p/ledger/story/chapters`,
  `/w/${wid}/p/ledger/story/audiobook`,
  `/w/${wid}/guide`,
  '/publications',
];

await buildClientPage(output, `
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {MemoryRouter} from 'react-router';
import {App} from './App';import {__setStateForTest,__setBridgeForTest} from './lib/store';${await clientStyles()}
const seed=${JSON.stringify(state)};let renderer;
window.mountAt=async(path,dark=false)=>{renderer?.unmount();document.documentElement.classList.toggle('dark',dark);
__setBridgeForTest({platform:'test',appVersion:'publish-capture',connect(){},subscribe(){return()=>{}},send(){},coordinatorHttpBase:()=>location.origin});
__setStateForTest(structuredClone(seed),{connection:'open'});renderer=createRoot(document.getElementById('root'));
flushSync(()=>renderer.render(<MemoryRouter initialEntries={[path]}><App/></MemoryRouter>));await new Promise(r=>setTimeout(r,400));await document.fonts.ready;};
`);
const page = await servePage(output);
const browser = await openChrome();
try {
  const { cdp, evaluate: js } = browser;
  await cdp('Page.enable'); await cdp('Page.navigate', { url: page.origin }); await until(() => js('typeof mountAt === "function"'));
  const [width, height] = (process.env.VIEWPORT ?? '1360x850').split('x').map(Number);
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  const shells = {};
  for (const route of routes) {
    const name = route.replace(/^\/w\/[^/]+/, 'w').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root';
    for (const dark of [false, true]) {
      await js(`mountAt(${JSON.stringify(route)}, ${dark})`);
      await new Promise(r => setTimeout(r, 300));
      const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(output, `${name}-${width}-${dark ? 'dark' : 'light'}.png`), Buffer.from(data, 'base64'));
    }
    shells[route] = await js(`(() => {
      const box = el => { if (!el) return null; const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return { cls: el.className, x: r.x, y: r.y, w: r.width, h: r.height, font: s.font, color: s.color, bg: s.backgroundColor, pad: s.padding, gap: s.gap, border: s.borderRight + ' | ' + s.borderBottom, radius: s.borderRadius }; };
      const all = sel => [...document.querySelectorAll(sel)].map(box);
      return { text: document.body.innerText.slice(0, 1800), rail: box(document.querySelector('.fy-prodrail')), railItems: all('.fy-prodrail a, .fy-prodrail button').slice(0, 30).map(b => ({ ...b, text: undefined })),
        railText: [...document.querySelectorAll('.fy-prodrail a, .fy-prodrail button')].map(e => e.innerText.replace(/\\n/g, ' · ')).slice(0, 30),
        top: box(document.querySelector('header, .fy-topbar, [class*="topbar"]')), main: box(document.querySelector('main')), h1: all('h1'), h2: all('h2').slice(0, 6), buttons: [...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean).slice(0, 60) };
    })()`);
  }
  await writeFile(join(output, 'shell.json'), JSON.stringify(shells, null, 2));
  console.log(`${routes.length} routes captured in ${output}`);
} finally {
  await browser.close();
  await page.close();
}
