import assert from "node:assert/strict";
import { once } from "node:events";
import { lstat, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import WebSocket from "ws";
import { CACHE_CLEANUP_POLICY, NARRATOR_PREVIEW_TEXT, ulid, type DomainEvent, type RecoveryActionCommand } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { RecoveryControlService } from "../../src/recovery/control.js";
import { FileRecoveryControlStore } from "../../src/recovery/control-file.js";
import { AppStorageService } from "../../src/storage/service.js";
import { tempDir } from "../tmp.js";
import { until } from "../wait.js";

it("the authenticated host requires opt-in and Automatic mode before maintaining its measured low-space preview volume", { skip: process.platform !== "win32", timeout: 120_000 }, async () => {
  const root = await tempDir("arke-cache-maintenance-"), events: DomainEvent[] = [], provider = new FsWorldProvider(root);
  const bytes = Buffer.alloc(60); bytes.write("RIFF"); bytes.writeUInt32LE(52, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24);
  bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(16, 40);
  let low = false, cacheLow = true, cacheRootId: string | null = null, path: string | null = null, syntheses = 0, socket: WebSocket | undefined;
  const storage = new AppStorageService({ appRoot: root, native: {
    setRoots: roots => { cacheRootId = roots.find(root => root.path.endsWith("local-presets-v1"))?.rootId ?? null; }, stop: async () => {}, probe: async (rootId, _signal, after) => {
      let available = 20 * 1024 ** 3;
      if (low && (rootId !== cacheRootId || cacheLow)) {
        let exists = true; if (path) try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; exists = false; }
        available = (rootId === cacheRootId && !exists ? 6 : 4) * 1024 ** 3;
      }
      if (after !== undefined && Date.now() <= after) await new Promise(resolve => setTimeout(resolve, 1));
      return { state: "measured", source: "host-provided", limitations: [], capacity: { volumeId: rootId === cacheRootId ? "fixture-preview-volume" : "fixture-app-volume", mappingRevision: rootId,
        measuredAt: Date.now(), availableBytes: available, totalBytes: 100 * 1024 ** 3 } };
    },
  } });
  const coordinator = new Coordinator({ provider, adapter: null, appRoot: root, appVersion: "maintenance-fixture", storageHealth: storage,
    recoveryControl: new RecoveryControlService({ store: new FileRecoveryControlStore(join(root, "operations", "recovery.json")) }),
    changeLogPath: join(root, "changes.jsonl"), observeEvent: event => events.push(event), voice: { localPresets: [], cloudSources: [], sidecar: {
      health: async () => ({ engineStatus: { kokoro: { ready: true } } }), listVoices: async () => [{ id: "bm_george", label: "George", attributes: [] }],
      synthesize: async input => { assert.equal(input.text, NARRATOR_PREVIEW_TEXT); syntheses++; return bytes; }, transcribe: async () => "",
    } } });
  try {
    const { port, token } = await coordinator.start(); socket = new WebSocket(`ws://127.0.0.1:${port}`); let hello = false;
    socket.on("message", data => { if (JSON.parse(String(data)).kind === "snapshot") hello = true; });
    await once(socket, "open"); socket.send(JSON.stringify({ kind: "hello", token })); await until(() => hello, "authenticated maintenance host", 5000);
    const action = async (command: RecoveryActionCommand["command"]) => {
      const requestId = ulid(); socket!.send(JSON.stringify({ kind: "recovery-action", requestId, command }));
      await until(() => events.some(event => event.type === "recovery.action-result" && event.result.requestId === requestId), "saved maintenance setting", 15_000);
      return (events.findLast(event => event.type === "recovery.action-result" && event.result.requestId === requestId) as Extract<DomainEvent, { type: "recovery.action-result" }>).result;
    };
    const mode = async (value: "automatic" | "suggest-only") => {
      const requestId = ulid(); socket!.send(JSON.stringify({ kind: "recovery-set-mode", requestId, mode: value }));
      await until(() => events.some(event => event.type === "recovery.command-result" && event.result.requestId === requestId && event.result.status === "saved"), "saved recovery mode", 5000);
    };
    socket.send(JSON.stringify({ kind: "voice-catalogue" })); await until(() => events.some(event => event.type === "voice.catalogue"), "maintenance voices", 5000);
    const requestId = ulid(); socket.send(JSON.stringify({ kind: "catalogue-voice-preview", requestId, provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george", maxMicroUsd: 0 }));
    await until(() => events.some(event => event.type === "voice.catalogue-preview" && event.requestId === requestId && event.status === "ready"), "producer audition", 10_000);
    const ready = events.findLast(event => event.type === "voice.catalogue-preview" && event.requestId === requestId) as Extract<DomainEvent, { type: "voice.catalogue-preview" }>;
    const directory = join(root, "voice-previews", "local-presets-v1"); path = join(directory, ready.file!.slice(6));
    const old = new Date(Date.now() - CACHE_CLEANUP_POLICY.minAgeMs - 60_000); await utimes(path, old, old);
    const indexPath = join(directory, "receipts.json"), index = JSON.parse(await readFile(indexPath, "utf8"));
    index.entries[0].createdAt = old.getTime(); index.entries[0].modifiedNs = String((await lstat(path, { bigint: true })).mtimeNs); await writeFile(indexPath, JSON.stringify(index));
    const protectedPath = join(root, "retained-artifact.txt"); await writeFile(protectedPath, "protected fixture");
    low = true; await storage.wake(); assert.deepEqual(await readFile(path), bytes);
    assert.equal(coordinator.getState().app.recoveryPolicy?.cleanup?.maintenance?.enabled, false, "low space alone cannot grant maintenance");
    await mode("suggest-only"); const enabled = await action({ action: "set-cleanup-maintenance", enabled: true }); assert.equal(enabled.maintenanceSaved, true);
    await storage.wake(); assert.deepEqual(await readFile(path), bytes);
    const controlPath = join(root, "voice-previews", "cleanup-control.json");
    assert.equal(JSON.parse(await readFile(controlPath, "utf8")).maintenance.lastAttemptId, undefined, "Suggest only grants no automatic attempt");
    cacheLow = false; await storage.wake(); await mode("automatic"); await storage.wake();
    assert.deepEqual(await readFile(path), bytes, "pressure on another registered volume cannot authorize this cache's cleanup");
    assert.equal(JSON.parse(await readFile(controlPath, "utf8")).maintenance.lastAttemptId, undefined);
    cacheLow = true; await storage.wake();
    try {
      await until(() => coordinator.getState().app.recoveryPolicy?.cleanup?.maintenance?.lastRun?.status === "verified", "verified native maintenance outcome", 45_000);
    } catch (error) {
      assert.fail(JSON.stringify({ error: (error as Error).message, cleanup: coordinator.getState().app.recoveryPolicy?.cleanup,
        roots: coordinator.getState().app.storageHealth?.roots.map(root => ({ state: root.state, volume: root.capacity?.volumeId,
          available: root.capacity?.availableBytes, warning: root.pressure?.warning, measuredAt: root.capacity?.measuredAt })) }));
    }
    const run = coordinator.getState().app.recoveryPolicy!.cleanup!.maintenance!.lastRun!;
    assert.equal(run.cleanup.removedFiles, 1); assert.equal(run.cleanup.availableAfter, 6 * 1024 ** 3); assert.equal(run.cleanup.reclaimedBytes, null);
    await assert.rejects(readFile(path), { code: "ENOENT" }); assert.equal(await readFile(protectedPath, "utf8"), "protected fixture"); assert.equal(syntheses, 1);
    const disk = JSON.parse(await readFile(controlPath, "utf8")); assert.equal(disk.pending, null); assert.equal(disk.outcomes.at(-1).automatic, true);
    const disabled = await action({ action: "set-cleanup-maintenance", enabled: false }); assert.equal(disabled.maintenanceSaved, false);
    assert.equal(JSON.parse(await readFile(controlPath, "utf8")).maintenance.enabled, false);
  } finally { socket?.close(); await coordinator.stop(); await provider.close(); }
  assert(!(await readFile(join(root, "changes.jsonl"), "utf8")).includes("native-input-v1"));
});
