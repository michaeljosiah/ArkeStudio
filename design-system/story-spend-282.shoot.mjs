import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openChrome, until } from "../scripts/lib/chrome.mjs";
import { servePage } from "../scripts/lib/client-page.mjs";
const root=fileURLToPath(new URL("../",import.meta.url));
const output=resolve(root,"output/story-spend-282");
await mkdir(output,{recursive:true});
const page=await servePage(root);
const browser=await openChrome();
try {
  const {cdp,evaluate:js}=browser;
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride",{width:1000,height:900,deviceScaleFactor:2,mobile:false});
  await cdp("Page.navigate",{url:`${page.origin}/design-system/story-spend-282.review.html`});
  await until(()=>js('document.readyState === "complete" && document.fonts.status === "loaded"'));
  const report=[];
  for(const dark of [false,true]) {
    await js(`document.documentElement.classList.toggle("dark",${dark})`);
    for(const id of ["282a","282b","282c"]) {
      const state=await js(`(()=>{const root=document.querySelector('[id="${id}"] .ui282');root.scrollIntoView();const r=root.getBoundingClientRect();return {box:{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height},overflow:root.scrollWidth>root.clientWidth||root.scrollHeight>root.clientHeight,font:getComputedStyle(root).fontFamily,fontLoaded:document.fonts.check('14px "Geist Sans"')};})()`);
      if(state.overflow || !state.fontLoaded) throw new Error(JSON.stringify({id,...state}));
      const {data}=await cdp("Page.captureScreenshot",{format:"png",captureBeyondViewport:true,clip:{...state.box,scale:1}});
      await writeFile(join(output,`${id}-${dark?"dark":"light"}.png`),Buffer.from(data,"base64"));
      report.push({id,dark,overflow:state.overflow,fontLoaded:state.fontLoaded});
    }
  }
  await writeFile(join(output,"render-check.json"),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); await page.close(); }
