import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile, access, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { defaultEffectClip } from "../packages/contracts/src/editor-effects.ts";
import { compositeRgba, renderEffectLayersRgba } from "../packages/contracts/src/editor-effect-raster.ts";

// Real Chromium decoders + the production component + its actual module worker. These small
// synthetic raster fixtures verify composition; they do not replace the real-world UI passes.
// Run: node --import tsx scripts/smoke-editor-effects-preview.mjs
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "arke-effect-preview-"));
for (const fps of [24, 30]) execFileSync(process.env.ARKE_FFMPEG ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=${fps}:duration=2`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "0", "-pix_fmt", "yuv420p", "-y", join(directory, `sample${fps}.mp4`)], { windowsHide: true });
const labels = Buffer.alloc(32 * 32 * 4 * 30);
for (let offset = 0; offset < labels.length; offset += 4) { labels.fill(Math.floor(offset / (32 * 32 * 4)) * 8, offset, offset + 3); labels[offset + 3] = 255; }
execFileSync(process.env.ARKE_FFMPEG ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "32x32", "-framerate", "30", "-i", "pipe:0", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "0", "-pix_fmt", "yuv420p", "-y", join(directory, "labels30.mp4")], { input: labels, windowsHide: true });
const workerEntry = join(root, "packages/client/src/lib/editor-effect-preview.worker.ts");
await build({ entryPoints: [workerEntry], bundle: true, platform: "browser", format: "esm", outfile: join(directory, "effect-worker.js") });
await build({ stdin: { resolveDir: join(root, "packages/client/src"), loader: "tsx", contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { defaultEffectClip } from "@arke-studio/contracts";
import { EditorPicturePreview } from "./screens/editor-picture-preview";
const root = createRoot(document.getElementById("root"));
const timeRef = { current: 5 };
const urlFor = path => new URL(path, location.href).href;
let projection, time = 5;
const layer = (clipId,path,order) => ({clipId,trackId:'tr_'+clipId,order,kind:'media',label:clipId,path,still:true,startFrame:0,endFrame:240,sourceInSec:0,fit:'contain',matte:'source-alpha'});
const effect = preset => {const e=defaultEffectClip({id:'cl_fx',lineageId:'ef_fx',seed:42,startFrame:0,durationFrames:240,preset});e.appearance={amount:1,size:1,opacity:1,colour:'#ff0000'};return e;};
function paint(){flushSync(()=>root.render(<EditorPicturePreview projection={projection} urlFor={urlFor} transport={{playing:false,time,timeRef,setPlaying(){},seek(){}}}/>));}
window.preview={
 mount(preset='smoke',mode='matte'){
  time=timeRef.current=5;
  const e=effect(preset);if(mode==='matte')e.target={kind:'visual-clip',clipId:'cl_middle'};if(mode.startsWith('video')||mode.startsWith('labels'))e.appearance.opacity=0;
  projection={rendererVersion:'software-rgba-v1',width:320,height:180,frameRate:24,startFrame:0,endFrame:240,issues:[],pictureLayers:mode==='matte'?[layer('cl_base','base.svg',0),layer('cl_middle','portrait.svg',1),layer('cl_top','top.svg',2)]:mode.startsWith('video')?[{...layer('cl_video','sample'+mode.slice(5)+'.mp4',0),still:false,sourceOutSec:0.5}]:[],effectLayers:[{trackId:'tr_fx',trackOrder:0,effect:e}]};
  if(mode.startsWith('labels'))projection.pictureLayers=[{...layer('cl_labels','labels30.mp4',0),still:false,sourceInSec:mode==='labels-in'?0.05:0.9,sourceOutSec:1}];
  paint();
 },
 seek(frame){time=timeRef.current=frame/24;paint();},
 pixels(){const c=document.querySelector('canvas');return [...c.getContext('2d').getImageData(0,0,c.width,c.height).data];},
 frame(){return document.querySelector('canvas')?.dataset.frame;},
 error(){return document.querySelector('[role=alert]')?.textContent;},
};
window.preview.mount();
` }, bundle: true, platform: "browser", format: "esm", outfile: join(directory, "view.js"), plugins: [{ name: "fixture-worker-url", setup(bundle) {
  bundle.onLoad({ filter: /editor-picture-preview\.tsx$/ }, async ({ path }) => ({ loader: "tsx", contents: (await readFile(path, "utf8")).replace('new URL("../lib/editor-effect-preview.worker.ts", import.meta.url)', 'new URL("/effect-worker.js", location.href)') }));
} }] });
await writeFile(join(directory, "index.html"), '<!doctype html><meta charset="utf-8"><title>Effect preview pixel fixture</title><style>html,body{margin:0}#root{position:relative;width:320px;height:180px}.fy-effectpreview{position:absolute;inset:0}.fy-effectpreview__stage{position:absolute;overflow:hidden}.fy-effectpreview__picture{display:block;width:100%;height:100%}</style><div id="root"></div><script type="module" src="view.js"></script>');
await writeFile(join(directory, "base.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><path fill="#0000ff" d="M0 0h320v180H0z"/></svg>');
await writeFile(join(directory, "portrait.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="160"><path fill="#00ff00" d="M0 0h40v160H0z"/></svg>');
await writeFile(join(directory, "top.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><path fill="#ffffff" d="M140 0h5v180h-5z"/></svg>');
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://localhost").pathname;
    const file = join(directory, path === "/" ? "index.html" : path.slice(1));
    const rel = relative(directory, file); assert.ok(!isAbsolute(rel) && !rel.startsWith(".."));
    response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".mp4") ? "video/mp4" : "text/html");
    const bytes = await readFile(file);
    response.setHeader("Accept-Ranges", "bytes");
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    if (range) {
      const start = Number(range[1]), end = Math.min(bytes.length - 1, range[2] ? Number(range[2]) : bytes.length - 1);
      response.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Content-Length": end - start + 1 });
      response.end(bytes.subarray(start, end + 1));
    } else { response.setHeader("Content-Length", bytes.length); response.end(bytes); }
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const chrome = process.env.ARKE_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
await access(chrome);
const child = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${join(directory, "profile")}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
let socket;
const until = async fn => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { const value = await fn().catch(() => null); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error("Effect preview fixture timed out"); };
try {
  const port = await until(async () => (await readFile(join(directory, "profile/DevToolsActivePort"), "utf8")).split("\n")[0]);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0; const pending = new Map();
  socket.onmessage = ({ data }) => { const message = JSON.parse(data), request = pending.get(message.id); if (!request) return; pending.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params })); });
  const js = async expression => { const response = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails)); return response.result.value; };
  await cdp("Page.navigate", { url: origin });
  await until(() => js("window.preview?.frame()==='120'"));
  assert.equal(await js("window.preview.error()"), undefined);
  const matte = await js("window.preview.pixels()");
  const pixel = (x, y) => matte.slice((y * 320 + x) * 4, (y * 320 + x) * 4 + 4);
  for (let y = 0; y < 180; y++) {
    assert.deepEqual(pixel(50, y), [0, 0, 255, 255], "contain bounds retain lower picture");
    assert.deepEqual(pixel(185, y), [0, 0, 255, 255], "transparent target pixels retain lower picture");
    assert.deepEqual(pixel(142, y), [255, 255, 255, 255], "upper picture occludes scoped effect");
  }
  assert.ok(matte.some((value, index) => index % 4 === 0 && value > 0 && Math.floor(index / 4) % 320 >= 115 && Math.floor(index / 4) % 320 < 140), "scoped particles appear on visible target");
  const records = [];
  for (const preset of ["dust", "embers", "snow", "lights", "rain", "smoke"]) {
    await js(`window.preview.mount(${JSON.stringify(preset)},'gap')`);
    await until(() => js("window.preview.frame()==='120'"));
    const pixels = Uint8ClampedArray.from(await js("window.preview.pixels()"));
    const effect = defaultEffectClip({ id: "cl_fx", lineageId: "ef_fx", seed: 42, startFrame: 0, durationFrames: 240, preset });
    effect.appearance = { amount: 1, size: 1, opacity: 1, colour: "#ff0000" };
    const expected = new Uint8ClampedArray(320 * 180 * 4); for (let offset = 3; offset < expected.length; offset += 4) expected[offset] = 255;
    compositeRgba(expected, renderEffectLayersRgba([effect], 120, 24, 320, 180));
    assert.deepEqual(pixels, expected, `${preset}: browser worker matches the Node raster byte for byte`);
    await js("window.preview.seek(35);window.preview.seek(140);window.preview.seek(120)");
    await until(() => js("window.preview.frame()==='120'"));
    assert.deepEqual(Uint8ClampedArray.from(await js("window.preview.pixels()")), expected, `${preset}: seek race keeps latest frame`);
    records.push({ preset, frame: 120, sha256: createHash("sha256").update(pixels).digest("hex"), differingBytes: 0 });
  }
  for (const sourceRate of [24, 30]) {
  await js(`window.preview.mount('smoke','video${sourceRate}')`);
  try { assert.equal(await until(() => js("window.preview.frame() || window.preview.error()")), "120"); }
  catch (error) {
    const prototype = await cdp("Runtime.evaluate", { expression: "HTMLVideoElement.prototype" });
    const objects = await cdp("Runtime.queryObjects", { prototypeObjectId: prototype.result.objectId });
    const details = await cdp("Runtime.callFunctionOn", { objectId: objects.objects.objectId, functionDeclaration: "function(){return Array.from(this,v=>({src:v.src,currentTime:v.currentTime,seeking:v.seeking,readyState:v.readyState,networkState:v.networkState,error:v.error?.message,duration:v.duration}));}", returnByValue: true });
    console.error(JSON.stringify(details.result.value));
    throw error;
  }
  const held = await js("window.preview.pixels()");
  const videoFrames = [];
  for (const frame of [9, 10, 11, 12, 13]) {
    await js(`window.preview.seek(${frame})`);
    await until(() => js(`window.preview.frame()==='${frame}'`));
    videoFrames.push(await js("window.preview.pixels()"));
  }
  assert.notDeepEqual(videoFrames[0], videoFrames[1], "adjacent paused video frames seek without activation tolerance");
  assert.notDeepEqual(videoFrames[1], videoFrames[2], "next paused frame decodes before capture");
  if (sourceRate === 24) assert.deepEqual(videoFrames[2], videoFrames[3], "matching-rate segment holds its final source frame");
  else assert.notDeepEqual(videoFrames[2], videoFrames[3], "30 fps source end hold includes its final frame on a 24 fps production");
  assert.deepEqual(videoFrames[3], videoFrames[4], "filed video segment holds its final allowed frame");
  assert.deepEqual(videoFrames[3], held, "random access and sequential end holds agree");
  }
  const sourceClock = [];
  for (const [mode, expected] of [["labels-in", [1, 2, 4, 5, 6, 7, 9, 10]], ["labels-tail", [27, 28, 29, 29, 29, 29, 29, 29]]]) {
    await js(`window.preview.mount('dust',${JSON.stringify(mode)})`);
    await until(() => js("window.preview.frame()==='120'"));
    const actual = [];
    for (let frame = 0; frame < expected.length; frame++) {
      await js(`window.preview.seek(${frame})`);
      await until(() => js(`window.preview.frame()==='${frame}'`));
      const pixels = await js("window.preview.pixels()");
      actual.push(Math.round(pixels[(90 * 320 + 160) * 4] / 8));
    }
    assert.deepEqual(actual, expected, "30 fps source uses previous physical frame at fractional in-points and tail holds");
    sourceClock.push({ sourceRate: 30, productionRate: 24, sourceInSec: mode === "labels-in" ? 0.05 : 0.9, sampledFrames: actual });
  }
  const screenshot = await cdp("Page.captureScreenshot", { format: "png" });
  await writeFile(join(directory, "preview.png"), Buffer.from(screenshot.data, "base64"));
  await writeFile(join(directory, "parity.json"), JSON.stringify({ platform: process.platform, browser: await cdp("Browser.getVersion"), width: 320, height: 180, frameRate: 24, records, sourceClock }, null, 2));
  if (process.env.ARKE_EFFECT_EVIDENCE_DIR) {
    await mkdir(process.env.ARKE_EFFECT_EVIDENCE_DIR, { recursive: true });
    for (const name of ["parity.json", "preview.png"]) await copyFile(join(directory, name), join(process.env.ARKE_EFFECT_EVIDENCE_DIR, name));
  }
  console.log(JSON.stringify({ directory, checks: "source-alpha, contain, full stack, occlusion, all six presets, seek races, adjacent video frames, source-end hold", parity: "zero differing RGBA bytes" }));
} finally { socket?.close(); child.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
