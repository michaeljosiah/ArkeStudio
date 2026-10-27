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
  const interrupts: string[] = [];
  const completions = new Map<string, ReturnType<typeof deferred>>();
  let revision = 1, identity = "c".repeat(64), local = true, answer = '{"kind":"reply","text":"A reply."}',
    catalogGate: Promise<void> | undefined, creationGate: Promise<void> | undefined, sendGate: Promise<void> | undefined, failure = false, retained = false;
  const raw: HarnessAdapter = { id: "test", privateSessions: true, capabilities: () => new Set(["events", "models"]), readiness: () => ({ ready: true }), lifecycleRevision: () => revision,
    async listModels() { await catalogGate; return [{ id: "test", provider: "ollama" }]; },
    prepareSession(input) { prepared.push(input); }, sessionFiles: () => [{ name: "opencode.json", contents: "{}" }],
    async createSession(input) { created.push(input); await creationGate; if (retained) await writeFile(join(input.cwd!, "unrecognized.txt"), "KEEP_UNKNOWN_BYTES");
      const sessionId = `studio-${created.length}`, completion = deferred(); completions.set(sessionId, completion);
      return { sessionId, privateEvents: (signal: AbortSignal) => raw.streamEvents(signal), privateTurnSettled: completion.promise, privateOwnerStopped: () => completion.resolve() }; },
    async sendMessage(input) { sent.push(input); await sendGate;
      if (failure) { events.emit("event", { type: "session.error", sessionId: input.sessionId, message: "private backend failure" } satisfies HarnessEvent); throw new Error("unknown outcome"); }
      events.emit("event", { type: "message.completed", sessionId: input.sessionId, text: answer } satisfies HarnessEvent); completions.get(input.sessionId)!.resolve(); return { sessionId: input.sessionId, correlationId: input.correlationId! }; },
    dispatchAsync: async () => { throw new Error("Only sendMessage owns model completion"); }, interrupt: async id => { interrupts.push(id); },
    streamEvents(signal) { const iterator = on(events, "event", { signal }); return { async *[Symbol.asyncIterator]() {
      try { for await (const [event] of iterator) yield event as HarnessEvent; } catch (error) { if (!signal?.aborted) throw error; }
    } }; },
  };
  const deps = { adapter: () => raw, scratch, sessionInput: async (input: SessionConfigInput) => ({ ...input, worldQueryUrl: "PRIVATE_WORLD_TOKEN", memoryDir: "PRIVATE_WORLD_NOTES", authorNotesFile: "PRIVATE_AUTHOR_NOTES", researchWeb: true,
    agents: { "world-builder": { brief: "PRIVATE_WORLD_OVERRIDE" } } }), destination: () => ({ identity, local }), timeoutMs: 5000 };
  const runner = new HarnessStudioModelRunner(deps);
  return { raw, deps, runner, scratch, prepared, created, sent, interrupts, revision: () => { revision++; }, destination: () => { identity = "d".repeat(64); }, cloud: () => { local = false; },
    emit: (event: HarnessEvent) => { if (event.type === "message.completed") completions.get(event.sessionId)?.resolve(); events.emit("event", event); },
    answer: (text: string) => { answer = text; }, catalog: (gate: Promise<void>) => { catalogGate = gate; }, create: (gate: Promise<void>) => { creationGate = gate; },
    send: (gate: Promise<void>) => { sendGate = gate; }, fail: () => { failure = true; }, keep: () => { retained = true; } };
}
const input = { role: "studio-assistant" as const, model: "ollama/test", prompt: "A bounded Studio question." }, allow = async () => ({ cloudApproved: false });
it("the reviewed request cannot be rebound by a caller mutation during authorization", async () => {
  const h = await fixture(), request = { ...input }; h.cloud();
  try {
    await h.runner.run(request, new AbortController().signal, async disclosure => {
      assert.equal(disclosure.prompt, input.prompt); assert(disclosure.system); assert.equal(disclosure.outputTokenLimit, 4096);
      request.prompt = "MUST_NOT_REBIND_THE_APPROVED_PAYLOAD";
      return { cloudApproved: true };
    });
    assert.equal(h.created[0]!.privateRequest!.prompt, input.prompt);
    assert.equal(h.sent[0]!.parts[0]!.type === "text" && h.sent[0]!.parts[0]!.text, input.prompt);
  } finally { await h.runner.stop(); await h.runner.ownerStopped(); }
});
it("a qualified native destination cannot borrow payload authority without its explicit capability", async () => {
  const h = await fixture();
  Object.defineProperty(h.raw, "privateDestinations", { value: true });
  h.raw.sendMessageWithFence = async () => { throw new Error("MUST_NOT_DISPATCH"); };
  try {
    await assert.rejects(h.runner.run(input, new AbortController().signal, allow), /cannot seal the reviewed provider payload/);
    assert.equal(h.created.length, 0); assert.equal(h.sent.length, 0);
  } finally { await h.runner.stop(); await h.runner.ownerStopped(); }
});
it("a sealed native payload cannot borrow transient completion authority without its explicit capability", async () => {
  const h = await fixture();
  Object.defineProperty(h.raw, "privateDestinations", { value: true });
  Object.defineProperty(h.raw, "privatePayloads", { value: true });
  h.raw.sendMessageWithFence = async () => { throw new Error("MUST_NOT_DISPATCH"); };
  try {
    await assert.rejects(h.runner.run(input, new AbortController().signal, allow), /qualified transient completion/);
    assert.equal(h.created.length, 0); assert.equal(h.sent.length, 0);
  } finally { await h.runner.stop(); await h.runner.ownerStopped(); }
});
it("prepared-session composition preserves opaque prototype capabilities and their original native receiver", async () => {
  const h = await fixture(), create = h.raw.createSession.bind(h.raw); h.fail(); let cleaned = false;
  h.raw.createSession = async input => {
    const original = await create(input);
    const native = Object.create({
      privateTurnSettled: original.privateTurnSettled,
      privateEvents(signal: AbortSignal) { assert.equal(this, native); return original.privateEvents!(signal); },
      privateOwnerStopped() { assert.equal(this, native); cleaned = true; original.privateOwnerStopped!(); },
    });
    Object.defineProperty(native, "sessionId", { value: original.sessionId, enumerable: true }); return native;
  };
  try {
    await assert.rejects(h.runner.run(input, new AbortController().signal, allow), /could not be completed/);
    assert(h.runner.busy()); assert.equal(cleaned, false); await h.runner.ownerStopped(); assert(cleaned); assert(!h.runner.busy());
  } finally { await h.runner.stop(); await h.runner.ownerStopped(); }
});
it("cancellation never sends an old session interrupt to a replacement writing generation", async () => {
  const h = await fixture(), gate = deferred(), stop = new AbortController(); h.send(gate.promise);
  try {
    const rejected = assert.rejects(h.runner.run(input, stop.signal, allow), /stopped/);
    await until(() => h.sent.length === 1, "the original generation owns the turn"); h.revision(); stop.abort(); await rejected;
    assert.deepEqual(h.interrupts, []); assert(h.runner.busy());
    gate.resolve(); await until(() => !h.runner.busy(), "the original owner later confirms its own completion");
  } finally { gate.resolve(); await h.runner.stop(); await h.runner.ownerStopped(); }
});

