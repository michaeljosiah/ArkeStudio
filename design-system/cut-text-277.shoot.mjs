// Shoots turn 277's frames from its review page, light and dark, and reports anything that leaves
// its frame.   node design-system/cut-text-277.shoot.mjs [output folder]
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openChrome, until } from '../scripts/lib/chrome.mjs';
import { servePage } from '../scripts/lib/client-page.mjs';

const here = fileURLToPath(new URL('./', import.meta.url));
const output = resolve(process.argv[2] ?? join(here, '../output/cut-text-277'));
await mkdir(output, { recursive: true });
const page = await servePage(here);
const browser = await openChrome();
try {
  const { cdp, evaluate: js } = browser;
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `${page.origin}/cut-text-277.review.html` });
  await until(() => js('document.readyState === "complete" && document.fonts.status === "loaded"'));
  const ids = await js('[...document.querySelectorAll(".rv > section")].map(s => s.id)');
  const report = [];
  for (const dark of [false, true]) {
    await js(`document.documentElement.classList.toggle('dark', ${dark})`);
    for (const id of ids) {
      const box = await js(`(() => { const el = document.querySelector('[id="${id}"] .fr'); el.scrollIntoView(); const r = el.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`);
      // The Inspector and the timeline scroll by design; anything else past the frame's edge is a fault.
      const over = await js(`(() => { const root = document.querySelector('[id="${id}"] .tx277'); const r = root.getBoundingClientRect(); return [...root.querySelectorAll('*')].filter(el => { const b = el.getBoundingClientRect(); return b.width && (b.right > r.right + 1 || b.bottom > r.bottom + 1) && !el.closest('.n-inspector-scroll, .n-timeline-canvas, svg'); }).slice(0, 5).map(el => el.className || el.tagName); })()`);
      const scroll = await js(`(() => { const el = document.querySelector('[id="${id}"] .n-inspector-scroll'); return el ? [el.clientHeight, el.scrollHeight] : null; })()`);
      const { data } = await cdp('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 }, captureBeyondViewport: true });
      await writeFile(join(output, `${id}-${dark ? 'dark' : 'light'}.png`), Buffer.from(data, 'base64'));
      if (!dark) report.push({ id, width: box.width, height: box.height, overflow: over, inspector: scroll });
    }
  }
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  await page.close();
}
