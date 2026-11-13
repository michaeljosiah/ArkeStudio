import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openChrome, until } from '../scripts/lib/chrome.mjs';
import { servePage } from '../scripts/lib/client-page.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'output/voice-upload-dialog-283');
await mkdir(output, { recursive: true });
const page = await servePage(root);
const browser = await openChrome();
try {
  const { cdp, evaluate } = browser;
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 2, mobile: false });
  await cdp('Page.navigate', { url: `${page.origin}/design-system/voice-upload-dialog-283.review.html` });
  await until(() => evaluate('document.readyState === "complete" && document.fonts.status === "loaded"'));
  const results = [];
  for (const dark of [false, true]) {
    await evaluate(`document.documentElement.classList.toggle('dark',${dark})`);
    for (const id of ['283a', '283b']) {
      const state = await evaluate(`(()=>{const frame=document.getElementById('${id}').querySelector('.voice283');frame.scrollIntoView();const r=frame.getBoundingClientRect(),panel=frame.querySelector('.dialog');return {box:{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height},overflow:frame.scrollWidth>frame.clientWidth||panel.scrollWidth>panel.clientWidth,fontLoaded:document.fonts.check('14px "Geist Sans"'),actions:[...frame.querySelectorAll('.actions button')].map(b=>({label:b.textContent,height:b.getBoundingClientRect().height}))};})()`);
      if (state.overflow || !state.fontLoaded) throw new Error(JSON.stringify({ id, ...state }));
      const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...state.box, scale: 1 } });
      await writeFile(join(output, `${id}-${dark ? 'dark' : 'light'}.png`), Buffer.from(data, 'base64'));
      results.push({ id, dark, ...state });
    }
  }
  await writeFile(join(output, 'render-check.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally { await browser.close(); await page.close(); }
