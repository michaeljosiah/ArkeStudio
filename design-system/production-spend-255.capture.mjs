// Render the design drawings in an owned headless Chrome. No app or author's world is opened.
// node design-system/production-spend-255.capture.mjs [output-directory]
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frames } from './production-spend-255.frames.mjs';
const root = dirname(fileURLToPath(import.meta.url));
const serving = process.argv.includes('--serve');
const output = resolve((serving ? undefined : process.argv[2]) ?? join(root, '../output/production-spend-255'));
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(path);
    const type = { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[extname(path)] ?? 'text/plain';
    res.writeHead(200, { 'Content-Type': type }); res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
if (serving) {
  console.log('Design turn 255: http://127.0.0.1:' + server.address().port + '/production-spend-255.review.html');
  await new Promise(() => {});
}
const chrome = process.env.ARKE_CHROME ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');
await access(chrome);
const profile = await mkdtemp(join(tmpdir(), 'arke-spend-design-'));
const child = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const until = async read => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { try { const value = await read(); if (value) return value; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Design browser did not become ready');
};
let socket;
try {
  const port = await until(async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => { const answer = JSON.parse(data), task = pending.get(answer.id); if (task) { pending.delete(answer.id); answer.error ? task.reject(Error(JSON.stringify(answer.error))) : task.resolve(answer.result); } };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const js = async expression => { const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  await cdp('Page.enable');
  const base = 'http://127.0.0.1:' + server.address().port + '/production-spend-255.review.html';
  await cdp('Page.navigate', { url: base });
  await until(() => js('document.querySelectorAll(".ps255").length === 8'));
  const links = await js('[...document.querySelectorAll("a[href]")].map(a=>a.getAttribute("href"))');
  for (const href of links.filter(link => /#255[a-h]$/.test(link))) assert.ok(frames.some(frame => href.endsWith('#' + frame.id)), href);
  const results = [];
  for (const dark of [false, true]) for (const frame of frames) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: frame.width, height: frame.height, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: base + '?case=' + frame.id + '-' + dark });
    await until(() => js('document.querySelectorAll(".ps255").length === 8'));
    await js(`document.documentElement.classList.toggle('dark',${dark});document.body.innerHTML=document.getElementById('${frame.id}').querySelector('.frame').innerHTML;document.body.style.margin='0';document.body.style.padding='0';document.body.style.overflow='hidden';document.fonts.ready`);
    await until(() => js('[...document.images].every(img=>img.complete&&img.naturalWidth>0)'));
    const metrics = await js(`(()=>{const root=document.querySelector('.ps255'),sheet=document.querySelector('.ps255-sheet'),head=document.querySelector('.ps255-sheethead'),foot=document.querySelector('.ps255-sheetfoot'),body=document.querySelector('.ps255-sheetbody');const r=el=>el?.getBoundingClientRect();return {width:root.clientWidth,scrollWidth:root.scrollWidth,font:getComputedStyle(root).fontFamily,headTop:r(head)?.top,footBottom:r(foot)?.bottom,sheetBottom:r(sheet)?.bottom,bodyHeight:body?.clientHeight,bodyScroll:body?.scrollHeight,missingTokens:[...document.querySelectorAll('.ps255 *')].filter(el=>getComputedStyle(el).fontFamily.includes('Times')).length};})()`);
    assert.equal(metrics.width, frame.width, frame.id + ' width');
    assert.equal(metrics.scrollWidth, frame.width, frame.id + ' horizontal overflow');
    assert.equal(metrics.missingTokens, 0, frame.id + ' missing type tokens');
    if (metrics.headTop !== undefined) { assert.ok(metrics.headTop >= 0); assert.ok(metrics.footBottom <= frame.height); }
    const screenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const name = frame.id + (dark ? '-dark' : '-light') + '.png';
    await writeFile(join(output, name), Buffer.from(screenshot.data, 'base64'));
    if (frame.id === '255d') {
      assert.ok(await js(`(()=>{const d=document.querySelector('details');d.open=true;return d.textContent.includes('$2.00')&&d.textContent.includes('$3.00');})()`));
      const expanded = await cdp('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(output, '255d-expanded-' + (dark ? 'dark' : 'light') + '.png'), Buffer.from(expanded.data, 'base64'));
    }
    if (frame.id === '255h') {
      assert.ok(await js(`(()=>{const body=document.querySelector('.ps255-sheetbody');body.scrollTop=body.scrollHeight;return body.scrollTop>0&&document.querySelector('.ps255-sheetfoot').getBoundingClientRect().bottom<=844;})()`), 'phone final receipts accessible');
      assert.ok(await js(`(()=>{const close=document.querySelector('.ps255-sheethead a').getBoundingClientRect();return close.width>=44&&close.height>=44;})()`), 'phone close target');
    }
    results.push({ frame: frame.id, dark, file: name, ...metrics });
  }
  await writeFile(join(output, 'measurements.json'), JSON.stringify(results, null, 2));
  console.log(`${results.length} design renders checked; links, source fonts, horizontal fit, sheet header/footer, board expansion and phone scroll verified. ${output}`);
} finally {
  socket?.close(); child.kill(); await new Promise(resolve => server.close(resolve));
}
