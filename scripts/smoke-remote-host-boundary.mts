import assert from "node:assert/strict";
import { createServer as httpServer, request } from "node:http";
import { createServer as httpsServer } from "node:https";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { RemoteGateway } from "../packages/coordinator/src/remote-access/gateway.js";
import { RemoteDevices } from "../packages/coordinator/src/remote-access/devices.js";
import { hostOnlyCommandFixtures } from "../packages/coordinator/test/remote-host-commands.js";
// Real HTTPS + HttpOnly cookie pairing in Chrome. TLS models the local Tailscale terminator.
const dir = await mkdtemp(join(tmpdir(), "arke-remote-browser-"));
const openssl = process.env.ARKE_OPENSSL ?? (process.platform === "win32" ? "C:/Program Files/Git/usr/bin/openssl.exe" : "openssl");
execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir,"key.pem"), "-out", join(dir,"cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore", windowsHide: true });
await writeFile(join(dir, "index.html"), '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src self"></head><body>Pairing boundary check</body></html>');
const received: unknown[] = [], token = randomBytes(32).toString("hex");
const upstream = httpServer(); const wss = new WebSocketServer({ server: upstream });
wss.on("connection", socket => socket.on("message", raw => { const command = JSON.parse(raw.toString()); received.push(command); socket.send(JSON.stringify(command.kind === "hello" ? { kind: "snapshot", seq: 1 } : command)); }));
upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
const devices = new RemoteDevices(join(dir,"devices.json")); await devices.load();
let gatewayPort = 0;
const proxy = httpsServer({ key: await readFile(join(dir,"key.pem")), cert: await readFile(join(dir,"cert.pem")) }, (req,res) => {
 const forward = request({ host: "127.0.0.1", port: gatewayPort, method: req.method, path: req.url, headers: req.headers }, response => { res.writeHead(response.statusCode!, response.headers); response.pipe(res); });
 forward.on("error", () => res.writeHead(502).end()); req.pipe(forward);
});
proxy.on("upgrade", (req, socket, head) => {
 const forward = request({ host: "127.0.0.1", port: gatewayPort, path: req.url, headers: req.headers });
 forward.on("upgrade", (response, target, rest) => { socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(response.headers).map(([key,value])=>key+': '+value).join('\r\n')+'\r\n\r\n'); if(head.length)target.write(head); if(rest.length)socket.write(rest); socket.pipe(target).pipe(socket); socket.on("error",()=>target.destroy()); target.on("error",()=>socket.destroy()); });
 forward.on("response", response => { socket.end(`HTTP/1.1 ${response.statusCode} Refused\r\nConnection: close\r\n\r\n`); }); forward.on("error",()=>socket.destroy()); forward.end();
});
proxy.listen(0,"127.0.0.1"); await once(proxy,"listening");
const origin = "https://127.0.0.1:"+(proxy.address() as import("node:net").AddressInfo).port;
const gateway = new RemoteGateway({ origin, clientDirectory: dir, devices, session: { port: (upstream.address() as import("node:net").AddressInfo).port, token } }); gatewayPort = await gateway.start(0);
const chrome = process.env.ARKE_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
const child = spawn(chrome,["--headless=new","--ignore-certificate-errors","--no-first-run","--no-default-browser-check","--remote-debugging-port=0","--user-data-dir="+join(dir,"profile"),"about:blank"],{windowsHide:true,stdio:"ignore"});
const sleep = () => new Promise(resolve=>setTimeout(resolve,100));
const until = async (fn: ()=>Promise<any>) => { const deadline=Date.now()+20000; while(Date.now()<deadline){try{const result=await fn();if(result)return result;}catch{}await sleep();}throw new Error("Chrome did not respond"); };
let control: WebSocket | undefined;
try {
 const port = await until(async()=>(await readFile(join(dir,"profile/DevToolsActivePort"),"utf8")).split("\n")[0]);
 const targets=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();
 control=new WebSocket(targets.find((t:any)=>t.type==="page").webSocketDebuggerUrl); await once(control,"open");
 let seq=0; const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
 control.on("message",raw=>{const message=JSON.parse(raw.toString()),p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(new Error(JSON.stringify(message.error))):p.resolve(message.result);}});
 const cdp=(method:string,params={})=>new Promise<any>((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});control!.send(JSON.stringify({id,method,params}));});
 const js=async(expression:string)=>{const result=await cdp("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
 await cdp("Page.navigate",{url:origin});await until(()=>js('document.readyState==="complete" && location.protocol==="https:"'));
 assert.equal(await js('fetch("/remote/device").then(r=>r.status)'),401);
 const {code}=devices.createCode();
 assert.equal(await js('fetch("/remote/pair",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify('+JSON.stringify({code,name:"Chrome paired phone"})+')}).then(r=>r.status)'),202);
 assert.equal(await js('fetch("/remote/pair").then(r=>r.status)'),202);
 await devices.approve(devices.pending()[0]!.id,30);
 assert.equal(await js('fetch("/remote/pair").then(r=>r.status)'),204);
 assert.equal(await js('document.cookie.includes("arke")'),false,"pairing credentials are HttpOnly");
 const own=await js('fetch("/remote/device").then(r=>r.json())');assert.deepEqual(Object.keys(own).sort(),["expiresAt","name","pairedAt"]);assert.equal(own.name,"Chrome paired phone");
 await js('new Promise((resolve,reject)=>{window.studio=new WebSocket(location.origin.replace("https:","wss:")+"/");studio.addEventListener("message",()=>resolve(true),{once:true});studio.onerror=reject;})');
 const commands=hostOnlyCommandFixtures(join(dir,"host-only.txt"));
 for(const command of commands) {
   const reply=await js('new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error("No refusal")),5000);studio.addEventListener("message",e=>{clearTimeout(timeout);resolve(JSON.parse(e.data));},{once:true});studio.send('+JSON.stringify(JSON.stringify(command))+');})');
   assert.deepEqual(reply,{kind:"command-refused",refused:"host-only",command:command.kind});
   assert.equal(await js('studio.readyState'),1);
 }
 assert.equal(received.length,1,"only the authenticated hello reached the coordinator");
 const after=await js('new Promise(resolve=>{studio.addEventListener("message",e=>resolve(JSON.parse(e.data)),{once:true});studio.send(JSON.stringify({kind:"refresh-diagnostics"}));})');assert.deepEqual(after,{kind:"refresh-diagnostics"});
 await js('studio.close()');
 const desktop=new WebSocket("ws://127.0.0.1:"+(upstream.address() as import("node:net").AddressInfo).port);await once(desktop,"open");
 for(const command of commands){const reply=once(desktop,"message");desktop.send(JSON.stringify(command));assert.deepEqual(JSON.parse((await reply)[0].toString()),command);}desktop.terminate();
 const result={pairedBrowser:"Chrome over HTTPS",refusals:commands.length,socketSurvived:true,allowedCommandAfterRefusals:true,desktopTransportPassed:commands.length};
 await writeFile(join(dir,"result.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {
 control?.close();child.kill();await gateway.stop();await devices.stop();for(const socket of wss.clients)socket.terminate();wss.close();proxy.closeAllConnections();await Promise.all([new Promise<void>(r=>proxy.close(()=>r())),new Promise<void>(r=>upstream.close(()=>r()))]);
}
