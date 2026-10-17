// Turn 228 · renders the Stage stills the frames use, from stage-228.render.mjs, into assets/ and
// writes the label positions to stage-228.labels.json. Deterministic: rerun after a scene edit.
//   node design-system/stage-228.renders.mjs   (CHROME=<path> if Chrome is elsewhere)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStageServer } from './stage-228.serve.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const JOBS = [
  ['over-lit', 'lit', 'overview', 2120, 1160], ['over-grey', 'greybox', 'overview', 2120, 1160], ['board-lit', 'lit', 'board', 2120, 1160],
  ['shot1-lit', 'lit', 'shot1', 540, 960], ['shot1-plate', 'plate', 'plateview', 540, 960], ['shot1-grey', 'greybox', 'shot1', 540, 960],
  ['shot2-lit', 'lit', 'shot2', 540, 960], ['shot3-lit', 'lit', 'shot3', 540, 960], ['shot4-lit', 'lit', 'shot4', 540, 960],
];
const server = createStageServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = 9800 + Math.floor(Math.random() * 150);
// An absolute profile directory, or Chrome hands the launch to a running browser and exits.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-228-'));
const chrome = spawn(process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let target;
for (let i = 0; i < 80 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {} }
if (!target) throw new Error('Chrome did not open its debugging port');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const waiting = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); waiting.delete(m.id); });
const send = (method, params = {}) => new Promise(r => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed'); return r.result.result.value; };
await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/stage-228.render.html` });
for (let i = 0; i < 120 && !(await evaluate('!!window.stage228ready').catch(() => false)); i++) await sleep(250);
const labels = {};
for (const [name, look, view, w, h] of JOBS) {
  const r = await evaluate(`stage228.render(${JSON.stringify({ look, view, w, h, type: 'image/jpeg' })})`);
  fs.writeFileSync(path.join(here, 'assets', `stage-228-${name}.jpg`), Buffer.from(r.png.split(',')[1], 'base64'));
  labels[name] = { w, h, labels: r.labels };
  console.log(`assets/stage-228-${name}.jpg`);
}
labels.shots = await evaluate('stage228.SHOTS');
fs.writeFileSync(path.join(here, 'stage-228.labels.json'), JSON.stringify(labels, null, 1) + '\n');
ws.close(); chrome.kill(); server.close();
await sleep(400); fs.rmSync(profile, { recursive: true, force: true });
