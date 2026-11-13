// Shoots turn 278's frames from its review page, light and dark, and reports anything that leaves
// its frame.   node design-system/world-cleanup-278.shoot.mjs [output folder]
// The repository root is served, not this folder: the storage reply links the shipped
// studio-assistant.css from packages/client.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openChrome, until } from '../scripts/lib/chrome.mjs';
import { servePage } from '../scripts/lib/client-page.mjs';

const here = fileURLToPath(new URL('./', import.meta.url));
const output = resolve(process.argv[2] ?? join(here, '../output/world-cleanup-278'));
await mkdir(output, { recursive: true });
const page = await servePage(resolve(here, '..'));
const browser = await openChrome();
try {
  const { cdp, evaluate: js } = browser;
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `${page.origin}/design-system/world-cleanup-278.review.html` });
  await until(() => js('document.readyState === "complete" && document.fonts.status === "loaded" && [...document.images].every(i => i.complete)'));
  const ids = await js('[...document.querySelectorAll(".rv > section")].map(s => s.id)');
  const report = [];
  for (const dark of [false, true]) {
    await js(`document.documentElement.classList.toggle('dark', ${dark})`);
    for (const id of ids) {
      const box = await js(`(() => { const el = document.querySelector('[id="${id}"] .fr'); el.scrollIntoView(); const r = el.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`);
      // The sheet's body and the assistant's transcript scroll by design; anything else past the
      // sheet's own edge, or past the frame's, is a fault. Text cut short by an ellipsis is listed.
      const faults = await js(`(() => {
        const root = document.querySelector('[id="${id}"] .cu278'), r = root.getBoundingClientRect();
        const scrolled = el => el.closest('.cu-body, .g239-messages, .g239-page');
        const over = [...root.querySelectorAll('*')].filter(el => { const b = el.getBoundingClientRect(); return b.width && !scrolled(el) && (b.right > r.right + 1 || b.bottom > r.bottom + 1 || b.left < r.left - 1); }).slice(0, 5).map(el => el.className || el.tagName);
        const sheet = root.querySelector('.cu-sheet'), s = sheet?.getBoundingClientRect();
        const wide = sheet ? [...sheet.querySelectorAll('*')].filter(el => { const b = el.getBoundingClientRect(); return b.width && (b.right > s.right + 1 || b.left < s.left - 1); }).slice(0, 5).map(el => el.className || el.tagName) : [];
        const cut = [...root.querySelectorAll('.cu-name b, .cu-name span, .cu-sz, .cu-n, .cu-btn')].filter(el => el.scrollWidth > el.clientWidth + 1).slice(0, 6).map(el => el.textContent.trim());
        return { over, wide, cut, sheet: s ? [Math.round(s.width), Math.round(s.height)] : null };
      })()`);
      const { data } = await cdp('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 }, captureBeyondViewport: true });
      await writeFile(join(output, `${id}-${dark ? 'dark' : 'light'}.png`), Buffer.from(data, 'base64'));
      if (!dark) report.push({ id, width: box.width, height: box.height, ...faults });
    }
  }
  console.log(JSON.stringify(report, null, 1));
} finally {
  await browser.close();
  await page.close();
}
