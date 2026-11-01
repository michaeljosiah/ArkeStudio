// Actual App/Settings/PageSheet in an owned browser, with synthetic prompt evidence.
// node --import tsx scripts/smoke-prompt-tools.mjs [output-directory]
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_STATE } from '../packages/client/test/fixture-state.ts';
import { orderedShots } from '../packages/contracts/src/index.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] ?? join(root, 'output/prompt-tools-native'));
await mkdir(output, { recursive: true });
const state = structuredClone(FIXTURE_STATE), world = state.world, production = world.productions[0];
production.meta.medium = 'video'; production.meta.kind = 'film'; production.meta.format = 'video';
production.scenes = [{ id: 'sc_1', number: 1, slug: 'tide', title: 'The tide', status: 'draft', version: 21,
 shots: [{ id: 'sh_12', number: 12, title: 'Maren at the rail', description: 'Maren holds the folded signal by the harbour rail.', durationSec: 6,
 promptOverride: { text: 'Maren stands at the harbour rail, holding the folded signal. Her plain oilskin coat catches the grey dawn light. The harbour lies behind her.', capability: 'image', sheetVersions: { 'maren-kest': 4 } } }] }];
production.sceneFiles = { sc_1: '001-tide' }; production.takes = []; production.selections = {};
const scene = production.scenes[0], shot = orderedShots(scene)[0], target = { productionId: production.meta.id, sceneId: scene.id, shotId: shot.id, capability: 'image' };
const hash = 'sha256:' + 'a'.repeat(64), at = '2026-11-01T12:00:00.000Z';
const history = { target, currentVersion: 21, currentHash: hash, assembledBody: 'Today’s sources assemble the shot by the harbour.', assembledHash: hash,
 currentBody: shot.promptOverride.text, currentOverride: shot.promptOverride, partial: true, entries: [
 { version: 21, hash, prompt: shot.promptOverride, unavailable: false },
 { version: 19, hash, prompt: { text: 'Close on the folded signal in Maren’s hands. Her plain oilskin coat fills the edge of the frame. The harbour stays soft behind her.', capability: 'image', sheetVersions: { 'maren-kest': 3 } }, unavailable: false },
 { version: 17, unavailable: true }, { version: 16, hash, prompt: null, unavailable: false }] };
const inspection = { source: 'saved-shot', identity: 'Shot 12 · scene v21', capability: 'image', provider: 'fal', model: 'Image model', quantity: 1,
 prompt: 'Image 1: Maren Kest — identity and appearance.\nImage 2: The Vigil — harbour setting.\n\n' + history.currentBody + '\n\nDo not render captions or subtitles.',
 controls: [{ label: 'Aspect', value: '16:9' }, { label: 'Size', value: '1536 × 864' }], references: [
 { field: 'Images', index: 1, subject: 'Maren Kest', role: 'Identity and appearance', file: 'references/maren-kest/main-photo.png', hash, sheetVersion: 4, sent: true },
 { field: 'Images', index: 2, subject: 'The Vigil', role: 'Harbour setting', file: 'references/the-vigil/harbour-wide.png', hash, sheetVersion: 7, sent: true }],
 notices: ['Prepared preview only. Generate compiles again from its then-current inputs.', 'The full compiler prompt is shown. Separate layers are unavailable on this route.'] };
