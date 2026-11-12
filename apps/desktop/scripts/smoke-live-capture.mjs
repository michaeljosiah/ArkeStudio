import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Real Chromium microphone/worklet and component cleanup on a sandboxed file page.
// Chromium supplies a synthetic device. This does not qualify physical hardware or echo.
const root = fileURLToPath(new URL("../../../", import.meta.url)), require = createRequire(import.meta.url);
const dir = await mkdtemp(join(tmpdir(), "arke-live-capture-"));
const within = relative(tmpdir(), dir);
if (within.startsWith("..") || isAbsolute(within)) throw new Error("Smoke directory escaped tmpdir");
try {
  const assets = join(root, "packages/client/dist/assets");
  const worklet = (await readdir(assets)).find(name => /^voice-capture\.worklet-.*\.js$/.test(name));
  assert(worklet, "Build the production client first; the worklet must be a separate asset.");
  await mkdir(join(dir, "components")); await mkdir(join(dir, "lib"));
  await cp(join(assets, worklet), join(dir, "lib/voice-capture.worklet.js"));
  await build({ entryPoints: [join(root, "apps/desktop/src/microphone-permission.ts")], bundle: true, platform: "node", format: "cjs", outfile: join(dir, "permission.cjs") });
  await writeFile(join(dir, "preload.cjs"), `const {contextBridge,ipcRenderer}=require("electron"); contextBridge.exposeInMainWorld("captureSmoke",{send:raw=>ipcRenderer.send("capture-smoke",raw)});`);
  await build({ stdin: { resolveDir: root, contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { VoiceConversation } from "./packages/client/src/components/voice-conversation.tsx";
import { __setStateForTest, __setBridgeForTest, __handleFrameForTest, __connectionStatusForTest } from "./packages/client/src/lib/store.ts";
import { FIXTURE_STATE } from "./packages/client/test/fixture-state.ts";
const streams = [], contexts = [], sent = [];
const OriginalContext = window.AudioContext, originalMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
window.AudioContext = class extends OriginalContext { constructor(options) { super(options); contexts.push(this); } };
let delay = false, release;
navigator.mediaDevices.getUserMedia = async options => {
  const stream = await originalMedia(options); streams.push(stream);
  if (delay) await new Promise(resolve => { release = resolve; });
  return stream;
};
__setStateForTest(structuredClone(FIXTURE_STATE), { connection: "open" });
let seq = 0;
__setBridgeForTest({ appVersion: "smoke", platform: "win32", connect() {}, subscribe() {}, send(raw) {
  const message = JSON.parse(raw); sent.push(message); window.captureSmoke.send(raw);
  if (message.kind === "voice-conversation" && message.command.action === "open")
    setTimeout(() => __handleFrameForTest({ kind: "voice-conversation", seq: ++seq, session: message.session, response: { type: "state", state: "listening" } }), 0);
} });
const onActive = () => {};
createRoot(document.getElementById("root")).render(React.createElement(VoiceConversation, {
  worldId: FIXTURE_STATE.world.meta.worldId, conversationId: "cv_01J00000000000000000000000", available: true, model: "local smoke", canStart: true, onActive,
}));
window.smoke = {
  state: () => ({ text: document.body.innerText, streams: streams.length, tracks: streams.flatMap(stream => stream.getTracks().map(track => track.readyState)), contexts: contexts.map(context => context.state), actions: sent.filter(row => row.kind === "voice-conversation").map(row => row.command.action) }),
  disconnect: () => { const track = streams.at(-1).getAudioTracks()[0]; track.stop(); track.dispatchEvent(new Event("ended")); },
  offline: () => __connectionStatusForTest("closed"),
  online: () => __connectionStatusForTest("open"),
  delay: () => { delay = true; }, release: () => { delay = false; release?.(); },
};
` }, bundle: true, platform: "browser", format: "esm", define: { "import.meta.env": "{}" }, outfile: join(dir, "components/renderer.js") });
  await writeFile(join(dir, "index.html"), `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self' ws://127.0.0.1:*"><title>Voice capture qualification</title><div id="root"></div><script type="module" src="components/renderer.js"></script>`);
  await writeFile(join(dir, "main.cjs"), `
const assert = require("node:assert/strict"), {join} = require("node:path"), {pathToFileURL} = require("node:url");
const {app,BrowserWindow,ipcMain} = require("electron"), {microphoneAllowed} = require("./permission.cjs");
app.disableHardwareAcceleration(); app.setPath("userData",join(__dirname,"profile")); app.commandLine.appendSwitch("use-fake-device-for-media-stream");
const timeout = setTimeout(()=>{console.error("Capture smoke timed out");app.exit(1);},60000);
app.whenReady().then(async()=>{
  let allow = false, audio = 0, opens = 0;
  const window = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:join(__dirname,"preload.cjs")}});
  const rendererUrl=pathToFileURL(join(__dirname,"index.html")).href;
  const permission = (contents,name,details) => allow && microphoneAllowed({permission:name,sameWebContents:contents===window.webContents,isMainFrame:details.isMainFrame,requestingUrl:details.requestingUrl??"",rendererUrl,mediaTypes:details.mediaTypes??(details.mediaType?[details.mediaType]:[])});
  window.webContents.session.setPermissionCheckHandler((contents,name,_origin,details)=>permission(contents,name,details));
  window.webContents.session.setPermissionRequestHandler((contents,name,callback,details)=>callback(permission(contents,name,details)));
  ipcMain.on("capture-smoke",(event,raw)=>{
    assert.equal(event.sender,window.webContents); const message=JSON.parse(raw);
    if(message.kind!=="voice-conversation")return;
    if(message.command.action==="open")opens++;
    if(message.command.action==="audio"){assert.equal(Buffer.from(message.command.audioBase64,"base64").length,1280);audio++;}
  });
  const js=code=>window.webContents.executeJavaScript(code,true);
  const state=()=>js("window.smoke.state()");
  const until=async(check,label)=>{const end=Date.now()+10000;while(!await check()){assert(Date.now()<end,label);await new Promise(resolve=>setTimeout(resolve,20));}};
  const click=label=>js('Array.from(document.querySelectorAll("button")).find(button=>button.textContent==='+JSON.stringify(label)+')?.click()');
  const stopped=async()=>until(async()=>{const value=await state();return value.contexts.every(status=>status==="closed")&&value.tracks.every(status=>status==="ended");},"Capture graph did not close");
  await window.loadFile(join(__dirname,"index.html")); await until(()=>js("!!window.smoke && !!document.querySelector('button')"),"Component did not mount");
  await click("Talk with Arke"); await until(async()=> (await state()).text.includes("Voice could not start."),"Denied microphone did not degrade"); assert.equal(opens,0);assert.equal(audio,0);await stopped();
  allow=true;
  await click("Talk with Arke"); await until(()=>audio>=5,"Production worklet did not capture PCM");assert.equal(opens,1);
  await click("End voice");await stopped();const ended=audio;await new Promise(resolve=>setTimeout(resolve,120));assert.equal(audio,ended);
  await click("Talk with Arke");await until(()=>opens===2,"Second capture did not start");await js("window.smoke.disconnect()");await stopped();assert((await state()).text.includes("microphone disconnected"));
  await click("Talk with Arke");await until(()=>opens===3,"Capture did not recover from device loss");await js('window.dispatchEvent(new Event("blur"))');await stopped();
  await click("Talk with Arke");await until(()=>opens===4,"Capture did not restart after blur");await js("window.smoke.offline()");await stopped();await js("window.smoke.online();window.smoke.delay()");
  const before=(await state()).streams;await click("Talk with Arke");await until(async()=> (await state()).streams>before,"Delayed permission did not create a stream");await click("End voice");await js("window.smoke.release()");await stopped();assert.equal(opens,4);
  window.destroy();clearTimeout(timeout);console.log("PASS: sandboxed file-page denied/regranted synthetic mic, production worklet PCM, End voice, device loss, blur, disconnect and late-permission cleanup");app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [join(dir, "main.cjs")], { env, windowsHide: true, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, "Native file-page voice capture failed");
} finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
