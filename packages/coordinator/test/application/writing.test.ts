import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { join, dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { HarnessAdapter } from "@arke-studio/contracts";
import { createEngine, type EngineContext, type EnginePolicy } from "../../src/application/engine.js";
import { createLocalWorldRepository } from "../../src/application/local-worlds.js";
import { FileEngineOperationStore } from "../../src/application/local-operations.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { saveChapter } from "../../src/productions/ops.js";
import { MarkdownFile } from "../../src/world/text-files.js";

const context: EngineContext = { actorId: "parent", scopeId: "family", executorId: "worker", subjectId: "child" };
const productionId = "the-ledger-of-nights", chapterId = "neap";
async function harness(t: TestContext, setup?: (worldDir: string) => Promise<void>) {
  const { root, worldDir } = await makeTempRoot();
  await setup?.(worldDir);
  let provider = new FsWorldProvider(root);
  await provider.loadWorld(WORLD_ID);
  await mkdir(join(root, "scratch"));
  const state = { calls: 0, opened: 0, closed: 0, saves: 0, scratch: join(root, "scratch"),
    corruptResult: "" as "" | "identity" | "target" | "body" | "title",
    body: "Maren found the path home.", wrongTarget: false,
    revoked: false, held: false, failSave: false, hideOutline: false, denyChapter: "", hang: false,
    dispatched: undefined as (() => void) | undefined, beforeReply: undefined as (() => Promise<void>) | undefined };
  const prompts: string[] = [];
  const policy: EnginePolicy = {
    async authorise(ctx, _action, resource) {
      if (ctx.scopeId !== context.scopeId || state.revoked || resource.chapterId === state.denyChapter) throw new Error("Forbidden");
    },
    async project(_ctx, bundle) {
      if (state.hideOutline) bundle.productions.find(p => p.meta.id === productionId)!.chapters.pop();
      return bundle;
    },
    async deliver(_ctx, _resource, content) { if (state.held && content.kind === "proposal") throw new Error("Held"); },
    async reserve() { throw new Error("Portrait billing must not be used for prose."); }, async settle() {}, async release() {},
  };
  const journal = join(root, "engine-operations.jsonl");
  const make = () => {
    const local = createLocalWorldRepository(provider, { finalise: async () => {
      state.saves++; if (state.failSave) throw new Error("Save unavailable");
    } });
    return createEngine({
    worlds: { use: (id, action) => local.use(id, session => action({ ...session, writing: {
      review: id => session.writing!.review(id),
      run: async (...args) => {
        const value = await session.writing!.run(...args);
        if (state.corruptResult === "identity") value.chapterId = "different-chapter";
        if (state.corruptResult === "body") value.body = "A different story from the staged draft.";
        if (state.corruptResult === "title") value.title = "A different title";
        if (state.corruptResult === "target") {
          const other = (await session.snapshot()).bundle.productions.find(p => p.meta.id === productionId)!
            .chapters.find(c => c.id !== chapterId)!;
          value.proposal.targets[0]!.path = `productions/${productionId}/chapters/${other.file}.md`;
        }
        return value;
      },
    } })), close: () => local.close() },
    operations: new FileEngineOperationStore(journal), policy,
    queue: { jobs: () => [], enqueue: async () => { throw new Error("Unexpected image job"); } },
    writing: async ({ modelId, signal }) => {
      assert.equal(modelId, "test-writer"); state.opened++;
      let ready!: () => void;
      const sent = new Promise<void>(resolve => { ready = resolve; });
      const adapter = Object.freeze({
        id: "fake", capabilities: () => new Set(["events"]), readiness: () => ({ ready: true }),
        dispatchAsync: async (input: { parts: Array<{ text?: string }> }) => {
          state.calls++; prompts.push(input.parts.map(p => p.text ?? "").join("\n")); ready(); state.dispatched?.(); return { ok: true };
        },
        streamEvents: (abort: AbortSignal) => (async function* () {
          abort.addEventListener("abort", ready, { once: true });
          await sent;
          if (abort.aborted) return;
          if (state.hang) { if (!abort.aborted) await new Promise<void>(resolve => abort.addEventListener("abort", () => resolve(), { once: true })); return; }
          await state.beforeReply?.();
          const ids = [...new Set([...prompts.at(-1)!.matchAll(/"proposalCheckReceiptId":"([^"]+)"/g)].map(m => m[1]!))];
          yield { type: "message.completed", sessionId: "session", text: JSON.stringify({
            reply: "A chapter draft is ready.", candidateOperations: [], groupOperations: [],
            actions: [{ kind: "production-chapter", productionId,
              change: { operation: "edit", chapterId: state.wrongTarget ? "other-chapter" : chapterId, changes: { body: state.body } },
              checkReceiptIds: ids }],
          }) };
        })(),
      }) as unknown as HarnessAdapter;
      class AccessorAdapter {
        #adapter = adapter;
        get id() { return this.#adapter.id; }
        get capabilities() { return this.#adapter.capabilities; }
        get readiness() { return this.#adapter.readiness; }
        get dispatchAsync() { return this.#adapter.dispatchAsync; }
        get streamEvents() { return this.#adapter.streamEvents; }
      }
      signal.throwIfAborted();
      return { adapter: Object.freeze(new AccessorAdapter()) as HarnessAdapter,
        cwd: state.scratch, inputTokenLimit: 100000, sessionModel: modelId,
        createSession: async () => ({ sessionId: "session" }), close: async () => { state.closed++; } };
    },
  }); };
  let engine = make();
  t.after(async () => { await engine.close(); await provider.close(); });
  return { engine, state, prompts, journal, policy, store: () => provider.openStore()!,
    async input(operationId: string) {
      const chapter = await engine.prose.readChapter(context, WORLD_ID, productionId, chapterId);
      return { operationId, modelId: "test-writer", instruction: "Write the chapter.", baseHash: chapter.hash,
        expectedRevision: (await engine.worlds.read(context, WORLD_ID)).revision };
    },
    async restart() { await engine.close(); await provider.close(); provider = new FsWorldProvider(root);
      await provider.loadWorld(WORLD_ID); engine = make(); return engine; },
  };
}

it("public writing drafts, accepts, revises and exports only committed manuscript text, with durable replay", async t => {
  const h = await harness(t);
  const before = await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId);
  const input = await h.input("draft");
  const [draft, joined] = await Promise.all([
    h.engine.writing.draft(context, WORLD_ID, productionId, chapterId, input),
    h.engine.writing.draft(context, WORLD_ID, productionId, chapterId, input),
  ]);
  assert.deepEqual(joined, draft); assert.equal(h.state.calls, 1);
  assert.equal((await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId)).body, before.body);
  const pending = await h.engine.prose.manuscript(context, WORLD_ID, productionId);
  assert.ok(!pending.value.markdown.includes(h.state.body));
  const accepted = await h.engine.proposals.accept(context, WORLD_ID, draft.value.proposal.id,
    { operationId: "accept-draft", expectedDraftRevision: draft.value.proposal.draftRevision });
  assert.equal(accepted.value.status, "accepted");
  const committed = await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId);
  assert.equal(committed.body.trim(), h.state.body); assert.ok(committed.version > before.version);
  h.state.body = "Maren returned home with the missing ledger.";
  const revised = await h.engine.writing.revise(context, WORLD_ID, productionId, chapterId, await h.input("revise"));
  assert.ok(h.prompts.at(-1)!.includes("Maren found the path home."));
  assert.equal((await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId)).hash, committed.hash);
  assert.equal((await h.engine.proposals.accept(context, WORLD_ID, revised.value.proposal.id,
    { operationId: "accept-revision", expectedDraftRevision: revised.value.proposal.draftRevision })).value.status, "accepted");
  const manuscript = await h.engine.prose.manuscript(context, WORLD_ID, productionId);
  assert.ok(manuscript.value.markdown.includes(h.state.body));
  const latest = await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId);
  assert.equal(manuscript.value.chapters.find(c => c.chapterId === chapterId)!.hash, latest.hash);
  const reopened = await h.restart();
  assert.deepEqual(await reopened.writing.draft(context, WORLD_ID, productionId, chapterId, input), draft);
  assert.equal(h.state.calls, 2); assert.equal(h.state.opened, h.state.closed);
  assert.deepEqual(await reopened.prose.manuscript(context, WORLD_ID, productionId), manuscript);
});

it("writing refuses changed bases and partial outlines before opening a model", async t => {
  const h = await harness(t);
  const input = await h.input("stale");
  await assert.rejects(h.engine.writing.draft(context, WORLD_ID, productionId, chapterId,
    { ...input, baseHash: "sha256:" + "0".repeat(64) }), /chapter changed/);
  h.state.hideOutline = true;
  await assert.rejects(h.engine.writing.draft(context, WORLD_ID, productionId, chapterId,
    { ...await h.input("hidden"), expectedRevision: input.expectedRevision }), /complete story outline/);
  assert.equal(h.state.opened, 0);
});

it("out-of-scope model actions never stage or commit a chapter", async t => {
  const h = await harness(t); h.state.wrongTarget = true;
  const before = h.store().getBundle().proposals.length;
  await assert.rejects(h.engine.writing.draft(context, WORLD_ID, productionId, chapterId, await h.input("wrong")), /did not produce/);
  assert.equal(h.store().getBundle().proposals.length, before); assert.equal(h.state.closed, 1);
});

it("held output and revoked replay cannot leak a completed proposal", async t => {
  const h = await harness(t); const input = await h.input("held"); h.state.held = true;
  await assert.rejects(h.engine.writing.draft(context, WORLD_ID, productionId, chapterId, input), /Held/);
  assert.equal((await h.engine.operation(context, WORLD_ID, "held"))!.status, "completed");
  h.state.held = false; h.state.revoked = true;
  await assert.rejects(h.engine.writing.draft(context, WORLD_ID, productionId, chapterId, input), /Forbidden/);
  assert.equal(h.state.calls, 1);
});

it("an uncertain authoritative save survives restart without another provider call", async t => {
  const h = await harness(t); const input = await h.input("save"); h.state.failSave = true;
  await assert.rejects(h.engine.writing.draft(context, WORLD_ID, productionId, chapterId, input), /Save unavailable/);
  assert.equal((await h.engine.operation(context, WORLD_ID, "save"))!.status, "started");
  h.state.failSave = false;
  const restarted = await h.restart();
  await assert.rejects(restarted.writing.draft(context, WORLD_ID, productionId, chapterId, input), /uncertain outcome/);
  assert.equal(h.state.calls, 1);
  assert.match(await readFile(h.journal, "utf8"), /chapter-draft/);
});

it("cancellation does not wait behind the world's active writing operation", async t => {
  const h = await harness(t); h.state.hang = true;
  const dispatched = new Promise<void>(resolve => { h.state.dispatched = resolve; });
  const run = h.engine.writing.draft(context, WORLD_ID, productionId, chapterId, await h.input("cancel"));
  const refused = assert.rejects(run, /cancelled/);
  await Promise.race([dispatched, run]);
  assert.equal(await h.engine.writing.cancel(context, WORLD_ID, "cancel"), true);
  await refused;
  assert.equal(h.state.closed, 1);
  assert.equal((await h.engine.operation(context, WORLD_ID, "cancel"))!.status, "started");
});

it("engine shutdown aborts and drains active writing before closing its repository", async t => {
  const h = await harness(t); h.state.hang = true;
  const dispatched = new Promise<void>(resolve => { h.state.dispatched = resolve; });
  const run = h.engine.writing.draft(context, WORLD_ID, productionId, chapterId, await h.input("close"));
  const refused = assert.rejects(run, /cancelled/);
  await Promise.race([dispatched, run]); await h.engine.close(); await refused;
  assert.equal(h.state.opened, h.state.closed);
});

it("manuscript refuses a denied chapter or a filtered production", async t => {
  const h = await harness(t);
  h.state.denyChapter = chapterId;
  await assert.rejects(h.engine.prose.manuscript(context, WORLD_ID, productionId), /Forbidden/);
  h.state.denyChapter = ""; h.state.hideOutline = true;
  await assert.rejects(h.engine.prose.manuscript(context, WORLD_ID, productionId), /complete authorised/);
});

it("a same-version author edit during generation cannot be overwritten by the staged draft", async t => {
  const h = await harness(t);
  const input = await h.input("concurrent-edit");
  h.state.beforeReply = async () => {
    h.state.beforeReply = undefined;
    await saveChapter(h.store(), productionId, "01-neap", "The author's newer ending.", { baseHash: input.baseHash });
  };
  const proposals = h.store().getBundle().proposals.length;
  await assert.rejects(h.engine.writing.draft(context, WORLD_ID, productionId, chapterId, input), /did not produce/);
  assert.equal((await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId)).body.trim(), "The author's newer ending.");
  assert.equal(h.store().getBundle().proposals.length, proposals);
});

it("revocation during the model call blocks proposal preparation", async t => {
  const h = await harness(t); const input = await h.input("revoke");
  const proposals = h.store().getBundle().proposals.length;
  h.state.dispatched = () => { h.state.revoked = true; };
  await assert.rejects(h.engine.writing.draft(context, WORLD_ID, productionId, chapterId, input), /did not produce/);
  assert.equal(h.store().getBundle().proposals.length, proposals);
  assert.equal(h.state.closed, 1);
});

it("draft receipts preserve valid legacy titles longer than the new-title input limit", async t => {
  const title = "A chapter title ".repeat(20);
  const h = await harness(t, async dir => {
    const path = join(dir, "productions", productionId, "chapters", "01-neap.md");
    const doc = MarkdownFile.parse(await readFile(path, "utf8"));
    doc.setData({ title }); await writeFile(path, doc.serialize());
  });
  const draft = await h.engine.writing.draft(context, WORLD_ID, productionId, chapterId, await h.input("legacy-title"));
  assert.equal(draft.value.title, title);
  assert.equal(h.state.calls, 1);
});

it("pending chapter proposals refuse new writing before opening another runtime", async t => {
  const h = await harness(t);
  const draft = await h.engine.writing.draft(context, WORLD_ID, productionId, chapterId, await h.input("first"));
  await assert.rejects(h.engine.writing.revise(context, WORLD_ID, productionId, chapterId, await h.input("second")), /pending chapter proposal/);
  assert.equal(h.state.calls, 1);
  await h.engine.proposals.discard(context, WORLD_ID, draft.value.proposal.id, { operationId: "discard" });
  await h.engine.writing.draft(context, WORLD_ID, productionId, chapterId, await h.input("after-discard"));
  assert.equal(h.state.calls, 2);
});

for (const corruption of ["identity", "target", "body", "title"] as const) {
  it(`malformed host writing ${corruption} finalises side effects but never completes or delivers`, async t => {
    const h = await harness(t);
    const other = h.store().getBundle().productions.find(p => p.meta.id === productionId)!.chapters.find(c => c.id !== chapterId)!;
    h.state.denyChapter = other.id;
    h.state.corruptResult = corruption;
    const input = await h.input("bad-host");
    let delivered = false;
    h.policy.deliver = async (_ctx, _resource, content) => { if (content.kind === "proposal") delivered = true; };
    await assert.rejects(h.engine.writing.draft(context, WORLD_ID, productionId, chapterId, input), /chapter identity changed|different chapter|differs from the staged/);
    assert.equal(delivered, false); assert.equal(h.state.saves, 1);
    assert.equal(h.state.calls, 1);
    assert.equal((await h.engine.operation(context, WORLD_ID, input.operationId))!.status, "started");
  });
}

it("a sibling world cannot be used as the writing harness scratch directory", async t => {
  const h = await harness(t);
  h.state.scratch = join(dirname(h.store().dir), "another-world");
  await mkdir(h.state.scratch);
  await assert.rejects(h.engine.writing.draft(context, WORLD_ID, productionId, chapterId, await h.input("sibling-scratch")), /outside all managed worlds/);
  assert.equal(h.state.calls, 0); assert.equal(h.state.closed, 1);
});

it("replay refuses a durable writing receipt redirected to another chapter file", async t => {
  const h = await harness(t); const input = await h.input("replay-target");
  await h.engine.writing.draft(context, WORLD_ID, productionId, chapterId, input);
  const other = h.store().getBundle().productions.find(p => p.meta.id === productionId)!.chapters.find(c => c.id !== chapterId)!;
  await h.engine.close();
  const rows = (await readFile(h.journal, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  rows.find(row => row.status === "completed").result.value.proposal.targets[0].path =
    `productions/${productionId}/chapters/${other.file}.md`;
  await writeFile(h.journal, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const restarted = await h.restart();
  await assert.rejects(restarted.writing.draft(context, WORLD_ID, productionId, chapterId, input), /no longer targets/);
  assert.equal(h.state.calls, 1);
});
