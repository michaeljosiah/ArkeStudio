import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createEngine, engineHash, type EngineContext, type EnginePolicy } from "../../src/application/engine.js";
import { createLocalWorldRepository } from "../../src/application/local-worlds.js";
import { FileEngineOperationStore } from "../../src/application/local-operations.js";
import { parseOperationRecord } from "../../src/application/operation-record.js";
import type { ProseChapterRead } from "../../src/application/prose-contracts.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { ProposalManager } from "../../src/gate/proposals.js";
import { MarkdownFile, sha256 } from "../../src/world/text-files.js";
import { createProduction, saveChapter, setChapterRetired } from "../../src/productions/ops.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const context: EngineContext = { actorId: "parent", scopeId: "family", executorId: "worker", subjectId: "child" };
const productionId = "the-ledger-of-nights";
const chapterId = "neap";

async function harness(t: TestContext, setup?: (worldDir: string) => Promise<void>) {
  const { root, worldDir } = await makeTempRoot();
  await setup?.(worldDir);
  let provider = new FsWorldProvider(root);
  await provider.loadWorld(WORLD_ID);
  const state = { revoked: false, held: false, failSave: false, saves: 0, deniedChapter: "", unsupported: false,
    nonProse: false, wrongSavedBody: undefined as string | undefined,
    productionOverride: {} as { title?: string; logline?: string }, duplicateChapter: false, chapterCalls: 0,
    mutationOverride: {} as { productionId?: string; chapterId?: string; hash?: string; version?: number },
    readOverride: {} as Partial<ProseChapterRead>, afterSave: undefined as (() => Promise<void>) | undefined };
  const deliveries: Array<{ resource: unknown; sha256: string }> = [];
  const policy: EnginePolicy = {
    async authorise(ctx, action, resource) {
      if (ctx.scopeId !== context.scopeId || ctx.subjectId !== context.subjectId || resource.worldId !== WORLD_ID || state.revoked ||
        (resource.chapterId && resource.chapterId === state.deniedChapter) || (ctx.actorId !== "parent" && action !== "read")) throw new Error("Forbidden");
    },
    async project(_ctx, bundle) { return bundle; },
    async deliver(_ctx, resource, content) {
      if (state.held) throw new Error("Held");
      deliveries.push({ resource, sha256: content.sha256 });
    },
    async reserve() { throw new Error("No provider expected"); }, async settle() {}, async release() {},
  };
  const path = join(root, "operations.jsonl");
  const make = () => {
    const local = createLocalWorldRepository(provider, { finalise: async () => {
      if (state.failSave) throw new Error("Authoritative save unavailable"); state.saves++;
      await state.afterSave?.();
    } });
    return createEngine({ policy, operations: new FileEngineOperationStore(path),
      worlds: { use: (id, action) => local.use(id, session => action({ ...session,
        snapshot: async () => {
          const snapshot = structuredClone(await session.snapshot());
          if (state.duplicateChapter) {
            const production = snapshot.bundle.productions.find(p => p.meta.id === productionId)!;
            production.chapters.push(structuredClone(production.chapters[0]!));
          }
          return snapshot;
        },
        prose: state.unsupported ? undefined : { ...session.prose!,
          createProduction: async (...args) => ({ ...(state.nonProse
            ? { productionId: await createProduction(provider.openStore()!, { title: args[0].title, format: "video", requestId: args[1] }) }
            : await session.prose!.createProduction({ ...args[0], ...state.productionOverride }, args[1])), ...state.mutationOverride }),
          createChapter: async (...args) => { state.chapterCalls++; return { ...await session.prose!.createChapter(...args), ...state.mutationOverride }; },
          saveChapter: async (p, c, input, key) => ({ ...await session.prose!.saveChapter(p, c,
            { ...input, body: state.wrongSavedBody ?? input.body }, key), ...state.mutationOverride }),
          readChapter: async (p, c) => ({ ...await session.prose!.readChapter(p, c), ...state.readOverride }) } })),
        close: () => local.close() },
      queue: { enqueue: async () => { throw new Error("No provider expected"); }, jobs: () => [] } });
  };
  let engine = make();
  t.after(async () => { await engine.close(); await provider.close(); });
  return { engine, state, deliveries, path, worldDir, policy, store: () => provider.openStore()!,
    async restart() {
      await engine.close(); await provider.close();
      provider = new FsWorldProvider(root); await provider.loadWorld(WORLD_ID); engine = make(); return engine;
    } };
}

