// Design-only browser checks. No Studio, world writes, model calls or media export.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createDesignServer} from './air-particles-220.serve.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const out=path.resolve(here,'../.dev/air-particles-design');fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(out,'chrome-'));
const chrome=process.env.CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe';
if(!fs.existsSync(chrome))throw Error('Set CHROME to a Chromium executable');
const server=createDesignServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/air-particles-220.review.html`;
const port=9700+Math.floor(Math.random()*200);
const proc=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const report={frames:[],checks:[],errors:[]};let ws;
try{
  let target;
  for(let i=0;i<80&&!target;i++){try{target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page')?.webSocketDebuggerUrl;}catch{}if(!target)await delay(200);}
  if(!target)throw Error('Browser not ready');
  ws=new WebSocket(target);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let id=0;const pending=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(m.id&&pending.has(m.id)){const {r,j}=pending.get(m.id);pending.delete(m.id);m.error?j(Error(JSON.stringify(m.error))):r(m.result);}};
  const send=(method,params={})=>new Promise((r,j)=>{const n=++id;pending.set(n,{r,j});ws.send(JSON.stringify({id:n,method,params}));});
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const check=(label,value)=>{report.checks.push({label,result:value});if(!value)throw Error('Design check failed: '+label);};
  const ok=async(label,expression)=>check(label,await evaluate(expression));
  const click=act=>evaluate(`(()=>{const b=[...document.querySelectorAll('#live-stage [data-act="${act}"]')].find(e=>e.getClientRects().length);if(!b||b.disabled)throw Error('Unavailable: ${act}');b.click();})()`);
  const add=async()=>{await click('open-picker');await click('add');};
  const dragStart=()=>evaluate(`(()=>{window.__crossfadeCheckDrag=new DataTransfer();document.querySelector('#live-stage [data-transition]').dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:window.__crossfadeCheckDrag}));})()`);
  const dragTo=(type,target)=>evaluate(`document.querySelector('#live-stage [data-drop="${target}"]').dispatchEvent(new DragEvent('${type}',{bubbles:true,cancelable:true,dataTransfer:window.__crossfadeCheckDrag}))`);
  const demo=name=>evaluate(`document.querySelector('[data-demo="${name}"]').click()`);
  const input=(key,value)=>evaluate(`(()=>{const e=document.querySelector('#live-stage [data-key="${key}"]');if(!e||e.disabled)throw Error('Input unavailable: ${key}');${typeof value==='boolean'?`e.checked=${value}`:`e.value=${JSON.stringify(value)}`};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const state=()=>evaluate('airDesignState()');
  const capture=async(selector,name)=>{
    if(name.startsWith('prototype-')){
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start'})`);await delay(100);
      const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));return;
    }
    const box=await evaluate(`(async()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=e.getBoundingClientRect();return {x:b.x+scrollX,y:b.y+scrollY,width:b.width,height:b.height};})()`);
    const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{...box,scale:1}});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));
  };
  await send('Page.enable');await send('Runtime.enable');
  await send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await send('Emulation.setDeviceMetricsOverride',{width:1500,height:1150,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url});
  for(let i=0;i<60;i++){if(await evaluate('typeof airDesignState==="function"').catch(()=>false))break;await delay(150);}
  await evaluate('document.fonts.ready');
  await ok('31 proposed HTML drawings','document.querySelectorAll(".frame-wrap .air220").length===31');
  await ok('Images decoded','[...document.querySelectorAll("img")].every(i=>i.complete&&i.naturalWidth>0)');
  await ok('Geist loaded','[...document.fonts].some(f=>f.family.includes("Geist")&&f.status==="loaded")');
  await ok('Only Inspector and Arke permanent tabs','[...document.querySelectorAll(".panel-tabs")].every(e=>[...e.children].map(b=>b.textContent).join(",")==="Inspector,Arke")');
  await ok('Procedural previews painted','[...document.querySelectorAll("canvas[data-particles]")].every(e=>e.dataset.ready==="true")');
  for(const id of await evaluate('[...document.querySelectorAll("article[id^=frame-]")].map(e=>e.id)')){
    const measured=await evaluate(`(()=>{const e=document.querySelector('#${id} .air220');return {id:${JSON.stringify(id)},width:e.clientWidth,height:e.clientHeight,overflow:e.scrollWidth-e.clientWidth,panelOverflow:e.querySelector('.inspector').scrollWidth-e.querySelector('.inspector').clientWidth};})()`);
    check(id+' no horizontal overflow',measured.overflow<=1&&measured.panelOverflow<=1);report.frames.push(measured);await capture('#'+id+' .air220',id);
  }
  await demo('reset');const original=JSON.stringify((await state()).current);
  await demo('placement');await input('target','Video 1');await input('start',12);await click('cancel-add');check('Cancel placement preserves Current',JSON.stringify((await state()).current)===original);
  await demo('motion');const seed=(await state()).current.seed;await click('pattern');check('New pattern is explicit',(await state()).current.seed!==seed);await ok('Pattern keeps its protection','airDesignState().current.protect.seed');
  await demo('reset');await demo('chat');await ok('Ready card does not enter Suggested','!airDesignState().review&&airDesignState().view==="current"&&!document.querySelector("#live-stage .review-bar")');
  await click('review');await ok('Explicit Review activates Suggested','airDesignState().review&&airDesignState().view==="suggested"');const clock=(await state()).clock;
  await click('appearance');await input('amount',115);check('Pending edit keeps Current unchanged',JSON.stringify((await state()).current)===original);
  await click('chat');await click('suggest');await ok('Incoming version retains active preview','airDesignState().version===1&&airDesignState().incoming.version===2&&airDesignState().pending.amount===115&&airDesignState().incoming.values.amount===115');
  await click('review-incoming');await ok('New version requires explicit Review','airDesignState().version===2&&!airDesignState().incoming&&airDesignState().pending.amount===115');check('Version switch keeps clock',(await state()).clock===clock);
  await click('appearance');await click('protect');await click('protect:blend');await click('release');await ok('Release leaves Current and active candidate protected','airDesignState().current.protect.blend&&airDesignState().pending.protect.blend&&!airDesignState().incoming.values.protect.blend');
  await click('review-incoming');await ok('Reviewed release remains pending','airDesignState().current.protect.blend&&!airDesignState().pending.protect.blend&&airDesignState().pending.release.includes("blend")');
  await click('apply');await ok('Apply commits reviewed release and settings','!airDesignState().current.protect.blend&&airDesignState().current.protect.seed&&airDesignState().current.amount===115&&!airDesignState().review');
  await click('undo');check('One Undo restores entire arrangement',JSON.stringify((await state()).current)===original);
  await demo('chat');await click('review');await demo('stale');await ok('Stale proposal blocks Apply','document.querySelector("#live-stage [data-act=apply]").disabled');await click('update');await ok('Update does not auto-review','airDesignState().stale&&airDesignState().incoming');await click('review-incoming');await ok('Review fresh version clears staleness','!airDesignState().stale');
  await click('appearance');await input('opacity',64);await click('close');await send('Page.reload');await delay(1800);await ok('Closed review resumes on Current with manual edits','!airDesignState().review&&airDesignState().view==="current"&&airDesignState().pending.opacity===64');await click('review');await click('discard');await ok('Discard clears pending work','!airDesignState().pending&&!airDesignState().review');
  await demo('reset');await click('audio');await input('reaction','On');await ok('Audio On needs an explicit source','airDesignState().current.reaction==="Off"');await input('source','Boat clip · sound');await input('reaction','On');await ok('Placed video sound is a valid reaction source','airDesignState().current.reaction==="On"&&airDesignState().current.source==="Boat clip · sound"');
  await demo('reset');await demo('chat');await click('review');
  for(const width of [984,390,320]){await send('Emulation.setDeviceMetricsOverride',{width,height:1150,deviceScaleFactor:1,mobile:false});await delay(150);await ok(`Live ${width}px has no horizontal overflow`,'document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector("#live-stage .air220").scrollWidth<=document.querySelector("#live-stage .air220").clientWidth+1');await capture('#live-stage',`prototype-${width}`);}
  await demo('dark');await capture('#live-stage','prototype-dark');
  check('No runtime exceptions',report.errors.length===0);
  console.log(`Air Particles design: ${report.frames.length} frames; ${report.checks.length} checks passed. Screenshots: ${out}`);
}finally{
  fs.writeFileSync(path.join(out,'render-report.json'),JSON.stringify(report,null,2));ws?.close();proc.kill();server.close();await delay(200);
  const resolved=path.resolve(profile);if(!resolved.startsWith(out+path.sep)||!path.basename(resolved).startsWith('chrome-'))throw Error('Unexpected temporary profile path');
  try{fs.rmSync(resolved,{recursive:true,force:true});}catch{}
}
