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
  const input=(key,value,time=false)=>evaluate(`(()=>{const e=document.querySelector('#live-stage [data-native-${time?'time':'key'}="${key}"]');if(!e||e.disabled)throw Error('Input unavailable');${typeof value==='boolean'?`e.checked=${value}`:`e.value=${JSON.stringify(value)}`};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const state=()=>evaluate('airNativeState()');
  await send('Page.enable');await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1500,height:1150,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url});
  for(let i=0;i<80;i++){if(await evaluate('typeof airNativeState==="function"&&document.querySelector("#live-stage [data-native-particles]")?.dataset.ready==="true"').catch(()=>false))break;await delay(150);}
  await evaluate('document.fonts.ready');
  await ok('38 drawings all use the existing shell','document.querySelectorAll(".frame-wrap .air220").length===38&&document.querySelectorAll(".frame-wrap .native220").length===38');
  await ok('No earlier alternative shell is left in the review','!document.querySelector(".legacy-frames,.air220 .workspace,.air220 .sections")');
  await ok('Images decoded','[...document.querySelectorAll("img")].every(i=>i.complete&&i.naturalWidth>0)');
  await ok('Geist loaded','[...document.fonts].some(f=>f.family.includes("Geist")&&f.status==="loaded")');
  await ok('Inspector and Arke are the only permanent Inspector tabs','[...document.querySelectorAll(".n-inspector-tabs")].every(e=>[...e.children].map(b=>b.textContent).join(",")==="Inspector,Arke")&&!document.querySelector(".native220 .sections")');
  await ok('All revised previews painted','[...document.querySelectorAll("[data-native-particles]")].every(e=>e.dataset.ready==="true")');
  for(const id of await evaluate('[...document.querySelectorAll("article[id^=frame-]")].map(e=>e.id)')){
    const measured=await evaluate(`(()=>{const e=document.querySelector('#${id} .native220'),p=e.querySelector('.n-inspector-scroll');return {id:${JSON.stringify(id)},width:e.clientWidth,height:e.clientHeight,overflow:e.scrollWidth-e.clientWidth,panelOverflow:p.scrollWidth-p.clientWidth,inspectorScroll:p.scrollTop};})()`);
    check(id+' fits the existing shell',measured.overflow<=1&&measured.panelOverflow<=1);report.frames.push(measured);await capture('#'+id+' .native220','revision3-'+id);
  }
  await demo('reset');const initial=JSON.stringify((await state()).values);
  await click('add-open');await input('target','Boat video · Picture');await input('start','00:00:12:12',true);await click('cancel');check('Cancel leaves the timeline untouched',JSON.stringify((await state()).values)===initial);
  await click('add-open');await input('start','00:00:12:12',true);await input('target','Boat video · Picture');check('Target leaves the chosen frame-precise interval intact',(await state()).draft.start===300);await click('add');
  await ok('Add selects effect and existing Inspector','airNativeState().values.added&&airNativeState().values.start===300&&airNativeState().values.end===1728&&!airNativeState().draft');
  await ok('Creation anchors animation and fades to its placed start','airNativeState().current.origin===300&&airNativeState().current.fadeStart===300&&airNativeState().current.fadeEnd===1728');
  await input('end','00:00:58:08',true);await ok('Trim retains fade envelope and simulation origin','airNativeState().current.end===1400&&airNativeState().current.fadeEnd===1728&&airNativeState().current.origin===300');await input('move','00:00:25:00',true);await ok('Move shifts origin and fade anchors with the interval','airNativeState().current.origin===600&&airNativeState().current.fadeStart===600&&airNativeState().current.fadeEnd===2028');await click('undo');await click('undo');
  await click('play');await delay(300);await evaluate('document.querySelector("#live-stage [data-native-ruler]").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))');await ok('Seeking pauses playback and updates every visible clock','!airNativeState().playing&&document.querySelector("#live-stage [data-native-act=play]").getAttribute("aria-label")==="Play preview"&&document.querySelector("#live-stage .n-view-time").textContent.startsWith(document.querySelector("#live-stage [data-native-clock]").textContent)');
  await demo('appearance');await input('size',80);await input('colour','#ffbb77');await ok('Appearance edits commit without target/range changes','airNativeState().values.size===80&&airNativeState().values.colour==="#ffbb77"&&airNativeState().values.target==="Boat video · Picture"&&airNativeState().values.start===300');
  await demo('motion');const seed=(await state()).values.seed;await click('pattern');check('New pattern changes its identity',(await state()).values.seed!==seed);await click('undo');check('Undo restores the exact pattern',(await state()).values.seed===seed);
  await input('start','00:00:12:24',true);check('Invalid 24fps timecode is rejected',(await state()).values.start===300);
  await evaluate('document.querySelector("[data-native-highlight]").click()');await ok('Review annotations can be hidden','!document.querySelector("#live-stage .show-additions")');
  await demo('appearance');await capture('#live-stage .native220','revision3-live-appearance');

  await demo('audio');await input('source','Boat video · sound');await input('reaction',true);await ok('Placed video sound can enable reaction','airNativeState().values.reaction&&airNativeState().values.source==="Boat video · sound"&&airNativeState().values.target==="Boat video · Picture"&&airNativeState().values.start===300');
  await input('beat',64);await ok('Advanced mapping changes label to Custom','airNativeState().values.response==="Custom"');await input('source','No audio source');await ok('Clearing source turns reaction Off','!airNativeState().values.reaction');
  await demo('protection');const protectedBefore=JSON.stringify((await state()).current);await click('release:blend');await ok('Current release names one rule only','!airNativeState().current.rules.some(r=>r.id==="blend")&&airNativeState().current.rules.some(r=>r.id==="pattern")');await click('undo');check('Undo restores Current rule',JSON.stringify((await state()).current)===protectedBefore);
  await demo('arke');const baseline=JSON.stringify((await state()).current);await ok('Ready chat card does not enter Suggested','airNativeState().flow.ready&&!airNativeState().flow.review&&!document.querySelector("#live-stage .n-review-bar")');
  await click('inspect');const panel=(await state()).panel,clock=(await state()).clock;await demo('receive');check('Incoming card preserves selected panel and clock',(await state()).panel===panel&&(await state()).clock===clock);await ok('Arrival does not activate a review','!airNativeState().flow.review');
  await demo('arke');await click('review');await ok('Only explicit Review activates Suggested','airNativeState().flow.review&&airNativeState().flow.comparison==="suggested"');
  await click('changes');await click('inspect-effect');await input('amount',72);check('Suggested edits leave Current untouched',JSON.stringify((await state()).current)===baseline);await ok('Manual adjustment is retained','airNativeState().candidate.amount===72&&airNativeState().flow.adjusted.includes("amount")');
  await demo('less-busy');await ok('Broad revision retains manual Amount and active candidate','airNativeState().flow.version===1&&airNativeState().candidate.amount===72&&airNativeState().flow.incoming.values.amount===72');
  await click('arke');await click('review-incoming');await ok('New version needs explicit Review','airNativeState().flow.version===2&&!airNativeState().flow.incoming&&airNativeState().candidate.amount===72');check('Review keeps common clock',(await state()).clock===clock);
  await click('changes');await click('keep:size');await demo('less-busy');await ok('Keep current survives the next revision','airNativeState().flow.kept.includes("size")&&airNativeState().flow.incoming.values.size===airNativeState().current.size');
  await click('review-incoming');await click('compare-current');await click('inspect');await ok('Current comparison is inspection only','document.querySelector("#live-stage [data-native-key=amount]").disabled');await click('compare-suggested');
  await click('changes');await click('proposal-release:blend');await ok('Release keeps Current and active candidate protected','airNativeState().current.rules.some(r=>r.id==="blend")&&airNativeState().candidate.rules.some(r=>r.id==="blend")&&!airNativeState().flow.incoming.values.rules.some(r=>r.id==="blend")');await ok('Pending release blocks old Apply until reviewed','airNativeState().flow.needsReview&&document.querySelector("#live-stage [data-native-act=apply]").disabled');
  await click('review-incoming');await ok('Reviewed release remains pending','airNativeState().current.rules.some(r=>r.id==="blend")&&!airNativeState().candidate.rules.some(r=>r.id==="blend")&&airNativeState().flow.releases.includes("blend")');
  await click('apply');await ok('Apply commits the exact settings and named release','!airNativeState().flow.review&&!airNativeState().current.rules.some(r=>r.id==="blend")&&airNativeState().current.rules.some(r=>r.id==="pattern")&&airNativeState().current.amount===72&&airNativeState().undo===1');await click('undo');check('One Undo restores original arrangement and rules',JSON.stringify((await state()).current)===baseline);
  await demo('arke');await click('review');await demo('appearance');await input('amount',73);await demo('stale');await ok('Current change removes Apply','airNativeState().flow.stale&&!document.querySelector("#live-stage [data-native-act=apply]")');await click('update');await ok('Update preserves sticky adjustment and active version','airNativeState().flow.stale&&airNativeState().flow.version===1&&airNativeState().flow.incoming.values.amount===73');await click('review-incoming');await ok('Fresh version requires and accepts explicit Review','!airNativeState().flow.stale&&airNativeState().flow.version===2&&airNativeState().candidate.amount===73');
  await click('close-review');await ok('Closing retains the pending adjustment','!airNativeState().flow.review&&airNativeState().candidate.amount===73');await click('arke');await click('review');await click('discard');await ok('Discard clears pending work, leaving Current','!airNativeState().flow.ready&&!airNativeState().candidate&&airNativeState().current.amount===65');
  await demo('overlay');await input('blend','Normal');await ok('Opaque Normal overlay is a clip, with its own finite duration','airNativeState().overlay&&airNativeState().values.end===190&&!document.querySelector("#live-stage .n-effect-clip")&&document.querySelector("#live-stage .n-overlay-lane")');await capture('#live-stage .native220','revision3-live-normal-overlay');
  await demo('reset');
  for(const width of [984,390,320]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:1150,deviceScaleFactor:1,mobile:false});await delay(250);await demo('appearance');
    await ok(`Live ${width}px has no horizontal overflow`,'document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector("#live-stage .native220").scrollWidth<=document.querySelector("#live-stage .native220").clientWidth+1');
    if(width<=390){await ok('Phone keeps Done outside the scrolling controls','(()=>{const r=document.querySelector("#live-stage .native220").getBoundingClientRect(),f=document.querySelector("#live-stage .n-sheet-foot").getBoundingClientRect();return f.height>40&&f.bottom<=r.bottom+1;})()');await click('close-sheet');await ok('Done returns to the timeline','!document.querySelector("#live-stage .n-inspector.is-open")');await click('library');await click('add-open');await ok('Phone uses the existing Add sheet','!!document.querySelector("#live-stage .n-dialog")');await click('cancel');await demo('appearance');}
    await capture('#live-stage',`prototype-revision3-${width}`);
    await demo('arke');await ok(`Arke ${width}px fits existing sheet or panel`,'document.querySelector("#live-stage .n-inspector").scrollWidth<=document.querySelector("#live-stage .n-inspector").clientWidth+1');await capture('#live-stage',`prototype-revision3-arke-${width}`);await click('review');await ok('Review closes Arke to the compact Inspector','!airNativeState().sheet&&airNativeState().panel==="inspector"');await ok(`Review ${width}px retains reachable bar`,'!!document.querySelector("#live-stage .n-review-bar")&&document.querySelector("#live-stage .n-review-bar").scrollWidth<=document.querySelector("#live-stage .n-review-bar").clientWidth+1');

  }

  await send('Emulation.setDeviceMetricsOverride',{width:1500,height:1150,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:url.replace('air-particles-220.review.html','design-review.html')});
  let indexReady=false;for(let i=0;i<240;i++){if(await evaluate('document.readyState!=="loading"&&!!document.getElementById("223j")?.querySelector(".native220")').catch(()=>false)){indexReady=true;break;}await delay(150);}
  if(!indexReady)throw Error('Review index did not load: '+JSON.stringify(await evaluate('({url:location.href,title:document.title,body:document.body?.innerText.slice(0,300)})')));await evaluate('document.fonts.ready');
  await ok('Review index retains scoped frame CSS','getComputedStyle(document.getElementById("221a").querySelector(".n-cutcols")).display==="grid"&&getComputedStyle(document.getElementById("221a").querySelector(".n-cutcols")).gridTemplateColumns.startsWith("286px")');
  await ok('Review index retains device widths','document.getElementById("220g").dataset.width==="390"&&document.getElementById("220i").dataset.width==="984"');
  await ok('Static before-start frame has no particles','getComputedStyle(document.getElementById("220c").querySelector("[data-native-particles]")).backgroundImage==="none"');
  await ok('Static Normal overlay retains opaque black','getComputedStyle(document.getElementById("222d").querySelector("[data-native-particles]")).mixBlendMode==="normal"&&getComputedStyle(document.getElementById("222d").querySelector("[data-native-particles]")).backgroundColor==="rgb(0, 0, 0)"');
  await ok('Static Add uses Add compositing','getComputedStyle(document.getElementById("222c").querySelector("[data-native-particles]")).mixBlendMode==="plus-lighter"');
  await capture('[id="221a"] .native220','revision3-index-221a');await capture('[id="220g"] .native220','revision3-index-220g');await capture('[id="222d"] .native220','revision3-index-222d');
  check('No runtime exceptions',report.errors.length===0);
  console.log(`Turns 220–223 revision 3: ${report.frames.length} drawings; ${report.checks.length} checks passed. Screenshots: ${out}`);
}finally{
  fs.writeFileSync(path.join(out,'render-report.json'),JSON.stringify(report,null,2));ws?.close();proc.kill();server.close();await delay(200);
  const resolved=path.resolve(profile);if(!resolved.startsWith(out+path.sep)||!path.basename(resolved).startsWith('chrome-'))throw Error('Unexpected temporary profile path');
  try{fs.rmSync(resolved,{recursive:true,force:true});}catch{}
}
