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
  const capture=async(selector,name)=>{
    if(name.startsWith('prototype-')){
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start'})`);await delay(100);
      const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));return;
    }
    const box=await evaluate(`(async()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=e.getBoundingClientRect();return {x:b.x+scrollX,y:b.y+scrollY,width:b.width,height:b.height};})()`);
    const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{...box,scale:1}});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));
  };

  const click=act=>evaluate(`(()=>{const b=[...document.querySelectorAll('#live-stage [data-native-act="${act}"]')].find(e=>e.getClientRects().length);if(!b||b.disabled)throw Error('Unavailable: ${act}');b.click();})()`);
  const demo=name=>evaluate(`document.querySelector('[data-native-demo="${name}"]').click()`);
  const input=(key,value,time=false)=>evaluate(`(()=>{const e=document.querySelector('#live-stage [data-native-${time?'time':'key'}="${key}"]');if(!e||e.disabled)throw Error('Input unavailable');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const state=()=>evaluate('airNativeState()');
  await send('Page.enable');await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1500,height:1150,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url});
  for(let i=0;i<80;i++){if(await evaluate('typeof airNativeState==="function"&&document.querySelector("#live-stage [data-native-particles]")?.dataset.ready==="true"').catch(()=>false))break;await delay(150);}
  await evaluate('document.fonts.ready');
  await ok('34 drawings retained; ten revised turn 220 frames','document.querySelectorAll(".frame-wrap .air220").length===34&&document.querySelectorAll(".frame-wrap .native220").length===10');
  await ok('Other turns explicitly preliminary and collapsed','document.querySelectorAll(".legacy-frames:not([open])").length===3');
  await ok('Images decoded','[...document.querySelectorAll("img")].every(i=>i.complete&&i.naturalWidth>0)');
  await ok('Geist loaded','[...document.fonts].some(f=>f.family.includes("Geist")&&f.status==="loaded")');
  await ok('Inspector and Arke are the only permanent Inspector tabs','[...document.querySelectorAll(".n-inspector-tabs")].every(e=>[...e.children].map(b=>b.textContent).join(",")==="Inspector,Arke")&&!document.querySelector(".native220 .sections")');
  await ok('All revised previews painted','[...document.querySelectorAll("[data-native-particles]")].every(e=>e.dataset.ready==="true")');
  for(const id of await evaluate('[...document.querySelectorAll("#turn-220 article")].map(e=>e.id)')){
    const measured=await evaluate(`(()=>{const e=document.querySelector('#${id} .native220'),p=e.querySelector('.n-inspector-scroll');return {id:${JSON.stringify(id)},width:e.clientWidth,height:e.clientHeight,overflow:e.scrollWidth-e.clientWidth,panelOverflow:p.scrollWidth-p.clientWidth,inspectorScroll:p.scrollTop};})()`);
    check(id+' fits the existing shell',measured.overflow<=1&&measured.panelOverflow<=1);report.frames.push(measured);await capture('#'+id+' .native220','revision2-'+id);
  }
  await demo('reset');const initial=JSON.stringify((await state()).values);
  await click('add-open');await input('target','Boat video · Picture');await input('start','00:00:12:12',true);await click('cancel');check('Cancel leaves the timeline untouched',JSON.stringify((await state()).values)===initial);
  await click('add-open');await input('start','00:00:12:12',true);await input('target','Boat video · Picture');check('Target leaves the chosen frame-precise interval intact',(await state()).draft.start===300);await click('add');
  await ok('Add selects effect and existing Inspector','airNativeState().values.added&&airNativeState().values.start===300&&airNativeState().values.end===1728&&!airNativeState().draft');
  await demo('appearance');await input('size',80);await input('colour','#ffbb77');await ok('Appearance edits commit without target/range changes','airNativeState().values.size===80&&airNativeState().values.colour==="#ffbb77"&&airNativeState().values.target==="Boat video · Picture"&&airNativeState().values.start===300');
  await demo('motion');const seed=(await state()).values.seed;await click('pattern');check('New pattern changes its identity',(await state()).values.seed!==seed);await click('undo');check('Undo restores the exact pattern',(await state()).values.seed===seed);
  await input('start','00:00:12:24',true);check('Invalid 24fps timecode is rejected',(await state()).values.start===300);
  await evaluate('document.querySelector("[data-native-highlight]").click()');await ok('Review annotations can be hidden','!document.querySelector("#live-stage .show-additions")');
  await demo('appearance');await capture('#live-stage .native220','revision2-live-appearance');
  for(const width of [984,390,320]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:1150,deviceScaleFactor:1,mobile:false});await delay(250);await demo('appearance');
    await ok(`Live ${width}px has no horizontal overflow`,'document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector("#live-stage .native220").scrollWidth<=document.querySelector("#live-stage .native220").clientWidth+1');
    if(width<=390){await ok('Phone keeps Done outside the scrolling controls','(()=>{const r=document.querySelector("#live-stage .native220").getBoundingClientRect(),f=document.querySelector("#live-stage .n-sheet-foot").getBoundingClientRect();return f.height>40&&f.bottom<=r.bottom+1;})()');await click('close-sheet');await ok('Done returns to the timeline','!document.querySelector("#live-stage .n-inspector.is-open")');await click('library');await click('add-open');await ok('Phone uses the existing Add sheet','!!document.querySelector("#live-stage .n-dialog")');await click('cancel');await demo('appearance');}
    await capture('#live-stage',`prototype-revision2-${width}`);
  }
  check('No runtime exceptions',report.errors.length===0);
  console.log(`Turn 220 revision 2: ${report.frames.length} drawings; ${report.checks.length} checks passed. Screenshots: ${out}`);
}finally{
  fs.writeFileSync(path.join(out,'render-report.json'),JSON.stringify(report,null,2));ws?.close();proc.kill();server.close();await delay(200);
  const resolved=path.resolve(profile);if(!resolved.startsWith(out+path.sep)||!path.basename(resolved).startsWith('chrome-'))throw Error('Unexpected temporary profile path');
  try{fs.rmSync(resolved,{recursive:true,force:true});}catch{}
}