it("trusted confirmed backing-owner cleanup releases only its retained GPU/runtime reservation", async () => {
  const h = await fixture(), gpu = new LocalGpu(async () => {}), changes = new HarnessRuntimeChanges(); h.fail();
  const adapter = withLocalGpu(changes.wrap(h.raw), gpu), runner = new HarnessStudioModelRunner({ ...h.deps, adapter: () => adapter });
  let nextRelease: (() => void) | undefined;
  try {
    await assert.rejects(runner.run(input, new AbortController().signal, allow), /could not be completed/); assert(gpu.isBusy("Ollama"));
    const next = gpu.acquire("ComfyUI", new AbortController().signal).then(release => { nextRelease = release; });
    // This is a trusted test owner confirming both inference and writer cleanup, not Stop
    // acknowledgement or a writing process exit. Production native plans must prove that fact.
    await runner.ownerStopped(); await next; assert(gpu.isBusy("ComfyUI")); assert(!runner.busy());
    await changes.run(async () => {});
    await runner.ownerStopped(); h.emit({ type: "message.completed", sessionId: "studio-1", text: "Old completion cannot release the new owner" });
    await Promise.resolve(); assert(gpu.isBusy("ComfyUI")); assert.equal(h.sent.length, 1);
  } finally { nextRelease?.(); await runner.stop(); await adapter.dispose?.(); await runner.ownerStopped(); gpu.stop(); }
});

it("refuses a private session without native turn settlement proof before sending", async () => {
  const h = await fixture(), create = h.raw.createSession.bind(h.raw);
  h.raw.createSession = async value => { const session = await create(value); delete session.privateTurnSettled; return session; };
  try { await assert.rejects(h.runner.run(input, new AbortController().signal, allow), /native completion proof/); assert.equal(h.sent.length, 0); }
  finally { await h.runner.stop(); await h.runner.ownerStopped(); }
});

