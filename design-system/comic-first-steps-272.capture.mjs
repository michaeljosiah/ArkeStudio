// Render turn 272's synthetic drawings in an owned headless browser, light and dark, and report
// anything that spills. No author world or app is opened.
//   node design-system/comic-first-steps-272.capture.mjs [output folder]
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frames } from './comic-first-steps-272.frames.mjs';
const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2] ?? join(root, '../output/comic-first-steps-272'));
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' }[extname(path)] ?? 'text/plain' });
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
const chrome = process.env.ARKE_CHROME ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');
await access(chrome);
const profile = await mkdtemp(join(tmpdir(), 'arke-comic-first-steps-design-'));
const child = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const until = async read => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { try { const value = await read(); if (value) return value; } catch {} await new Promise(wake => setTimeout(wake, 100)); }
  throw Error('Design browser did not become ready');
};
// The door's style grid scrolls on purpose (.gn272-scroll is left out); nothing else may run past its column.
const measure = `(() => {
  const out = [];
  for (const box of document.querySelectorAll('.gn272-foot,.gn249-chat,.gn249-plan,.gn256-dash,.gn247-head,.gn270-dockbody,.gn256-usual')) {
    if (box.scrollHeight > box.clientHeight + 1) out.push('tall ' + box.className + ' ' + box.scrollHeight + '/' + box.clientHeight);
    if (box.scrollWidth > box.clientWidth + 1) out.push('wide ' + box.className + ' ' + box.scrollWidth + '/' + box.clientWidth);
  }
  return out;
})()`;
let socket;
let spilled = 0;
try {
  const port = await until(async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((open, fail) => { socket.onopen = open; socket.onerror = fail; });
  let seq = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => { const result = JSON.parse(data), task = pending.get(result.id); if (task) { pending.delete(result.id); result.error ? task.reject(Error(JSON.stringify(result.error))) : task.resolve(result.result); } };
  const cdp = (method, params = {}) => new Promise((done, fail) => { const id = ++seq; pending.set(id, { resolve: done, reject: fail }); socket.send(JSON.stringify({ id, method, params })); });
  const js = async expression => { const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  await cdp('Page.enable');
  for (const dark of [true, false]) for (const frame of frames) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: frame.width, height: frame.height, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/comic-first-steps-272.review.html?case=${frame.id}-${dark}` });
    await until(() => js(`document.querySelector('[id="${frame.id}"] .fr') !== null`));
    await js(`document.documentElement.classList.toggle('dark',${dark});document.body.innerHTML=document.querySelector('[id="${frame.id}"] .fr').innerHTML;document.body.style.cssText='margin:0;padding:0;overflow:hidden;height:100vh';document.fonts.ready`);
    await until(() => js('[...document.images].every(image=>image.complete&&image.naturalWidth>0)'));
    const faults = await js(measure);
    if (faults.length) { spilled += faults.length; console.log(frame.id, dark ? 'dark' : 'light', faults.join(' | ')); }
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(output, `${frame.id}-${dark ? 'dark' : 'light'}.png`), Buffer.from(shot.data, 'base64'));
  }
  console.log(`${frames.length} frames, light and dark. ${spilled} spills. ${output}`);
} finally { socket?.close(); child.kill(); await new Promise(closed => server.close(closed)); }