it("a host cannot complete prose creation with a video production", async t => {
  const h = await harness(t); h.state.nonProse = true;
  await assert.rejects(h.engine.prose.createProduction(context, WORLD_ID, { operationId: "wrong-format", title: "New work" }),
    /does not support prose chapters/);
  assert.equal(h.state.saves, 1);
  assert.equal((await h.engine.operation(context, WORLD_ID, "wrong-format"))!.status, "started");
});

for (const field of ["title", "logline"] as const) it(`production creation verifies the requested ${field}`, async t => {
  const h = await harness(t); h.state.productionOverride = { [field]: "Different value" };
  await assert.rejects(h.engine.prose.createProduction(context, WORLD_ID,
    { operationId: "wrong-metadata", title: "Requested title", logline: "Requested logline" }), /requested metadata/);
  assert.equal(h.state.saves, 1);
});

it("chapter creation refuses a video production before calling persistence", async t => {
  const h = await harness(t);
  await assert.rejects(h.engine.prose.createChapter(context, WORLD_ID, "saltlight",
    { operationId: "video-chapter", title: "Chapter", order: 1 }), /unique prose production/);
  assert.equal(h.state.chapterCalls, 0);
});

it("manuscripts refuse duplicate canonical chapter IDs", async t => {
  const h = await harness(t); h.state.duplicateChapter = true;
  await assert.rejects(h.engine.prose.manuscript(context, WORLD_ID, productionId), /ambiguous chapter identities/);
});

it("manuscripts preserve meaningful leading chapter indentation", async t => {
  const h = await harness(t);
  const chapter = await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId);
  await h.engine.prose.saveChapter(context, WORLD_ID, productionId, chapterId,
    { operationId: "indented-manuscript", baseHash: chapter.hash, body: "    An indented block.\n" });
  const manuscript = await h.engine.prose.manuscript(context, WORLD_ID, productionId);
  assert.ok(manuscript.value.markdown.includes("\n\n    An indented block.\n"));
});

it("a host save with matching metadata still must contain the requested prose", async t => {
  const h = await harness(t);
  const before = await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId);
  h.state.wrongSavedBody = "Different prose.";
  await assert.rejects(h.engine.prose.saveChapter(context, WORLD_ID, productionId, chapterId,
    { operationId: "wrong-body", body: "Requested prose.", baseHash: before.hash }), /differs from the requested prose/);
  assert.equal(h.state.saves, 1);
  assert.equal((await h.engine.operation(context, WORLD_ID, "wrong-body"))!.status, "started");
});

it("direct saves compare canonical line endings without losing leading indentation", async t => {
  const h = await harness(t);
  const before = await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId);
  const body = "    Indented prose.\r\n\r\nAnother paragraph.\r\n";
  await h.engine.prose.saveChapter(context, WORLD_ID, productionId, chapterId,
    { operationId: "canonical-save", body, baseHash: before.hash });
  assert.equal((await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId)).body.trimEnd(),
    body.replace(/\r\n/g, "\n").trimEnd());
});

