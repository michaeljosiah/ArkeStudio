import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { it } from "node:test";
import WebSocket from "ws";
import { FrameSchema, ulid, type Frame, type RecoveryActionCommand } from "@arke-studio/contracts";
import { createStudioCoordinator } from "../../src/application/studio-host.js";
import { ChildLedger } from "../../src/child-ledger.js";
import { MingProcess } from "../../src/local-ai/ming.js";
import type { LocalGpu } from "../../src/local-ai/gpu.js";
import { NativeSetupProcessJob } from "../../src/setup/process-job.js";
import { RecoveryControlService } from "../../src/recovery/control.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { tempDir } from "../tmp.js";
import { until, untilAsync } from "../wait.js";

for (const audit of ["available", "unavailable"] as const) it(`the authenticated production host reviews original Ming cleanup with ${audit} recovery audit and no replay`, { timeout: 120_000 }, async () => {
  const root = await tempDir("ming-recovery-host-"), worker = join(root, "worker.mjs"), ready = join(root, "ready"), creative = join(root, "creative.txt");
  await writeFile(creative, "original creative bytes");
  await writeFile(worker, `import {writeFileSync,appendFileSync} from 'node:fs';writeFileSync(process.argv[2],String(process.pid));appendFileSync(process.argv[2]+'.starts','started\\n');setInterval(()=>{},1000);`);
  let refuse = true, terminations = 0; const native = new NativeSetupProcessJob(), ledger = new ChildLedger(join(root, "children.json"));
  const owner = new MingProcess(ledger, { prepareCommand: (command, args) => ({ command, args: args.slice(1) }), job: {
    bind: (pid, signal) => native.bind(pid, signal), active: (pid, signal) => native.active(pid, signal),
    terminate: async (pid, signal) => { terminations++; if (refuse) throw new Error("synthetic retained worker"); await native.terminate(pid, signal); },
  } });
  const provider = new FsWorldProvider(root), coordinator = createStudioCoordinator({ provider, adapter: null, appRoot: root,
    storageHealth: null, systemResources: null, ming: owner, changeLogPath: join(root, "changes.jsonl"), appVersion: "test",
    ...(audit === "unavailable" ? { recoveryControl: new RecoveryControlService({ store: {
      load: async () => { throw Object.assign(new Error("synthetic audit unavailable"), { code: "ENOSPC" }); },
      save: async () => { throw Object.assign(new Error("synthetic audit unavailable"), { code: "ENOSPC" }); },
    } }) } : {}) });
  const abort = new AbortController(); let socket: WebSocket | undefined;
  try {
    assert(!owner.cleanupAuthorized);
    const session = await coordinator.start(), frames: Frame[] = [];
    assert.equal(coordinator.getState().app.recoveryPolicy?.audit, audit);
    if (audit === "unavailable") assert.equal(coordinator.getState().app.recoveryPolicy?.accepting, false);
    socket = new WebSocket(`ws://127.0.0.1:${session.port}`);
    socket.on("message", data => frames.push(FrameSchema.parse(JSON.parse(String(data)))));
    await once(socket, "open"); socket.send(JSON.stringify({ kind: "hello", token: session.token }));
    await until(() => frames.some(frame => frame.kind === "snapshot"), "authenticated Ming owner");
    const action = async (command: RecoveryActionCommand["command"]) => {
      const requestId = ulid(); socket!.send(JSON.stringify({ kind: "recovery-action", requestId, command }));
      const result = () => frames.findLast(frame => frame.kind === "event" && frame.event.type === "recovery.action-result" &&
        frame.event.result.requestId === requestId && frame.event.result.status !== "accepted");
      await until(() => result() !== undefined, "Ming action receipt", 40_000);
      const frame = result()!; assert(frame.kind === "event" && frame.event.type === "recovery.action-result"); return frame.event.result;
    };
    const batch = coordinator.generateMingBatch({ python: process.execPath, worker, args: [ready], cacheRoot: join(root, "cache") }, abort.signal);
    const failed = assert.rejects(batch, /not confirmed process exit/);
    await untilAsync(async () => readFile(ready, "utf8").then(() => true, () => false), "native Ming worker", 45_000);
    assert(!owner.cleanupAuthorized, "a live batch cannot offer the retained-cleanup action");
    const pid = Number(await readFile(ready, "utf8")); abort.abort(new Error("user stopped narration")); await failed;
    assert(owner.cleanupAuthorized); process.kill(pid, 0);
    await until(() => coordinator.getState().app.recoveryPolicy?.mingCleanup?.available === true, "proactive retained cleanup availability");
    const state = coordinator.getState(), source = state.app.recoveryPolicy!.mingCleanup!; assert(source.scope); assert.equal(source.state, "held");
    await until(() => coordinator.getState().app.recoveryHistory?.incidents.some(row => row.kind === "ming-cleanup-unconfirmed") === true, "proactive Ming incident");
    const gpu = (coordinator as unknown as { localGpu: LocalGpu }).localGpu; let admitted = false;
    const waiting = gpu.acquire("ComfyUI", new AbortController().signal).then(release => { admitted = true; return release; });
    const before = terminations, review = await action({ action: "preview-ming-cleanup", scope: source.scope });
    assert(review.mingPlan); assert.equal(terminations, before); assert(!admitted);
    const unknown = await action({ action: "approve-ming-cleanup", planId: review.mingPlan.id }); assert.equal(unknown.status, "unknown");
    process.kill(pid, 0); assert(!admitted); assert(gpu.isBusy("Ming"));
    await until(() => coordinator.getState().app.recoveryPolicy?.mingCleanup?.available === true, "failed cleanup can be reviewed again after executor settles");
    refuse = false;
    const next = await action({ action: "preview-ming-cleanup", scope: source.scope }); assert(next.mingPlan);
    const verified = await action({ action: "approve-ming-cleanup", planId: next.mingPlan.id }); assert.equal(verified.status, "verified");
    (await waiting)(); assert(admitted); assert.throws(() => process.kill(pid, 0)); assert(!owner.running);
    assert.equal(await readFile(ready + ".starts", "utf8"), "started\n"); assert.equal(await readFile(creative, "utf8"), "original creative bytes");
    assert.equal((await action({ action: "approve-ming-cleanup", planId: next.mingPlan.id })).status, "refused");
    await until(() => coordinator.getState().app.recoveryHistory?.actions?.filter(row => row.action === "confirm-ming-cleanup").length === 2, "historical failed and confirmed cleanup receipts");
    await until(() => coordinator.getState().app.recoveryHistory?.incidents.some(row => row.kind === "ming-cleanup-unconfirmed" && row.phase === "recovered") === true, "exact original incident cleared by positive confirmation");
    const serialized = JSON.stringify(coordinator.getState().app.recoveryPolicy!.mingCleanup);
    for (const excluded of [root, worker, "pid", "nativeToken"]) assert(!serialized.includes(excluded));
    assert.deepEqual(JSON.parse(await readFile(join(root, "children.json"), "utf8")).children, []);
  } finally { refuse = false; abort.abort(); socket?.close(); await coordinator.stop(); await provider.close(); }
});
