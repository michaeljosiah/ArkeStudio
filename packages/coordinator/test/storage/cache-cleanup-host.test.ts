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
import { tempDir } from "../tmp.js";
import { until } from "../wait.js";

it("the authenticated host previews without deletion, approves the exact native cleanup and refuses replay", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const root = await tempDir("arke-cleanup-host-"); const events: DomainEvent[] = [];
  const provider = new FsWorldProvider(root);
  const bytes = Buffer.alloc(60); bytes.write("RIFF"); bytes.writeUInt32LE(52, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24);
  bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(16, 40);
  let syntheses = 0, socket: WebSocket | undefined;
  const coordinator = new Coordinator({ provider, adapter: null, appRoot: root, appVersion: "fixture", changeLogPath: join(root, "changes.jsonl"),
    recoveryControl: new RecoveryControlService({ store: new FileRecoveryControlStore(join(root, "operations", "recovery.json")) }),
    observeEvent: event => events.push(event), voice: { localPresets: [], cloudSources: [], sidecar: {
      health: async () => ({ engineStatus: { kokoro: { ready: true } } }), listVoices: async () => [{ id: "bm_george", label: "George", attributes: [] }],
      synthesize: async input => { assert.equal(input.text, NARRATOR_PREVIEW_TEXT); syntheses++; return bytes; }, transcribe: async () => "",
    } } });
  try {
    const { port, token } = await coordinator.start();
    socket = new WebSocket(`ws://127.0.0.1:${port}`); let hello = false;
    socket.on("message", data => { if (JSON.parse(String(data)).kind === "snapshot") hello = true; });
    await once(socket, "open"); socket.send(JSON.stringify({ kind: "hello", token }));
    await until(() => hello, "authenticated host snapshot", 5000);
    socket.send(JSON.stringify({ kind: "voice-catalogue" }));
    await until(() => events.some(event => event.type === "voice.catalogue"), "local preset catalogue", 5000);
    const previewId = ulid();
    socket.send(JSON.stringify({ kind: "catalogue-voice-preview", requestId: previewId, provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george", maxMicroUsd: 0 }));
    await until(() => events.some(event => event.type === "voice.catalogue-preview" && event.requestId === previewId && event.status === "ready"), "generated local preview", 5000);
    const ready = events.findLast(event => event.type === "voice.catalogue-preview" && event.requestId === previewId) as Extract<DomainEvent, { type: "voice.catalogue-preview" }>;
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
    const review = await action({ action: "preview-cleanup" }); assert.equal(review.status, "preview"); assert(review.cleanupPlan);
    assert.equal(review.cleanupPlan.files, 1); assert.deepEqual(await readFile(path), bytes); assert.equal(syntheses, 1);
    await assert.rejects(readFile(join(root, "voice-previews", "cleanup-control.json")), { code: "ENOENT" });
    const completed = await action({ action: "approve-cleanup", planId: review.cleanupPlan.id });
    assert.equal(completed.status, "verified"); assert.equal(completed.cleanup?.removedFiles, 1); assert.equal(completed.cleanup?.reclaimedBytes, null);
    await assert.rejects(readFile(path), { code: "ENOENT" }); assert.equal(await readFile(protectedPath, "utf8"), "protected generated fixture");
    const repeated = await action({ action: "approve-cleanup", planId: review.cleanupPlan.id }); assert.equal(repeated.status, "refused"); assert.equal(repeated.reason, "stale");
    assert.equal(syntheses, 1); assert.equal(provider.openStore(), null);
    const control = JSON.parse(await readFile(join(root, "voice-previews", "cleanup-control.json"), "utf8"));
    assert.equal(control.pending, null); assert.equal(control.outcomes.length, 1); assert.equal(control.outcomes[0].status, "removed");
    assert(events.some(event => event.type === "recovery.policy" && event.policy.cleanup?.pending), "the flushed intent publishes its hold before final outcome");
  } finally { socket?.close(); await coordinator.stop(); await provider.close(); }
  assert(!(await readFile(join(root, "changes.jsonl"), "utf8")).includes("cleanup-local-preset-previews"), "cleanup authority never enters the diagnostic journal");
});
