// Shoots turn 285's frames and reports anything that leaves its frame.
//   node design-system/location-plan-285.shoot.mjs [output folder]             from the review page, light and dark
//   node design-system/location-plan-285.shoot.mjs --master [output folder]    from the design master itself, light
// --master serves this folder on a loopback port of its own, checks that the master it is served
// holds turn 285, waits for the dc runtime to draw it (which needs the network once, for React),
// and writes 285a.png … 285f.png at full size. Nothing but design-system is served.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openChrome, until } from '../scripts/lib/chrome.mjs';

const here = fileURLToPath(new URL('./', import.meta.url));
const fromMaster = process.argv.includes('--master');
const given = process.argv.slice(2).find(arg => !arg.startsWith('--'));
const output = resolve(given ?? join(here, '../.dev/location-plan-285/shots'));
await mkdir(output, { recursive: true });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.md': 'text/plain; charset=utf-8' };
const server = createServer(async (request, response) => {
  try {
    const file = resolve(here, decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).slice(1));
    const inside = relative(here, file);
    if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('outside design-system');
    const data = await readFile(file);
    response.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(data);
  } catch { response.writeHead(404).end(); }
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
const origin = `http://127.0.0.1:${server.address().port}`;

// What may not happen in a frame: anything past its edge, a picture that did not load, text cut
// short in the Plan's own parts. The page's own scrollers (the dock's thread, the inspector) are
// the app's and are left alone.
const faults = selector => `(() => {
  const root = document.querySelector(${JSON.stringify(selector)}); if (!root) return { missing: true };
  const r = root.getBoundingClientRect();
  const clipped = el => { for (let p = el.parentElement; p && p !== root; p = p.parentElement) { const o = getComputedStyle(p); if (o.overflowX !== 'visible' || o.overflowY !== 'visible') return true; } return false; };
  const over = [...root.querySelectorAll('.pl285 *, .pl285-place *, .pl285p *, .pl285-menu, .pl285-menu *')].filter(el => { const b = el.getBoundingClientRect(); return b.width && !clipped(el) && (b.right > r.right + 1 || b.bottom > r.bottom + 1 || b.left < r.left - 1 || b.top < r.top - 1); }).slice(0, 6).map(el => (el.className || el.tagName) + ' ' + el.textContent.trim().slice(0, 30));
  const cut = [...root.querySelectorAll('.pl285 .fy-swstage__item > span, .pl285 .fy-swstage__eyebrow > span, .pl285 .fy-swstage__row > *, .pl285-place h3, .pl285-place .fy-mono, .pl285p-row > span, .pl285-opt > span, .fy-sw__tab, .fy-seg__item')].filter(el => el.scrollWidth > el.clientWidth + 1).slice(0, 8).map(el => el.textContent.trim());
  const panel = root.querySelector('.pl285 .fy-swstage__panel'); const spill = panel && panel.scrollHeight > panel.clientHeight + 1 ? panel.scrollHeight + '/' + panel.clientHeight : null;
  const tags = [...root.querySelectorAll('.pl285-vp > *')].map(el => el.getBoundingClientRect()); const vp = root.querySelector('.pl285-vp')?.getBoundingClientRect();
  const outside = vp ? tags.filter(b => b.left < vp.left || b.right > vp.right || b.top < vp.top || b.bottom > vp.bottom).length : 0;
  const pictures = [...root.querySelectorAll('img')].filter(img => !img.complete || img.naturalWidth === 0).map(img => img.getAttribute('src'));
  const font = getComputedStyle(root.querySelector('.fy-sw__title, h1, .fy-swstage__head') ?? root).fontFamily.split(',')[0];
  return { width: Math.round(r.width), height: Math.round(r.height), over, cut, spill, outside, pictures, font };
})()`;

const browser = await openChrome({ args: ['--hide-scrollbars'] });
let failed = false;
try {
  const { cdp, evaluate: js } = browser;
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  // A frame in a flowing page can sit on a fraction of a pixel, which blurs every hairline in the
  // shot and moves it a pixel against the app's own. It is pushed onto whole pixels for the shot,
  // by a margin and not a transform: a transformed layer loses the text's sub-pixel smoothing.
  const clipOf = selector => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'start' });
    for (let pass = 0; pass < 3; pass++) { const r = el.getBoundingClientRect(), s = getComputedStyle(el); const fy = Math.ceil(r.y - 0.001) - r.y, fx = Math.ceil(r.x - 0.001) - r.x; if (fy < 0.002 && fx < 0.002) break; el.style.marginTop = (parseFloat(s.marginTop) + fy) + 'px'; el.style.marginLeft = (parseFloat(s.marginLeft) + fx) + 'px'; }
    const r = el.getBoundingClientRect(); return { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), width: Math.round(r.width), height: Math.round(r.height), frac: [r.x % 1, r.y % 1] }; })()`);
  // Every weight the app sets, loaded before anything is measured: a face still on its way is drawn in the next one down.
  const faces = `Promise.all([400, 500, 600, 700].map(w => document.fonts.load(w + ' 14px "Geist Sans"'))).then(() => document.fonts.ready).then(() => true)`;
  const report = [];
  if (fromMaster) {
    const served = await (await fetch(`${origin}/Arke%20Studio.dc.html`)).text();
    if (!served.includes('<section class="dv-turn" id="t285">')) throw new Error('the master this server holds has no turn 285');
    await cdp('Page.navigate', { url: `${origin}/Arke%20Studio.dc.html` });
    // The served HTML already holds the frames; the dc runtime then makes the page again inside its
    // own scroller. Wait for that one, laid out, and let it settle before measuring anything.
    await until(() => js(`(() => { const all = [...document.querySelectorAll('.sc-host [data-screen-label^="285"]')]; return all.length === 6 && all.every(el => el.getBoundingClientRect().width > 0); })()`), { ms: 120_000, what: 'the master to draw turn 285' });
    await new Promise(r => setTimeout(r, 2500));
    await js(faces);
    await until(() => js(`[...document.querySelectorAll('[data-screen-label^="285"] img')].every(img => img.complete)`), { ms: 30_000, what: 'the pictures' });
    // Nothing moves while it is shot, and the master's own light/dark control (fixed to the window's corner) stays out of the frame.
    await js(`(() => { const s = document.createElement('style'); s.textContent = '*{animation:none!important;transition:none!important}.dv-theme{display:none!important}'; document.head.append(s); })()`);
    for (const letter of 'abcdef') {
      const selector = `[data-screen-label^="285${letter} "]`;
      const box = await clipOf(selector);
      await new Promise(r => setTimeout(r, 400));
      const { data } = await cdp('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 }, captureBeyondViewport: true });
      await writeFile(join(output, `285${letter}.png`), Buffer.from(data, 'base64'));
      report.push({ id: '285' + letter, from: 'master', ...(await js(faults(selector))) });
    }
  } else {
    await cdp('Page.navigate', { url: `${origin}/location-plan-285.review.html` });
    await until(() => js('document.readyState === "complete" && [...document.images].every(i => i.complete)'));
    await js(faces);
    const ids = await js('[...document.querySelectorAll(".rv > section")].map(s => s.id)');
    for (const dark of [false, true]) {
      await js(`document.documentElement.classList.toggle('dark', ${dark})`);
      for (const id of ids) {
        const box = await clipOf(`[id="${id}"] .fr`);
        await new Promise(r => setTimeout(r, 250));
        const { data } = await cdp('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 }, captureBeyondViewport: true });
        await writeFile(join(output, `${id}-${dark ? 'dark' : 'light'}.png`), Buffer.from(data, 'base64'));
        if (!dark) report.push({ id, from: 'review', ...(await js(faults(`[id="${id}"] .fr > div`))) });
      }
    }
  }
  for (const r of report) if (r.missing || r.over?.length || r.cut?.length || r.spill || r.outside || r.pictures?.length || !/Geist/.test(r.font ?? '')) failed = true;
  console.log(JSON.stringify(report, null, 1));
  console.log(`${report.length} frames in ${output}${failed ? ' · FAULTS above' : ' · nothing leaves its frame'}`);
} finally { await browser.close(); await new Promise(closed => server.close(closed)); }
if (failed) process.exitCode = 1;
