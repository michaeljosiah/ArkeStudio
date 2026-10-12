// Browser checks for the isolated design; no application acceptance claim.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const out=path.resolve(here,'../.dev/global-chat-design');fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(out,'chrome-'));
const chrome=process.env.CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe';
if(!fs.existsSync(chrome))throw Error('Set CHROME to a Chromium executable');
const proc=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--allow-file-access-from-files','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const report={checks:[],frames:[],errors:[]};let ws;
try{
 let target;
 for(let i=0;i<80&&!target;i++){try{const port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page')?.webSocketDebuggerUrl;}catch{}if(!target)await delay(150);}
 if(!target)throw Error('Browser not ready');
 ws=new WebSocket(target);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 let id=0;const pending=new Map();
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(m.id&&pending.has(m.id)){const {r,j}=pending.get(m.id);pending.delete(m.id);m.error?j(Error(JSON.stringify(m.error))):r(m.result);}};
 const send=(method,params={})=>new Promise((r,j)=>{const n=++id;pending.set(n,{r,j});ws.send(JSON.stringify({id:n,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 const check=async(label,expression)=>{const result=await evaluate(expression);report.checks.push({label,result});if(!result)throw Error('Design check failed: '+label);};
 const click=action=>evaluate(`document.querySelector('#chat-prototype [data-act="${action}"]').click()`);
 const demo=name=>evaluate(`document.querySelector('[data-demo="${name}"]').click()`);
 const capture=async(selector,name)=>{const box=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return {x:b.x+scrollX,y:b.y+scrollY,width:b.width,height:b.height};})()`);const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{...box,scale:1}});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
 await send('Page.enable');await send('Runtime.enable');await send('Emulation.setFocusEmulationEnabled',{enabled:true});
 await send('Emulation.setDeviceMetricsOverride',{width:1500,height:1100,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:pathToFileURL(process.env.ARKE_CHAT_DESIGN_FILE||path.join(here,'global-chat-224.review.html')).href});
 for(let i=0;i<60;i++){if(await evaluate('typeof globalChatDesignState==="function"').catch(()=>false))break;await delay(100);}
 await evaluate('document.fonts.ready');
 await check('Nine HTML drawings','document.querySelectorAll("#drawings .gc224").length===9');
 await check('Images decoded','[...document.images].every(i=>i.complete&&i.naturalWidth>0)');
 await check('Geist loaded','[...document.fonts].some(f=>f.family.includes("Geist")&&f.status==="loaded")');
 for(const frame of await evaluate('[...document.querySelectorAll(".review-frame")].map(e=>e.id)')){const measured=await evaluate(`(()=>{const e=document.querySelector('#${frame} .gc224');return {id:${JSON.stringify(frame)},width:e.clientWidth,overflow:e.scrollWidth-e.clientWidth};})()`);report.frames.push(measured);if(measured.overflow>1)throw Error('Frame overflow '+frame);await capture('#'+frame+' .gc224',frame);}
 await demo('reset');await click('toggle');
 await check('Opens World Chat and focuses composer','globalChatDesignState().chat==="world"&&document.activeElement.matches("[data-draft]")');
 await evaluate('(()=>{const e=document.querySelector("#chat-prototype [data-draft]");e.value="A retained world draft";e.dispatchEvent(new Event("input",{bubbles:true}));})()');
 await click('production');await check('Navigation retains world conversation and draft','globalChatDesignState().chat==="world"&&globalChatDesignState().drafts.world==="A retained world draft"&&!!document.querySelector("#chat-prototype [data-act=adopt]")');
 await click('adopt');await check('Explicit switch opens Builder Chat','globalChatDesignState().chat==="production"&&document.querySelector("#chat-prototype .gc224-panel-head p").textContent==="Builder Chat"');
 await click('history');await click('resume-world');await check('World draft survives return','document.querySelector("#chat-prototype [data-draft]").value==="A retained world draft"');
 await click('send');await check('Send captures visible conversation','globalChatDesignState().messages.world[0]==="A retained world draft"&&!globalChatDesignState().messages.production');
 await click('settings');await click('dismiss-overlay');await check('Settings preserves the conversation','globalChatDesignState().chat==="world"&&globalChatDesignState().open');
 await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await check('Escape closes and returns focus','!globalChatDesignState().open&&document.activeElement.matches("[data-chat-trigger]")');
 await click('toggle');await check('Opening closed Chat follows current page','globalChatDesignState().chat==="production"');
 await demo('running');await check('Work continues while hidden','globalChatDesignState().running.world&&!globalChatDesignState().open&&!!document.querySelector("#chat-prototype [data-chat-trigger] .gc224-dot")');
 await demo('world-change');await check('World switch disables previous composer','document.querySelector("#chat-prototype [data-draft]").disabled&&document.querySelector("#chat-prototype [data-act=send]").disabled');
 await click('adopt');await check('Explicit new-world conversation preserves old draft','globalChatDesignState().chat==="other"&&globalChatDesignState().drafts.world==="Continue with Maren."');
 await demo('no-world');await check('No-world composer disabled','document.querySelector("#chat-prototype [data-draft]").disabled');await click('world');await check('Opening world enables its chat','globalChatDesignState().chat==="world"&&!document.querySelector("#chat-prototype [data-draft]").disabled');
 for(const width of [984,390,320]){await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<600});await delay(100);await demo('builder');await check(width+' no page overflow','document.documentElement.scrollWidth<=innerWidth+1');await check(width+' no chat overflow','(()=>{const e=document.querySelector("#chat-prototype .gc224");return e.scrollWidth<=e.clientWidth+1;})()');await capture('#chat-prototype','prototype-'+width);if(width<600){await check(width+' phone sheet','!!document.querySelector("#chat-prototype .gc224-phone [role=dialog]")');await check(width+' reachable 44px controls','[...document.querySelectorAll("#chat-prototype .gc224-panel-head>button,#chat-prototype [data-act=send]")].every(e=>e.getBoundingClientRect().height>=44)');await evaluate('document.querySelector("#chat-prototype [data-act=send]").focus()');await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await check(width+' phone focus stays in sheet','document.activeElement.dataset.act==="history"');}}
 await demo('theme');await check('Dark theme switches','document.documentElement.classList.contains("dark")');await capture('#chat-prototype','prototype-dark-phone');
 if(report.errors.length)throw Error(report.errors.join('\n'));
 console.log(`${report.checks.length} design interaction/layout checks and nine drawings passed`);
}finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));ws?.close();proc.kill();}
