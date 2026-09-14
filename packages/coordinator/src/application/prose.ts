import type { EngineContext, EngineResource, EngineWorldRepository, EngineWorldSession } from "./contracts.js";
import { engineHash, EngineOperations, requireContext } from "./operations.js";
import { proseId, proseProductionInput, proseChapterInput, proseSaveInput, proseProductionResult,
  proseChapterResult, proseSaveResult, proseChapterRead,
  type ProseProductionInput, type ProseChapterInput, type ProseSaveInput } from "./prose-contracts.js";

function prose(session: EngineWorldSession) {
  if (!session.prose) throw new Error("This world repository does not support prose authoring.");
  return session.prose;
}

/** Scoped direct editing. The domain still owns chapter history and stale-base decisions. */
export class ProseApplicationService {
  constructor(private readonly worlds: EngineWorldRepository, private readonly operations: EngineOperations) {}

  private async deliver(context: EngineContext, resource: EngineResource, value: unknown) {
    await this.operations.policy.authorise(context, "read", resource);
    await this.operations.policy.deliver(context, resource, { kind: resource.chapterId ? "chapter" : "production",
      id: resource.chapterId ?? resource.productionId!, sha256: engineHash(value) });
  }

  async createProduction(context: EngineContext, worldId: string, input: ProseProductionInput) {
    context = structuredClone(context); input = proseProductionInput.parse(input);
    const result = await this.operations.run(context, "production-create", { worldId }, input.operationId, input, key =>
      this.worlds.use(worldId, async session => {
        await this.operations.policy.authorise(context, "production-create", { worldId });
        const value = proseProductionResult.parse(await prose(session).createProduction(input, key));
        return { operationKey: key, ...(await session.saved(key)), value };
      }));
    await this.deliver(context, { worldId, productionId: result.value.productionId }, result.value);
    return result;
  }

  async createChapter(context: EngineContext, worldId: string, productionId: string, input: ProseChapterInput) {
    context = structuredClone(context); input = proseChapterInput.parse(input); productionId = proseId.parse(productionId);
    const resource = { worldId, productionId };
    const result = await this.operations.run(context, "chapter-create", resource, input.operationId, input, key =>
      this.worlds.use(worldId, async session => {
        await this.operations.policy.authorise(context, "chapter-create", resource);
        const value = proseChapterResult.parse(await prose(session).createChapter(productionId, input, key));
        if (value.productionId !== productionId) throw new Error("The chapter belongs to a different production.");
        return { operationKey: key, ...(await session.saved(key)), value };
      }));
    await this.deliver(context, { ...resource, chapterId: result.value.chapterId }, result.value);
    return result;
  }

  async readChapter(context: EngineContext, worldId: string, productionId: string, chapterId: string) {
    context = structuredClone(context); requireContext(context);
    productionId = proseId.parse(productionId); chapterId = proseId.parse(chapterId);
    const resource = { worldId, productionId, chapterId };
    await this.operations.policy.authorise(context, "read", resource);
    const value = await this.worlds.use(worldId, async session => {
      await this.operations.policy.authorise(context, "read", resource);
      const chapter = proseChapterRead.parse(await prose(session).readChapter(productionId, chapterId));
      if (chapter.productionId !== productionId || chapter.chapterId !== chapterId) throw new Error("The chapter identity changed.");
      return chapter;
    });
    await this.deliver(context, resource, value);
    return value;
  }

  async saveChapter(context: EngineContext, worldId: string, productionId: string, chapterId: string, input: ProseSaveInput) {
    context = structuredClone(context); input = proseSaveInput.parse(input);
    productionId = proseId.parse(productionId); chapterId = proseId.parse(chapterId);
    const resource = { worldId, productionId, chapterId };
    const result = await this.operations.run(context, "chapter-save", resource, input.operationId, input, key =>
      this.worlds.use(worldId, async session => {
        await this.operations.policy.authorise(context, "chapter-save", resource);
        const value = proseSaveResult.parse(await prose(session).saveChapter(productionId, chapterId, input, key));
        if (value.productionId !== productionId || value.chapterId !== chapterId) throw new Error("The chapter identity changed.");
        return { operationKey: key, ...(await session.saved(key)), value };
      }));
    await this.deliver(context, resource, result.value);
    return result;
  }
}
