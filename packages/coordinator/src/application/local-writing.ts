import { relative, isAbsolute, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { MarkdownFile } from "../world/text-files.js";
import { ArkeTargetReadPageSchema, type WorldChatCheckReceipt } from "@arke-studio/contracts";
import { ProposalManager, type StageInput } from "../gate/proposals.js";
import { ConversationActionLifecycle } from "../arke-actions/lifecycle.js";
import { WorldChatRunner } from "../world-chat/run.js";
import { WorldChatService } from "../world-chat/service.js";
import { conversationDir, WorldChatStore } from "../world-chat/store.js";
import { QueryLeaseRegistry } from "../world-chat/lease.js";
import { WorldChatRetrieval } from "../world-chat/retrieval.js";
import { WorldChatAttachmentStore } from "../world-chat/attachments.js";
import { chapterDraftingBrief } from "../world-chat/chapter-brief.js";
import { prepareWorldChatActions, worldChatActionAdapters } from "../world-chat/actions.js";
import type { WorldStore, WorldStatePrecondition } from "../world/store.js";
import { localProse } from "./local-prose.js";
import { engineHash } from "./operations.js";
import type { EngineWritingSession } from "./writing-contracts.js";

/** A bounded consumer of Studio's runner, read receipts and proposal preparation. */
export function localWriting(store: WorldStore, assertScratch: (path: string) => Promise<void>): EngineWritingSession {
  return {
    async review(proposalId) {
      const gate = new ProposalManager(store);
      const proposal = await gate.readManifest(proposalId);
      if (proposal.kind !== "chapter-draft" || proposal.targets.length !== 1) throw new Error("A single chapter proposal is required.");
      const doc = MarkdownFile.parse(await gate.readTarget(proposalId, proposal.targets[0]!.path));
      return { proposal, title: String(doc.data.title ?? ""), body: doc.body };
    },
    async run(productionId, chapterId, input, options) {
    const { context, policy, signal, operationKey } = options;
    const resource = { worldId: store.worldId, productionId, chapterId };
    const prose = localProse(store);
    const sourceRevisionNow = (admission = false) => {
      const value = store.getBundle();
      // The schema boundary may change only these operational metadata fields.
      const meta = admission ? { ...value.meta, schemaVersion: 0, updated: "" } : value.meta;
      return engineHash({ meta, bible: value.bible, canon: value.canon, sheets: value.sheets,
        production: value.productions.filter(p => p.meta.id === productionId) });
    };
    let admittedSources = "";
    const pendingChapter = () => {
      const found = store.getBundle().productions.find(p => p.meta.id === productionId)?.chapters.find(c => c.id === chapterId);
      const path = `productions/${productionId}/chapters/${found?.file}.md`;
      return store.getBundle().proposals.some(p => p.proposal.targets.some(target => target.path === path));
    };
    const initial = await store.gateOp(async () => {
      const chapter = await prose.readChapter(productionId, chapterId);
      if (chapter.hash !== input.baseHash) throw new Error("The chapter changed before writing.");
      if (pendingChapter()) throw new Error("Accept or discard the pending chapter proposal before writing again.");
      admittedSources = sourceRevisionNow(true);
      return chapter;
    }, () => engineHash(store.getBundle()) === input.expectedRevision ? null : "The world changed before writing.");
    if (options.mode === "revise" && !initial.body.trim()) throw new Error("There is no committed prose to revise.");
    // This is the existing chapter-subject journal boundary, before freezing the run's sources.
    await store.raiseSchemaBoundary(17, "engine-writing");
    if (sourceRevisionNow(true) !== admittedSources) throw new Error("The world changed before freezing writing sources.");
    // Conversation events are produced by this run; only authored source state fences staging.
    const sourceRevision = sourceRevisionNow();
    const bundle = await policy.project(context, structuredClone(store.getBundle()));
    const projectedSources = (value: typeof bundle) => engineHash({ meta: value.meta, bible: value.bible,
      canon: value.canon, sheets: value.sheets, production: value.productions.filter(p => p.meta.id === productionId) });
    const projectedHash = projectedSources(bundle);
    const productions = bundle.productions.filter(p => p.meta.id === productionId);
    const production = productions[0];
    const rawProduction = store.getBundle().productions.find(p => p.meta.id === productionId)!;
    if (productions.length !== 1 || production?.meta.format !== "story" ||
      engineHash(production.chapters) !== engineHash(rawProduction.chapters) ||
      engineHash(production.story) !== engineHash(rawProduction.story) ||
      engineHash(production.proseStyle) !== engineHash(rawProduction.proseStyle)) {
      throw new Error("Writing requires an authorised, complete story outline and overview.");
    }
    const chapter = production.chapters.find(c => c.id === chapterId);
    if (!chapter || chapter.retired) throw new Error("That chapter is unavailable.");
    const chapters = new Map<string, Awaited<ReturnType<typeof prose.readChapter>>>();
    const receipts: WorldChatCheckReceipt[] = [];
    const leases = new QueryLeaseRegistry(() => store.isClosed() ? null : store.worldId);
    const retrieval = new WorldChatRetrieval({
      leases, getBundle: () => bundle, getIndex: () => null,
      attachments: new WorldChatAttachmentStore(store.dir), findAttachment: async () => null,
      getChapterBody: async (id, file) => {
        if (id !== productionId) throw new Error("The source is outside this story.");
        const matches = production.chapters.filter(c => c.file === file);
        if (matches.length !== 1) throw new Error("The chapter identity is ambiguous.");
        const sourceId = matches[0]!.id;
        const sourceResource = { ...resource, chapterId: sourceId };
        await policy.authorise(context, "read", sourceResource);
        const source = chapters.get(sourceId) ?? await prose.readChapter(productionId, sourceId);
        await policy.deliver(context, sourceResource, { kind: "chapter", id: sourceId, sha256: engineHash(source) });
        chapters.set(sourceId, source);
        return source.body;
      },
    });
    const guard = async () => {
      signal.throwIfAborted();
      if (pendingChapter()) throw new Error("A chapter proposal is already pending.");
      await policy.authorise(context, "chapter-draft", resource);
      if (projectedSources(await policy.project(context, structuredClone(store.getBundle()))) !== projectedHash) {
        throw new Error("The authorised writing sources changed.");
      }
      if (sourceRevisionNow() !== sourceRevision) throw new Error("The world changed during writing.");
      for (const source of chapters.values()) {
        await policy.authorise(context, "read", { ...resource, chapterId: source.chapterId });
        if ((await prose.readChapter(productionId, source.chapterId)).hash !== source.hash) throw new Error("A source chapter changed during writing.");
      }
    };
    let groundedText = "";
    class WritingGate extends ProposalManager {
      override async stage(value: StageInput, precondition?: WorldStatePrecondition) {
        await guard();
        const path = `productions/${productionId}/chapters/${chapter!.file}.md`;
        if (value.targets.length !== 1 || value.targets[0]!.path !== path) throw new Error("The draft targets a different chapter.");
        return super.stage({ ...value, targets: value.targets.map(target => ({ ...target, expectedBaseHash: initial.hash })) },
          () => signal.aborted ? "Writing cancelled." :
          pendingChapter() ? "A chapter proposal is already pending." :
          sourceRevisionNow() !== sourceRevision ? "The world changed during writing." : precondition?.() ?? null);
      }
    }
    const gate = new WritingGate(store);
    const lifecycle = new ConversationActionLifecycle({
      worldPath: store.dir, worldId: store.worldId, now: () => store.now(), isWorldOpen: () => !store.isClosed() && !signal.aborted,
      adapters: worldChatActionAdapters(store, gate, () => store.now()).filter(a => a.actionKind === "world-chat-production-chapter"),
    });
    const service = new WorldChatService(store.dir, () => store.now());
    const conversation = await service.create({ title: options.mode === "draft" ? "Draft chapter" : "Revise chapter",
      entryContext: { kind: "production", productionId }, requestId: operationKey });
    await guard();
    const runtime = await options.runtime({ context: structuredClone(context), resource, operationKey, modelId: input.modelId, signal });
    let proposalId: string | undefined;
    let body: string | undefined;
    let title = initial.title;
    try {
      if (!isAbsolute(runtime.cwd)) throw new Error("The writing scratch directory must be absolute.");
      await assertScratch(runtime.cwd);
      const world = await realpath(store.dir), scratch = await realpath(runtime.cwd);
      const contained = (path: string) => !path || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
      if (contained(relative(world, scratch)) || contained(relative(scratch, world))) {
        throw new Error("The writing harness must run outside the world.");
      }
      if (!Number.isFinite(runtime.inputTokenLimit) || runtime.inputTokenLimit < 1024 || !runtime.sessionModel) throw new Error("The writing model is unavailable.");
      const runner = new WorldChatRunner({
        // A separate target permits guarded methods even when the host froze its adapter.
        adapter: new Proxy(Object.create(runtime.adapter) as typeof runtime.adapter, { get(_target, property) {
          const target = runtime.adapter;
          const value = Reflect.get(target, property, runtime.adapter);
          if (typeof value !== "function") return value;
          if (property === "dispatchAsync" || property === "sendMessage") return async (...args: unknown[]) => {
            await guard();
            await policy.deliver(context, resource, { kind: "chapter", id: chapterId, sha256: engineHash(args[0]) });
            return value.apply(target, args);
          };
          return value.bind(target);
        } }), closingSignal: signal, now: () => store.now(),
        resolveLanguageModel: async () => ({ modelId: input.modelId, sessionModel: runtime.sessionModel, inputTokenLimit: runtime.inputTokenLimit }),
        prepare: async ({ runId, conversationId }) => {
          await guard();
          return { cwd: runtime.cwd, leaseToken: leases.mint({ worldId: store.worldId, runId, conversationId }).token };
        },
        release: async ({ runId }) => { leases.revokeRun(runId); retrieval.forgetRun(runId); },
        createSession: async ({ cwd }) => {
          await guard();
          await policy.deliver(context, resource, { kind: "chapter", id: chapterId, sha256: engineHash(groundedText) });
          return runtime.createSession({ cwd, model: runtime.sessionModel });
        },
        receiptsFor: () => receipts,
        runCheckPlan: async () => { throw new Error("World changes are outside this chapter-writing operation."); },
        evidenceSources: messages => ({ messages, bundle, attachments: [], attachmentText: new Map() }),
        bible: async () => ({ version: bundle.bible.version, text: bundle.bible.text }),
        chapterBrief: async ({ leaseToken, budgetChars }) => {
          const read = async (tool: string, args: Record<string, unknown>) => {
            const value = await retrieval.call(leaseToken, tool, args);
            receipts.push(value.receipt);
            return value;
          };
          let text = await chapterDraftingBrief(bundle, productionId, chapterId, read, budgetChars);
          for (const [tool, args] of [
            ["list_chapters", { productionId }],
            ["get_chapter", { productionId, chapterId }],
          ] as const) {
            let cursor: string | undefined;
            do {
              const value = await read(tool, { ...args, ...(cursor ? { cursor } : {}) });
              if (value.receipt.status !== "complete" && value.receipt.status !== "empty") throw new Error("The chapter source is unavailable.");
              text += "\n\n" + JSON.stringify({ result: value.result, receipt: value.receipt,
                ...(value.receipt.complete && value.receipt.nextCursor === null ? { proposalCheckReceiptId: value.receipt.id } : {}) });
              const page = ArkeTargetReadPageSchema.safeParse(value.result);
              cursor = page.success ? page.data.nextCursor ?? undefined : undefined;
            } while (cursor);
          }
          text += '\n\nThis bounded chapter-writing API supports exactly one edit to the requested chapter. ' +
            'Return its complete body with optional title and status "draft" only. ' +
            'Do not include implies, plan edits, passage edits or other actions; those need separate authoring operations.';
          if (text.length > budgetChars) throw new Error("The chapter context is too large for this model.");
          groundedText = text;
          return text;
        },
        prepareActions: turn => {
          const action = turn.actions[0];
          if (turn.candidates.length || turn.groups.length || turn.bibleEdits.length || turn.sceneEdits.length || turn.editorRequests.length ||
            turn.actions.length !== 1 || action?.kind !== "production-chapter" || action.productionId !== productionId ||
            action.change.operation !== "edit" || action.change.chapterId !== chapterId ||
            !action.change.changes.body?.trim() || action.change.changes.body.length > 2000000 ||
            (action.change.changes.status !== undefined && action.change.changes.status !== "draft") ||
            Object.keys(action.change.changes).some(key => !["body", "title", "status"].includes(key))) {
            throw new Error("Return exactly one complete draft for the requested chapter, without other changes.");
          }
          body = action.change.changes.body;
          title = action.change.changes.title ?? initial.title;
          return prepareWorldChatActions(store, lifecycle, turn);
        },
        bindActions: async actions => {
          for (const action of actions) {
            const card = await lifecycle.bindIntent(action.intent, action.payload);
            proposalId = card.authority.id;
          }
        },
      });
      const outcome = await runner.send(new WorldChatStore(conversationDir(store.dir, conversation.id)), conversation.id,
        `${options.mode === "revise" ? "Revise the committed chapter" : "Draft the planned chapter"}. Return its complete proposed body as the chapter action.\n${input.instruction}`,
        [], { kind: "chapter", chapterId }, input.modelId);
      if (outcome.status !== "completed" || !proposalId || !body) throw new Error(`Writing did not produce a staged chapter (${outcome.status}).`);
      const proposal = await gate.readManifest(proposalId);
      return { productionId, chapterId, conversationId: conversation.id, title, proposal, body,
        groundingHash: engineHash({ text: groundedText, bible: bundle.bible,
          sources: [...chapters.values()].map(c => ({ chapterId: c.chapterId, hash: c.hash })) }) };
    } finally { await runtime.close(); }
  } };
}
