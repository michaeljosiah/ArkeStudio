// Actual Cut/App/PageSheet with synthetic media metadata replies; no author world or provider.
// node --import tsx scripts/smoke-media-measurement.mjs [output-directory]
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cutLayoutFixture } from '../packages/client/test/cut-layout-fixture.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] ?? join(root, 'output/media-measurement-native'));
await mkdir(output, { recursive: true });
const seed = cutLayoutFixture(), p = seed.world.productions[0];
const id = p.selections.sh_12.acceptedTakeId, take = p.takes.find(t => t.id === id);
take.mediaHash = 'sha256:' + 'a'.repeat(64); delete p.takeMediaInfo[id];
const main = await readFile(join(root, 'packages/client/src/main.tsx'), 'utf8');
const styles = [...main.matchAll(/^import "([^"\n]+\.css)";/gm)].map(match => match[0]).join('\n');
await build({ stdin: { resolveDir: join(root, 'packages/client/src'), loader: 'tsx', contents: `
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {MemoryRouter} from 'react-router';
import {App} from './App';import {__setStateForTest,__setBridgeForTest,__applyEventForTest} from './lib/store';${styles}
const seed=${JSON.stringify(seed)};let renderer;window.sent=[];
window.mountMeasurement=async(dark=false,known=false)=>{renderer?.unmount();document.documentElement.classList.toggle('dark',dark);window.sent=[];
const s=structuredClone(seed),p=s.world.productions[0];if(known)p.takeMediaInfo[${JSON.stringify(id)}]={sourceHash:${JSON.stringify(take.mediaHash)},mediaInfo:{durationSec:12,hasAudio:true},probedAt:'2026-11-01T12:00:00.000Z'};
window.answerMeasurement=result=>{const m=window.sent.filter(m=>m.kind==='measure-production-media').at(-1);__applyEventForTest({type:'media.measured',at:'2026-11-01T12:00:00.000Z',worldId:m.worldId,requestId:m.requestId,result});};
__setBridgeForTest({platform:'test',appVersion:'measurement-fixture',connect(){},subscribe(){return()=>{}},send(raw){window.sent.push(JSON.parse(raw));},coordinatorHttpBase:()=>location.origin});__setStateForTest(s,{connection:'open'});
renderer=createRoot(document.getElementById('root'));flushSync(()=>renderer.render(<MemoryRouter initialEntries={['/w/'+s.world.meta.worldId+'/p/'+p.meta.id+'/cut']}><App/></MemoryRouter>));await new Promise(resolve=>setTimeout(resolve,150));await document.fonts.ready;};
` }, bundle: true, platform: 'browser', format: 'iife', define: { 'import.meta.env': '{}' }, external: ['/*.webp', '/*.png'], loader: { '.woff': 'file', '.woff2': 'file' }, outfile: join(output, 'view.js'),
  plugins: [{ name: 'url-assets', setup(builder) { builder.onResolve({ filter: /\?url$/ }, args => ({ path: createRequire(import.meta.url).resolve(args.path.slice(0, -4)), namespace: 'url-asset' })); builder.onLoad({ filter: /.*/, namespace: 'url-asset' }, args => ({ contents: JSON.stringify(args.path), loader: 'text' })); } }] });
