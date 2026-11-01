// Actual App/PageSheet in an owned browser over the same synthetic fixture as turn 255.
// node --import tsx scripts/smoke-production-spend.mjs [output-directory]
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
import { productionSpend } from '../packages/coordinator/src/spend/rollups.ts';
import { jobs, shots } from '../design-system/production-spend-255.fixture.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] ?? join(root, 'output/production-spend-native'));
await mkdir(output, { recursive: true });
const state = structuredClone(FIXTURE_STATE), world = state.world, production = world.productions[0];
production.meta.medium = 'video'; production.meta.kind = 'film'; production.meta.format = 'video';
production.scenes = ['The tide', 'The bell'].map((title, i) => ({ id: 'sc_' + (i + 1), number: i + 1, slug: i ? 'bell' : 'tide', title, status: 'draft', version: 1,
  shots: shots.filter(shot => shot.scene === title).map(shot => ({ id: 'sh_' + shot.id, number: Number(shot.id), title: shot.title, description: 'Maren watches the signal beyond the rail.', durationSec: 5 })) }));
production.sceneFiles = { sc_1: '001-the-tide', sc_2: '002-the-bell' }; production.takes = []; production.selections = {};
const history = [], ledger = []; const at = '2026-11-01T00:00:00.000Z';
for (const [index, sample] of jobs.entries()) {
  const id = `jb_01J8F3K2QW9VZX4N7M0RTYB6H${index}`, sceneId = sample.plan[0][0] === '14' ? 'sc_2' : 'sc_1';
  let offset = 0;
  const plan = sample.plan.map(([shotId, duration]) => { const startSec = offset; offset += duration; return { shotId: 'sh_' + shotId, startSec, endSec: offset }; });
  const provider = sample.source === 'Unmetered' ? 'comfyui' : sample.source === 'ChatGPT plan' ? 'codex' : 'fal';
  const source = sample.source === 'Unmetered' ? 'local-zero' : sample.source === 'ChatGPT plan' ? 'included-plan' : sample.source === 'Derived' ? 'manifest-derived' : 'provider-reported';
  const kind = sample.id.startsWith('still') || sample.id.startsWith('plan') ? 'image' : 'video';
  const job = { id, worldId: world.meta.worldId, productionId: production.meta.id, target: sample.plan.length > 1 ? { kind: 'scene-pass', id: sceneId } : { kind: 'shot', id: plan[0].shotId },
    capability: kind, provider, model: sample.model, params: { provenance: { sceneId }, ...(plan.length > 1 ? { shotPlan: plan } : {}) }, status: sample.outcome === 'Made' ? 'succeeded' : 'failed', estimatedMicroUsd: sample.amount };
  history.push(job); ledger.push({ ...job, jobId: id, actualMicroUsd: sample.amount, actualSource: source, ts: at, outcome: job.status });
  if (sample.video) for (const [member, item] of plan.entries()) {
    const takeId = `tk_01J8F3K2QW9VZX4N7M0RTYB${index}H${member}`;
    production.takes.push({ id: takeId, jobId: id, kind: 'clip', coversShots: [item.shotId], provider, model: sample.model, provenance: { canonRevision: 1, sheets: {}, artDirectionVersion: 1 },
      cost: { estimatedMicroUsd: sample.amount, actualMicroUsd: sample.amount, actualSource: source }, references: [], params: {}, dispatchedAt: at, media: 'clip.mp4',
      ...(plan.length > 1 ? { segment: { passTakeId: `tk_parent${index}`, inSec: item.startSec, outSec: item.endSec } } : {}) });
    if (sample.id === 'shot-12' || sample.id === 'shot-14') production.selections[item.shotId] = { acceptedTakeId: takeId, trimInSec: 0 };
  }
}
state.productionSpend = productionSpend(world, { jobs: history, ledger, bench: [], ledgerUnavailable: false, historyUnavailable: false, benchIncomplete: false });
assert.equal(state.productionSpend.productions[production.meta.id].total.spentMicroUsd, 13_000_000);
assert.equal(state.productionSpend.productions[production.meta.id].total.generated, 7);
const main = await readFile(join(root, 'packages/client/src/main.tsx'), 'utf8');
const styles = [...main.matchAll(/^import "([^"\n]+\.css)";/gm)].map(match => match[0]).join('\n');
await build({ stdin: { resolveDir: join(root, 'packages/client/src'), loader: 'tsx', contents: `
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {MemoryRouter} from 'react-router';
import {App} from './App';import {__setStateForTest,__setBridgeForTest} from './lib/store';${styles}
const seed=${JSON.stringify(state)};let renderer;window.sent=[];
window.mountSpend=async(page='production',mode='complete',dark=false)=>{renderer?.unmount();document.documentElement.classList.toggle('dark',dark);window.sent=[];
const s=structuredClone(seed),p=s.world.productions[0],r=s.productionSpend.productions[p.meta.id];
if(mode==='partial'){r.total.coverage='partial';r.total.unallocatedMicroUsd=2400000;r.total.problems=['allocation-missing'];}
if(mode==='unavailable'){r.total.coverage='unavailable';r.total.spentMicroUsd=null;r.total.problems=['ledger-unreadable'];}
if(mode==='local'){r.total.spentMicroUsd=0;r.total.sources=[{source:'local-zero',entries:1,microUsd:0}];r.total.localRuns=1;}
__setBridgeForTest({platform:'test',appVersion:'spend-fixture',connect(){},subscribe(){return()=>{}},send(raw){window.sent.push(JSON.parse(raw))},coordinatorHttpBase:()=>location.origin});__setStateForTest(s,{connection:'open'});
renderer=createRoot(document.getElementById('root'));const path='/w/'+s.world.meta.worldId+'/p/'+p.meta.id+(page==='scene'?'/scenes/sc_1':page==='shot'?'/scenes/sc_1/shots/sh_12':'');
flushSync(()=>renderer.render(<MemoryRouter initialEntries={[path]}><App/></MemoryRouter>));await new Promise(resolve=>setTimeout(resolve,100));await document.fonts.ready;};
` }, bundle: true, platform: 'browser', format: 'iife', define: { 'import.meta.env': '{}' }, external: ['/*.webp', '/*.png'], loader: { '.woff': 'file', '.woff2': 'file' }, outfile: join(output, 'view.js'),
  plugins: [{ name: 'url-assets', setup(builder) { builder.onResolve({ filter: /\?url$/ }, args => ({ path: createRequire(import.meta.url).resolve(args.path.slice(0, -4)), namespace: 'url-asset' })); builder.onLoad({ filter: /.*/, namespace: 'url-asset' }, args => ({ contents: JSON.stringify(args.path), loader: 'text' })); } }] });