it("public prose creates, saves and reopens through the durable local domain without cutting a version", async t => {
  const h = await harness(t);
  const request = { operationId: "production", title: "A small adventure", logline: "A fox finds a way home." };
  const [created, duplicate] = await Promise.all([h.engine.prose.createProduction(context, WORLD_ID, request),
    h.engine.prose.createProduction(context, WORLD_ID, request)]);
  assert.deepEqual(created, duplicate);
  const p = created.value.productionId;
  const chapterRequest = { operationId: "chapter", title: "The lost path", order: 1 };
  const chapter = await h.engine.prose.createChapter(context, WORLD_ID, p, chapterRequest);
  const c = chapter.value.chapterId;
  const read = await h.engine.prose.readChapter(context, WORLD_ID, p, c);
  const save = { operationId: "save", body: "The fox followed the river home.", baseHash: read.hash, expectedRevision: chapter.revision };
  const saved = await h.engine.prose.saveChapter(context, WORLD_ID, p, c, save);
  assert.equal(saved.value.version, read.version);
  assert.equal(saved.revision, (await h.engine.worlds.read(context, WORLD_ID)).revision);
  assert.equal(h.state.saves, 3);
  const restarted = await h.restart();
  assert.deepEqual(await restarted.prose.createProduction(context, WORLD_ID, request), created);
  assert.deepEqual(await restarted.prose.createChapter(context, WORLD_ID, p, chapterRequest), chapter);
  assert.deepEqual(await restarted.prose.saveChapter({ ...context, executorId: "worker-two" }, WORLD_ID, p, c, save), saved);
  const reopened = await restarted.prose.readChapter(context, WORLD_ID, p, c);
  assert.equal(reopened.body.trim(), save.body); assert.equal(reopened.hash, saved.value.hash);
  assert.equal(h.state.saves, 3, "replay never saves twice");
  assert.deepEqual(h.deliveries.at(-1), { resource: { worldId: WORLD_ID, productionId: p, chapterId: c }, sha256: engineHash(reopened) });
  await assert.rejects(restarted.prose.createProduction(context, WORLD_ID, { ...request, title: "Different" }), /different input/);
  assert.equal((await restarted.operation(context, WORLD_ID, "save"))?.status, "completed");
  const rows = (await readFile(h.path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(rows.find(row => row.action === "chapter-save").context, context);
});

for (const mutation of ["production", "chapter", "save"] as const) {
  it(`a malformed host ${mutation} receipt finalises the mutation once without delivering or retrying`, async t => {
    const h = await harness(t);
    const before = await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId);
    h.state.mutationOverride = mutation === "production" ? { productionId: "" } :
      mutation === "chapter" ? { productionId: "other-production" } : { chapterId: "other-chapter" };
    const invoke = (engine: typeof h.engine) => mutation === "production"
      ? engine.prose.createProduction(context, WORLD_ID, { operationId: "bad-receipt", title: "Created once" })
      : mutation === "chapter"
      ? engine.prose.createChapter(context, WORLD_ID, productionId, { operationId: "bad-receipt", title: "Created once", order: 99 })
      : engine.prose.saveChapter(context, WORLD_ID, productionId, chapterId,
        { operationId: "bad-receipt", baseHash: before.hash, body: "Saved once." });
    const delivered = h.deliveries.length;
    await assert.rejects(invoke(h.engine));
    assert.equal(h.state.saves, 1); assert.equal(h.deliveries.length, delivered);
    const restarted = await h.restart();
    assert.equal((await restarted.operation(context, WORLD_ID, "bad-receipt"))?.status, "started");
    await assert.rejects(invoke(restarted), /uncertain outcome/);
    assert.equal(h.state.saves, 1);
    const bundle = h.store().getBundle();
    if (mutation === "production") assert.equal(bundle.productions.filter(p => p.meta.title === "Created once").length, 1);
    else if (mutation === "chapter") assert.equal(bundle.productions.find(p => p.meta.id === productionId)!.chapters.filter(c => c.title === "Created once").length, 1);
    else assert.equal((await restarted.prose.readChapter(context, WORLD_ID, productionId, chapterId)).body.trim(), "Saved once.");
  });
}

it("manuscript delivery identifies the semantic manuscript value", async t => {
  const h = await harness(t);
  const result = await h.engine.prose.manuscript(context, WORLD_ID, productionId);
  assert.equal(h.deliveries.at(-1)?.sha256, engineHash(result.value));
});

it("manuscript output refuses non-prose productions before reading chapters", async t => {
  const h = await harness(t);
  await assert.rejects(h.engine.prose.manuscript(context, WORLD_ID, "saltlight"), /requires a prose production/);
  assert.equal(h.deliveries.length, 0);
});

for (const mutation of ["production", "chapter"] as const) {
  it(`creation cannot acknowledge an existing ${mutation} instead of the newly created record`, async t => {
    const h = await harness(t);
    h.state.mutationOverride = mutation === "production" ? { productionId } : { chapterId };
    const invoke = (engine: typeof h.engine) => mutation === "production"
      ? engine.prose.createProduction(context, WORLD_ID, { operationId: "crossed-create", title: "New record" })
      : engine.prose.createChapter(context, WORLD_ID, productionId, { operationId: "crossed-create", title: "New record", order: 99 });
    await assert.rejects(invoke(h.engine), /creation receipt names a different/);
    assert.equal(h.state.saves, 1); assert.equal(h.deliveries.length, 0);
    const restarted = await h.restart();
    await assert.rejects(invoke(restarted), /uncertain outcome/);
    assert.equal(h.state.saves, 1);
  });
}

it("a cached chapter cannot claim current manuscript provenance after a save", async t => {
  const h = await harness(t);
  const chapter = await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId);
  await h.engine.prose.saveChapter(context, WORLD_ID, productionId, chapterId,
    { operationId: "new-text", body: "A newer ending.", baseHash: chapter.hash });
  h.state.readOverride = chapter;
  const deliveries = h.deliveries.length;
  await assert.rejects(h.engine.prose.manuscript(context, WORLD_ID, productionId), /provenance differs/);
  assert.equal(h.deliveries.length, deliveries);
});

