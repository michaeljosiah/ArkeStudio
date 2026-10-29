// Disposable native fixture: exit synchronously after the worker record flushes, before its
// input gate returns. The parent verifies both process exits before reopening this app root.
import { readFileSync, writeSync } from "node:fs";
import { lstat, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import { CACHE_CLEANUP_POLICY, ulid, type DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { RecoveryControlService } from "../../src/recovery/control.js";
import { FileRecoveryControlStore } from "../../src/recovery/control-file.js";
import { until, untilAsync } from "../wait.js";

const root = process.argv[2]!;
if (!root || process.platform !== "win32") throw Error("Disposable Windows fixture root required.");
const bytes = Buffer.alloc(60); bytes.write("RIFF"); bytes.writeUInt32LE(52, 4); bytes.write("WAVEfmt ", 8);
bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24);
bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(16, 40);
const events: DomainEvent[] = [], controlPath = join(root, "voice-previews", "cleanup-control.json");
const provider = new FsWorldProvider(root);
const coordinator = new Coordinator({ provider, adapter: null, appRoot: root, appVersion: "crash-fixture", changeLogPath: join(root, "changes.jsonl"),
  recoveryControl: new RecoveryControlService({ store: new FileRecoveryControlStore(join(root, "operations", "recovery.json")) }),
  observeEvent: event => {
    events.push(event);
    if (event.type === "recovery.policy" && event.policy.cleanup?.pending) {
      const pending = JSON.parse(readFileSync(controlPath, "utf8")).pending;
      if (pending?.workerPid) { writeSync(1, "worker-intent-flushed\n"); process.exit(0); }
    }
  },
  voice: { localPresets: [], cloudSources: [], sidecar: {
    health: async () => ({ engineStatus: { kokoro: { ready: true } } }), listVoices: async () => [{ id: "bm_george", label: "George", attributes: [] }],
    synthesize: async () => bytes, transcribe: async () => "",
  } } });
let socket: WebSocket | undefined;
try {
  const { port, token } = await coordinator.start(); socket = new WebSocket(`ws://127.0.0.1:${port}`); let hello = false;
  socket.on("message", data => { if (JSON.parse(String(data)).kind === "snapshot") hello = true; });
  await once(socket, "open"); socket.send(JSON.stringify({ kind: "hello", token })); await until(() => hello, "fixture hello", 5000);
  socket.send(JSON.stringify({ kind: "voice-catalogue" })); await until(() => events.some(event => event.type === "voice.catalogue"), "fixture voices", 5000);
  const requestId = ulid(); socket.send(JSON.stringify({ kind: "catalogue-voice-preview", requestId, provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george", maxMicroUsd: 0 }));
  await until(() => events.some(event => event.type === "voice.catalogue-preview" && event.requestId === requestId && event.status === "ready"), "fixture audio", 5000);
  const ready = events.findLast(event => event.type === "voice.catalogue-preview" && event.requestId === requestId) as Extract<DomainEvent, { type: "voice.catalogue-preview" }>;
  const directory = join(root, "voice-previews", "local-presets-v1"), key = ready.file!.slice(6, -4), path = join(directory, `${key}.wav`);
  const old = new Date(Date.now() - CACHE_CLEANUP_POLICY.minAgeMs - 60_000); await utimes(path, old, old);
  const indexPath = join(directory, "receipts.json"), index = JSON.parse(await readFile(indexPath, "utf8"));
  index.entries[0].createdAt = old.getTime(); index.entries[0].modifiedNs = String((await lstat(path, { bigint: true })).mtimeNs);
  await writeFile(indexPath, JSON.stringify(index));
  let result: Extract<DomainEvent, { type: "recovery.action-result" }>["result"] | undefined;
  await untilAsync(async () => {
    const reviewId = ulid(); socket!.send(JSON.stringify({ kind: "recovery-action", requestId: reviewId, command: { action: "preview-cleanup" } }));
    await until(() => events.some(event => event.type === "recovery.action-result" && event.result.requestId === reviewId), "fixture review", 15_000);
    result = (events.findLast(event => event.type === "recovery.action-result" && event.result.requestId === reviewId) as Extract<DomainEvent, { type: "recovery.action-result" }>).result;
    return result.status === "preview";
  }, "verified native fixture review", 35_000);
  if (!result?.cleanupPlan) throw Error("Fixture lacks reviewed cleanup.");
  socket.send(JSON.stringify({ kind: "recovery-action", requestId: ulid(), command: { action: "approve-cleanup", planId: result.cleanupPlan.id } }));
  await until(() => false, "fixture native input gate", 15_000);
} catch {
  console.error("Disposable fixture did not reach its native worker gate."); process.exitCode = 1;
} finally { socket?.close(); await coordinator.stop(); await provider.close(); }
