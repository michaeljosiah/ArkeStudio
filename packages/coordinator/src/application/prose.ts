import type { EngineContext, EngineResource, EngineWorldRepository, EngineWorldSession } from "./contracts.js";
import { engineHash, EngineOperations, requireContext } from "./operations.js";
import { proseId, proseProductionInput, proseChapterInput, proseSaveInput, proseProductionResult,
  proseChapterResult, proseSaveResult, proseChapterRead, proseManuscript,
  type ProseProductionInput, type ProseChapterInput, type ProseSaveInput } from "./prose-contracts.js";

function prose(session: EngineWorldSession) {
  if (!session.prose) throw new Error("This world repository does not support prose authoring.");
  return session.prose;
}

/** Scoped direct editing. The domain still owns chapter history and stale-base decisions. */
export class ProseApplicationService {
  constructor(private readonly worlds: EngineWorldRepository, private readonly operations: EngineOperations) {}

  private async saved<T>(session: EngineWorldSession, key: string, mutate: () => Promise<T>) {
    let value: T;
    try { value = await mutate(); }
    catch (error) {
      // A host may have changed storage before returning an invalid receipt or throwing.
      await session.saved(key);
      throw error;
    }
    return { operationKey: key, ...(await session.saved(key)), value };
  }

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
        const port = prose(session);
        return this.saved(session, key, async () => proseProductionResult.parse(await port.createProduction(input, key)));
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
        const port = prose(session);
        return this.saved(session, key, async () => {
          const value = proseChapterResult.parse(await port.createChapter(productionId, input, key));
          if (value.productionId !== productionId) throw new Error("The chapter belongs to a different production.");
          return value;
        });
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

  async manuscript(context: EngineContext, worldId: string, productionId: string) {
    context = structuredClone(context); requireContext(context); productionId = proseId.parse(productionId);
    const resource = { worldId, productionId };
    await this.operations.policy.authorise(context, "read", resource);
    const result = await this.worlds.use(worldId, async session => {
      const before = await session.snapshot();
      const projected = await this.operations.policy.project(context, structuredClone(before.bundle));
      const raw = before.bundle.productions.filter(p => p.meta.id === productionId);
      const visible = projected.productions.filter(p => p.meta.id === productionId);
      if (raw.length !== 1 || visible.length !== 1 || engineHash(raw[0]) !== engineHash(visible[0])) {
        throw new Error("A complete authorised production is required for manuscript output.");
      }
      const ids = raw[0]!.chapters.filter(c => !c.retired).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map(c => c.id);
      for (const chapterId of ids) await this.operations.policy.authorise(context, "read", { ...resource, chapterId });
      const port = prose(session);
      if (!port.manuscript) throw new Error("This repository does not support manuscript output.");
      const value = proseManuscript.parse(await port.manuscript(productionId));
      if (value.productionId !== productionId || value.chapters.some(c => c.productionId !== productionId) ||
        engineHash(value.chapters.map(c => c.chapterId)) !== engineHash(ids)) throw new Error("The manuscript chapter identities changed.");
      const after = await session.snapshot();
      if (engineHash(raw) !== engineHash(after.bundle.productions.filter(p => p.meta.id === productionId))) {
        throw new Error("The production changed during manuscript output.");
      }
      return { revision: after.revision, value };
    });
    for (const chapter of result.value.chapters) {
      await this.operations.policy.authorise(context, "read", { ...resource, chapterId: chapter.chapterId });
    }
    await this.deliver(context, resource, result);
    return result;
  }

  async saveChapter(context: EngineContext, worldId: string, productionId: string, chapterId: string, input: ProseSaveInput) {
    context = structuredClone(context); input = proseSaveInput.parse(input);
    productionId = proseId.parse(productionId); chapterId = proseId.parse(chapterId);
    const resource = { worldId, productionId, chapterId };
    const result = await this.operations.run(context, "chapter-save", resource, input.operationId, input, key =>
      this.worlds.use(worldId, async session => {
        await this.operations.policy.authorise(context, "chapter-save", resource);
        const port = prose(session);
        return this.saved(session, key, async () => {
          const value = proseSaveResult.parse(await port.saveChapter(productionId, chapterId, input, key));
          if (value.productionId !== productionId || value.chapterId !== chapterId) throw new Error("The chapter identity changed.");
          return value;
        });
      }));
    await this.deliver(context, resource, result.value);
    return result;
  }
}