await writeFile(join(output, 'index.html'), '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="view.css"><div id="root"></div><script src="view.js"></script>');
const server = createServer(async (req, res) => { try { const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1) || 'index.html'; const path = resolve(output, name); assert.ok(!relative(output, path).startsWith('..') && !isAbsolute(relative(output, path))); res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'application/octet-stream'); res.end(await readFile(path)); } catch { res.writeHead(404).end(); } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const chrome = process.env.ARKE_CHROME ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome'); await access(chrome);
const profile = await mkdtemp(join(tmpdir(), 'arke-measurement-native-'));
const child = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const until = async read => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { try { const value = await read(); if (value) return value; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('Native measurement fixture did not become ready'); };
let socket;
try {
  const port = await until(async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let seq = 0; const pending = new Map(); socket.onmessage = ({ data }) => { const result = JSON.parse(data), task = pending.get(result.id); if (task) { pending.delete(result.id); result.error ? task.reject(Error(JSON.stringify(result.error))) : task.resolve(result.result); } };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const js = async expression => { const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  await cdp('Page.enable'); await cdp('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port }); await until(() => js('typeof mountMeasurement === "function"'));
  const results=[];
  for(const dark of [false,true])for(const [name,width,height] of [['desktop',1360,820],['phone',390,844],['short',900,400]]) {
    await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    const select=async()=>{
      await js(`document.querySelector('button[aria-label="Close Chat"]')?.click();document.querySelector('[data-clip="cl_12"]').click()`);
      if(width<768)await js(`document.querySelector('.fy-cut-tools button:nth-child(3)').focus();document.querySelector('.fy-cut-tools button:nth-child(3)').click()`);
      await until(()=>js(`!!document.querySelector('.fy-source-measurement')`));
      await js(`document.querySelector('.fy-source-measurement').scrollIntoView({block:'center'})`);
    };
    const capture=async label=>{const picture=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(join(output,name+'-'+label+'-'+(dark?'dark':'light')+'.png'),Buffer.from(picture.data,'base64'));};
    await js(`mountMeasurement(${dark})`);await select();
    assert.equal(await js(`sent.filter(m=>m.kind==='measure-production-media').length`),0);
    const metrics=await js(`(()=>{const e=document.querySelector('.fy-source-measurement'),r=e.getBoundingClientRect(),b=e.querySelector('button').getBoundingClientRect(),d=e.closest('dialog'),body=d?.querySelector('.fy-page-sheet__body');return{width:e.clientWidth,scroll:e.scrollWidth,top:r.top,bottom:r.bottom,buttonHeight:b.height,dialog:d?{top:d.querySelector('header').getBoundingClientRect().top,bottom:d.querySelector('footer').getBoundingClientRect().bottom,body:body.clientHeight,scroll:body.scrollHeight}:null}})()`);
    assert.equal(metrics.width,metrics.scroll,name+': source panel fits horizontally');assert.ok(metrics.top>=0&&metrics.bottom<=height,name+': measurement control reachable');
    if(width<768){assert.ok(metrics.buttonHeight>=44);assert.ok(metrics.dialog.top>=0&&metrics.dialog.bottom<=height+1);assert.ok(metrics.dialog.body>80);}
    await capture('unknown');
    await js(`document.querySelector('.fy-source-measurement button').focus();document.querySelector('.fy-source-measurement button').click();document.querySelector('.fy-source-measurement button').click()`);
    assert.equal(await js(`sent.filter(m=>m.kind==='measure-production-media').length`),1);
    assert.equal(await js(`document.querySelector('.fy-source-measurement button').disabled`),true);await capture('pending');
    await js(`answerMeasurement({status:'failed',reason:'probe-failed'})`);await until(()=>js(`document.querySelector('.fy-source-measurement').textContent.includes('Try again')`));await capture('failed');
    await js(`document.querySelector('.fy-source-measurement button').click();answerMeasurement({status:'measured',info:{durationSec:12,hasAudio:true}})`);
    await until(()=>js(`document.querySelector('.fy-source-measurement').textContent.includes('12.0 seconds')`));await capture('success');
    assert.ok(await js(`!sent.some(m=>/dispatch|generate|enqueue|timeline-command/.test(m.kind))`));
    if(width<768){
      for(let tab=0;tab<8;tab++){await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});assert.ok(await js(`document.activeElement===document.body||document.querySelector('.fy-cut-trim-sheet').contains(document.activeElement)`));}
      await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await until(()=>js(`!document.querySelector('.fy-cut-trim-sheet[open]')`));
      assert.equal(await js(`document.activeElement.closest('.fy-cut-tools')!==null`),true,'focus returns to existing Trim opener');
    }
    await js(`mountMeasurement(${dark},true);document.querySelector('[data-clip="cl_12"]').click()`);
    assert.equal(await js(`document.querySelectorAll('.fy-source-measurement').length`),0,'measured media has no standing recovery control');
    results.push({name,dark,...metrics});
  }
  await writeFile(join(output,'measurements.json'),JSON.stringify(results,null,2));console.log(`${results.length} actual Cut/App cases passed: conditional controls, retry/success, local commands only, phone targets and existing sheet focus. ${output}`);
} finally { socket?.close(); child.kill(); await new Promise(resolve=>server.close(resolve)); }
