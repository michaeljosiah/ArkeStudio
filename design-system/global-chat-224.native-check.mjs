// Visual/interaction checks of the offline existing-page comparison, not application acceptance.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),out=path.resolve(here,'../.dev/global-chat-design/native');
const profile=fs.mkdtempSync(path.join(out,'chrome-'));
const proc=spawn(process.env.CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--allow-file-access-from-files','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
const delay=ms=>new Promise(r=>setTimeout(r,ms));let ws;const report={checks:[],errors:[]};
try {
 let target;for(let i=0;i<80&&!target;i++){try{const port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page')?.webSocketDebuggerUrl;}catch{}if(!target)await delay(150);}
 if(!target)throw Error('Browser not ready');ws=new WebSocket(target);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(pending.has(m.id)){const {r,j}=pending.get(m.id);pending.delete(m.id);m.error?j(Error(JSON.stringify(m.error))):r(m.result);}};
 const send=(method,params={})=>new Promise((r,j)=>{const n=++id;pending.set(n,{r,j});ws.send(JSON.stringify({id:n,method,params}));});
 const js=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 const check=async(label,expression)=>{const result=await js(expression);report.checks.push({label,result});if(!result)throw Error(label);};
 const page=expression=>js(`(()=>{const w=document.getElementById('native-preview').contentWindow,d=w.document;return ${expression};})()`);
 const capture=async name=>{await delay(250);const b=await js(`(()=>{const e=document.getElementById('native-preview');const b=e.getBoundingClientRect();return {x:b.x+scrollX+1,y:b.y+scrollY+1,width:b.width-2,height:b.height-2};})()`);const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{...b,scale:1}});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
 await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1500,height:1150,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:pathToFileURL(process.env.ARKE_NATIVE_CHAT_FILE||path.join(here,'global-chat-224.native-review.html')).href});
 for(let i=0;i<80;i++){if(await page('typeof w.nativeDesignReady==="function"').catch(()=>false))break;await delay(150);}
 await page('w.nativeDesignReady()');
 await js('document.getElementById("native-preview").scrollIntoView({block:"start"})');await delay(150);
 await check('Existing real Develop page rendered',`document.getElementById('native-preview').contentDocument.querySelector('[data-screen="production-chat"]')!==null`);
 await check('Existing ModelChip rendered',`document.getElementById('native-preview').contentDocument.querySelector('.fy-mchip')!==null`);
 await page('w.nativeDesignSetMode("existing")');await capture('existing-page');
 await page('w.nativeDesignSetMode("proposed")');
 await check('One existing conversation mount',`document.getElementById('native-preview').contentDocument.querySelectorAll('.fy-production-studio-chat').length===1`);
 await check('Native composer remains in proposed panel',`!!document.getElementById('native-preview').contentDocument.querySelector('.fy-global-chat .fy-cx')`);
 await check('Desktop canvas fits beside the panel',`(()=>{const d=document.getElementById('native-preview').contentDocument;return d.querySelector('.fy-production-studio__canvas').getBoundingClientRect().right<=d.querySelector('.fy-global-chat').getBoundingClientRect().left+1;})()`);
 await check('Chat prepends existing header icon set',`document.getElementById('native-preview').contentDocument.querySelector('.fy-titlebar__side--right').firstElementChild.matches('[data-global-chat-trigger]')`);
 await capture('proposed-page');
 await page('d.querySelector(".fy-mchip__btn").click()');await delay(150);
 await check('Native grouped model picker opens',`!!document.getElementById('native-preview').contentDocument.querySelector('.fy-mpick__search')`);
 await capture('model-picker');
 report.picker=await page('JSON.stringify({rows:[...d.querySelectorAll(".fy-mpick__row")].map(e=>e.textContent),events:w.nativeDesignEvents})');
 await page('[...d.querySelectorAll(".fy-mpick__row")].find(e=>e.textContent.includes("GPT-5.4")).click()');await delay(150);
 await check('Provider mark and separate effort preserved',`(()=>{const d=document.getElementById('native-preview').contentDocument;return !!d.querySelector('.fy-mchip__btn .fy-mark')&&d.querySelector('.fy-mchip__btn').textContent.includes('GPT-5.4')&&!!d.querySelector('.fy-mchip__btn--effort');})()`);
 await capture('proposed-selected-model');
 await page('d.querySelector(".fy-mchip__btn--effort").click()');await delay(100);await capture('effort-picker');
 await page('d.dispatchEvent(new w.KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await delay(100);
 await page('w.nativeDesignSetMode("closed")');
 await check('Closing restores original mounted conversation',`(()=>{const d=document.getElementById('native-preview').contentDocument;return !d.querySelector('.fy-global-chat[open]')&&d.querySelectorAll('.fy-production-studio-chat').length===1&&d.querySelector('.fy-mchip__btn').textContent.includes('GPT-5.4');})()`);
 await page('w.nativeDesignSetMode("proposed")');await capture('proposed-final');
 report.geometry=await page('JSON.stringify([...d.querySelectorAll(".fy-global-chat,.fy-cx,.fy-mchip,.fy-production-studio__canvas,.fy-production-studio__thread,.fy-story")].map(e=>({cls:e.className,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y})))');
 await check('Persistent Chat remains visible above panel',`(()=>{const d=document.getElementById('native-preview').contentDocument;const b=d.querySelector('[data-global-chat-trigger]').getBoundingClientRect();return b.right<=d.defaultView.innerWidth&&b.top>=0&&b.width>0&&d.elementFromPoint(b.x+b.width/2,b.y+b.height/2)?.closest('[data-global-chat-trigger]')!==null;})()`);
 if(report.errors.length)throw Error(report.errors.join('\n'));
 console.log(`${report.checks.length} native comparison checks passed`);
} finally {fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));ws?.close();proc.kill();}