for (const field of ["hash", "version"] as const) {
  it(`a save receipt cannot return a stale ${field}`, async t => {
    const h = await harness(t);
    const chapter = await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId);
    h.state.mutationOverride = field === "hash" ? { hash: chapter.hash } : { version: chapter.version + 1 };
    const deliveries = h.deliveries.length;
    await assert.rejects(h.engine.prose.saveChapter(context, WORLD_ID, productionId, chapterId,
      { operationId: "bad-save-evidence", body: "A real new ending.", baseHash: chapter.hash }), /save receipt differs/);
    assert.equal(h.state.saves, 1); assert.equal(h.deliveries.length, deliveries);
    assert.equal((await h.engine.operation(context, WORLD_ID, "bad-save-evidence"))?.status, "started");
  });
}

it("manuscript Markdown is assembled from authoritative chapter reads", async t => {
  const h = await harness(t);
  const production = h.store().getBundle().productions.find(p => p.meta.id === productionId)!;
  const sections = [`# ${production.meta.title}`];
  for (const chapter of production.chapters.filter(c => !c.retired).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    const read = await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapter.id);
    sections.push(`## ${read.title}\n\n${read.body.trim()}`);
  }
  assert.equal((await h.engine.prose.manuscript(context, WORLD_ID, productionId)).value.markdown, sections.join("\n\n") + "\n");
});

it("canonical chapter IDs preserve legacy filenames and prevent alias-based permission bypass", async t => {
  const h = await harness(t);
  const before = await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId);
  assert.ok(before.body.length > 0); assert.equal("file" in before, false);
  await h.engine.prose.saveChapter(context, WORLD_ID, productionId, chapterId,
    { operationId: "legacy", body: "A new page.", baseHash: before.hash });
  assert.match(await readFile(join(h.worldDir, "productions", productionId, "chapters/01-neap.md"), "utf8"), /A new page/);
  h.state.deniedChapter = chapterId;
  await assert.rejects(h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId), /Forbidden/);
  await assert.rejects(h.engine.prose.readChapter(context, WORLD_ID, productionId, "01-neap"), /no longer/);
  await assert.rejects(h.engine.prose.readChapter(context, WORLD_ID, "../private", chapterId));
  await assert.rejects(h.engine.prose.readChapter({ ...context, scopeId: "elsewhere" }, WORLD_ID, productionId, chapterId), /Forbidden/);
});

