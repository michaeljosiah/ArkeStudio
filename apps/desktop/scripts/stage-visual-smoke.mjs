// Explicit local visual gate; no provider or model calls. Keep outputs for cinematic review.
import { build } from "esbuild";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = await mkdtemp(join(tmpdir(), "arke-stage-visual-"));
await build({
  entryPoints: [join(root, "apps/desktop/src/stage-export.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: join(output, "export.cjs"),
  alias: { "@arke-studio/coordinator": join(root, "packages/coordinator/src/artifacts/spool.ts") },
});
await build({
  stdin: {
    contents: `
import {StageViewport,figureColour} from "./packages/client/src/screens/scene-workspace/stage-viewport.ts";
import {stageFixtures} from "./packages/contracts/test/fixtures/stage-scenes.ts";
window.runStageSmoke=async()=>{
  const host=document.getElementById("stage");
  for(const fixture of stageFixtures) {
    const s=fixture.stage;
    const data={cast:s.cast.map((f,i)=>({...f,name:f.sheetId,colour:figureColour(i),pose:f.pose??null,to:f.to??null,ghost:null})),sets:s.sets,keys:s.keys,performances:s.performances,objectMotions:s.objectMotions,durationSec:fixture.duration,active:0,mode:"look",at:0,fov:40,aspect:16/9,lensLabel:"fixture",rig:undefined,seed:undefined,rigIntensity:undefined};
    const viewport=new StageViewport(host,data,{autokey(){},autoaim(){},castchange(){},walkchange(){},selchange(){},trackpick(){}});
    viewport.frame();
    const frames=await viewport.inspectFrames([fixture.duration/3,fixture.duration*2/3]);
    await window.smoke.inspect(fixture.name,frames);
    const result=await viewport.record({start:window.smoke.start,write:window.smoke.write,cancel:window.smoke.cancel},()=>{});
    await window.smoke.finish(fixture.name,result.jobId,new Uint8Array(await result.openingFrame.arrayBuffer()),fixture.duration);
    viewport.dispose();
  }
};`,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  outfile: join(output, "view.js"),
});
await writeFile(
  join(output, "preload.cjs"),
  `
const {contextBridge,ipcRenderer}=require("electron");
contextBridge.exposeInMainWorld("smoke",Object.fromEntries(["inspect","start","write","cancel","finish"].map(name=>[name,(...args)=>ipcRenderer.invoke("stage-smoke:"+name,...args)])));
`,
);
await writeFile(
  join(output, "index.html"),
  '<!doctype html><style>body{margin:0;background:#e6e3dd}#stage{width:1100px;height:720px}</style><div id="stage"></div><script src="view.js"></script>',
);
await writeFile(
  join(output, "main.cjs"),
  `
const {app,BrowserWindow,ipcMain,nativeImage}=require("electron");
const assert=require("node:assert/strict");
const {join}=require("node:path");
const {writeFile,copyFile}=require("node:fs/promises");
const {execFile}=require("node:child_process");
const {promisify}=require("node:util");
const {createStageExporter}=require("./export.cjs");
app.setPath("userData",join(__dirname,"profile"));
app.commandLine.appendSwitch("use-angle","swiftshader");
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
const exporter=createStageExporter(__dirname,process.env.ARKE_STAGE_FFMPEG||"ffmpeg");
const timeout=setTimeout(()=>{console.error("Stage visual gate timed out");app.exit(1);},600000);
const check=result=>{if(!result.ok)throw new Error(result.reason);return result;};
ipcMain.handle("stage-smoke:start",async(_,spec)=>check(await exporter.start(spec)).jobId);
ipcMain.handle("stage-smoke:write",async(_,id,index,bytes)=>{check(await exporter.write(id,index,bytes));});
ipcMain.handle("stage-smoke:cancel",(_,id)=>exporter.cancel(id));
ipcMain.handle("stage-smoke:inspect",async(_,name,frames)=>{
  for(const [index,frame] of frames.entries()) await writeFile(join(__dirname,name+"-"+index+"-"+frame.view+".png"),Buffer.from(frame.png,"base64"));
  await writeFile(join(__dirname,name+"-observations.json"),JSON.stringify(frames.map(({png,...frame})=>frame),null,2));
});
ipcMain.handle("stage-smoke:finish",async(_,name,id,png,duration)=>{
  const {path}=check(await exporter.finish(id));
  const target=join(__dirname,name+".mp4");
  await copyFile(path,target);
  await writeFile(join(__dirname,name+"-opening.png"),png);
  const {stdout}=await promisify(execFile)(process.env.ARKE_STAGE_FFPROBE||"ffprobe",["-v","error","-show_entries","format=duration:stream=width,height,r_frame_rate,nb_frames","-of","json",target],{windowsHide:true,timeout:15000});
  await writeFile(join(__dirname,name+"-encoded.json"),stdout);
  const measured=JSON.parse(stdout);const stream=measured.streams[0];
  assert.equal(stream.width,1280);assert.equal(stream.height,720);assert.equal(stream.r_frame_rate,"30/1");assert.equal(Number(stream.nb_frames),duration*30);assert.equal(Number(measured.format.duration),duration);
  assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(png)).getSize(),{width:1280,height:720});
  const {stderr}=await promisify(execFile)(process.env.ARKE_STAGE_FFMPEG||"ffmpeg",["-i",target,"-i",join(__dirname,name+"-opening.png"),"-filter_complex","[0:v]trim=end_frame=1,setpts=PTS-STARTPTS[a];[1:v]format=yuv420p[b];[a][b]ssim","-frames:v","1","-f","null","-"],{windowsHide:true,timeout:15000});
  const score=Number(/All:([0-9.]+)/.exec(stderr)?.[1]);assert.ok(score>.98,name+" opening video/PNG mismatch: "+score);
  await writeFile(join(__dirname,name+"-opening-agreement.txt"),"SSIM "+score);
  console.log(name+": "+duration+"s, "+stream.nb_frames+" frames, opening SSIM "+score);
});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1100,height:720,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:join(__dirname,"preload.cjs")}});
 win.webContents.on("console-message",event=>console.log(event.message));
 await win.loadFile(join(__dirname,"index.html"));
 await win.webContents.executeJavaScript("window.runStageSmoke()");
 clearTimeout(timeout);await exporter.cancelAll();console.log("Stage visual outputs: "+__dirname);app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
`,
);
console.log(`Stage visual outputs: ${output}`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [join(output, "main.cjs")], {
  cwd: root,
  env,
  windowsHide: true,
  stdio: "inherit",
});
process.exitCode = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("exit", (code) => resolve(code ?? 1));
});
