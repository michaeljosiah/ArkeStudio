import assert from "node:assert/strict";
import { build } from "esbuild";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";

// Turn 240 in the application's global-chat composition, not an isolated Inspector.
const root = fileURLToPath(new URL("../", import.meta.url));
const value = flag => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined;
const baseline = value("--baseline");
const dir = value("--output") ?? await mkdtemp(join(tmpdir(), "arke-story-layout-"));
await mkdir(dir, { recursive: true });
const main = await readFile(join(root, "packages/client/src/main.tsx"), "utf8");
const styles = [...main.matchAll(/^import "([^"]+\.css)";/gm)].map(match => match[0]).join("\n");
await build({
  stdin: { resolveDir: join(root, "packages/client/src"), loader: "tsx", contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {MemoryRouter} from 'react-router';
import {App} from './App';
import {__setBridgeForTest,__setStateForTest} from './lib/store';
import {FIXTURE_STATE} from '../test/fixture-state';
${styles}
let renderer;
window.mountStory=async(mode='facts',dark=false)=>{
 renderer?.unmount();document.documentElement.classList.toggle('dark',dark);
 const state=structuredClone(FIXTURE_STATE), world=state.world;
 const labels=['Imani Okoro','Dev Malik','Lin Wei','Ana Lucía Reyes','Elsie Ward','Tomas Vale','Submitted account'];
 const facts=labels.map((label,i)=>({id:'fact-'+i,label,type:'enum',values:i===6?['Undecided','Full recording']:['Alive','Lost'],default:i===6?'Undecided':'Alive'}));
 const count=mode==='two'?2:mode==='three'?3:mode==='five'?5:1;
 const labelsByCount={1:['Continue to the next scene'],2:['Return with Ana for Elsie','Seal the shaft and leave Elsie'],3:['Power the clinic bulkhead','Power communications','Use Elsie’s route and Tomas’s rigging to isolate both wings'],5:['Stay at the outside release myself','Accept Dev’s offer to hold the release','Accept Tomas’s offer to hold the release','Accept Ana’s offer to hold the release','Return to help the remaining miners']};
 const scenes=[{id:'sc_start',number:1,slug:'start',title:'The launch collar',status:'draft',version:1,shots:[],script:{version:1,blocks:[{id:'blk_start',kind:'action',text:'The crew waits for your decision.'}]}},...Array.from({length:count},(_,i)=>({id:'sc_end-'+i,number:i+2,slug:'end-'+i,title:'Outcome '+(i+1),status:'draft',version:1,shots:[]}))];
 scenes[0].shots=[{id:'sh_start',number:1,title:'Decision',description:'Text-only fixture',covers:[{blockId:'blk_start',textDigest:'sha256:'+'0'.repeat(64)}]}];
 const routing={schemaVersion:2,version:1,start:'sc_start',facts,choices:scenes.slice(1).map((scene,i)=>({id:'ch_'+i,from:'sc_start',to:scene.id,label:labelsByCount[count][i]})),endings:scenes.slice(1).map(scene=>({sceneId:scene.id,title:scene.title})),excluded:[],groups:[]};
 const production={...world.productions[0],meta:{...world.productions[0].meta,id:'first-contact',title:'First Contact',kind:'visual-novel',medium:'video'},scenes,sceneFiles:Object.fromEntries(scenes.map(s=>[s.id,s.slug])),routing,takes:[],selections:{}};
 state.world={...world,meta:{...world.meta,name:'The Red Quiet'},productions:[production]};
 const bridge={platform:'test',appVersion:'layout-fixture',connect(){},subscribe(){return()=>{}},send(){},coordinatorHttpBase:()=>location.origin};
 __setBridgeForTest(bridge);__setStateForTest(state,{connection:'closed'});
 renderer=createRoot(document.getElementById('root'));flushSync(()=>renderer.render(<MemoryRouter initialEntries={['/w/'+world.meta.worldId+'/p/first-contact/branch-map']}><App/></MemoryRouter>));
 await new Promise(r=>setTimeout(r,350));await document.fonts.ready;
 const button=[...document.querySelectorAll('button')].find(b=>b.textContent.includes(mode==='facts'?'Story facts ·':'Preview'));
 button.click();await new Promise(r=>setTimeout(r,350));
 if(mode!=='facts'){const player=document.querySelector('.bm-player');for(let i=0;i<2;i++)player.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await new Promise(r=>setTimeout(r,450));}
};
window.storyMetrics=()=>{
 const box=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
 const inspector=document.querySelector('.story-facts-inspector');
 const body=inspector?.querySelector('.bm-insp__body');
 const choices=document.querySelector('.aip-choices');
 return {viewport:[innerWidth,innerHeight],globalChat:document.body.dataset.globalChatEnabled,inspector:inspector&&box(inspector),body:body&&box(body),facts:[...document.querySelectorAll('.story-fact-row')].map(box),chat:[...document.querySelectorAll('.bm-side .fy-global-chat-slot')].map(e=>({display:getComputedStyle(e).display,...box(e)})),choices:choices&&box(choices),options:[...document.querySelectorAll('.aip-choice')].map(e=>({label:e.querySelector('.l').textContent,labelOverflow:e.querySelector('.l').scrollWidth>e.querySelector('.l').clientWidth+1,...box(e)})),overflow:document.documentElement.scrollWidth>innerWidth};
};
` }, bundle: true, platform: "browser", format: "iife", define: { "import.meta.env": "{}" }, external: ["/*.webp", "/*.png"],
  loader: { ".woff": "file", ".woff2": "file" }, outfile: join(dir, "view.js"),
  plugins: [{name:"url-assets",setup(builder){builder.onResolve({filter:/\?url$/},args=>({path:createRequire(import.meta.url).resolve(args.path.slice(0,-4)),namespace:"url-asset"}));builder.onLoad({filter:/.*/,namespace:"url-asset"},async({path})=>({contents:await readFile(path),loader:"file"}));}}, ...(baseline ? [{ name: "baseline-style", setup(builder) { builder.onLoad({ filter: /(?:story-controls\.css|branch-map\.css|interactive-player\.js)$/ }, ({path}) => ({ loader: path.endsWith('.css')?'css':'js', resolveDir: dirname(path), contents: execFileSync("git", ["show", baseline + ":" + relative(root,path).replaceAll("\\","/")], {cwd:root,encoding:"utf8"}) })); } }] : [])],
});
await writeFile(join(dir,"index.html"),'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="view.css"><div id="root"></div><script src="view.js"></script>');
const server=createServer(async(req,res)=>{try{const name=decodeURIComponent(new URL(req.url,"http://localhost").pathname).slice(1)||'index.html';const path=join(dir,name);assert.ok(!relative(dir,path).startsWith('..')&&!isAbsolute(relative(dir,path)));res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const chrome=process.env.ARKE_CHROME??(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/google-chrome');await access(chrome);
const profile=await mkdtemp(join(tmpdir(),'arke-story-browser-'));
const child=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
let socket;
const wait=()=>new Promise(resolve=>setTimeout(resolve,100));
const until=async read=>{const deadline=Date.now()+20000;while(Date.now()<deadline){try{const result=await read();if(result)return result;}catch{}await wait();}throw Error('Browser fixture did not become ready');};
try{
 const port=await until(async()=>(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);
 const targets=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 let seq=0;const pending=new Map();socket.onmessage=({data})=>{const result=JSON.parse(data),task=pending.get(result.id);if(task){pending.delete(result.id);result.error?task.reject(Error(JSON.stringify(result.error))):task.resolve(result.result);}};
 const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 const js=async expression=>{const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
 await cdp('Page.enable');await cdp('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});await until(()=>js('typeof mountStory === "function"'));
 const records=[];
 for(const dark of [false,true])for(const [viewport,width,height] of [['desktop',1360,850],['window',1200,792],['tablet',820,900],['phone',390,844]]){
  const name=viewport+(dark?'-dark':'');
  await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  for(const mode of ['facts','one','two','three','five']){
   await js('mountStory('+JSON.stringify(mode)+','+dark+')');const metrics=await js('storyMetrics()');records.push({name,mode,...metrics});
   const {data}=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(dir,name+'-'+mode+'.png'),Buffer.from(data,'base64'));
   await writeFile(join(dir,'measurements.json'),JSON.stringify(records,null,2));
   if(mode==='facts'){
    assert.equal(metrics.globalChat,'true');assert.equal(metrics.facts.length,7);
    if(!baseline){assert.ok(metrics.body.height>(width>=1100?250:120),name+': fact list has usable height');assert.ok(metrics.facts[0].y>=metrics.body.y-1&&metrics.facts[0].bottom<=metrics.body.bottom+1,name+': first fact visible');}
   }else{
    const count={one:1,two:2,three:3,five:5}[mode];assert.equal(metrics.options.length,count,name+': all authored alternatives rendered');
    if(!baseline){assert.ok(metrics.choices.height>40,name+': choices have usable height');assert.ok(metrics.options.every(option=>option.width>0&&option.height>=44),name+': options have usable targets');assert.ok(metrics.options.every(option=>option.x>=metrics.choices.x-1&&option.right<=metrics.choices.right+1&&!option.labelOverflow),name+': complete labels remain within the choice list');
     assert.ok(metrics.options.filter(option=>option.y>=metrics.choices.y-1&&option.bottom<=metrics.choices.bottom+1).length>=Math.min(count,2),name+': multiple alternatives visible together');
     await js('document.querySelector(".aip-choice:last-child").scrollIntoView({block:"nearest"})');const scrolled=await js('storyMetrics()');assert.ok(scrolled.options.at(-1).y>=scrolled.choices.y-1&&scrolled.options.at(-1).bottom<=scrolled.choices.bottom+1,name+': final alternative reachable');
     if(count>1){await js('document.querySelector(".bm-player").dispatchEvent(new KeyboardEvent("keydown",{key:"2",bubbles:true}))');assert.ok(await js('document.querySelector(".bm-player").textContent.includes("Outcome 2")'),name+': second option takes its own route');}
    }
   }
  }
 }
 console.log(JSON.stringify({output:dir,cases:records.length,baseline:baseline??null}));
}finally{socket?.close();child.kill();await new Promise(resolve=>server.close(resolve));}
