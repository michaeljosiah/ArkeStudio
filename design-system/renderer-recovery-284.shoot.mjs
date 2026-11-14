import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openChrome, until } from '../scripts/lib/chrome.mjs';
import { servePage } from '../scripts/lib/client-page.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'output/renderer-recovery-284');
await mkdir(output, { recursive: true });
const page = await servePage(root);
const browser = await openChrome();
try {
  const { cdp, evaluate } = browser;
  await cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 2, mobile: false });
  await cdp('Page.navigate', { url: `${page.origin}/design-system/renderer-recovery-284.review.html` });
  await until(() => evaluate('document.readyState === "complete" && document.fonts.status === "loaded"'));
  const results = [];
  for (const dark of [false, true]) {
    await evaluate(`document.documentElement.classList.toggle('dark',${dark})`);
    const state = await evaluate(`(()=>{const frame=document.querySelector('.recovery284'),r=frame.getBoundingClientRect(),panel=frame.querySelector('.native-dialog');return {box:{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height},overflow:frame.scrollHeight>frame.clientHeight||panel.scrollWidth>panel.clientWidth,font:getComputedStyle(panel).fontFamily,actions:[...frame.querySelectorAll('.native-actions button')].map(b=>b.textContent)};})()`);
    if (state.overflow) throw new Error(JSON.stringify(state));
    const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...state.box, scale: 1 } });
    await writeFile(join(output, `284a-${dark ? 'dark' : 'light'}.png`), Buffer.from(data, 'base64'));
    results.push({ dark, ...state });
  }
  await writeFile(join(output, 'render-check.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally { await browser.close(); await page.close(); }