it("permissions and exact content delivery are checked again on completed replay", async t => {
  const h = await harness(t);
  const input = { operationId: "held", title: "Held story" };
  h.state.held = true;
  await assert.rejects(h.engine.prose.createProduction(context, WORLD_ID, input), /Held/);
  assert.equal((await h.engine.operation(context, WORLD_ID, input.operationId))?.status, "completed");
  h.state.held = false;
  const result = await h.engine.prose.createProduction(context, WORLD_ID, input);
  assert.equal(h.state.saves, 1);
  h.state.revoked = true;
  await assert.rejects(h.engine.prose.createProduction(context, WORLD_ID, input), /Forbidden/);
  assert.equal(h.deliveries.at(-1)?.sha256, engineHash(result.value));
});

it("uncertain authoritative save never creates a second production after restart", async t => {
  const h = await harness(t); h.state.failSave = true;
  const input = { operationId: "lost-save", title: "Only once" };
  await assert.rejects(h.engine.prose.createProduction(context, WORLD_ID, input), /Authoritative save/);
  assert.equal(h.store().getBundle().productions.filter(p => p.meta.title === input.title).length, 1);
  const restarted = await h.restart(); h.state.failSave = false;
  assert.equal((await restarted.operation(context, WORLD_ID, input.operationId))?.status, "started");
  await assert.rejects(restarted.prose.createProduction(context, WORLD_ID, input), /uncertain outcome/);
  assert.equal(h.store().getBundle().productions.filter(p => p.meta.title === input.title).length, 1);
});

it("stale editor hashes refuse atomically and retain the competing chapter and progress", async t => {
  const h = await harness(t);
  const initial = await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId);
  await saveChapter(h.store(), productionId, "01-neap", "Competing text", { baseHash: initial.hash });
  const revision = engineHash(h.store().getBundle());
  await assert.rejects(h.engine.prose.saveChapter(context, WORLD_ID, productionId, chapterId,
    { operationId: "stale", body: "Unseen competing text should not be overwritten.", baseHash: initial.hash }), /stale|changed/i);
  assert.equal(engineHash(h.store().getBundle()), revision);
  assert.equal((await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId)).body.trim(), "Competing text");
});

it("revision and retirement are rechecked inside the write gate after external file changes", async t => {
  const h = await harness(t);
  const before = await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId);
  await setChapterRetired(h.store(), productionId, "01-neap", true);
  await assert.rejects(h.engine.prose.saveChapter(context, WORLD_ID, productionId, chapterId,
    { operationId: "retired", body: "Do not replace", baseHash: before.hash }), /retired/);
  const snapshot = await h.engine.worlds.read(context, WORLD_ID);
  const file = join(h.worldDir, "productions", productionId, "chapters/01-neap.md");
  await writeFile(file, (await readFile(file, "utf8")) + "\nExternal edit.\n");
  await assert.rejects(h.engine.prose.createProduction(context, WORLD_ID,
    { operationId: "stale-create", title: "Do not create", expectedRevision: snapshot.revision }), /world changed|external edits/);
  assert.equal(h.store().getBundle().productions.some(p => p.meta.id === "do-not-create"), false);
});

it("unsupported sessions, invalid production kinds and malformed inputs refuse without authoring", async t => {
  const h = await harness(t);
  const count = h.store().getBundle().productions.length;
  await assert.rejects(h.engine.prose.createProduction(context, WORLD_ID, { operationId: "empty", title: " " }));
  assert.equal(await h.engine.operation(context, WORLD_ID, "empty"), null);
  await assert.rejects(h.engine.prose.createChapter(context, WORLD_ID, "saltlight", { operationId: "video", title: "No chapter", order: 1 }), /prose production/);
  h.state.unsupported = true;
  await assert.rejects(h.engine.prose.createProduction(context, WORLD_ID, { operationId: "unsupported", title: "No story" }), /does not support prose/);
  assert.equal(h.store().getBundle().productions.length, count);
});

