// Walk the whole path by clicking the wired hotspots, asserting each click lands on the frame the
// step says it should. A prototype that looks clickable and is not is the thing being tested for.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire("C:/Users/mjosi/source/repos/ArkeStudio/package.json");
const WebSocket = require("ws");

const PORT = 9441;
const profile = mkdtempSync(join(tmpdir(), "walk-"));
const proc = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--window-size=1500,1100", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, "--no-first-run", "about:blank",
], { stdio: "ignore" });
proc.on("exit", (c) => { if (c) { console.error("chrome exit", c); process.exit(1); } });

async function ep() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); const t = (await r.json()).find((x) => x.type === "page"); if (t) return t.webSocketDebuggerUrl; } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("no endpoint");
}
const ws = new WebSocket(await ep(), { perMessageDeflate: false });
let id = 0; const pend = new Map();
const send = (m, p) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } });
await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });

const logs = [];
await send("Runtime.enable");
await send("Page.enable");
await send("Log.enable").catch(() => {});
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "warning") {
    logs.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  }
});

const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};

await send("Page.navigate", { url: process.argv[2] });
await new Promise((r) => setTimeout(r, 2500));

const steps = await ev(`JSON.stringify(STEPS)`);
const plan = JSON.parse(steps);
console.log("steps:", plan.length);

// 1. Every configured action must have found a control.
const unwired = await ev(`(() => {
  const bad = [];
  for (const s of STEPS) {
    const screen = document.querySelector('[data-frame="' + s.id + '"]');
    for (const a of s.actions) {
      const hits = [...screen.querySelectorAll('.hotspot')].filter(el => {
        const t = (el.textContent||'').trim();
        return t === a.match || t.startsWith(a.match);
      });
      if (!hits.length) bad.push(s.id + ' :: ' + a.match);
    }
  }
  return JSON.stringify(bad);
})()`);
console.log("unwired actions:", unwired);

// 2. Click through the path, asserting the landing frame each time.
const results = [];
for (const s of plan) {
  if (!s.actions.length) { results.push(`${s.id} -> (end)`); continue; }
  const a = s.actions[0];
  const landed = await ev(`(() => {
    show(${JSON.stringify(s.id)});
    const screen = document.querySelector('[data-frame="' + ${JSON.stringify(s.id)} + '"]');
    const el = [...screen.querySelectorAll('.hotspot')].find(e => {
      const t = (e.textContent||'').trim();
      return t === ${JSON.stringify(a.match)} || t.startsWith(${JSON.stringify(a.match)});
    });
    if (!el) return 'NO-CONTROL';
    el.click();
    const vis = [...document.querySelectorAll('.screen')].filter(x => !x.hidden);
    return vis.length === 1 ? vis[0].dataset.frame : 'VISIBLE=' + vis.length;
  })()`);
  const ok = landed === a.to;
  results.push(`${ok ? "OK  " : "FAIL"} ${s.id} --[${a.match}]--> ${landed}${ok ? "" : " (expected " + a.to + ")"}`);
}
console.log(results.join("\n"));

// 3. Second action on branch screens (day one has two).
const branch = await ev(`(() => {
  show('53b');
  const screen = document.querySelector('[data-frame="53b"]');
  const el = [...screen.querySelectorAll('.hotspot')].find(e => (e.textContent||'').trim().startsWith('Shape the whole thing first'));
  if (!el) return 'NO-CONTROL';
  el.click();
  const vis = [...document.querySelectorAll('.screen')].filter(x => !x.hidden);
  return vis[0].dataset.frame;
})()`);
console.log("branch 53b 'Shape the whole thing first' ->", branch, branch === "89a" ? "OK" : "FAIL");

// 4. A details frame must not still contain the conversation it replaced.
//    This is what actually broke 88a: the transform inserted the details and left the old
//    column in place, so both fought for width. A layout heuristic could not see it; the
//    leftover content could. Frames built by transforming another frame get checked here.
const DETAILS_FRAMES = ["88a"];
const leftovers = await ev(`(() => {
  const bad = [];
  for (const id of ${JSON.stringify(['88a'])}) {
    const el = document.querySelector('[data-frame="' + id + '"]');
    if (!el) continue;
    const text = el.textContent || '';
    // A composer belongs to a conversation; a details screen has none (turn 88).
    for (const mark of ['Keep shaping', 'send', 'still a maybe']) {
      if (text.includes(mark)) bad.push(id + ' still contains "' + mark + '"');
    }
  }
  return JSON.stringify(bad);
})()`);
console.log("conversation left on a details frame:", leftovers);

// 5. Rendering sanity on every screen.
const render = await ev(`(() => {
  const bad = [];
  for (const s of STEPS) {
    show(s.id);
    const el = document.querySelector('[data-frame="' + s.id + '"]');
    const stage = el.querySelector('.stage');
    if (stage.clientHeight < 200) bad.push(s.id + ' stage h=' + stage.clientHeight);
  }
  const imgs = [...document.querySelectorAll('img')].filter(i => !i.complete || !i.naturalWidth);
  return JSON.stringify({ badStages: bad, brokenImgs: imgs.map(i => i.getAttribute('src')).slice(0,8),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth });
})()`);
console.log("render:", render);
console.log("console warnings:", logs.length ? logs : "none");

ws.close(); proc.kill(); process.exit(0);
