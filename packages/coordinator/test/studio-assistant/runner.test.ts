import assert from "node:assert/strict";
import { EventEmitter, on } from "node:events";
import { it } from "node:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STUDIO_ASSISTANT_LIMITS, type CreateSessionInput, type HarnessAdapter, type HarnessEvent, type SendMessageInput, type SessionConfigInput } from "@arke-studio/contracts";
import { HarnessStudioModelRunner } from "../../src/studio-assistant/runner.js";
import { StudioAssistantService } from "../../src/studio-assistant/service.js";
import { FileStudioConversationStore } from "../../src/studio-assistant/store.js";
import { studioDiagnosticEvidence } from "../../src/studio-assistant/evidence.js";
import { withLocalGpu } from "../../src/harness/local-gpu.js";
import { withModelValidation } from "../../src/harness/model-validation.js";
import { HarnessRuntimeChanges } from "../../src/harness/runtime-change.js";
import { LocalGpu } from "../../src/local-ai/gpu.js";
import { tempDir } from "../tmp.js";
import { until, untilAsync } from "../wait.js";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture() {
  const scratch = await tempDir("arke-studio-runner-"), events = new EventEmitter(); events.setMaxListeners(0);
  const prepared: SessionConfigInput[] = [], created: CreateSessionInput[] = [], sent: SendMessageInput[] = [];
  let revision = 1, identity = "c".repeat(64), local = true, answer = '{"kind":"reply","text":"A reply."}',
    catalogGate: Promise<void> | undefined, creationGate: Promise<void> | undefined, sendGate: Promise<void> | undefined, failure = false, retained = false;
  const raw: HarnessAdapter = { id: "test", privateSessions: true, capabilities: () => new Set(["events", "models"]), readiness: () => ({ ready: true }), lifecycleRevision: () => revision,
    async listModels() { await catalogGate; return [{ id: "test", provider: "ollama" }]; },
    prepareSession(input) { prepared.push(input); }, sessionFiles: () => [{ name: "opencode.json", contents: "{}" }],
    async createSession(input) { created.push(input); await creationGate; if (retained) await writeFile(join(input.cwd!, "unrecognized.txt"), "KEEP_UNKNOWN_BYTES"); return { sessionId: `studio-${created.length}`, privateEvents: (signal: AbortSignal) => raw.streamEvents(signal) }; },
    async sendMessage(input) { sent.push(input); await sendGate;
      if (failure) { events.emit("event", { type: "session.error", sessionId: input.sessionId, message: "private backend failure" } satisfies HarnessEvent); throw new Error("unknown outcome"); }
      events.emit("event", { type: "message.completed", sessionId: input.sessionId, text: answer } satisfies HarnessEvent); return { sessionId: input.sessionId, correlationId: input.correlationId! }; },
    dispatchAsync: async () => { throw new Error("Only sendMessage owns model completion"); }, interrupt: async () => {},
    streamEvents(signal) { const iterator = on(events, "event", { signal }); return { async *[Symbol.asyncIterator]() {
      try { for await (const [event] of iterator) yield event as HarnessEvent; } catch (error) { if (!signal?.aborted) throw error; }
    } }; },
  };
  const deps = { adapter: () => raw, scratch, sessionInput: async (input: SessionConfigInput) => ({ ...input, worldQueryUrl: "PRIVATE_WORLD_TOKEN", memoryDir: "PRIVATE_WORLD_NOTES", authorNotesFile: "PRIVATE_AUTHOR_NOTES", researchWeb: true,
    agents: { "world-builder": { brief: "PRIVATE_WORLD_OVERRIDE" } } }), destination: () => ({ identity, local }), timeoutMs: 5000 };
  const runner = new HarnessStudioModelRunner(deps);
  return { raw, deps, runner, scratch, prepared, created, sent, revision: () => { revision++; }, destination: () => { identity = "d".repeat(64); }, cloud: () => { local = false; },
    emit: (event: HarnessEvent) => { events.emit("event", event); },
    answer: (text: string) => { answer = text; }, catalog: (gate: Promise<void>) => { catalogGate = gate; }, create: (gate: Promise<void>) => { creationGate = gate; },
    send: (gate: Promise<void>) => { sendGate = gate; }, fail: () => { failure = true; }, keep: () => { retained = true; } };
}
const input = { role: "studio-assistant" as const, model: "ollama/test", prompt: "A bounded Studio question." }, allow = async () => ({ cloudApproved: false });
it("refuses a harness without private session isolation before preparing or sending content", async () => {
  const h = await fixture(); delete (h.raw as { privateSessions?: true }).privateSessions;
  try { await assert.rejects(h.runner.run(input, new AbortController().signal, allow), /private operational sessions/); assert.equal(h.created.length, 0); assert.equal(h.prepared.length, 0); assert.equal(h.sent.length, 0); }
  finally { await h.runner.stop(); await h.runner.ownerStopped(); }
});
it("refuses a claimed private session whose native owner returns no private observer", async () => {
  const h = await fixture(); const create = h.raw.createSession.bind(h.raw);
  h.raw.createSession = async value => { const session = await create(value); delete session.privateEvents; return session; };
  try { await assert.rejects(h.runner.run(input, new AbortController().signal, allow), /private session observer/); assert.equal(h.created[0]?.visibility, "private"); assert.equal(h.sent.length, 0); }
  finally { await h.runner.stop(); await h.runner.ownerStopped(); }
});
it("refuses a missing lifecycle fence instead of treating an absent generation as unchanged", async () => {
  const h = await fixture(); delete h.raw.lifecycleRevision;
  try { await assert.rejects(h.runner.run(input, new AbortController().signal, allow), /no verified generation/); assert.equal(h.created.length, 0); assert.equal(h.sent.length, 0); }
  finally { await h.runner.stop(); await h.runner.ownerStopped(); }
});
for (const change of ["route", "generation"] as const) {
  it(`rechecks ${change} after GPU admission through the production wrapper order`, async () => {
    const h = await fixture(), gpu = new LocalGpu(async () => {}), owner = await gpu.acquire("ComfyUI", new AbortController().signal);
    const adapter = withModelValidation(withLocalGpu(new HarnessRuntimeChanges().wrap(h.raw), gpu), async () => ({}));
    const runner = new HarnessStudioModelRunner({ ...h.deps, adapter: () => adapter });
    try {
      const refused = assert.rejects(runner.run(input, new AbortController().signal, allow), /could not be completed/);
      await until(() => gpu.isBusy("Ollama"), "Studio queued on the GPU after its route was approved");
      if (change === "route") { h.cloud(); h.destination(); } else h.revision();
      owner(); await refused;
      await until(() => !runner.busy(), "changed route was refused before native dispatch");
      assert.equal(h.sent.length, 0); assert.equal(gpu.isBusy("Ollama"), false);
    } finally { owner(); await runner.stop(); await adapter.dispose?.(); await runner.ownerStopped(); gpu.stop(); }
  });
}
it("retires cancellation while queued for the GPU and admits a fresh explicitly requested turn", async () => {
  const h = await fixture(), gpu = new LocalGpu(async () => {}), owner = await gpu.acquire("ComfyUI", new AbortController().signal);
  const adapter = withModelValidation(withLocalGpu(new HarnessRuntimeChanges().wrap(h.raw), gpu), async () => ({}));
  const runner = new HarnessStudioModelRunner({ ...h.deps, adapter: () => adapter }), stop = new AbortController();
  try {
    const cancelled = assert.rejects(runner.run(input, stop.signal, allow), /stopped/);
    await until(() => gpu.isBusy("Ollama"), "first Studio turn queued"); stop.abort(); await cancelled;
    await until(() => !runner.busy(), "confirmed not-dispatched Studio turn retired");
    assert.equal(h.sent.length, 0); assert.equal(gpu.isBusy("ComfyUI"), true);
    const next = runner.run(input, new AbortController().signal, allow);
    await until(() => gpu.isBusy("Ollama"), "new independent turn queued"); owner();
    assert.match(await next, /A reply/); assert.equal(h.sent.length, 1);
  } finally { owner(); await runner.stop(); await adapter.dispose?.(); await runner.ownerStopped(); gpu.stop(); }
});
it("uses the pinned operational role, strips world configuration and removes only known settled config", async () => {
  const h = await fixture();
  try {
    const answer = await h.runner.run(input, new AbortController().signal, disclosure => { assert.equal(h.created.length, 0); assert(disclosure.local); return allow(); });
    assert(answer.includes("A reply.")); assert.equal(h.sent.length, 1); assert.equal(h.created[0]!.agent, "studio-assistant");
    assert(!JSON.stringify(h.prepared).includes("PRIVATE_")); assert.equal(h.prepared[0]!.inferencePriority, "background");
    await untilAsync(async () => (await readdir(h.scratch)).length === 0, "only known config retired after actual completion");
    assert.equal(h.runner.busy(), false);
  } finally { await h.runner.stop(); await h.runner.ownerStopped(); }
});
it("does not treat an ollama provider label as proof of a local destination", async () => {
  const h = await fixture(); h.cloud();
  try { await assert.rejects(h.runner.run(input, new AbortController().signal, allow), /explicit approval/); assert.equal(h.created.length, 0); assert.equal(h.sent.length, 0); }
  finally { await h.runner.stop(); await h.runner.ownerStopped(); }
});
it("refuses route or generation changes after approval without dispatching", async () => {
  for (const change of ["route", "generation"] as const) {
    const h = await fixture(), gate = deferred(); let entered = false;
    try {
      const running = h.runner.run(input, new AbortController().signal, async () => { entered = true; await gate.promise; return { cloudApproved: true }; });
      const rejected = assert.rejects(running, /owner changed/); await until(() => entered, "disclosure wait entered");
      if (change === "route") h.destination(); else h.revision(); gate.resolve(); await rejected; assert.equal(h.sent.length, 0); assert.equal(h.created.length, 0);
    } finally { gate.resolve(); await h.runner.stop(); await h.runner.ownerStopped(); }
  }
});
it("rechecks the native owner after session creation and fences a late catalog during shutdown", async () => {
  const h = await fixture(), gate = deferred(); h.create(gate.promise);
  try {
    const running = h.runner.run(input, new AbortController().signal, allow), rejected = assert.rejects(running, /owner changed/);
    await until(() => h.created.length === 1, "native session creation entered"); h.revision(); gate.resolve(); await rejected; assert.equal(h.sent.length, 0);
  } finally { gate.resolve(); await h.runner.stop(); await h.runner.ownerStopped(); }
  const later = await fixture(), catalog = deferred(); later.catalog(catalog.promise);
  const stopped = assert.rejects(later.runner.run(input, new AbortController().signal, allow), /stopped/);
  await later.runner.stop(); await stopped; catalog.resolve(); await until(() => !later.runner.busy(), "late metadata settled without dispatch");
  assert.equal(later.created.length, 0); assert.equal(later.sent.length, 0); await later.runner.ownerStopped();
});
it("keeps an unconfirmed interrupted send held until actual completion and never publishes a late answer", async () => {
  const h = await fixture(), gate = deferred(), abort = new AbortController(); h.send(gate.promise);
  try {
    const stopped = assert.rejects(h.runner.run(input, abort.signal, allow), /stopped/);
    await until(() => h.sent.length === 1, "one model dispatch"); abort.abort(); await stopped; assert(h.runner.busy());
    await assert.rejects(h.runner.run(input, new AbortController().signal, allow), /previous owner/); assert.equal(h.sent.length, 1);
    gate.resolve(); await until(() => !h.runner.busy(), "actual final response and send settlement"); assert.equal(h.sent.length, 1);
  } finally { gate.resolve(); await h.runner.stop(); await h.runner.ownerStopped(); }
});
it("retains unknown SDK outcomes through stop, requiring the trusted lifecycle owner's confirmation", async () => {
  const h = await fixture(); h.fail();
  await assert.rejects(h.runner.run(input, new AbortController().signal, allow), /could not be completed/); assert(h.runner.busy());
  await h.runner.stop(); assert(h.runner.busy()); assert.equal(h.sent.length, 1);
  await h.runner.ownerStopped(); assert.equal(h.runner.busy(), false);
});
it("bounds completed output without retaining a known-settled owner and preserves unknown scratch contents", async () => {
  const h = await fixture(); h.answer("x".repeat(STUDIO_ASSISTANT_LIMITS.responseBytes + 1));
  try { await assert.rejects(h.runner.run(input, new AbortController().signal, allow), /within its limits/); await until(() => !h.runner.busy(), "oversized but completed response settled"); }
  finally { await h.runner.stop(); await h.runner.ownerStopped(); }
  const retained = await fixture(); retained.keep();
  try { await retained.runner.run(input, new AbortController().signal, allow); assert.equal(await readFile(join(retained.created[0]!.cwd!, "unrecognized.txt"), "utf8"), "KEEP_UNKNOWN_BYTES"); }
  finally { await retained.runner.stop(); await retained.runner.ownerStopped(); }
});
it("runs the real conversation/session/GPU composition behind admitted creative work without a model replay", async () => {
  const h = await fixture(), gpu = new LocalGpu(async () => {}), owner = await gpu.acquire("ComfyUI", new AbortController().signal);
  const adapter = withLocalGpu(h.raw, gpu), runner = new HarnessStudioModelRunner({ ...h.deps, adapter: () => adapter });
  const service = new StudioAssistantService({ store: new FileStudioConversationStore(join(h.scratch, "studio.json")), model: runner, evidence: topic => studioDiagnosticEvidence(topic, {}, Date.now()) });
  const shared: HarnessEvent[] = [], sharedStop = new AbortController();
  const sharedDone = (async () => { for await (const event of adapter.streamEvents(sharedStop.signal)) shared.push(event); })();
  try {
    const threadId = (await service.createThread())!; await service.send({ threadId, text: "Help with Arke.", model: input.model });
    await until(() => gpu.isBusy("Ollama"), "Studio explanation waiting behind creative work"); assert.equal(h.sent.length, 0); owner();
    await until(() => !service.snapshot().busy, "one durable Studio answer"); assert.equal(h.sent.length, 1); assert.equal(service.snapshot().threads[0]!.messages.at(-1)!.text, "A reply.");
    assert.equal(h.prepared[0]!.inferencePriority, "background"); assert(!JSON.stringify(h.prepared).includes("PRIVATE_"));
    h.emit({ type: "tool.activity", sessionId: "ordinary-world-session", tool: "world-query", summary: "Ordinary activity" });
    await until(() => shared.some(event => "sessionId" in event && event.sessionId === "ordinary-world-session"), "ordinary event proves the shared pump drained");
    assert(shared.every(event => !("sessionId" in event) || event.sessionId !== h.sent[0]!.sessionId), "no private native reply or synthetic GPU wait reaches the shared stream");
    assert(!JSON.stringify(shared).includes("A reply."));
  } finally { sharedStop.abort(); owner(); await service.stop(); await adapter.dispose?.(); await sharedDone; await runner.ownerStopped(); gpu.stop(); }
});
