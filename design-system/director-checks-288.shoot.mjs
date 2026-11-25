// Shoots turn 288's frames and reports anything that leaves its frame, as 285's shoot does.
//   node design-system/director-checks-288.shoot.mjs [output folder]             from the review page, light and dark
//   node design-system/director-checks-288.shoot.mjs --master [output folder]    from the design master itself, light
// --master serves this folder on a loopback port of its own, checks that the master it is served
// holds turn 288, waits for the dc runtime to draw it (which needs the network once, for React),
// and writes 288a.png … 288d.png at full size. Nothing but design-system is served.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openChrome, until } from '../scripts/lib/chrome.mjs';

const here = fileURLToPath(new URL('./', import.meta.url));
const fromMaster = process.argv.includes('--master');
const given = process.argv.slice(2).find(arg => !arg.startsWith('--'));
const output = resolve(given ?? join(here, '../.dev/director-checks-288/shots'));
await mkdir(output, { recursive: true });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.md': 'text/plain; charset=utf-8' };
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

// What may not happen in a frame: the turn's parts past the frame's edge or cut short, a panel that
// scrolls, a picture that did not load, the face not the product's. The app's own scrollers are left alone.
const faults = selector => `(() => {
  const root = document.querySelector(${JSON.stringify(selector)}); if (!root) return { missing: true };
  const r = root.getBoundingClientRect();
  const clipped = el => { for (let p = el.parentElement; p && p !== root; p = p.parentElement) { const o = getComputedStyle(p); if (o.overflowX !== 'visible' || o.overflowY !== 'visible') return true; } return false; };
  const ours = [...root.querySelectorAll('.dc288-panel, .dc288-panel *, .dc288-chip, .dc288-look, .dc288-look *, .dc288-cta, .dc288-cta *')];
  const over = ours.filter(el => { const b = el.getBoundingClientRect(); return b.width && !clipped(el) && (b.right > r.right + 1 || b.bottom > r.bottom + 1 || b.left < r.left - 1 || b.top < r.top - 1); }).slice(0, 6).map(el => (el.className || el.tagName) + ' ' + el.textContent.trim().slice(0, 30));
  const cut = [...root.querySelectorAll('.dc288-row > span, .dc288-chip, .dc288-head, .dc288-look .fy-models__what, .dc288-look .ui-check__label, .dc288-look .fy-seg__item, .dc288-look .fy-takechip, .dc288-cta .ui-btn, .dc288-foot .ui-btn, .fy-bench__wallactions .ui-btn, .fy-cuthead .ui-btn')].filter(el => el.scrollWidth > el.clientWidth + 1).slice(0, 8).map(el => el.textContent.trim());
  // A row that runs past its panel, or a panel row that wraps.
  const rows = [...root.querySelectorAll('.dc288-row')].filter(el => { const b = el.getBoundingClientRect(), p = el.closest('.dc288-panel').getBoundingClientRect(); return b.right > p.right - 5 || b.height > 34; }).map(el => el.textContent.trim().slice(0, 30));
  // The look's rows stay one line, and the card stays in the sheet's view.
  const look = root.querySelector('.dc288-look'); const body = look?.closest('.fy-page-sheet__body');
  const tall = [...root.querySelectorAll('.dc288-look .fy-models__row')].filter(el => el.getBoundingClientRect().height > 54).map(el => el.textContent.trim().slice(0, 20));
  const hidden = look && body && look.getBoundingClientRect().bottom > body.getBoundingClientRect().bottom + 1 ? 'look below the fold' : null;
  const pictures = [...root.querySelectorAll('img')].filter(img => !img.complete || img.naturalWidth === 0).map(img => img.getAttribute('src'));
  const font = getComputedStyle(root.querySelector('h1, h2, .dc288-head') ?? root).fontFamily.split(',')[0];
  const boxes = Object.fromEntries([...root.querySelectorAll('.dc288-panel, .dc288-chip, .dc288-look')].map((el, i) => { const b = el.getBoundingClientRect(); return [el.className.split(' ').find(c => c.startsWith('dc288')) + i, [Math.round(b.left - r.left), Math.round(b.top - r.top), Math.round(b.width), Math.round(b.height)].join(',')]; }));
  return { width: Math.round(r.width), height: Math.round(r.height), over, cut, rows, tall, hidden, pictures, font, boxes };
})()`;

const browser = await openChrome({ args: ['--hide-scrollbars'] });
let failed = false;
try {
  const { cdp, evaluate: js } = browser;
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  // As 285: a frame is pushed onto whole pixels by a margin before it is shot.
  const clipOf = selector => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'start' });
    for (let pass = 0; pass < 3; pass++) { const r = el.getBoundingClientRect(), s = getComputedStyle(el); const fy = Math.ceil(r.y - 0.001) - r.y, fx = Math.ceil(r.x - 0.001) - r.x; if (fy < 0.002 && fx < 0.002) break; el.style.marginTop = (parseFloat(s.marginTop) + fy) + 'px'; el.style.marginLeft = (parseFloat(s.marginLeft) + fx) + 'px'; }
    const r = el.getBoundingClientRect(); return { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
  const faces = `Promise.all([400, 500, 600, 700].map(w => document.fonts.load(w + ' 14px "Geist Sans"'))).then(() => document.fonts.ready).then(() => true)`;
  const report = [];
  if (fromMaster) {
    const served = await (await fetch(`${origin}/Arke%20Studio.dc.html`)).text();
    if (!served.includes('<section class="dv-turn" id="t288">')) throw new Error('the master this server holds has no turn 288');
    await cdp('Page.navigate', { url: `${origin}/Arke%20Studio.dc.html` });
    await until(() => js(`(() => { const all = [...document.querySelectorAll('.sc-host [data-screen-label^="288"]')]; return all.length === 4 && all.every(el => el.getBoundingClientRect().width > 0); })()`), { ms: 120_000, what: 'the master to draw turn 288' });
    await new Promise(r => setTimeout(r, 2500));
    await js(faces);
    await until(() => js(`[...document.querySelectorAll('[data-screen-label^="288"] img')].every(img => img.complete)`), { ms: 30_000, what: 'the pictures' });
    await js(`(() => { const s = document.createElement('style'); s.textContent = '*{animation:none!important;transition:none!important}.dv-theme{display:none!important}'; document.head.append(s); })()`);
    for (const letter of 'abcd') {
      const selector = `.sc-host [data-screen-label^="288${letter} "]`;
      const box = await clipOf(selector);
      await new Promise(r => setTimeout(r, 400));
      const { data } = await cdp('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 }, captureBeyondViewport: true });
      await writeFile(join(output, `288${letter}.png`), Buffer.from(data, 'base64'));
      report.push({ id: '288' + letter, from: 'master', ...(await js(faults(selector))) });
    }
  } else {
    await cdp('Page.navigate', { url: `${origin}/director-checks-288.review.html` });
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
  for (const r of report) if (r.missing || r.over?.length || r.cut?.length || r.rows?.length || r.tall?.length || r.hidden || r.pictures?.length || !/Geist/.test(r.font ?? '')) failed = true;
  console.log(JSON.stringify(report, null, 1));
  console.log(`${report.length} frames in ${output}${failed ? ' · FAULTS above' : ' · nothing leaves its frame'}`);
} finally { await browser.close(); await new Promise(closed => server.close(closed)); }
if (failed) process.exitCode = 1;