const main = await readFile(join(root, 'packages/client/src/main.tsx'), 'utf8');
const styles = [...main.matchAll(/^import "([^"\n]+\.css)";/gm)].map(match => match[0]).join('\n');
await build({ stdin: { resolveDir: join(root, 'packages/client/src'), loader: 'tsx', contents: `
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {MemoryRouter} from 'react-router';
import {App} from './App';import {__setStateForTest,__setBridgeForTest,__applyEventForTest} from './lib/store';${styles}
const seed=${JSON.stringify(state)}, history=${JSON.stringify(history)}, inspection=${JSON.stringify(inspection)};let renderer;window.sent=[];
window.mountPrompts=async(page='shot',enabled=true,dark=false)=>{renderer?.unmount();document.documentElement.classList.toggle('dark',dark);window.sent=[];
const s=structuredClone(seed),p=s.world.productions[0];s.app.promptTools=enabled;
const reply=(request,result)=>__applyEventForTest({type:'prompt-tools.result',at:${JSON.stringify(at)},worldId:s.world.meta.worldId,requestId:request.requestId,result});
__setBridgeForTest({platform:'test',appVersion:'prompt-fixture',connect(){},subscribe(){return()=>{}},send(raw){const m=JSON.parse(raw);window.sent.push(m);queueMicrotask(()=>{
if(m.kind==='set-prompt-tools')__applyEventForTest({type:'prompt-tools.changed',at:${JSON.stringify(at)},enabled:m.enabled});
if(m.kind==='prompt-history-read')reply(m,{kind:'history',history});
if(m.kind==='prompt-request-inspect')reply(m,{kind:'inspection',inspection});
if(m.kind==='prompt-history-restore')reply(m,{kind:'failed',reason:'The scene changed. Read the current prompt again before restoring.'});
});},coordinatorHttpBase:()=>location.origin});__setStateForTest(s,{connection:'open'});
renderer=createRoot(document.getElementById('root'));const path=page==='settings'?'/settings/general':'/w/'+s.world.meta.worldId+'/p/'+p.meta.id+'/scenes/sc_1/shots/sh_12';
flushSync(()=>renderer.render(<MemoryRouter initialEntries={[path]}><App/></MemoryRouter>));await new Promise(resolve=>setTimeout(resolve,100));await document.fonts.ready;};
` }, bundle: true, platform: 'browser', format: 'iife', define: { 'import.meta.env': '{}' }, external: ['/*.webp', '/*.png'], loader: { '.woff': 'file', '.woff2': 'file' }, outfile: join(output, 'view.js'),
  plugins: [{ name: 'url-assets', setup(builder) { builder.onResolve({ filter: /\?url$/ }, args => ({ path: createRequire(import.meta.url).resolve(args.path.slice(0, -4)), namespace: 'url-asset' })); builder.onLoad({ filter: /.*/, namespace: 'url-asset' }, args => ({ contents: JSON.stringify(args.path), loader: 'text' })); } }] });
