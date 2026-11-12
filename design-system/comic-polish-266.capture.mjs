// Render synthetic drawings in an owned headless browser. No author world or app is opened.
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frames } from './comic-polish-266.frames.mjs';
const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2] ?? join(root, '../output/comic-polish-266'));
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[extname(path)] ?? 'text/plain' });
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const chrome = process.env.ARKE_CHROME ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');
await access(chrome);
const profile = await mkdtemp(join(tmpdir(), 'arke-media-measurement-design-'));
const child = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const until = async read => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { try { const value = await read(); if (value) return value; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error('Design browser did not become ready');
};
let socket;
try {
  const port = await until(async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => { const result = JSON.parse(data), task = pending.get(result.id); if (task) { pending.delete(result.id); result.error ? task.reject(Error(JSON.stringify(result.error))) : task.resolve(result.result); } };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const js = async expression => { const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  await cdp('Page.enable');
  const base = `http://127.0.0.1:${server.address().port}/comic-polish-266.review.html`;
  await cdp('Page.navigate', { url: base });
  await until(() => js(`document.querySelectorAll('.sw266').length === ${frames.length}`));
  const results = [];
  for (const dark of [false, true]) for (const frame of frames) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: frame.width, height: frame.height, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: base + '?case=' + frame.id + '-' + dark });
    await until(() => js(`document.querySelectorAll('.sw266').length === ${frames.length}`));
    await js(`document.documentElement.classList.toggle('dark',${dark});document.body.innerHTML=document.getElementById('${frame.id}').innerHTML;document.body.style.cssText='margin:0;padding:0;overflow:hidden;height:100vh';document.fonts.ready`);
    await until(() => js('[...document.images].every(image=>image.complete&&image.naturalWidth>0)'));
    const metrics = await js("({ width: document.querySelector('.sw266').clientWidth, scrollWidth: document.querySelector('.sw266').scrollWidth })");
    assert.equal(metrics.width,metrics.scrollWidth);
    const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
    const name = frame.id + (dark ? '-dark' : '-light') + '.png';
    await writeFile(join(output, name), Buffer.from(screenshot.data, 'base64'));
    results.push({ frame: frame.id, dark, file: name, ...metrics, text: undefined });
  }
  await writeFile(join(output, 'measurements.json'), JSON.stringify(results, null, 2));
  console.log(`${results.length} synthetic design renders passed horizontal fit. ${output}`);
} finally { socket?.close(); child.kill(); await new Promise(resolve => server.close(resolve)); }
