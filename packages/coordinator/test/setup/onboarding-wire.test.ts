import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import WebSocket from "ws";
import { FrameSchema, NEW_ONBOARDING, type Frame } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { tempDir } from "../tmp.js";
import { FIXTURE_WORLD } from "../world/helpers.js";

it("authenticated first run checks, saves, reopens and imports without any AI service", async () => {
  const root = await tempDir("arke-onboarding-wire-");
  let choose: string | null = FIXTURE_WORLD;
  const start = async () => {
    const provider = new FsWorldProvider(root); await provider.ensureAppRoot();
    const coordinator = new Coordinator({ provider, adapter: null, appRoot: root, appVersion: "test", changeLogPath: join(root, "logs", "changes.jsonl"), chooseWorldFolder: async () => choose });
    const { port, token } = await coordinator.start(0);
    const socket = new WebSocket(`ws://127.0.0.1:${port}`); const frames: Frame[] = [];
    socket.on("message", raw => frames.push(FrameSchema.parse(JSON.parse(String(raw)))));
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const until = async (predicate: (f: Frame) => boolean) => {
      const end = Date.now() + 8000;
      while (Date.now() < end) { const hit = frames.find(predicate); if (hit) return hit; await new Promise(resolve => setTimeout(resolve, 10)); }
      throw new Error("Expected onboarding reply did not arrive.");
    };
    const send = (message: unknown) => socket.send(JSON.stringify(message));
    send({ kind: "hello", token, lastSeq: 0 }); await until(f => f.kind === "snapshot");
    return { coordinator, send, until, close: async () => { socket.close(); await coordinator.stop(); } };
  };
  let session = await start();
  try {
    assert.equal(session.coordinator.getState().app.onboarding?.plan.step, "choose");
    session.send({ kind: "check-onboarding" });
    await session.until(f => f.kind === "event" && f.event.type === "onboarding.changed" && f.event.onboarding.workspace?.ready === true);
    session.send({ kind: "save-onboarding", action: "install", plan: { ...NEW_ONBOARDING, persona: "guided", writing: "local", modelId: "invented" } });
    await session.until(f => f.kind === "event" && f.event.type === "command.failed" && f.event.command === "save-onboarding");
    assert.equal(session.coordinator.getState().app.onboarding?.plan.step, "choose");
    session.send({ kind: "save-onboarding", action: "finish", plan: { ...NEW_ONBOARDING, persona: "lightweight", step: "lightweight" } });
    await session.until(f => f.kind === "event" && f.event.type === "onboarding.changed" && f.event.onboarding.plan.step === "done");
  } finally { await session.close(); }
  session = await start();
  try {
    assert.equal(session.coordinator.getState().app.onboarding?.plan.step, "done");
    assert.equal(session.coordinator.getState().app.setup, null);
    session.send({ kind: "import-world", requestId: "import-one" });
    const imported = await session.until(f => f.kind === "event" && f.event.type === "world.import-result" && f.event.requestId === "import-one");
    assert.ok(imported.kind === "event" && imported.event.type === "world.import-result" && imported.event.worldId);
    assert.equal(session.coordinator.getState().worlds.length, 1);
    choose = null;
    session.send({ kind: "import-world", requestId: "cancelled" });
    const cancelled = await session.until(f => f.kind === "event" && f.event.type === "world.import-result" && f.event.requestId === "cancelled");
    assert.ok(cancelled.kind === "event" && cancelled.event.type === "world.import-result" && cancelled.event.cancelled);
    assert.equal(session.coordinator.getState().worlds.length, 1);
  } finally { await session.close(); }
});
