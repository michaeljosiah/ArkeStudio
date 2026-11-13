import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lstat, mkdir, readFile, rename, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import WebSocket from "ws";
import { CACHE_CLEANUP_POLICY, FrameSchema, NARRATOR_PREVIEW_TEXT, ulid, type DomainEvent, type RecoveryActionCommand } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { RecoveryControlService } from "../../src/recovery/control.js";
import { FileRecoveryControlStore } from "../../src/recovery/control-file.js";
import { tempDir } from "../tmp.js";
import { until, untilAsync } from "../wait.js";
import { probeProcesses } from "../../src/child-ledger.js";
import { AppStorageService } from "../../src/storage/service.js";
import { RecoveryHistoryService } from "../../src/recovery/history.js";
import { FileRecoveryHistoryStore } from "../../src/recovery/history-file.js";

it("the authenticated host previews without deletion, approves the exact native cleanup and refuses replay", { skip: process.platform !== "win32", timeout: 120_000 }, async () => {
  const root = await tempDir("arke-cleanup-host-"); const events: DomainEvent[] = [], wireEvents: DomainEvent[] = [];
  const provider = new FsWorldProvider(root);
  const bytes = Buffer.alloc(60); bytes.write("RIFF"); bytes.writeUInt32LE(52, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24);
  bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(16, 40);
  let syntheses = 0, socket: WebSocket | undefined, low = false, mapping = 1;
  const storage = new AppStorageService({ appRoot: root, native: { setRoots: () => {}, stop: async () => {},
    probe: async (rootId, _signal, after) => {
      if (after !== undefined && Date.now() <= after) await new Promise(resolve => setTimeout(resolve, 1));
      return { state: "measured", source: "host-provided", limitations: [], capacity: { volumeId: "fixture-volume", mappingRevision: `${rootId}-${mapping}`,
        measuredAt: Date.now(), availableBytes: (low ? 4 : 20) * 1024 ** 3, totalBytes: 100 * 1024 ** 3 } };
    } } });
  const coordinator = new Coordinator({ provider, adapter: null, appRoot: root, appVersion: "fixture", changeLogPath: join(root, "changes.jsonl"),
    storageHealth: storage,
    recoveryHistory: new RecoveryHistoryService({ store: new FileRecoveryHistoryStore(join(root, "operations", "recovery-history.json")) }),
    recoveryControl: new RecoveryControlService({ store: new FileRecoveryControlStore(join(root, "operations", "recovery.json")) }),
    observeEvent: event => events.push(event), voice: { localPresets: [], cloudSources: [], sidecar: {
      health: async () => ({ engineStatus: { kokoro: { ready: true } } }), listVoices: async () => [{ id: "bm_george", label: "George", attributes: [] }],
      synthesize: async input => { assert.equal(input.text, NARRATOR_PREVIEW_TEXT); syntheses++; return bytes; }, transcribe: async () => "",
    } } });
  try {
    const { port, token } = await coordinator.start();
    socket = new WebSocket(`ws://127.0.0.1:${port}`); let hello = false;
    socket.on("message", data => { const frame = FrameSchema.parse(JSON.parse(String(data))); if (frame.kind === "snapshot") hello = true;
      else if (frame.kind === "event") wireEvents.push(frame.event); });
    await once(socket, "open"); socket.send(JSON.stringify({ kind: "hello", token }));
    await until(() => hello, "authenticated host snapshot", 5000);
    socket.send(JSON.stringify({ kind: "voice-catalogue" }));
    await until(() => events.some(event => event.type === "voice.catalogue"), "local preset catalogue", 5000);
    const previewId = ulid();
    socket.send(JSON.stringify({ kind: "catalogue-voice-preview", requestId: previewId, provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george", maxMicroUsd: 0 }));
    await until(() => events.some(event => event.type === "voice.catalogue-preview" && event.requestId === previewId && (event.status === "ready" || event.status === "failed")), "generated local preview outcome", 20_000);
    const ready = events.findLast(event => event.type === "voice.catalogue-preview" && event.requestId === previewId) as Extract<DomainEvent, { type: "voice.catalogue-preview" }>;
    assert.equal(ready.status, "ready", ready.error);
    assert.match(ready.file!, /^local-[a-f0-9]{64}\.wav$/);
    const directory = join(root, "voice-previews", "local-presets-v1"), key = ready.file!.slice(6, -4), path = join(directory, `${key}.wav`);
    // Simulate elapsed retention time only in this producer-created fixture. Preserve identity/content.
    const old = new Date(Date.now() - CACHE_CLEANUP_POLICY.minAgeMs - 60_000); await utimes(path, old, old);
    const indexPath = join(directory, "receipts.json"), index = JSON.parse(await readFile(indexPath, "utf8"));
    index.entries[0].createdAt = old.getTime(); index.entries[0].modifiedNs = String((await lstat(path, { bigint: true })).mtimeNs);
    await writeFile(indexPath, JSON.stringify(index));
    const protectedPath = join(root, "retained-artifact.txt"); await writeFile(protectedPath, "protected generated fixture");
    const action = async (command: RecoveryActionCommand["command"]) => {
      const requestId = ulid(); socket!.send(JSON.stringify({ kind: "recovery-action", requestId, command }));
      await until(() => events.some(event => event.type === "recovery.action-result" && event.result.requestId === requestId && event.result.status !== "accepted"), "cleanup host receipt", 15_000);
      return (events.findLast(event => event.type === "recovery.action-result" && event.result.requestId === requestId) as Extract<DomainEvent, { type: "recovery.action-result" }>).result;
    };
    low = true; await storage.wake();
    await until(() => coordinator.getState().app.recoveryPolicy?.cleanup?.scope?.candidateFiles === 1, "scoped receipt observation", 5000);
    const scope = coordinator.getState().app.recoveryPolicy!.cleanup!.scope!.revision;
    await until(() => wireEvents.some(event => event.type === "diagnostics.snapshot" && event.snapshot.findings.some(finding =>
      finding.kind === "storage-pressure" && finding.remedy?.control === "local-preview-cleanup-review" && finding.remedy.target === scope)),
    "derived warning offers the actual cache scope", 5000);
    const wrong = await action({ action: "preview-cleanup", scope: "f".repeat(64) }); assert.equal(wrong.status, "refused");
    assert.deepEqual(await readFile(path), bytes);
    // A loaded Windows runner can refuse its bounded, read-only native observation. Wait for
    // a verified review; do not retry approval or turn a refused probe into deletion authority.
    let review: Awaited<ReturnType<typeof action>> | undefined;
    await untilAsync(async () => { review = await action({ action: "preview-cleanup", scope }); return review.status === "preview"; }, "verified native cleanup review", 35_000);
    assert(review?.cleanupPlan);
    assert.equal(review.cleanupPlan.files, 1); assert.deepEqual(await readFile(path), bytes); assert.equal(syntheses, 1);
    assert.equal(review.cleanupPlan.scope, scope);
    mapping++; await storage.wake();
    await until(() => !!coordinator.getState().app.recoveryPolicy?.cleanup?.scope && coordinator.getState().app.recoveryPolicy!.cleanup!.scope!.revision !== scope,
      "changed volume mapping invalidates warning target", 5000);
    const stale = await action({ action: "approve-cleanup", planId: review.cleanupPlan.id });
    assert.equal(stale.status, "refused"); assert.equal(stale.cleanup?.removedFiles, 0); assert.deepEqual(await readFile(path), bytes);
    assert.equal((await action({ action: "preview-cleanup", scope })).status, "refused");
    const currentScope = coordinator.getState().app.recoveryPolicy!.cleanup!.scope!.revision;
    await untilAsync(async () => { review = await action({ action: "preview-cleanup", scope: currentScope }); return review.status === "preview"; }, "refreshed scoped native review", 35_000);
    assert(review?.cleanupPlan); assert.equal(review.cleanupPlan.scope, currentScope);
    // Swap only this fixture's named producer directory. A same-path successor is not
    // the original approved root, even if it contains the same audition basename.
    const heldDirectory = join(root, "voice-previews", "held-original-fixture"), successorDirectory = join(root, "voice-previews", "retained-successor-fixture");
    await rename(directory, heldDirectory); await mkdir(directory); await writeFile(path, "protected successor");
    const replaced = await action({ action: "approve-cleanup", planId: review.cleanupPlan.id });
    assert.equal(replaced.status, "refused"); assert.equal(replaced.cleanup?.removedFiles, 0);
    assert.equal(await readFile(path, "utf8"), "protected successor"); assert.deepEqual(await readFile(join(heldDirectory, `${key}.wav`)), bytes);
    await rename(directory, successorDirectory); await rename(heldDirectory, directory); await storage.wake();
    await until(() => coordinator.getState().app.recoveryPolicy?.cleanup?.scope?.revision === currentScope, "restored original root observation", 5000);
    await untilAsync(async () => { review = await action({ action: "preview-cleanup", scope: currentScope }); return review.status === "preview"; }, "new review of original restored root", 35_000);
    assert(review?.cleanupPlan);
    const before = JSON.parse(await readFile(join(root, "voice-previews", "cleanup-control.json"), "utf8"));
    assert.equal(before.pending, null); assert.deepEqual(before.outcomes, []); assert.equal(before.runs.length, 2);
    assert(before.runs.every((run: { status: string }) => run.status === "refused"));
    const completed = await action({ action: "approve-cleanup", planId: review.cleanupPlan.id });
    assert.equal(completed.status, "verified"); assert.equal(completed.cleanup?.removedFiles, 1); assert.equal(completed.cleanup?.reclaimedBytes, null);
    await assert.rejects(readFile(path), { code: "ENOENT" }); assert.equal(await readFile(protectedPath, "utf8"), "protected generated fixture");
    assert.equal(await readFile(join(successorDirectory, `${key}.wav`), "utf8"), "protected successor");
    const repeated = await action({ action: "approve-cleanup", planId: review.cleanupPlan.id }); assert.equal(repeated.status, "refused"); assert.equal(repeated.reason, "stale");
    assert.equal(syntheses, 1); assert.equal(provider.openStore(), null);
    const control = JSON.parse(await readFile(join(root, "voice-previews", "cleanup-control.json"), "utf8"));
    assert.equal(control.pending, null); assert.equal(control.outcomes.length, 1); assert.equal(control.outcomes[0].status, "removed");
    await until(() => coordinator.getState().app.recoveryHistory?.actionCount === 3, "retained scoped action outcomes", 5000);
    assert.equal(coordinator.getState().app.recoveryHistory!.actions!.filter(row => row.outcome === "verified").length, 1);
    assert.equal(coordinator.getState().app.recoveryHistory!.actions!.filter(row => row.outcome === "refused").length, 2);
    assert(events.some(event => event.type === "recovery.policy" && event.policy.cleanup?.pending), "the flushed intent publishes its hold before final outcome");
  } finally { socket?.close(); await coordinator.stop(); await provider.close(); }
  assert(!(await readFile(join(root, "changes.jsonl"), "utf8")).includes("cleanup-local-preset-previews"), "cleanup authority never enters the diagnostic journal");
});

it("a new authenticated host settles a crashed native worker intent without deletion or synthesis replay", { skip: process.platform !== "win32", timeout: 180_000 }, async () => {
  const root = await tempDir("arke-cleanup-restart-"), protectedPath = join(root, "retained-artifact.txt");
  await writeFile(protectedPath, "protected fixture sibling");
  const stdout = await new Promise<string>((resolve, reject) => execFile(process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./cache-cleanup-crash-fixture.ts", import.meta.url)), root],
    { windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  assert(stdout.includes("worker-intent-flushed"));
  const controlPath = join(root, "voice-previews", "cleanup-control.json"), disk = JSON.parse(await readFile(controlPath, "utf8"));
  assert(disk.pending?.workerPid); assert.notEqual(disk.pending.owner.pid, process.pid);
  const pids = [disk.pending.owner.pid, disk.pending.workerPid];
  // Reuse the process ledger's bounded 30s native probe; a loaded Windows host can spend
  // more than five seconds starting PowerShell/CIM without revealing any process evidence.
  await untilAsync(async () => { const rows = await probeProcesses(pids); return pids.every(pid => !rows.has(pid)); }, "original owner and leashed native worker exit", 45_000);
  const path = join(root, "voice-previews", "local-presets-v1", `${disk.pending.key}.wav`), original = await readFile(path);
  const events: DomainEvent[] = [], provider = new FsWorldProvider(root);
  const coordinator = new Coordinator({ provider, adapter: null, appRoot: root, appVersion: "restart-fixture", changeLogPath: join(root, "changes.jsonl"),
    recoveryControl: new RecoveryControlService({ store: new FileRecoveryControlStore(join(root, "operations", "recovery.json")) }),
    voice: { localPresets: [], cloudSources: [], sidecar: null }, observeEvent: event => events.push(event) });
  let socket: WebSocket | undefined;
  try {
    const { port, token } = await coordinator.start();
    const settled = JSON.parse(await readFile(controlPath, "utf8")); assert.equal(settled.pending, null); assert.equal(settled.outcomes.at(-1).status, "retained");
    assert.deepEqual(await readFile(path), original); assert.equal(await readFile(protectedPath, "utf8"), "protected fixture sibling");
    socket = new WebSocket(`ws://127.0.0.1:${port}`); let hello = false;
    socket.on("message", data => { if (JSON.parse(String(data)).kind === "snapshot") hello = true; });
    await once(socket, "open"); socket.send(JSON.stringify({ kind: "hello", token })); await until(() => hello, "reopened authenticated host", 5000);
    const requestId = ulid(); socket.send(JSON.stringify({ kind: "recovery-action", requestId, command: { action: "reconcile-cleanup" } }));
    await until(() => events.some(event => event.type === "recovery.action-result" && event.result.requestId === requestId), "already settled reconciliation refusal", 5000);
    assert.equal((events.findLast(event => event.type === "recovery.action-result" && event.result.requestId === requestId) as Extract<DomainEvent, { type: "recovery.action-result" }>).result.status, "refused");
    assert(!events.some(event => event.type === "voice.catalogue-preview"), "reopening never requests synthesis");
  } finally { socket?.close(); await coordinator.stop(); await provider.close(); }
});
