import type { EngineContext, EngineResource, EngineWorldRepository, EngineWorldSession } from "./contracts.js";
import { EngineOperations, engineHash, requireContext } from "./operations.js";
import { proseId } from "./prose-contracts.js";
import { writingInput, writingResult, type WritingInput, type WritingRuntimeFactory } from "./writing-contracts.js";

async function chapterTarget(session: EngineWorldSession, productionId: string, chapterId: string) {
  const { bundle } = await session.snapshot();
  const productions = bundle.productions.filter(p => p.meta.id === productionId);
  const chapters = productions.length === 1 ? productions[0]!.chapters.filter(c => c.id === chapterId) : [];
  const file = chapters.length === 1 ? chapters[0]!.file : undefined;
  if (!file || /[\\/:]/.test(file) || file.includes("\0") || file === "." || file === "..") {
    throw new Error("The chapter identity is unavailable or ambiguous.");
  }
  return `productions/${productionId}/chapters/${file}.md`;
}

export class WritingApplicationService {
  private readonly stopping = new AbortController();
  private readonly active = new Map<string, { controller: AbortController; context: EngineContext; resource: EngineResource }>();
  constructor(private readonly worlds: EngineWorldRepository, private readonly operations: EngineOperations,
    private readonly runtime?: WritingRuntimeFactory) {}

  draft(context: EngineContext, worldId: string, productionId: string, chapterId: string, input: WritingInput) {
    return this.run("draft", context, worldId, productionId, chapterId, input);
  }

  revise(context: EngineContext, worldId: string, productionId: string, chapterId: string, input: WritingInput) {
    return this.run("revise", context, worldId, productionId, chapterId, input);
  }

  private async run(mode: "draft" | "revise", context: EngineContext, worldId: string, productionId: string, chapterId: string, input: WritingInput) {
    context = structuredClone(context); input = writingInput.parse(input);
    productionId = proseId.parse(productionId); chapterId = proseId.parse(chapterId);
    const resource = { worldId, productionId, chapterId };
    const result = await this.operations.run(context, "chapter-draft", resource, input.operationId, { mode, ...input }, async key => {
      if (!this.runtime) throw new Error("This host has not configured AI writing.");
      const runtime = this.runtime;
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, this.stopping.signal]);
      this.active.set(key, { controller, context, resource });
      try {
        return await this.worlds.use(worldId, async session => {
          signal.throwIfAborted();
          await this.operations.policy.authorise(context, "chapter-draft", resource);
          if (!session.writing) throw new Error("This repository does not support AI writing.");
          const target = await chapterTarget(session, productionId, chapterId);
          let value;
          try {
            value = writingResult.parse(await session.writing.run(productionId, chapterId, input,
              { mode, context, operationKey: key, policy: this.operations.policy, runtime, signal }));
            if (value.productionId !== productionId || value.chapterId !== chapterId ||
              value.proposal.targets[0]!.path !== target || await chapterTarget(session, productionId, chapterId) !== target) {
              throw new Error("The chapter identity changed or the proposal targets a different chapter.");
            }
            const staged = await session.writing.review(value.proposal.id);
            if (engineHash(staged.proposal) !== engineHash(value.proposal) || staged.title !== value.title ||
              staged.body.trim() !== value.body.trim()) {
              throw new Error("The writing receipt differs from the staged proposal.");
            }
            value = writingResult.parse({ ...value, body: staged.body });
          } catch (error) {
            // Failed and cancelled runs also own durable conversation events.
            await session.saved(key);
            throw error;
          }
          return { operationKey: key, ...(await session.saved(key)), value };
        });
      } finally { this.active.delete(key); }
    });
    // Replayed data must still name this chapter, not another file in the same production.
    await this.worlds.use(worldId, async session => {
      if (result.value.proposal.targets[0]!.path !== await chapterTarget(session, productionId, chapterId)) {
        throw new Error("The writing proposal no longer targets this chapter.");
      }
    });
    await this.operations.policy.authorise(context, "read", resource);
    await this.operations.policy.deliver(context, { ...resource, proposalId: result.value.proposal.id },
      { kind: "proposal", id: result.value.proposal.id, sha256: engineHash(result.value) });
    return result;
  }

  async cancel(context: EngineContext, worldId: string, operationId: string) {
    context = structuredClone(context); requireContext(context);
    const key = this.operations.key(context, { worldId }, operationId);
    const active = this.active.get(key);
    await this.operations.policy.authorise(context, "chapter-draft", active?.resource ?? { worldId });
    if (!active) return false;
    if (active.context.subjectId !== context.subjectId) throw new Error("The writing run belongs to a different subject.");
    await this.operations.policy.authorise(context, "chapter-draft", active.resource);
    active.controller.abort(new Error("Writing cancelled."));
    return true;
  }

  stop() { this.stopping.abort(new Error("The engine is stopping.")); }
}
