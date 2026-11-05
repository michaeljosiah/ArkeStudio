import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import WebSocket from "ws";
import { FrameSchema, ulid, type Frame, type CreatorPublishingState } from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { FakeCreator } from "./helpers.js";

it("routes authenticated creator commands, preserves request IDs and excludes receipt feedback from the world changelog", async () => {
  const { root } = await makeTempRoot(); const provider = new FsWorldProvider(root); const creator = new FakeCreator(); const log = join(root, "logs", "events.jsonl"); let stopped = false; const called: string[] = [];
  const result: CreatorPublishingState = { configured: true, scopeId: creator.actor, publications: [], refusal: "creator-private-review-message" };
  const account = { current: () => creator.current(), onChange: creator.onChange.bind(creator), signIn: async () => {}, signOut: async () => {}, cancelSignIn: async () => {}, createAccount: async () => {}, open: async () => {} };
  const coordinator = new Coordinator({ provider, adapter: null, appRoot: root, cipher: devCipher(), manifest: SHIPPED_MANIFEST, changeLogPath: log, appVersion: "test", account,
    creatorPublishing: { list: async () => { called.push("list"); return result; }, prepare: async () => { called.push("prepare"); return result; }, submit: async () => { called.push("submit"); return result; }, control: async () => { called.push("control"); return result; }, onChange: () => () => {}, stop: async () => { stopped = true; } } });
  const { port, token } = await coordinator.start(0); const socket = new WebSocket(`ws://127.0.0.1:${port}`); const frames: Frame[] = []; socket.on("message", data => frames.push(FrameSchema.parse(JSON.parse(String(data)))));
  let closeReason = ""; socket.on("close", (code, reason) => { closeReason = code + ": " + reason.toString(); });
  const until = async (check: () => boolean) => { const end = Date.now() + 10000; while (!check()) { if (Date.now() > end) throw new Error("Wire reply timed out: " + closeReason + " " + frames.map(f => f.kind).join(",")); await new Promise(resolve => setTimeout(resolve, 10)); } };
  try { await new Promise<void>(resolve => socket.once("open", resolve)); socket.send(JSON.stringify({ kind: "hello", token, lastSeq: 0 })); await until(() => frames.some(f => f.kind === "snapshot"));
    const requestId = ulid(); socket.send(JSON.stringify({ kind: "creator-publishing-list", worldId: WORLD_ID, requestId })); await until(() => frames.some(f => f.kind === "event" && f.event.type === "creator-publishing.changed" && f.event.requestId === requestId));
    const controlId = ulid(); socket.send(JSON.stringify({ kind: "creator-publishing-control", worldId: WORLD_ID, requestId: controlId, id: "11111111-1111-4111-8111-111111111111", action: "refresh" })); await until(() => frames.some(f => f.kind === "event" && f.event.type === "creator-publishing.changed" && f.event.requestId === controlId)); assert.deepEqual(called, ["list", "control"]);
  } finally { socket.close(); await coordinator.stop(); await provider.close(); }
  assert.equal(stopped, true); const journal = await readFile(log, "utf8"); assert.ok(journal.includes("env.check")); assert.ok(!journal.includes("creator-private-review-message")); assert.ok(!journal.includes("creator-publishing.changed"));
});
