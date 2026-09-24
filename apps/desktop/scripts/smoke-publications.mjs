import assert from "node:assert/strict";
import { build } from "esbuild";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Actual built client and preload, sandboxed file page, real codecs, no coordinator or world.
const require = createRequire(import.meta.url);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(desktop, "../..");
const ffmpeg = process.env.ARKE_TEST_FFMPEG, ffprobe = process.env.ARKE_TEST_FFPROBE;
assert.ok(ffmpeg && ffprobe, "Set ARKE_TEST_FFMPEG and ARKE_TEST_FFPROBE to explicit binaries.");
const root = await mkdtemp(join(tmpdir(), "arke-publication-smoke-"));
const rel = relative(tmpdir(), root);
assert.ok(!rel.startsWith("..") && !isAbsolute(rel));
const source = join(root, "publication"); await mkdir(source);
try {
  await promisify(execFile)(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=0x32435b:s=640x360:r=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(source, "movie.mp4")], { windowsHide: true });
  const asset = async (href, mediaType, text) => {
    if (text) await writeFile(join(source, href), text);
    const bytes = await readFile(join(source, href));
    return { href, mediaType, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const manifest = { format: "arke-publication", schemaVersion: 1, id: "urn:uuid:00000000-0000-4000-8000-000000000001", edition: "First edition", profile: "video", profileVersion: 1,
    title: "A quiet moment", language: "en", requires: ["video-v1", "webvtt-v1"],
    assets: { movie: await asset("movie.mp4", "video/mp4"), en: await asset("en.vtt", "text/vtt", "WEBVTT\n\n00:00:00.000 --> 00:00:03.500\n[A steady tone]\n"),
      fr: await asset("fr.vtt", "text/vtt", "WEBVTT\n\n00:00:00.000 --> 00:00:03.500\nUn son continu\n") },
    content: { video: "movie", textTracks: [{ asset: "en", kind: "captions", label: "English CC", language: "en", default: true }, { asset: "fr", kind: "subtitles", label: "Français", language: "fr", default: false }] },
    build: { compiler: "smoke", compilerVersion: "1", dependencyFingerprint: "a".repeat(64) } };
  await writeFile(join(source, "publication.json"), JSON.stringify(manifest));
  const imports = (path) => JSON.stringify(join(repo, path));
  await build({ stdin: { contents: `
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { app, BrowserWindow, ipcMain } from 'electron';
import { PublicationHost } from ${imports("apps/desktop/src/publication-host.ts")};
import { publicationMedia } from ${imports("apps/desktop/src/publication-media.ts")};
import { createMediaProcessRunner } from ${imports("apps/desktop/src/media-tools.ts")};
import { authenticatedMediaHeaders } from ${imports("apps/desktop/src/transport-auth.ts")};
import { writePublicationZip } from ${imports("packages/coordinator/src/publications/archive.ts")};
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.setPath('userData', join(__dirname, 'profile'));
const timeout = setTimeout(() => { console.error('Publication smoke timed out'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  const source = join(__dirname, 'publication'); const zip = join(__dirname, 'publication.zip');
  await writePublicationZip(source, zip);
  const media = publicationMedia(createMediaProcessRunner({ ffmpeg: ${JSON.stringify(ffmpeg)}, ffprobe: ${JSON.stringify(ffprobe)} }));
  const host = new PublicationHost({ root: join(__dirname, 'host'), origins: ['null', 'file://'], providers: () => ({ starting: null, live: null }),
    pick: async kind => kind === 'zip' ? zip : source, reveal: () => {}, compiler: media.compiler, probe: media.playback });
  ipcMain.on('arke:get-theme', event => { event.returnValue = { preference: 'system', resolved: 'light' }; });
  const window = new BrowserWindow({ show: false, width: 1120, height: 840, webPreferences: { preload: ${JSON.stringify(join(desktop, "dist/preload.cjs"))}, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') console.error('[renderer]', details.message); });
  for (const method of ['open', 'close', 'list', 'start', 'retry', 'cancel', 'reveal']) ipcMain.handle('arke:publication-' + method, (event, input) => {
    assert.equal(event.sender, window.webContents); assert.equal(event.senderFrame, window.webContents.mainFrame);
    return host[method](input);
  });
  window.webContents.session.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => callback({ requestHeaders: authenticatedMediaHeaders(details, host.session, window.webContents.id) }));
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => callback({ cancel: new URL(details.url).hostname !== '127.0.0.1' }));
  await window.loadFile(${JSON.stringify(join(repo, "packages/client/dist/index.html"))}, { hash: '/publications' });
  const wait = async code => {
    for (let n = 0; n < 150; n++) { if (await window.webContents.executeJavaScript(code)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('UI condition failed: ' + code + '\\n' + await window.webContents.executeJavaScript('document.body.innerText'));
  };
  await wait('!!document.querySelector("[data-screen=publications]")');
  for (const kind of ['folder', 'ZIP']) {
    console.log('[smoke] opening ' + kind);
    await window.webContents.executeJavaScript('Array.from(document.querySelectorAll("button")).find(b => b.textContent === ' + JSON.stringify('Open ' + kind) + ').click()');
    await wait('document.querySelector("video")?.readyState >= 2');
    await rm(kind === 'folder' ? source : zip, { recursive: true, force: true });
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("video").textTracks.length'), 2);
    await window.webContents.executeJavaScript('document.querySelector("video").muted = true; document.querySelector("video").currentTime = 1;');
    await wait('Math.abs(document.querySelector("video").currentTime - 1) < 0.15 && !document.querySelector("video").seeking && document.querySelector("video").readyState >= 2');
    await window.webContents.executeJavaScript('(() => { const s = document.querySelector(".fy-publication-video select"); s.value = "fr"; s.dispatchEvent(new Event("change", {bubbles:true})); })()');
    await wait('document.querySelector("video").textTracks[1].mode === "showing" && document.querySelector("video").textTracks[1].cues?.length === 1');
    await window.webContents.executeJavaScript('document.querySelector("video").focus()');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await wait('document.querySelector("video").paused === false');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await wait('document.querySelector("video").paused === true');
    await window.webContents.executeJavaScript('document.querySelector("video").textTracks[1].mode = "disabled"; document.querySelector("video").textTracks[0].mode = "showing";');
    await wait('document.querySelector(".fy-publication-video select").value === "en"');
    await window.webContents.executeJavaScript('document.querySelector(".fy-publication-video select").value = ""; document.querySelector(".fy-publication-video select").dispatchEvent(new Event("change", {bubbles:true}));');
    await wait('Array.from(document.querySelector("video").textTracks).every(t => t.mode === "disabled")');
    const state = await window.webContents.executeJavaScript('JSON.stringify(window.arke)');
    assert.ok(!state.includes(host.session.token)); assert.ok(!state.includes(__dirname));
  }
  await mkdir(${JSON.stringify(join(repo, ".dev"))}, { recursive: true });
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await writeFile(${JSON.stringify(join(repo, ".dev/publication-player.png"))}, (await window.webContents.capturePage()).toPNG());
  window.destroy(); await host.stop(); clearTimeout(timeout);
  console.log('[smoke] real file-page player: directory + ZIP, source removed, offline video, two tracks, captions off, keyboard play/pause and seek');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
`, resolveDir: repo, sourcefile: "publication-smoke.ts", loader: "ts" }, bundle: true, platform: "node", format: "cjs", outfile: join(root, "main.cjs"), external: ["electron"],
    mainFields: ["module", "main"], banner: { js: 'var import_meta_url = require("node:url").pathToFileURL(__filename).href;' }, define: { "import.meta.url": "import_meta_url" } });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [join(root, "main.cjs")], { stdio: "inherit", windowsHide: true, env });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, "Publication smoke failed");
} finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