await writeFile(join(output, 'index.html'), '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="view.css"><div id="root"></div><script src="view.js"></script>');
const server = createServer(async (req, res) => { try { const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1) || 'index.html'; const path = resolve(output, name); assert.ok(!relative(output, path).startsWith('..') && !isAbsolute(relative(output, path))); res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'application/octet-stream'); res.end(await readFile(path)); } catch { res.writeHead(404).end(); } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const chrome = process.env.ARKE_CHROME ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome'); await access(chrome);
const profile = await mkdtemp(join(tmpdir(), 'arke-spend-native-'));
const child = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const until = async read => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { try { const value = await read(); if (value) return value; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('Native spend fixture did not become ready'); };
let socket;
try {
  const port = await until(async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let seq = 0; const pending = new Map(); socket.onmessage = ({ data }) => { const result = JSON.parse(data), task = pending.get(result.id); if (task) { pending.delete(result.id); result.error ? task.reject(Error(JSON.stringify(result.error))) : task.resolve(result.result); } };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const js = async expression => { const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  await cdp('Page.enable'); await cdp('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port }); await until(() => js('typeof mountSpend === "function"'));
  const results = [];
  for (const dark of [false, true]) for (const [name, width, height, page, mode] of [
    ['production', 1360, 820, 'production', 'complete'], ['scene', 1360, 820, 'scene', 'complete'], ['shot', 1360, 820, 'shot', 'complete'],
    ['phone', 390, 844, 'shot', 'complete'], ['short', 900, 400, 'production', 'complete'], ['zoom', 680, 410, 'production', 'complete'], ['partial', 1360, 820, 'production', 'partial'],
    ['unavailable', 390, 844, 'production', 'unavailable'], ['local', 1360, 820, 'production', 'local']]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await js(`mountSpend('${page}','${mode}',${dark})`);
    await js(`document.querySelector('button[aria-label="Close Chat"]')?.click()`);await new Promise(resolve=>setTimeout(resolve,150));
    assert.ok(await js(`!!document.querySelector('.fy-spend-summary')`), name + ': actual summary reachable');
    const before = await cdp('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, name + '-' + (dark ? 'dark' : 'light') + '.png'), Buffer.from(before.data, 'base64'));
    assert.ok(await js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Spend details'));b.focus();b.click();return true;})()`));
    await until(() => js(`!!document.querySelector('.fy-production-spend[open]')`));
    const metrics = await js(`(()=>{const d=document.querySelector('.fy-production-spend'),b=d.querySelector('.fy-page-sheet__body'),h=d.querySelector('header').getBoundingClientRect(),f=d.querySelector('footer').getBoundingClientRect();return {width:d.clientWidth,scrollWidth:d.scrollWidth,body:b.clientHeight,bodyScroll:b.scrollHeight,head:h.top,foot:f.bottom,view:innerHeight,text:d.textContent};})()`);
    assert.equal(metrics.width, metrics.scrollWidth, name + ': no sheet horizontal overflow'); assert.ok(metrics.head >= 0 && metrics.foot <= height + 1, name + ': sheet header/footer within viewport');
    assert.ok(metrics.body > 70, name + ': independently usable receipt body');
    if (name === 'unavailable') assert.ok(metrics.text.includes('Spend history could not be read') && !metrics.text.includes('$0.00'));
    if (name === 'local') assert.ok(metrics.text.includes('Unmetered'));
    if (name === 'partial') { await js(`document.querySelector('.fy-spend-callout button').click()`); assert.ok(await js(`sent.some(message=>message.kind==='production-spend-refresh')`)); }
    for (let tab = 0; tab < 10; tab++) { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); assert.ok(await js(`document.querySelector('.fy-production-spend').matches(':modal') && (document.activeElement === document.body || document.querySelector('.fy-production-spend').contains(document.activeElement))`), name + ': Tab cannot focus background controls'); }
    const initialSheet = await cdp('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, name + '-sheet-top-' + (dark ? 'dark' : 'light') + '.png'), Buffer.from(initialSheet.data, 'base64'));
    await js(`(()=>{const d=document.querySelector('.fy-production-spend details');if(d)d.open=true;const b=document.querySelector('.fy-production-spend .fy-page-sheet__body');b.scrollTop=b.scrollHeight;})()`);
    const receipt = await cdp('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, name + '-sheet-' + (dark ? 'dark' : 'light') + '.png'), Buffer.from(receipt.data, 'base64'));
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await until(() => js(`!document.querySelector('.fy-production-spend[open]')`));
    assert.ok(await js(`document.activeElement.textContent.includes('Spend details')`), name + ': focus returns to opener');
    results.push({ name, dark, ...metrics, text: undefined });
  }
  await writeFile(join(output, 'measurements.json'), JSON.stringify(results, null, 2)); console.log(`${results.length} actual App/PageSheet cases passed: hierarchy, themes, phone/short window, receipts, refresh, no horizontal overflow, Escape and focus return. ${output}`);
} finally { socket?.close(); child.kill(); await new Promise(resolve => server.close(resolve)); }
