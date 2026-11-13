// Approved turn 282: actual overview and receipt sheet, synthetic data, no provider work.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_STATE } from '../packages/client/test/fixture-state.ts';
import { productionSpend } from '../packages/coordinator/src/spend/rollups.ts';
import { buildClientPage, clientStyles, servePage } from './lib/client-page.mjs';
import { openChrome, until } from './lib/chrome.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)), output=resolve(root,'output/story-spend-native-282');
await mkdir(output,{recursive:true});
const state=structuredClone(FIXTURE_STATE), world=state.world, p=world.productions[0];
p.meta={...p.meta,title:'The Undersong',medium:'story',kind:'novel',format:'story'};
p.scenes=[];p.takes=[];p.selections={};
p.chapters=[{id:'first',file:'01-first',title:'The bell beneath the water',order:1,version:1,status:'draft',words:0}];
world.productions=[p];world.artifacts=[];
const jobs=[['narration',4320000],['illustration',500000],['missing',null]].map(([kind,amount],index)=>({id:'jb_sample'+index,worldId:world.meta.worldId,productionId:p.meta.id,
 target:kind==='illustration'?{kind:'bench-take',id:'session/picture'}:{kind:'voice-preview',id:'narrator'},capability:kind==='illustration'?'image':'voice-tts',provider:'fal',model:kind==='illustration'?'Image model':'Voice model',
 params:kind==='illustration'?{chapterSpend:{productionId:p.meta.id,chapterId:'first'}}:{purpose:'audiobook',chapterId:'first'},status:amount===null?'failed':'succeeded',estimatedMicroUsd:amount??0}));
const ledger=jobs.slice(0,2).map(job=>({ts:'2026-11-13T00:00:00.000Z',worldId:world.meta.worldId,productionId:p.meta.id,jobId:job.id,provider:job.provider,model:job.model,outcome:'succeeded',estimatedMicroUsd:job.estimatedMicroUsd,actualMicroUsd:job.estimatedMicroUsd,actualSource:'provider-reported'}));
state.productionSpend=productionSpend(world,{jobs,ledger,bench:[],chapters:[],ledgerUnavailable:false,historyUnavailable:false,benchIncomplete:false});
assert.equal(state.productionSpend.productions[p.meta.id].total.spentMicroUsd,4820000);
await buildClientPage(output,`
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {MemoryRouter} from 'react-router';
import {App} from './App';import {__setStateForTest,__setBridgeForTest} from './lib/store';${await clientStyles()}
const seed=${JSON.stringify(state)};let renderer;window.sent=[];
window.mountSpend=async(mode='partial',dark=false)=>{renderer?.unmount();document.documentElement.classList.toggle('dark',dark);window.sent=[];
 const s=structuredClone(seed),p=s.world.productions[0],r=s.productionSpend.productions[p.meta.id];
 if(mode==='empty'){r.receipts=[];r.total={...r.total,spentMicroUsd:0,coverage:'empty',sources:[],problems:[]};}
 if(mode==='unavailable'){r.total={...r.total,spentMicroUsd:null,coverage:'unavailable',problems:['ledger-unreadable']};}
 if(mode==='local'){r.receipts=[];r.total={...r.total,spentMicroUsd:0,coverage:'complete',localRuns:1,sources:[{source:'local-zero',entries:1,microUsd:0}],problems:[]};}
 __setBridgeForTest({platform:'test',appVersion:'spend-fixture',connect(){},subscribe(){return()=>{}},send(raw){window.sent.push(JSON.parse(raw))},coordinatorHttpBase:()=>location.origin});
 __setStateForTest(s,{connection:'open'});renderer=createRoot(document.getElementById('root'));
 flushSync(()=>renderer.render(<MemoryRouter initialEntries={['/w/'+s.world.meta.worldId+'/p/'+p.meta.id]}><App/></MemoryRouter>));await document.fonts.ready;
};`);
const page=await servePage(output), browser=await openChrome();
try {
 const {cdp,evaluate:js}=browser;await cdp('Page.enable');await cdp('Page.navigate',{url:page.origin});await until(()=>js('typeof mountSpend === "function"'));
 const results=[];
 for(const dark of [false,true]) for(const [name,width,height,mode] of [['desktop',1360,820,'partial'],['phone',390,844,'partial'],['fold',720,750,'partial'],['short',900,400,'partial'],['empty',390,844,'empty'],['unavailable',390,844,'unavailable'],['local',390,844,'local']]) {
  await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await js(`mountSpend(${JSON.stringify(mode)},${dark})`);await until(()=>js('!!document.querySelector(".fy-spend-summary button")'));
  await js('document.querySelector(".fy-spend-summary").scrollIntoView({block:"center"})');
  const overview=await js(`(()=>{const r=document.querySelector('.fy-spend-summary'),b=r.getBoundingClientRect();return {text:r.textContent,fit:r.scrollWidth<=r.clientWidth&&b.left>=0&&b.right<=innerWidth,description:document.querySelector('.fy-spend-description').textContent,clips:!!r.querySelector('.fy-spend-counts')}})()`);
  assert.equal(overview.fit,true,JSON.stringify({name,overview}));assert.equal(overview.clips,false);assert.match(overview.description,/Writing costs are not included/);
  if(mode==='empty')assert.match(overview.text,/\$0.00.*No audio or picture work yet/s);
  if(mode==='unavailable')assert.doesNotMatch(overview.text,/\$0.00/);
  if(mode==='local')assert.match(overview.text,/Unmetered.*1 local run/s);
  const shot=async suffix=>{const {data}=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(join(output,`${name}-${dark?'dark':'light'}-${suffix}.png`),Buffer.from(data,'base64'));};
  await shot('overview');
  await js('document.querySelector(".fy-spend-summary button").focus();document.querySelector(".fy-spend-summary button").click()');await until(()=>js('!!document.querySelector("dialog.fy-production-spend[open]")'));
  const detail=await js(`(()=>{const d=document.querySelector('dialog.fy-production-spend[open]'),b=d.getBoundingClientRect(),body=d.querySelector('.fy-page-sheet__body');return {text:d.textContent,selects:d.querySelectorAll('select').length,counts:d.querySelectorAll('.fy-spend-counts').length,fit:d.scrollWidth<=d.clientWidth&&b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight,scrolls:body.scrollHeight>body.clientHeight}})()`);
  assert.equal(detail.selects,0);assert.equal(detail.counts,0);assert.equal(detail.fit,true,JSON.stringify({name,detail}));
  if(mode==='partial'){assert.match(detail.text,/Chapter 1 · Narration/);assert.match(detail.text,/Chapter 1 · Illustration/);assert.match(detail.text,/Unavailable/);}
  await shot('details');
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await until(()=>js('!document.querySelector("dialog.fy-production-spend[open]")'));
  assert.equal(await js('document.activeElement===document.querySelector(".fy-spend-summary button")'),true);
  await js('document.querySelector(".fy-spend-summary button").click()');await until(()=>js('!!document.querySelector("dialog.fy-production-spend[open]")'));
  if(mode==='partial'||mode==='unavailable') {await js('window.sent=[];[...document.querySelectorAll("dialog.fy-production-spend button")].find(b=>b.textContent.includes("Read history again")).click()');assert.deepEqual(await js('sent.map(x=>x.kind)'),['production-spend-refresh']);}
  results.push({name,dark,mode,fit:true,focusReturned:true,scrolls:detail.scrolls});
 }
 await writeFile(join(output,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
} finally {await browser.close();await page.close();}
