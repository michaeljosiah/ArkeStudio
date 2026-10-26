import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NativeSetupProcessJob } from "../../src/setup/process-job.js";
import { SetupProcessRunner, SetupProcessCleanupPending } from "../../src/setup/process.js";
import { tempDir } from "../tmp.js";
import { until } from "../wait.js";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };

it("bounds program output and confirms exit before admitting another command", { timeout: 90000 }, async () => {
  const runner = new SetupProcessRunner(); let output = 0;
  try {
    await assert.rejects(runner.run(process.execPath, ["-e", "const b=Buffer.alloc(65536,120);setInterval(()=>process.stdout.write(b),1)"],
      new AbortController().signal, text => { output += Buffer.byteLength(text); }), /stopped before owned completion/);
    assert(output > 0 && output <= 1024 * 1024);
    assert.equal((await runner.run(process.execPath, ["-e", "process.exit(0)"], new AbortController().signal)).code, 0);
  } finally { await runner.dispose(); }
});

it("forced host death kills its owned Windows setup command and surviving helper", { skip: process.platform !== "win32", timeout: 120000 }, async () => {
  const fixture = fileURLToPath(new URL("../fixtures/setup-process-host.ts", import.meta.url));
  const host = spawn(process.execPath, ["--import", "tsx", fixture], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const closed = new Promise<void>(resolve => { host.once("close", () => resolve()); });
  let output = "", stderr = ""; let pids: number[] = [];
  host.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString(); const frame = /owned (\d+) (\d+)/.exec(output);
    if (frame) pids = [Number(frame[1]), Number(frame[2])];
  });
  host.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
  try {
    await until(() => { if (host.exitCode !== null) throw new Error(`Setup host exited early: ${stderr}`); return pids.length === 2; }, "setup command and helper owned", 60000);
    assert(pids.every(pid => !gone(pid))); host.kill("SIGKILL"); await closed;
    await until(() => pids.every(gone), "kernel confirmed setup tree exit after forced host death", 30000);
  } finally { host.kill("SIGKILL"); await closed; }
});

it("runs a literal catalogue command after ownership, retaining bounded stdout/stderr and its actual exit code", { timeout: 90000 }, async () => {
  const runner = new SetupProcessRunner();
  try {
    const result = await runner.run(process.execPath, ["-e", "process.stdout.write(process.argv[1]);process.stderr.write('stderr');process.exit(7)", "literal ; $() `quote` •"], new AbortController().signal);
    assert.equal(result.code, 7); assert.match(result.output, /literal ; \$\(\) `quote` •/); assert.match(result.output, /stderr/);
  } finally { await runner.dispose(); }
});

it("does not execute a program before its native ownership gate succeeds", { timeout: 90000 }, async () => {
  const root = await tempDir("arke-setup-process-gate-"), marker = join(root, "started.txt"), entered = deferred(), finish = deferred(), native = new NativeSetupProcessJob();
  const runner = new SetupProcessRunner({ job: { bind: async (pid, signal) => { entered.resolve(); await finish.promise; await native.bind(pid, signal); },
    active: (pid, signal) => native.active(pid, signal), terminate: (pid, signal) => native.terminate(pid, signal) } });
  const running = runner.run(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`], new AbortController().signal);
  try {
    await entered.promise; assert.equal(await stat(marker).catch(() => null), null);
    finish.resolve(); assert.equal((await running).code, 0); assert.equal(await readFile(marker, "utf8"), "started");
  } finally { finish.resolve(); await runner.dispose(); await running.catch(() => {}); }
});

it("a command's parent exit cannot finish setup while its ordinary helper still writes", { timeout: 90000 }, async () => {
  const root = await tempDir("arke-setup-process-helper-"), marker = join(root, "finish"), native = new NativeSetupProcessJob(), observed = deferred(); let finished = false;
  const runner = new SetupProcessRunner({ job: { bind: (pid, signal) => native.bind(pid, signal),
    active: async (pid, signal) => { const count = await native.active(pid, signal); if (count > 1) observed.resolve(); return count; },
    terminate: (pid, signal) => native.terminate(pid, signal) } });
  const helper = `const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(timer);process.exit(0)}},20)`;
  // Windows Node normally kills its own non-detached children on exit. Suppress that
  // independent libuv backstop; this child still inherits Arke's non-breakaway kernel job.
  const script = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:'ignore',detached:process.platform==='win32'});child.once('spawn',()=>process.exit(0));child.once('error',()=>process.exit(9))`;
  const running = runner.run(process.execPath, ["-e", script], new AbortController().signal).then(value => { finished = true; return value; });
  try {
    await Promise.race([observed.promise, running.then(value => { throw new Error(`Setup completed before its helper exited (code ${value.code}).`); })]);
    assert(!finished); await writeFile(marker, "done"); assert.equal((await running).code, 0);
  } finally { await writeFile(marker, "done"); await runner.dispose(); await running.catch(() => {}); }
});

it("cancel confirms native command exit before releasing its run and never replays it", { timeout: 90000 }, async () => {
  const runner = new SetupProcessRunner(), control = new AbortController(); let pid = 0;
  const running = runner.run(process.execPath, ["-e", "process.stdout.write(String(process.pid));setInterval(()=>{},1000)"], control.signal, text => { pid = Number(text); });
  const refused = assert.rejects(running, /Setup was stopped/);
  try {
    await until(() => pid > 0, "owned setup program", 45000); control.abort(); await refused;
    await until(() => gone(pid), "cancelled setup program exited", 15000);
  } finally { control.abort(); await runner.dispose(); await refused; }
});

it("failed cleanup retains its owned process for confirmation and refuses another command until that confirmation", { timeout: 90000 }, async () => {
  const native = new NativeSetupProcessJob(); let allowStop = false, pid = 0;
  const runner = new SetupProcessRunner({ job: { bind: (id, signal) => native.bind(id, signal), active: (id, signal) => native.active(id, signal),
    terminate: async (id, signal) => { if (!allowStop) throw new Error("synthetic unconfirmed exit"); await native.terminate(id, signal); } } });
  const control = new AbortController(), running = runner.run(process.execPath, ["-e", "process.stdout.write(String(process.pid));setInterval(()=>{},1000)"], control.signal, text => { pid = Number(text); });
  const refused = assert.rejects(running, SetupProcessCleanupPending);
  try {
    await until(() => pid > 0, "retained setup program", 45000); control.abort(); await refused; assert(!gone(pid));
    await assert.rejects(runner.run(process.execPath, ["-e", "process.exit(0)"], new AbortController().signal), SetupProcessCleanupPending);
    allowStop = true; await runner.confirmCleanup(); await until(() => gone(pid), "retained program exit confirmed", 15000);
    assert.equal((await runner.run(process.execPath, ["-e", "process.exit(0)"], new AbortController().signal)).code, 0);
  } finally { allowStop = true; control.abort(); await runner.dispose(); await refused; }
});
