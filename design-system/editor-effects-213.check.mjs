// Render and exercise the isolated design, without installing/running Studio or analysing media.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const out=path.resolve(here,'../.dev/editor-effects-design');
fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(out,'chrome-'));
const chrome=process.env.CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe';
if(!fs.existsSync(chrome))throw Error('Set CHROME to a Chromium browser binary');
const port=9510+Math.floor(Math.random()*250);
const proc=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--allow-file-access-from-files',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
let ws;
const report={frames:[],checks:[],errors:[]};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try{
 let target;
 for(let i=0;i<80&&!target;i++){try{target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page')?.webSocketDebuggerUrl;}catch{}if(!target)await delay(200);}
 if(!target)throw Error('Browser did not expose a page');
 ws=new WebSocket(target);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 let id=0;const waiting=new Map();
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(m.id&&waiting.has(m.id)){const {r,j}=waiting.get(m.id);waiting.delete(m.id);m.error?j(Error(JSON.stringify(m.error))):r(m.result);}};
 const send=(method,params={})=>new Promise((r,j)=>{const n=++id;waiting.set(n,{r,j});ws.send(JSON.stringify({id:n,method,params}));});
 const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
 const check=(label,result)=>{report.checks.push({label,result});if(!result)throw Error('Design check failed: '+label);};
 await send('Page.enable');await send('Runtime.enable');
 await send('Emulation.setDeviceMetricsOverride',{width:1500,height:1150,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:pathToFileURL(path.join(here,'editor-effects-213.review.html')).href});
 for(let i=0;i<60;i++){if(await evaluate('typeof effectDesignState === "function"').catch(()=>false))break;await delay(150);}
 await evaluate('document.fonts.ready');
 await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 report.loaded=await evaluate('({url:location.href,ready:document.readyState,frames:document.querySelectorAll(".frame-grid .fx213").length,prototype:typeof effectDesignState,rootChildren:[...document.getElementById("effects-prototype").children].map(e=>e.tagName+"."+e.className),articles:document.querySelectorAll("article").length,footer:document.querySelector("[data-footer]")?.parentElement?.outerHTML.slice(0,300),lastBody:document.body.innerHTML.slice(-600)})');
 check('29 approved-design HTML frames',report.loaded.frames===29);
 check('Inspector and Arke are the only permanent tabs',await evaluate('[...document.querySelectorAll(".frame-grid .panel-tabs")].every(t=>t.children.length===2&&t.children[0].textContent==="Inspector"&&t.children[1].textContent==="Arke")'));
 check('New effect placement separates target/time and starts without audio',await evaluate('(()=>{const d=document.querySelector("#frame-213b .dialog");return !!d.querySelector("[data-key=addVisualTarget]")&&!!d.querySelector("[data-key=addRange]")&&d.textContent.includes("Audio reaction off");})()'));
 check('Granular protection exposes visual, appearance, motion and audio properties',await evaluate('(()=>{const p=document.querySelector("#frame-213d [data-panel]");return ["visualTarget","start","end","colour","amount","audioSource","beat","bass","energy","strength"].every(k=>p.querySelector("[data-protect="+k+"]"));})()'));
 check('Artwork decoded',await evaluate('[...document.querySelectorAll(".frame-grid img")].every(i=>i.complete&&i.naturalWidth>0)'));
 check('Geist faces loaded',await evaluate('[...document.fonts].some(f=>f.family.includes("Geist")&&f.status==="loaded")'));
 const frameIds=await evaluate('[...document.querySelectorAll(".frame-grid > article")].map(a=>a.id)');
 for(const frameId of frameIds){
  const measure=await evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(frameId)}).querySelector('.fx213');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {label:e.dataset.screenLabel,width:e.clientWidth,height:e.clientHeight,overflow:e.scrollWidth-e.clientWidth,x:r.x+scrollX,y:r.y+scrollY,w:r.width,h:r.height};})()`);
  check(frameId+' no horizontal overflow',measure.overflow<=1);
  const capture=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:Math.max(0,measure.x),y:Math.max(0,measure.y),width:measure.w,height:measure.h,scale:1}});
  fs.writeFileSync(path.join(out,frameId+'.png'),Buffer.from(capture.data,'base64'));report.frames.push(measure);
 }
 const click=act=>evaluate(`document.querySelector('#effects-prototype [data-act="${act}"]').click()`);
 const input=(key,value)=>evaluate(`(()=>{const e=document.querySelector('#effects-prototype [data-key="${key}"]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 const resetReview=async()=>{await evaluate('document.querySelector("[data-demo=reset]").click()');await click('review');await click('inspect');};
 await evaluate('document.querySelector("[data-demo=reset]").click()');
 check('Ready card does not activate Suggested or review bar',await evaluate('!effectDesignState().reviewing&&effectDesignState().view==="current"&&document.querySelector("#effects-prototype [data-review-shell]").hidden&&!!document.querySelector("#effects-prototype [data-proposal-card]")'));
 const entryTime=await evaluate('effectDesignState().time');await click('review');
 check('Explicit Review in timeline activates Suggested at same clock',await evaluate(`effectDesignState().reviewing&&effectDesignState().view==="suggested"&&effectDesignState().time===${entryTime}&&!document.querySelector("#effects-prototype [data-review-shell]").hidden&&effectDesignState().current.amount===35`));
 check('Composite card owns expandable changes in Arke',await evaluate('effectDesignState().panel==="chat"&&document.querySelector("#effects-prototype .panel-tabs [data-act=chat]").classList.contains("on")&&!!document.querySelector("#effects-prototype [data-proposal-card] [data-card-changes]")'));
 await click('current');await click('chat');const strengthBefore=await evaluate('effectDesignState().proposal.strength');await click('send');
 check('New revision preserves Current comparison and reviewed version',await evaluate(`effectDesignState().view==="current"&&effectDesignState().version===1&&effectDesignState().proposal.strength===${strengthBefore}&&effectDesignState().incoming.version===2&&effectDesignState().time===${entryTime}`));
 await click('changes');check('Review count returns to active composite card rather than adopting incoming version',await evaluate('effectDesignState().version===1&&effectDesignState().view==="current"&&document.querySelector("#effects-prototype .retained-card").open&&document.querySelector("#effects-prototype [data-card-role=active] .proposal-details").open'));
 await click('review-new');check('Explicit Review version activates that version only',await evaluate(`effectDesignState().version===2&&effectDesignState().view==="suggested"&&!effectDesignState().incoming&&effectDesignState().time===${entryTime}`));

 await resetReview();
 const at=await evaluate('effectDesignState().time');await click('current');check('Compare keeps playhead',await evaluate(`effectDesignState().time===${at}`));
 check('Current comparison disables proposal controls',await evaluate('document.querySelector("#effects-prototype [data-key=amount]").disabled'));
 await click('suggested');await input('amount',24);
 check('Manual edit changes pending proposal only',await evaluate('effectDesignState().proposal.amount===24&&effectDesignState().current.amount===35&&effectDesignState().adjusted'));
 await click('response');await input('response','Beat pulse');await click('advanced');await input('bass',45);
 check('Advanced edits mark Custom',await evaluate('effectDesignState().proposal.response==="Custom"&&effectDesignState().proposal.bass===45'));
 await click('react');check('Reaction off preserves atmosphere',await evaluate('!effectDesignState().proposal.react&&effectDesignState().proposal.amount===24'));await click('react');
 await click('preview-react');check('Temporary reaction override does not rewrite saved response',await evaluate('!effectDesignState().previewReaction&&effectDesignState().proposal.react'));await click('preview-react');
 await click('curve-reaction');await evaluate('document.querySelector(\'#effects-prototype [data-point="3"]\').dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true}))');
 check('Independent curve edit',await evaluate('effectDesignState().proposal.reactionPoints[3]===23&&effectDesignState().proposal.points[3]===12'));
 await click('inspect');await click('protect-settings');await click('save-protection');await click('chat');await click('send');
 check('Revised card does not replace manual adjustments automatically',await evaluate('effectDesignState().version===1&&effectDesignState().incoming.version===2&&effectDesignState().proposal.amount===24'));await click('review-new');
 check('Arke revision preserves manual amount and protection',await evaluate('effectDesignState().proposal.amount===24&&effectDesignState().proposal.protected&&effectDesignState().version===2&&effectDesignState().versions.length===1'));
 await evaluate('document.querySelector("[data-demo=resume]").click()');
 check('Resume retains pending edits and position',await evaluate('effectDesignState().proposal.amount===24&&effectDesignState().time===96'));
 await evaluate('document.querySelector("[data-demo=stale]").click()');
 check('Stale review replaces Apply with Update',await evaluate('effectDesignState().stale&&!!document.querySelector("#effects-prototype .review-bar [data-act=update]")&&!document.querySelector("#effects-prototype .review-bar [data-act=apply]")'));
 await click('update');check('Updated card waits for explicit review',await evaluate('effectDesignState().stale&&!!effectDesignState().incoming&&effectDesignState().version===2'));await click('review-new');check('Update retains compatible adjustments',await evaluate('!effectDesignState().stale&&effectDesignState().proposal.amount===24&&effectDesignState().reviewBase===effectDesignState().baseRevision'));
 await click('apply');check('Apply commits exact reviewed settings',await evaluate('effectDesignState().applied&&JSON.stringify(effectDesignState().current)===JSON.stringify(effectDesignState().proposal)'));
 await click('undo');check('One Undo restores previous arrangement',await evaluate('effectDesignState().current.amount===35&&!effectDesignState().current.embers'));
 await resetReview();await click('changes');await click('exclude');await click('keep-current');
 check('Exclude and Keep current revise proposal without applying',await evaluate('!effectDesignState().proposal.embers&&effectDesignState().proposal.amount===35&&effectDesignState().current.amount===35&&!effectDesignState().applied'));
 await click('discard');check('Discard retains current',await evaluate('effectDesignState().discarded&&effectDesignState().current.amount===35'));
 await resetReview();
 await click('changes');check('Review count opens composite details in Arke',await evaluate('effectDesignState().panel==="chat"&&document.querySelector("#effects-prototype .panel-tabs [data-act=chat]").classList.contains("on")'));
 await click('inspect-dust');check('Inspect effect provides Back to proposal',await evaluate('effectDesignState().panel==="appearance"&&!!document.querySelector("#effects-prototype [data-panel] [data-act=changes]")'));
 await click('changes');check('Back returns without leaving review',await evaluate('effectDesignState().panel==="chat"&&!effectDesignState().applied'));
 await click('inspect');await click('placement-settings');await input('visualTarget','Video track · Video 1');await input('start','0:20');await input('end','1:10');
 check('Visual target and interval can change without changing audio source',await evaluate('effectDesignState().proposal.visualTarget==="Video track · Video 1"&&effectDesignState().proposal.start==="0:20"&&effectDesignState().proposal.end==="1:10"&&effectDesignState().proposal.audioSource==="Audio track · Audio 1"'));
 await click('response');await click('sources');await click('source-4');
 check('Video sound source leaves target and time intact',await evaluate('effectDesignState().proposal.audioSource==="Video sound · Harbour boat.mp4"&&effectDesignState().proposal.visualTarget==="Video track · Video 1"&&effectDesignState().proposal.start==="0:20"&&effectDesignState().proposal.end==="1:10"'));
 await input('audioSource','Composition audio mix');check('Composition mix is an explicit source',await evaluate('effectDesignState().proposal.audioSource==="Composition audio mix"&&document.querySelector("#effects-prototype [data-source-status]").textContent.includes("mute and levels")'));
 await click('place');await input('addVisualTarget','Visual clip · Still 2');await input('addRange','Selected picture · 0:48–1:20');
 check('Placement dialog changes are pending until Add',await evaluate('effectDesignState().proposal.visualTarget==="Video track · Video 1"'));
 await click('add');check('Add saves independent clip target, chosen range and reaction off',await evaluate('effectDesignState().proposal.visualTarget==="Visual clip · Still 2"&&effectDesignState().proposal.start==="0:48"&&effectDesignState().proposal.end==="1:20"&&!effectDesignState().proposal.react&&effectDesignState().proposal.audioSource==="Choose audio…"'));
 await click('response');await click('react');check('Reaction requires explicit source before Apply',await evaluate('document.querySelector("#effects-prototype .review-bar [data-act=apply]").disabled'));
 await click('sources');await click('source-2');check('Choosing audio keeps clip target and effect interval',await evaluate('!document.querySelector("#effects-prototype .review-bar [data-act=apply]").disabled&&effectDesignState().proposal.visualTarget==="Visual clip · Still 2"&&effectDesignState().proposal.end==="1:20"'));
 await click('inspect');await click('protect-settings');await input('protectionRange','Whole effect');
 await evaluate('for(const key of ["audioSource","strength"]){const e=document.querySelector("#effects-prototype [data-protect="+key+"]");e.checked=true;e.dispatchEvent(new Event("input",{bubbles:true}));}');
 await click('save-protection');await click('response');await input('strength',47);await click('chat');await click('send');await click('review-new');
 check('Protected settings still allow direct human edits and survive AI revision',await evaluate('effectDesignState().proposal.strength===47&&effectDesignState().proposal.audioSource==="Audio track · Audio 1"&&effectDesignState().proposal.protections.some(p=>p.key==="strength"&&p.scope==="Whole effect")'));
 check('AI retains visual target and time independently',await evaluate('effectDesignState().proposal.visualTarget==="Visual clip · Still 2"&&effectDesignState().proposal.start==="0:48"&&effectDesignState().proposal.end==="1:20"'));
 await click('inspect');await click('protect-settings');await click('release-protection');check('Releasing one property retains other protection',await evaluate('!effectDesignState().proposal.protections.some(p=>p.key==="colour")&&effectDesignState().proposal.protections.some(p=>p.key==="audioSource")'));
 await evaluate('document.querySelector("[data-demo=reset]").click()');await click('suggest');await input('suggestAudioSource','Off · no audio source');await click('prepare');
 check('Preparing a card leaves Current and review entry untouched',await evaluate('effectDesignState().view==="current"&&!effectDesignState().reviewing&&document.querySelector("#effects-prototype [data-review-shell]").hidden'));
 check('AI suggestion can be prepared without audio',await evaluate('!effectDesignState().proposal.react&&effectDesignState().proposal.audioSource==="Choose audio…"&&effectDesignState().proposal.visualTarget==="Whole composition"'));
 await resetReview();await click('play');await delay(150);await click('play');
 const paused=await evaluate('effectDesignState().time');await delay(100);check('Paused particles retain their clock',await evaluate(`effectDesignState().time===${paused}`));await input('seek',110);check('Seek chooses exact time',await evaluate('effectDesignState().time===110'));
 for(const width of [984,390,320]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await delay(80);
  check(`Live prototype ${width}px no horizontal overflow`,await evaluate('document.documentElement.scrollWidth<=innerWidth+1&&document.getElementById("effects-prototype").scrollWidth<=document.getElementById("effects-prototype").clientWidth+1'));
  const bounds=await evaluate('(()=>{const e=document.querySelector("#effects-prototype .review-bar [data-act=apply]"),r=e.getBoundingClientRect(),p=document.getElementById("effects-prototype").getBoundingClientRect();return {buttonRight:r.right,rootRight:p.right,rootWidth:p.width,rootLeft:p.left,buttonWidth:r.width};})()');
  report.viewports??=[];report.viewports.push({width,...bounds});
  check(`Review actions visible at ${width}px`,bounds.buttonWidth>0&&bounds.buttonRight<=bounds.rootRight+1);
  if(width<600)check(`Touch targets at ${width}px`,await evaluate('[...document.querySelectorAll("#effects-prototype .review-bar button")].every(b=>b.getBoundingClientRect().height>=44)'));
  const r=await evaluate('(async()=>{const e=document.getElementById("effects-prototype");e.scrollIntoView({block:"start"});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const r=e.getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,w:r.width,h:r.height};})()');
  const capture=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:r.x,y:r.y,width:r.w,height:r.h,scale:1}});fs.writeFileSync(path.join(out,`prototype-${width}.png`),Buffer.from(capture.data,'base64'));
  if(width===320){const viewportCapture=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'prototype-320-viewport.png'),Buffer.from(viewportCapture.data,'base64'));}
 }
 await send('Emulation.setDeviceMetricsOverride',{width:1500,height:1150,deviceScaleFactor:1,mobile:false});await delay(80);
 await evaluate('document.documentElement.classList.add("dark")');
 const dark=await evaluate('(()=>{const e=document.getElementById("frame-215b").querySelector(".fx213");e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,w:r.width,h:r.height};})()');
 const capture=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:dark.x,y:dark.y,width:dark.w,height:dark.h,scale:1}});fs.writeFileSync(path.join(out,'frame-215b-dark.png'),Buffer.from(capture.data,'base64'));
 check('No runtime exceptions',report.errors.length===0);
 console.log(`Design review: ${report.frames.length} frames rendered; ${report.checks.length} checks passed. Screenshots: ${out}`);
}finally{
 fs.writeFileSync(path.join(out,'render-report.json'),JSON.stringify(report,null,2));
 ws?.close();proc.kill();await delay(200);
 // A known temporary profile beneath this check's output directory; never remove a user profile.
 const resolved=path.resolve(profile);if(!resolved.startsWith(out+path.sep)||!path.basename(resolved).startsWith('chrome-'))throw Error('Unexpected temporary profile path');
 try{fs.rmSync(resolved,{recursive:true,force:true});}catch{}
}
