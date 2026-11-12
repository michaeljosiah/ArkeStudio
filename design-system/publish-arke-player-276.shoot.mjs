// Shoots turn 276's frames from its review page in light and dark, for the review in chat.
//   node design-system/publish-arke-player-276.shoot.mjs [output-directory]
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openChrome, until } from '../scripts/lib/chrome.mjs';
import { servePage } from '../scripts/lib/client-page.mjs';

const here = fileURLToPath(new URL('./', import.meta.url));
const output = resolve(process.argv[2] ?? join(here, '../output/publish-arke-player-276'));
await mkdir(output, { recursive: true });
const page = await servePage(here);
const browser = await openChrome();
try {
  const { cdp, evaluate: js } = browser;
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `${page.origin}/publish-arke-player-276.review.html` });
  await until(() => js('document.readyState === "complete" && document.fonts.status === "loaded"'));
  const ids = await js('[...document.querySelectorAll(".rv > section")].map(s => s.id)');
  const report = [];
  for (const dark of [false, true]) {
    await js(`document.documentElement.classList.toggle('dark', ${dark})`);
    for (const id of ids) {
      const box = await js(`(() => { const el = document.querySelector('[id="${id}"] .fr'); el.scrollIntoView(); const r = el.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`);
      const over = await js(`(() => { const root = document.querySelector('[id="${id}"] .pb276'); const r = root.getBoundingClientRect(); return [...root.querySelectorAll('*')].filter(el => { const b = el.getBoundingClientRect(); return b.width && (b.right > r.right + 1 || b.bottom > r.bottom + 1) && !el.closest('.pb276-body, .pb276-pmain'); }).slice(0, 5).map(el => el.className || el.tagName); })()`);
      const { data } = await cdp('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 }, captureBeyondViewport: true });
      await writeFile(join(output, `${id}-${dark ? 'dark' : 'light'}.png`), Buffer.from(data, 'base64'));
      if (!dark) report.push({ id, ...box, overflow: over });
    }
  }
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  await page.close();
}