it("malformed host chapter metadata is refused before content delivery", async t => {
  const h = await harness(t);
  for (const override of [{ title: "" }, { order: 0 }, { order: -1 }, { order: 1.5 }]) {
    h.state.readOverride = override;
    await assert.rejects(h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId));
  }
  assert.equal(h.deliveries.length, 0);
});

it("a changed file cannot be returned with cached chapter metadata", async t => {
  const h = await harness(t);
  const before = await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId);
  const path = join(h.worldDir, "productions", productionId, "chapters/01-neap.md");
  const doc = MarkdownFile.parse(await readFile(path, "utf8"));
  doc.setData({ title: "Changed title", order: 99 }); doc.setBody("Changed body.");
  const raw = doc.serialize();
  const cached = h.store().getBundle();
  const getBundle = h.store().getBundle;
  h.store().getBundle = () => cached;
  try {
    await writeFile(path, raw);
    await assert.rejects(h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId), /chapter changed/);
  } finally { h.store().getBundle = getBundle; }
  assert.equal(h.deliveries.length, 1);
  const restarted = await h.restart();
  const read = await restarted.prose.readChapter(context, WORLD_ID, productionId, chapterId);
  assert.equal(read.title, "Changed title"); assert.equal(read.body.trim(), "Changed body.");
  assert.equal(read.hash, sha256(raw)); assert.equal(read.version, before.version);
  const snapshot = await restarted.worlds.read(context, WORLD_ID);
  assert.equal(read.order, snapshot.bundle.productions.find(p => p.meta.id === productionId)!.chapters.find(c => c.id === chapterId)!.order);
});

it("durable prose replay rejects malformed results and crossed resource identities", async t => {
  const h = await harness(t);
  const before = await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId);
  await h.engine.prose.saveChapter(context, WORLD_ID, productionId, chapterId,
    { operationId: "record", body: "Checked", baseHash: before.hash });
  const rows = (await readFile(h.path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const row = rows.find(row => row.status === "completed");
  for (const value of [{ ...row.result.value, chapterId: "other" }, { ...row.result.value, hash: "invalid" },
    { ...row.result.value, productionId: "../private" }, { ...row.result.value, version: 0 }]) {
    assert.throws(() => parseOperationRecord({ ...row, result: { ...row.result, value } }));
  }
  assert.throws(() => parseOperationRecord({ ...row, resource: { worldId: WORLD_ID } }));
  const tooLong = "a".repeat(81);
  assert.throws(() => parseOperationRecord({ ...row, resource: { ...row.resource, chapterId: tooLong },
    result: { ...row.result, value: { ...row.result.value, chapterId: tooLong } } }));
  assert.throws(() => parseOperationRecord({ ...row, action: "production-create", resource: { worldId: WORLD_ID },
    result: { ...row.result, value: { productionId: tooLong } } }));
});


it("a pending agent draft blocks direct save until the existing proposal gate resolves it", async t => {
  const h = await harness(t);
  const before = await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId);
  const path = `productions/${productionId}/chapters/01-neap.md`;
  const doc = MarkdownFile.parse(await readFile(join(h.worldDir, path), "utf8"));
  doc.setBody("Proposed prose.");
  const gate = new ProposalManager(h.store());
  const proposal = await gate.stage({ kind: "chapter-draft", summary: "Draft", source: "test",
    targets: [{ path, content: doc.serialize() }] });
  await assert.rejects(h.engine.prose.saveChapter(context, WORLD_ID, productionId, chapterId,
    { operationId: "pending", body: "Direct edit", baseHash: before.hash }), /pending chapter proposal/);
  await h.engine.proposals.discard(context, WORLD_ID, proposal.id, { operationId: "discard-draft" });
  const saved = await h.engine.prose.saveChapter(context, WORLD_ID, productionId, chapterId,
    { operationId: "after-discard", body: "Direct edit", baseHash: before.hash });
  assert.equal(saved.value.version, before.version);
});

