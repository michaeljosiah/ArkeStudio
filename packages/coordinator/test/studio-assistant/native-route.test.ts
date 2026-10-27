import assert from "node:assert/strict";
import { it } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenCodeV2Adapter } from "@arke-studio/adapter-opencode";
import { STUDIO_ASSISTANT_LIMITS } from "@arke-studio/contracts";
import { StubOpenCodeV2, STUB_V2_PASSWORD } from "../../../adapter-opencode/test/helpers/stub-server-v2.js";
import { HarnessStudioModelRunner, type StudioModelDisclosure } from "../../src/studio-assistant/runner.js";
import { HarnessRuntimeChanges } from "../../src/harness/runtime-change.js";
import { withLocalGpu } from "../../src/harness/local-gpu.js";
import { withModelValidation } from "../../src/harness/model-validation.js";
import { LocalGpu } from "../../src/local-ai/gpu.js";
import { StudioAssistantService } from "../../src/studio-assistant/service.js";
import { FileStudioConversationStore } from "../../src/studio-assistant/store.js";
import { studioDiagnosticEvidence } from "../../src/studio-assistant/evidence.js";
import { tempDir } from "../tmp.js";
import { until, untilAsync } from "../wait.js";

const input = { role: "studio-assistant" as const, model: "ollama/neutral", prompt: "Explain the measured operational state." };
async function fixture() {
  let metadata: unknown = { model_info: { "general.architecture": "gemma" } }, identity = "c".repeat(64), local = true;
  const provider = createServer((req, res) => { req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(metadata)); }); });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const address = provider.address(); assert(address && typeof address !== "string");
  const stub = new StubOpenCodeV2(); stub.models = [{ id: "neutral", providerID: "ollama", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${address.port}/v1` } }];
  await stub.start();
  const raw = new OpenCodeV2Adapter({ baseUrl: () => stub.baseUrl(), password: () => STUB_V2_PASSWORD, warmupMs: 3000 }); await raw.init(); assert(raw.readiness().ready);
  const gpu = new LocalGpu(async () => {}), changes = new HarnessRuntimeChanges();
  const adapter = withModelValidation(withLocalGpu(changes.wrap(raw), gpu), async () => ({}));
  const scratch = await tempDir("arke-studio-native-route-");
  const runner = new HarnessStudioModelRunner({ adapter: () => adapter, scratch, sessionInput: async value => value,
    destination: () => ({ identity, local }), timeoutMs: 10_000 });
  const prompts = () => stub.requests.filter(request => request.method === "POST" && request.path.endsWith("/prompt"));
  const complete = async () => { await until(() => prompts().length === 1 && stub.streamCount > 0, "the sole qualified private prompt"); stub.emitTurn(prompts()[0]!.path.split("/")[3]!, '{"kind":"reply","text":"A qualified reply."}'); };
  return { runner, raw, adapter, gpu, changes, stub, prompts, complete, scratch,
    metadata: (value: unknown) => { metadata = value; }, host: (value: boolean) => { local = value; }, changeHost: () => { identity = "d".repeat(64); },
    close: async () => { await runner.stop(); await adapter.dispose?.(); await runner.ownerStopped(); gpu.stop(); await stub.stop(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); } };
}

it("discloses the combined native/host destination only after exact native session verification", async () => {
  const h = await fixture(); let disclosure: StudioModelDisclosure | undefined;
  try {
    const answer = h.runner.run(input, new AbortController().signal, async value => {
      disclosure = value; assert(h.stub.requests.some(request => request.method === "GET" && request.path.startsWith("/api/session/")));
      assert.equal(h.prompts().length, 0); return { cloudApproved: false };
    });
    await h.complete(); assert.match(await answer, /qualified reply/);
    assert(disclosure); assert(disclosure.local); assert.equal(disclosure.model, input.model);
    assert.match(disclosure.destination, /^[a-f0-9]{64}$/); assert.notEqual(disclosure.destination, "c".repeat(64));
    assert(!JSON.stringify(disclosure).includes("127.0.0.1")); assert.equal(h.prompts().length, 1);
  } finally { await h.close(); }
});

it("retains canonical Studio history and creative bytes while failed native retirement blocks new inference without holding GPU memory", async () => {
  const h = await fixture(), path = join(h.scratch, "conversations.json"), creative = join(h.scratch, "world-story.md");
  const service = new StudioAssistantService({ store: new FileStudioConversationStore(path), model: h.runner, evidence: topic => studioDiagnosticEvidence(topic, {}, Date.now()) });
  try {
    await writeFile(creative, "KEEP_CANONICAL_CREATIVE_BYTES"); const threadId = (await service.createThread())!;
    const ordinary = await h.adapter.createSession({ purpose: "authoring", agent: "world-builder" });
    h.stub.failSessionDelete = true;
    assert.equal((await service.send({ threadId, text: "KEEP_PRIVATE_STUDIO_REQUEST", model: input.model })).status, "accepted");
    await h.complete();
    await untilAsync(async () => { const saved = JSON.parse(await readFile(path, "utf8")); return saved.threads[0]?.pending === null && saved.threads[0]?.messages.at(-1)?.text === "A qualified reply."; }, "the completed reply is durable despite native retirement failure");
    const saved = await readFile(path, "utf8"); assert(saved.includes("KEEP_PRIVATE_STUDIO_REQUEST"));
    assert(h.runner.busy()); assert(service.snapshot().busy); assert.equal(h.gpu.isBusy("Ollama"), false);
    assert.deepEqual(await service.send({ threadId, text: "MUST_NOT_DISPATCH", model: input.model }), { status: "refused", reason: "busy" });
    await h.changes.run(async () => {}); await h.runner.reconcileRetirement(); assert(h.runner.busy());
    h.stub.failSessionDelete = false; await h.runner.reconcileRetirement();
    assert.equal(h.runner.busy(), false); assert.equal(h.prompts().length, 1);
    assert(h.stub.sessionStates.has(ordinary.sessionId));
    assert.equal(await readFile(path, "utf8"), saved); assert.equal(await readFile(creative, "utf8"), "KEEP_CANONICAL_CREATIVE_BYTES");
    assert.deepEqual(await new FileStudioConversationStore(path).load(), JSON.parse(saved));
  } finally { h.stub.failSessionDelete = false; await service.stop(); await h.close(); }
});

for (const source of ["host", "native"]) it(`${source} nonlocal evidence cannot be overridden by the other source's local claim`, async () => {
  const h = await fixture(); let disclosed = false;
  try {
    if (source === "host") h.host(false); else h.metadata({ remote_host: "https://cloud.invalid", remote_model: "ordinary-name" });
    await assert.rejects(h.runner.run(input, new AbortController().signal, async value => { disclosed = true; assert.equal(value.local, false); return { cloudApproved: false }; }), /explicit approval/);
    assert(disclosed); assert.equal(h.prompts().length, 0); await until(() => !h.runner.busy(), "the unsent refused session retires");
    await h.changes.run(async () => {});
  } finally { await h.close(); }
});