it("an error while queued cancels that unsent GPU waiter rather than dispatching it later", async () => {
  const h = await fixture(), gpu = new LocalGpu(async () => {}), owner = await gpu.acquire("ComfyUI", new AbortController().signal);
  const adapter = withLocalGpu(h.raw, gpu), runner = new HarnessStudioModelRunner({ ...h.deps, adapter: () => adapter });
  try {
    const rejected = assert.rejects(runner.run(input, new AbortController().signal, allow), /could not be completed/);
    await until(() => gpu.isBusy("Ollama"), "Studio queued before its native owner reports an error");
    h.emit({ type: "session.error", sessionId: "studio-1", message: "Private owner failed before dispatch" }); await rejected;
    await until(() => !gpu.isBusy("Ollama") && !runner.busy(), "known-unsent waiter and runner retire");
    assert(gpu.isBusy("ComfyUI")); assert.equal(h.sent.length, 0);
    owner(); const next = await runner.run(input, new AbortController().signal, allow);
    assert(next.includes("A reply.")); assert.equal(h.sent.length, 1); assert.equal(h.sent[0]!.sessionId, "studio-2");
  } finally { owner(); await runner.stop(); await adapter.dispose?.(); await runner.ownerStopped(); gpu.stop(); }
});

it("retains an unknown private GPU turn through Stop until late native completion, then still waits for handover", async () => {
  const h = await fixture(), unload = deferred(); h.fail(); let handover = false, admitted = false;
  const gpu = new LocalGpu(async engine => { if (engine === "Ollama") { handover = true; await unload.promise; } });
  const adapter = withLocalGpu(h.raw, gpu), runner = new HarnessStudioModelRunner({ ...h.deps, adapter: () => adapter });
  let releaseNext: (() => void) | undefined;
  try {
    await assert.rejects(runner.run(input, new AbortController().signal, allow), /could not be completed/);
    assert(runner.busy()); assert(gpu.isBusy("Ollama"));
    const next = gpu.acquire("ComfyUI", new AbortController().signal).then(release => { admitted = true; releaseNext = release; });
    await adapter.interrupt?.("studio-1"); assert(runner.busy()); assert.equal(handover, false); assert.equal(admitted, false);
    h.emit({ type: "message.completed", sessionId: "studio-1", text: "Late private answer is not republished" });
    await until(() => handover && !runner.busy(), "late native completion retires only the old turn and starts normal unload");
    assert.equal(admitted, false); unload.resolve(); await next; assert(admitted); assert.equal(h.sent.length, 1);
  } finally { unload.resolve(); releaseNext?.(); await runner.stop(); await adapter.dispose?.(); await runner.ownerStopped(); gpu.stop(); }
});

it("publishes late settlement so an interrupted request becomes acknowledgeable without polling or replay", async () => {
  const h = await fixture(), gpu = new LocalGpu(async () => {}); h.fail();
  const adapter = withLocalGpu(h.raw, gpu), runner = new HarnessStudioModelRunner({ ...h.deps, adapter: () => adapter });
  const service = new StudioAssistantService({ store: new FileStudioConversationStore(join(h.scratch, "late-settlement.json")), model: runner,
    evidence: topic => studioDiagnosticEvidence(topic, {}, Date.now()) });
  const states: ReturnType<StudioAssistantService["snapshot"]>[] = [], unsubscribe = service.subscribe(state => states.push(state));
  try {
    const threadId = (await service.createThread())!;
    const sent = await service.send({ threadId, text: "One explicit question", model: input.model }); assert.equal(sent.status, "accepted");
    await until(() => service.snapshot().threads[0]!.pending?.state === "interrupted", "unknown request retains its interrupted intent");
    assert(states.at(-1)?.busy); assert.equal(h.sent.length, 1);
    h.emit({ type: "message.completed", sessionId: h.sent[0]!.sessionId, text: "Late content must not become a new reply" });
    await until(() => states.at(-1)?.busy === false, "native settlement publishes through the existing private subscription");
    assert(!JSON.stringify(states).includes("Late content must not become a new reply"));
    const pending = service.snapshot().threads[0]!.pending!;
    assert(await service.acknowledgeInterruption(threadId, pending.id)); assert.equal(h.sent.length, 1);
  } finally { unsubscribe(); await service.stop(); await adapter.dispose?.(); await runner.ownerStopped(); gpu.stop(); }
});

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