it("a canonical ID cannot resolve to another chapter whose filename happens to match", async t => {
  const h = await harness(t, async worldDir => {
    const path = join(worldDir, "productions", productionId, "chapters", "neap.md");
    const doc = MarkdownFile.parse(await readFile(join(worldDir, "productions", productionId, "chapters/01-neap.md"), "utf8"));
    doc.setData({ id: "different-chapter", order: 0, number: 0 }); doc.setBody("Other chapter private text.");
    await writeFile(path, doc.serialize());
  });
  const read = await h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId);
  assert.doesNotMatch(read.body, /Other chapter private text/);
});


it("shutdown drains authoritative saving and revocation during it still withholds delivery", async t => {
  const h = await harness(t);
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  h.state.afterSave = async () => { enter(); await blocked; h.state.revoked = true; };
  const request = h.engine.prose.createProduction(context, WORLD_ID, { operationId: "drain", title: "Draining" });
  const refused = assert.rejects(request, /Forbidden/);
  await entered;
  let closed = false;
  const stopping = h.engine.close().then(() => { closed = true; });
  await assert.rejects(h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId), /stopping/);
  assert.equal(closed, false);
  release(); await refused; await stopping;
  assert.equal(h.deliveries.length, 0);
  const rows = (await readFile(h.path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.at(-1).status, "completed", "completed save is retained even when output becomes forbidden");
});

it("canonical chapter reads and saves preserve a portable filename with spaces", async t => {
  const h = await harness(t, async worldDir => {
    const path = join(worldDir, "productions", productionId, "chapters", "My Chapter_One.md");
    const doc = MarkdownFile.parse(await readFile(join(worldDir, "productions", productionId, "chapters/01-neap.md"), "utf8"));
    doc.setData({ id: "portable-one", title: "Portable one" }); doc.setBody("Legacy text.");
    await writeFile(path, doc.serialize());
  });
  const before = await h.engine.prose.readChapter(context, WORLD_ID, productionId, "portable-one");
  await h.engine.prose.saveChapter(context, WORLD_ID, productionId, "portable-one",
    { operationId: "portable", body: "Revised text.", baseHash: before.hash });
  assert.match(await readFile(join(h.worldDir, "productions", productionId, "chapters", "My Chapter_One.md"), "utf8"), /Revised text/);
});


it("duplicate canonical IDs refuse both read and save even when projection hides one duplicate", async t => {
  const h = await harness(t, async worldDir => {
    const doc = MarkdownFile.parse(await readFile(join(worldDir, "productions", productionId, "chapters/01-neap.md"), "utf8"));
    doc.setBody("Private duplicate.");
    await writeFile(join(worldDir, "productions", productionId, "chapters/00-private.md"), doc.serialize());
  });
  h.policy.project = async (_ctx, bundle) => {
    bundle.productions.find(p => p.meta.id === productionId)!.chapters =
      bundle.productions.find(p => p.meta.id === productionId)!.chapters.filter(c => c.file !== "00-private");
    return bundle;
  };
  const projected = await h.engine.worlds.read(context, WORLD_ID);
  assert.equal(projected.bundle.productions.find(p => p.meta.id === productionId)!.chapters.filter(c => c.id === chapterId).length, 1);
  await assert.rejects(h.engine.prose.readChapter(context, WORLD_ID, productionId, chapterId), /ambiguous/);
  await assert.rejects(h.engine.prose.saveChapter(context, WORLD_ID, productionId, chapterId,
    { operationId: "duplicate-id", body: "Replacement", baseHash: "sha256:" + "a".repeat(64) }), /ambiguous/);
  assert.match(await readFile(join(h.worldDir, "productions", productionId, "chapters/00-private.md"), "utf8"), /Private duplicate/);
  assert.equal(h.state.saves, 1, "a failed host mutation still finalises possible side effects");
});
