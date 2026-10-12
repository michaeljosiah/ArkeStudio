// Design-only browser checks. No Studio, world writes, model calls or media export.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createDesignServer} from './crossfade-216.serve.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const out=path.resolve(here,'../.dev/crossfade-design');fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(out,'chrome-'));
const chrome=process.env.CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe';
if(!fs.existsSync(chrome))throw Error('Set CHROME to a Chromium executable');
const server=createDesignServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/crossfade-216.review.html`;
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
  const click=act=>evaluate(`(()=>{const b=[...document.querySelectorAll('#crossfade-prototype [data-act="${act}"]')].find(e=>e.getClientRects().length);if(!b||b.disabled)throw Error('Unavailable: ${act}');b.click();})()`);
  const add=async()=>{await click('open-picker');await click('add');};
  const dragStart=()=>evaluate(`(()=>{window.__crossfadeCheckDrag=new DataTransfer();document.querySelector('#crossfade-prototype [data-transition]').dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:window.__crossfadeCheckDrag}));})()`);
  const dragTo=(type,target)=>evaluate(`document.querySelector('#crossfade-prototype [data-drop="${target}"]').dispatchEvent(new DragEvent('${type}',{bubbles:true,cancelable:true,dataTransfer:window.__crossfadeCheckDrag}))`);
  const demo=name=>evaluate(`document.querySelector('[data-demo="${name}"]').click()`);
  const input=(key,value)=>evaluate(`(()=>{const e=document.querySelector('#crossfade-prototype [data-key="${key}"]');if(!e||e.disabled)throw Error('Input unavailable: ${key}');${typeof value==='boolean'?`e.checked=${value}`:`e.value=${JSON.stringify(value)}`};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const state=()=>evaluate('crossfadeDesignState()');
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
  for(let i=0;i<60;i++){if(await evaluate('typeof crossfadeDesignState==="function"').catch(()=>false))break;await delay(150);}
  await evaluate('document.fonts.ready');
  await ok('33 proposed HTML frames','document.querySelectorAll(".frame-grid .xf216").length===33');
  await ok('Images decoded','[...document.querySelectorAll("img")].every(i=>i.complete&&i.naturalWidth>0)');
  await ok('Geist loaded','[...document.fonts].some(f=>f.family.includes("Geist")&&f.status==="loaded")');
  await ok('Only Inspector and Arke permanent tabs','[...document.querySelectorAll(".panel-tabs")].every(e=>[...e.children].filter(b=>!b.classList.contains("touch-only")).map(b=>b.textContent).join(",")==="Inspector,Arke")');
  for(const id of await evaluate('[...document.querySelectorAll(".frame-grid>article")].map(e=>e.id)')){
    const measured=await evaluate(`(()=>{const e=document.querySelector('#${id} .xf216');return {id:${JSON.stringify(id)},width:e.clientWidth,height:e.clientHeight,overflow:e.scrollWidth-e.clientWidth,panelOverflow:e.querySelector('.panel-scroll').scrollWidth-e.querySelector('.panel-scroll').clientWidth};})()`);
    check(id+' no horizontal overflow',measured.overflow<=1&&measured.panelOverflow<=1);report.frames.push(measured);await capture('#'+id+' .xf216',id);
  }
  await demo('manual');
  const beforePlacement=JSON.stringify((await state()).current);
  await ok('No preliminary Inspector insertion step','!document.querySelector("#crossfade-prototype .inspector [data-act=add]")');
  await ok('Plus initially quiet until hover or focus','getComputedStyle(document.querySelector("#crossfade-prototype .join-trigger span")).opacity==="0"');
  await evaluate('document.querySelector("#crossfade-prototype .join-trigger").focus()');
  await ok('Keyboard focus reveals plus','getComputedStyle(document.querySelector("#crossfade-prototype .join-trigger span")).opacity==="1"');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await ok('Keyboard activation opens choices without inserting','crossfadeDesignState().picker&&!crossfadeDesignState().current.hasTransition&&document.activeElement.dataset.act==="add"');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await ok('Escape closes picker and restores join focus','!crossfadeDesignState().picker&&document.activeElement.classList.contains("join-trigger")');
  check('Dismissal leaves Current unchanged',JSON.stringify((await state()).current)===beforePlacement);
  await click('open-picker');await click('close-picker');await ok('Library picker returns focus to its invoking tile','document.activeElement.dataset.transition==="crossfade"');
  await add();await ok('Choosing tile inserts directly and selects duration','crossfadeDesignState().current.hasTransition&&crossfadeDesignState().current.duration===1&&!crossfadeDesignState().picker&&document.activeElement.dataset.key==="duration"');
  await click('undo');check('Picker insertion is one Undo',JSON.stringify((await state()).current)===beforePlacement);
  await dragStart();await dragTo('dragover','join');
  await ok('Drag shows eligible target and placement ghost','crossfadeDesignState().dragging&&crossfadeDesignState().dragTarget==="join"&&getComputedStyle(document.querySelector("#crossfade-prototype .drop-ghost")).display!=="none"');
  check('Placement preview does not edit Current',JSON.stringify((await state()).current)===beforePlacement);
  await dragTo('drop','join');await ok('Dropping inserts with same one-second default','crossfadeDesignState().current.hasTransition&&crossfadeDesignState().current.duration===1&&!crossfadeDesignState().dragging');
  await click('undo');check('Drag insertion is one Undo',JSON.stringify((await state()).current)===beforePlacement);
  for(const invalid of ['gap','video']){await dragStart();await dragTo('dragover',invalid);await dragTo('drop',invalid);check(`${invalid} drop changes no clips or transitions`,JSON.stringify((await state()).current)===beforePlacement);}
  await dragStart();await evaluate('document.querySelector("#crossfade-prototype [data-transition]").dispatchEvent(new DragEvent("dragend",{bubbles:true}))');
  await ok('Cancelled drag clears placement state','!crossfadeDesignState().dragging&&!crossfadeDesignState().current.hasTransition');
  await add();await input('duration',1.5);await click('protect');await input('protectJoin',true);await input('protectDuration',true);await click('inspect');
  const beforeReplace=JSON.stringify((await state()).current);
  await dragStart();await dragTo('drop','join');await ok('Occupied join requires explicit replacement','crossfadeDesignState().replacePrompt&&crossfadeDesignState().current.duration===1.5');
  await click('close-picker');check('Keep existing retains settings and protection',JSON.stringify((await state()).current)===beforeReplace);
  await dragStart();await dragTo('drop','join');await click('replace-transition');
  await ok('Direct replacement retains protection and updates its value','crossfadeDesignState().current.duration===1&&crossfadeDesignState().current.protectDuration&&crossfadeDesignState().current.protectJoin');
  const beforeNoop=JSON.stringify((await state()).undo);await dragStart();await dragTo('drop','join');check('Identical replacement has no extra Undo',JSON.stringify((await state()).undo)===beforeNoop);
  await click('undo');check('Replacement undo restores all previous settings',JSON.stringify((await state()).current)===beforeReplace);
  await demo('manual');await add();await input('duration',1.5);
  await ok('Manual duration preserves fixed cut and total','crossfadeDesignState().current.duration===1.5&&document.querySelector("#crossfade-prototype .blend-window").textContent.includes("24.00s cut")&&document.querySelector("#crossfade-prototype footer").textContent.includes("1:12")');
  await input('duration',-1);await ok('Invalid duration rejected','crossfadeDesignState().current.duration===1.5&&crossfadeDesignState().status.includes("2–96 frames")');
  await click('protect');await input('protectJoin',true);await input('protectDuration',true);await click('inspect');await input('duration',1.25);
  await ok('Direct manual editing retains granular protection','crossfadeDesignState().current.duration===1.25&&crossfadeDesignState().current.protectDuration&&crossfadeDesignState().current.protectJoin');
  await click('release');await click('confirm-release');await ok('Duration release retains join rule','!crossfadeDesignState().current.protectDuration&&crossfadeDesignState().current.protectJoin');
  await click('batch');await input('duration',1.5);await input('existing','Replace unprotected');await click('skip-short');await click('apply-batch');await ok('Join protection permits unprotected duration edits','crossfadeDesignState().current.duration===1.5&&crossfadeDesignState().current.protectJoin');
  await click('remove');await ok('Remove returns to hard cut','!crossfadeDesignState().current.hasTransition&&!crossfadeDesignState().current.protectJoin');
  await demo('bulk');const beforeBatch=JSON.stringify((await state()).current);
  await ok('Bulk waits for shorter-duration decision','document.querySelector("#crossfade-prototype [data-act=apply-batch]").disabled');
  await click('inspect');check('Close batch leaves Current untouched',JSON.stringify((await state()).current)===beforeBatch);
  await click('batch');await input('scope','Selected images');await ok('Selection contains two internal joins','document.querySelectorAll("#crossfade-prototype .join-result").length===2');
  await input('scope','Time range');await ok('Range includes From and excludes To','document.querySelectorAll("#crossfade-prototype .join-result").length===2');
  await input('scope','All still images');await input('acceptShort',true);await click('apply-batch');
  await ok('Batch applies three additions and keeps protected opening','crossfadeDesignState().current.joinDurations.ab===.75&&crossfadeDesignState().current.joinDurations.bc===1&&crossfadeDesignState().current.joinDurations.de===.5&&crossfadeDesignState().current.joinDurations.ef===.5&&Object.keys(crossfadeDesignState().current.joinDurations).length===4');
  await click('undo');check('One Undo restores complete pre-batch state',JSON.stringify((await state()).current)===beforeBatch);
  await click('batch');await click('skip-short');await click('apply-batch');await ok('Skipping short joins applies only eligible full fade','Object.keys(crossfadeDesignState().current.joinDurations).length===2');
  await demo('arke');const beforeReview=JSON.stringify((await state()).current);
  await ok('Ready composite leaves Current active','!crossfadeDesignState().reviewed&&crossfadeDesignState().view==="current"&&!document.querySelector("#crossfade-prototype .review-bar")');
  await click('review');await ok('Explicit Review activates Suggested','crossfadeDesignState().reviewed&&crossfadeDesignState().view==="suggested"');
  await click('inspect');await input('duration',1.25);check('Pending adjustment leaves Current untouched',JSON.stringify((await state()).current)===beforeReview);
  await click('current');await ok('Current comparison disables edits','document.querySelector("#crossfade-prototype [data-act=open-picker]").disabled');
  await click('chat');await click('suggest');await ok('Incoming version preserves active version and Current comparison','crossfadeDesignState().incoming.duration===1.25&&crossfadeDesignState().version===1&&crossfadeDesignState().view==="current"');
  await click('review-new');await ok('Explicit new-version review retains manual edit','crossfadeDesignState().version===2&&crossfadeDesignState().proposal.duration===1.25&&crossfadeDesignState().adjusted');
  await click('batch');await ok('Separate batch cannot mutate Current during review','crossfadeDesignState().panel!=="batch"');
  await demo('stale');await ok('Stale Apply disabled','document.querySelector("#crossfade-prototype [data-act=apply]").disabled');
  await click('update');await ok('Update does not activate arriving version','crossfadeDesignState().stale&&crossfadeDesignState().version===2&&!!crossfadeDesignState().incoming');
  await click('review-new');await ok('Explicit review clears stale state','!crossfadeDesignState().stale&&crossfadeDesignState().version===3&&crossfadeDesignState().proposal.duration===1.25');
  await click('apply');check('Exact proposal applied',JSON.stringify((await state()).current)===JSON.stringify((await state()).proposal));await click('undo');check('One Undo restores pre-review Current',JSON.stringify((await state()).current)===beforeReview);
  await demo('manual');await add();await click('protect');await input('protectJoin',true);await input('protectDuration',true);await click('chat');await click('suggest');await click('review');await click('inspect');await click('release');await click('confirm-release');
  await ok('Release remains pending and blocks Apply','crossfadeDesignState().current.protectDuration&&!crossfadeDesignState().proposal.protectDuration&&crossfadeDesignState().proposal.protectJoin&&document.querySelector("#crossfade-prototype [data-act=apply]").disabled');
  await click('review-release');await click('apply');await ok('Reviewed release applies only named rule','!crossfadeDesignState().current.protectDuration&&crossfadeDesignState().current.protectJoin');
  await demo('arke');await click('review');await click('exclude');await ok('Keep Current removes one change from composite','!crossfadeDesignState().proposal.hasTransition&&document.querySelector("#crossfade-prototype .proposal-stats b").textContent==="2 changes"');
  await click('suggest');await click('review-new');await ok('Exclusion survives revision','!crossfadeDesignState().proposal.hasTransition&&!crossfadeDesignState().proposal.joinDurations.bc');
  await click('discard');await ok('Discard closes review without changing Current','!crossfadeDesignState().reviewed&&!crossfadeDesignState().proposal&&!crossfadeDesignState().current.hasTransition');
  await demo('arke');await click('review');await click('inspect');await input('duration',1.25);
  await send('Page.reload');await delay(400);await ok('Reload resumes pending adjustment','crossfadeDesignState().reviewed&&crossfadeDesignState().proposal.duration===1.25&&!crossfadeDesignState().current.hasTransition');
  await click('chat');
  for(const width of [984,390,320]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:1150,deviceScaleFactor:1,mobile:false});await delay(100);
    await ok(`Live ${width}px no horizontal overflow`,'document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector("#crossfade-prototype").scrollWidth<=document.querySelector("#crossfade-prototype").clientWidth+1');
    await ok(`Live ${width}px review actions inside frame`,'(()=>{const p=document.querySelector("#crossfade-prototype").getBoundingClientRect();return [...document.querySelectorAll("#crossfade-prototype .review-bar button")].every(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.right<=p.right+1&&b.left>=p.left-1;});})()');
    if(width<600)await ok(`Live ${width}px 44px touch controls`,'[...document.querySelectorAll("#crossfade-prototype .review-bar button")].every(e=>e.getBoundingClientRect().height>=44)');
    await capture('#crossfade-prototype',`prototype-${width}`);
    await click('inspect');await click('open-picker');
    await ok(`Live ${width}px picker fits with reachable choices`,'(()=>{const root=document.querySelector("#crossfade-prototype").getBoundingClientRect();const picker=[...document.querySelectorAll("#crossfade-prototype .transition-picker")].find(e=>e.getClientRects().length);const box=picker.getBoundingClientRect();const buttons=[...picker.querySelectorAll("button")];return box.left>=root.left-1&&box.right<=root.right+1&&buttons.every(b=>b.getBoundingClientRect().height>=36);})()');
    if(width<600)await ok(`Live ${width}px picker touch controls`,'[...document.querySelectorAll("#crossfade-prototype .mobile-picker button")].every(e=>e.getBoundingClientRect().height>=44)');
    await capture('#crossfade-prototype',`prototype-picker-${width}`);await click('close-picker');await click('chat');
  }
  await send('Emulation.setDeviceMetricsOverride',{width:1500,height:1150,deviceScaleFactor:1,mobile:false});await evaluate('document.documentElement.classList.add("dark")');await capture('#frame-219b .xf216','frame-219b-dark');await capture('#frame-216b .xf216','frame-216b-dark');
  check('No runtime exceptions',report.errors.length===0);
  console.log(`Crossfade design: ${report.frames.length} frames; ${report.checks.length} checks passed. Screenshots: ${out}`);
}finally{
  fs.writeFileSync(path.join(out,'render-report.json'),JSON.stringify(report,null,2));ws?.close();proc.kill();server.close();await delay(200);
  const resolved=path.resolve(profile);if(!resolved.startsWith(out+path.sep)||!path.basename(resolved).startsWith('chrome-'))throw Error('Unexpected temporary profile path');
  try{fs.rmSync(resolved,{recursive:true,force:true});}catch{}
}