it("one explicit nonlocal approval permits only the proved native route and a single prompt", async () => {
  const h = await fixture(); let approvals = 0;
  try {
    h.metadata({ remote_host: "https://cloud.invalid", remote_model: "ordinary-name" });
    const answer = h.runner.run(input, new AbortController().signal, async value => { approvals++; assert.equal(value.local, false); return { cloudApproved: true }; });
    await h.complete(); assert.match(await answer, /qualified reply/); assert.equal(approvals, 1); assert.equal(h.prompts().length, 1);
  } finally { await h.close(); }
});

it("a native cloud-route change while queued cannot cross the dispatch fence or retain an unsent GPU/runtime owner", async () => {
  const h = await fixture(), release = await h.gpu.acquire("ComfyUI", new AbortController().signal); let approvals = 0;
  try {
    const refused = assert.rejects(h.runner.run(input, new AbortController().signal, async value => { approvals++; assert(value.local); return { cloudApproved: false }; }), /could not be completed/);
    await until(() => h.gpu.isBusy("Ollama"), "the approved native route queued behind creative work");
    h.metadata({ remote_host: "https://cloud.invalid", remote_model: "ordinary-name" }); release(); await refused;
    await until(() => !h.runner.busy() && !h.gpu.isBusy("Ollama"), "known-unsent native route refusal releases only its own admission");
    assert.equal(approvals, 1); assert.equal(h.prompts().length, 0); await h.changes.run(async () => {});
  } finally { release(); await h.close(); }
});

for (const missing of ["proof", "fence", "model", "retirement"]) it(`refuses a qualified native owner with missing or invalid ${missing} without falling back to the host claim`, async () => {
  const h = await fixture(); let approvals = 0;
  try {
    if (missing === "fence") Object.defineProperty(h.raw, "sendMessageWithFence", { value: undefined, configurable: true });
    else {
      const create = h.raw.createSession.bind(h.raw);
      h.raw.createSession = async value => {
        const ref = await create(value);
        if (missing === "proof") delete ref.privateDestination;
        else if (missing === "retirement") delete ref.privateRetire;
        else { const read = ref.privateDestination!.bind(ref); ref.privateDestination = async signal => { const proof = await read(signal); return proof ? { ...proof, model: "ollama/different" } : null; }; }
        return ref;
      };
    }
    await assert.rejects(h.runner.run(input, new AbortController().signal, async () => { approvals++; return { cloudApproved: true }; }), /destination|retirement/);
    assert.equal(approvals, 0); assert.equal(h.prompts().length, 0);
  } finally { await h.close(); }
});

it("host ownership changes during native payload approval cannot dispatch or reuse the earlier combined identity", async () => {
  const h = await fixture(); let resume!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  try {
    const refused = assert.rejects(h.runner.run(input, new AbortController().signal, async () => { entered = true; await gate; return { cloudApproved: true }; }), /owner changed/);
    await until(() => entered, "native-bound disclosure approval"); h.changeHost(); resume(); await refused;
    assert.equal(h.prompts().length, 0); await until(() => !h.runner.busy(), "the unsent stale host attestation retires");
  } finally { resume(); await h.close(); }
});

it("an oversized private stream keeps unknown GPU/runtime ownership until positive native completion, without replay", async () => {
  const h = await fixture();
  try {
    const refused = assert.rejects(h.runner.run(input, new AbortController().signal, async () => ({ cloudApproved: false })), /could not be completed/);
    await until(() => h.prompts().length === 1, "the admitted private prompt");
    const sessionId = h.prompts()[0]!.path.split("/")[3]!;
    h.stub.emit({ type: "session.text.delta", data: { sessionID: sessionId, assistantMessageID: "private", delta: "x".repeat(STUDIO_ASSISTANT_LIMITS.responseBytes + 1) } });
    await refused; assert(h.runner.busy()); assert(h.gpu.isBusy("Ollama"));
    await assert.rejects(h.changes.run(async () => {}), /Finish or cancel writing/);
    h.stub.emit({ type: "session.execution.succeeded", data: { sessionID: sessionId } });
    await until(() => !h.runner.busy() && !h.gpu.isBusy("Ollama"), "positive native completion and exact retirement release the original owner");
    await h.changes.run(async () => {}); assert.equal(h.prompts().length, 1);
  } finally { await h.close(); }
});