await writeFile(join(output, 'index.html'), '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="view.css"><div id="root"></div><script src="view.js"></script>');
const server = createServer(async (req, res) => { try { const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1) || 'index.html'; const path = resolve(output, name); assert.ok(!relative(output, path).startsWith('..') && !isAbsolute(relative(output, path))); res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'application/octet-stream'); res.end(await readFile(path)); } catch { res.writeHead(404).end(); } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const chrome = process.env.ARKE_CHROME ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome'); await access(chrome);
const profile = await mkdtemp(join(tmpdir(), 'arke-prompts-native-'));
const child = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const until = async read => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { try { const value = await read(); if (value) return value; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('Native spend fixture did not become ready'); };
let socket;
try {
  const port = await until(async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let seq = 0; const pending = new Map(); socket.onmessage = ({ data }) => { const result = JSON.parse(data), task = pending.get(result.id); if (task) { pending.delete(result.id); result.error ? task.reject(Error(JSON.stringify(result.error))) : task.resolve(result.result); } };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const js = async expression => { const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  await cdp('Page.enable'); await cdp('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port }); await until(() => js('typeof mountPrompts === "function"'));
  const results = [];
  for (const dark of [false, true]) for (const [name,width,height] of [['desktop',1360,820],['phone',390,844],['short',900,400]]) {
    await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await js(`mountPrompts('settings',false,${dark})`);
    await js(`document.querySelector('button[aria-label="Close Chat"]')?.click()`);
    const label = `document.querySelector('.fy-prompt-pref input')`;
    await until(()=>js(`!!${label}`));
    assert.equal(await js(`${label}.checked`),false);
    await js(`${label}.scrollIntoView({block:'center'})`);
    let picture=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(join(output,name+'-settings-'+(dark?'dark':'light')+'.png'),Buffer.from(picture.data,'base64'));
    await js(`${label}.click()`);await until(()=>js(`${label}.checked`));
    assert.ok(await js(`sent.some(m=>m.kind==='set-prompt-tools'&&m.enabled)`));
    await js(`mountPrompts('shot',false,${dark})`);
    assert.equal(await js(`document.querySelectorAll('.fy-prompt-tools').length`),0);
    await js(`mountPrompts('shot',true,${dark})`);
    await js(`document.querySelector('button[aria-label="Close Chat"]')?.click()`);
    for (const mode of ['history','inspection']) {
      const opener=mode==='history'?'History':'Inspect request';
      await js(`(()=>{const b=[...document.querySelectorAll('.fy-prompt-tools button')].find(b=>b.textContent==='${opener}');b.focus();b.click();})()`);
      await until(()=>js(`!!document.querySelector('.fy-prompt-sheet[open]')&&!document.querySelector('.fy-prompt-sheet [role="status"]')`));
      const metrics=await js(`(()=>{const d=document.querySelector('.fy-prompt-sheet'),b=d.querySelector('.fy-page-sheet__body'),h=d.querySelector('header').getBoundingClientRect(),f=d.querySelector('footer').getBoundingClientRect();return {width:d.clientWidth,scroll:d.scrollWidth,body:b.clientHeight,bodyScroll:b.scrollHeight,head:h.top,foot:f.bottom,text:d.textContent};})()`);
      assert.equal(metrics.width,metrics.scroll,name+': no horizontal overflow');assert.ok(metrics.head>=0&&metrics.foot<=height+1,name+': fixed chrome in viewport');assert.ok(metrics.body>70,name+': usable body');
      assert.ok(metrics.text.includes(mode==='history'?'Some history is unavailable':'Current saved shot'));
      picture=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(join(output,name+'-'+mode+'-'+(dark?'dark':'light')+'.png'),Buffer.from(picture.data,'base64'));
      for(let tab=0;tab<8;tab++){await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});assert.ok(await js(`document.activeElement===document.body||document.querySelector('.fy-prompt-sheet').contains(document.activeElement)`),name+': Tab cannot focus background controls');}
      if(mode==='history') {
        await js(`[...document.querySelectorAll('.fy-prompt-sheet button')].find(b=>b.textContent==='Review restore').click()`);
        await until(()=>js(`document.querySelector('.fy-prompt-sheet').textContent.includes('original source versions stay recorded')`));
        picture=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(join(output,name+'-restore-'+(dark?'dark':'light')+'.png'),Buffer.from(picture.data,'base64'));
        await js(`[...document.querySelectorAll('.fy-prompt-sheet button')].find(b=>b.textContent==='Restore image prompt').click()`);
        await until(()=>js(`document.querySelector('.fy-prompt-sheet').textContent.includes('scene changed')`));
      }
      await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await until(()=>js(`!document.querySelector('.fy-prompt-sheet[open]')`));
      assert.equal(await js(`document.activeElement.textContent`),opener,name+': focus returns');results.push({name,dark,mode,...metrics,text:undefined});
    }
    assert.ok(await js(`sent.filter(m=>m.kind.startsWith('prompt-')).every(m=>['prompt-history-read','prompt-history-restore','prompt-request-inspect'].includes(m.kind))`));
  }
  await writeFile(join(output,'measurements.json'),JSON.stringify(results,null,2));console.log(`${results.length} actual App/PageSheet cases passed, plus Settings default-off/toggle checks. ${output}`);
} finally { socket?.close(); child.kill(); await new Promise(resolve => server.close(resolve)); }
