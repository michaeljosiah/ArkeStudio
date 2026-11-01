// Render synthetic drawings in an owned headless browser. No author world or app is opened.
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frames, compiled, draft, current } from './shot-prompts-257.frames.mjs';
const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2] ?? join(root, '../output/shot-prompts-257'));
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
const profile = await mkdtemp(join(tmpdir(), 'arke-shot-prompt-design-'));
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
  const base = `http://127.0.0.1:${server.address().port}/shot-prompts-257.review.html`;
  await cdp('Page.navigate', { url: base });
  await until(() => js(`document.querySelectorAll('.ph257').length === ${frames.length}`));
  const links = await js(`[...document.querySelectorAll('a[href]')].map(link=>link.getAttribute('href'))`);
  for (const link of links.filter(link => /#257[a-l]$/.test(link))) assert.ok(frames.some(frame => link.endsWith('#' + frame.id)), link);
  assert.equal(frames.find(frame => frame.id === '257a').markup.includes('shot-prompts-257.review.html#257k'), true, 'frame inspector entry stays image');
  assert.equal(compiled.split('\n\n')[1], draft, 'compiled drawing preserves generator draft verbatim');
  assert.notEqual(current, draft, 'saved shot and generator draft are distinct');
  const results = [];
  for (const dark of [false, true]) for (const frame of frames) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: frame.width, height: frame.height, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: base + '?case=' + frame.id + '-' + dark });
    await until(() => js(`document.querySelectorAll('.ph257').length === ${frames.length}`));
    await js(`document.documentElement.classList.toggle('dark',${dark});document.body.innerHTML=document.getElementById('${frame.id}').querySelector('.frame').innerHTML;document.body.style.cssText='margin:0;padding:0;overflow:hidden;height:100vh';document.fonts.ready`);
    await until(() => js('[...document.images].every(image=>image.complete&&image.naturalWidth>0)'));
    const metrics = await js(`(()=>{const r=document.querySelector('.ph257'),h=r.querySelector('.ph257-sheethead'),f=r.querySelector('.ph257-sheetfoot'),b=r.querySelector('.ph257-sheetbody');return {width:r.clientWidth,scrollWidth:r.scrollWidth,headTop:h?.getBoundingClientRect().top,footBottom:f?.getBoundingClientRect().bottom,bodyHeight:b?.clientHeight,bodyScroll:b?.scrollHeight,bodyWidth:b?.clientWidth,bodyScrollWidth:b?.scrollWidth,missingFonts:[...r.querySelectorAll('*')].filter(el=>getComputedStyle(el).fontFamily.includes('Times')).length,text:r.textContent};})()`);
    assert.equal(metrics.width, frame.width, frame.id + ': root width');
    assert.equal(metrics.scrollWidth, frame.width, frame.id + ': root horizontal fit');
    assert.equal(metrics.missingFonts, 0, frame.id + ': product font tokens');
    if (metrics.headTop !== undefined) {
      assert.ok(metrics.headTop >= 0 && metrics.footBottom <= frame.height, frame.id + ': fixed sheet chrome within viewport');
      assert.equal(metrics.bodyWidth, metrics.bodyScrollWidth, frame.id + ': body has no horizontal overflow');
      assert.ok(metrics.bodyHeight >= 100, frame.id + ': usable body');
    }
    if (['257d', '257h'].includes(frame.id)) assert.ok(metrics.text.includes('Current generator draft') && metrics.text.includes(draft));
    if (frame.id === '257k') assert.ok(metrics.text.includes('Current saved shot prompt') && !metrics.text.includes(draft));
    if (frame.id === '257f') assert.ok(await js(`document.querySelector('button[disabled]').textContent.includes('Restore')`));
    if (frame.id === '257i') assert.ok(!metrics.text.includes('Image 1') && metrics.text.includes('No request has been compiled'));
    const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
    const name = frame.id + (dark ? '-dark' : '-light') + '.png';
    await writeFile(join(output, name), Buffer.from(screenshot.data, 'base64'));
    if (['257b', '257e'].includes(frame.id)) {
      assert.ok(await js(`(()=>{const detail=document.querySelector('details');detail.open=true;return detail.textContent.includes('${frame.id === '257b' ? 'Maren Kest v3' : 'references/maren-kest'}');})()`));
    }
    if (['257g', '257h', '257j'].includes(frame.id)) {
      assert.ok(await js(`(()=>{const c=document.querySelector('.ph257-close').getBoundingClientRect();return c.width>=44&&c.height>=44;})()`), frame.id + ': phone close target');
      await js(`document.querySelector('.ph257-sheetbody').scrollTop=${frame.id === '257g' ? '290' : 'document.querySelector(".ph257-sheetbody").scrollHeight'}`);
      assert.ok(await js(`document.querySelector('.ph257-sheetfoot').getBoundingClientRect().bottom<=${frame.height}`));
      const scrolled = await cdp('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(output, frame.id + '-scrolled-' + (dark ? 'dark' : 'light') + '.png'), Buffer.from(scrolled.data, 'base64'));
    }
    results.push({ frame: frame.id, dark, file: name, ...metrics, text: undefined });
  }
  await writeFile(join(output, 'measurements.json'), JSON.stringify(results, null, 2));
  console.log(`${results.length} design renders passed: fonts, internal links, saved/draft context, reference source details, horizontal fit, fixed sheet chrome and phone scrolling. ${output}`);
} finally { socket?.close(); child.kill(); await new Promise(resolve => server.close(resolve)); }
