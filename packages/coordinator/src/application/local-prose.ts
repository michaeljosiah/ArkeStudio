import { productionShape } from "@arke-studio/contracts";
import { createProduction, createChapter, openChapter, saveChapter } from "../productions/ops.js";
import type { WorldStore, WorldStatePrecondition } from "../world/store.js";
import { proseId, type EngineProseSession } from "./prose-contracts.js";
import { engineHash } from "./operations.js";

export function localProse(store: WorldStore): EngineProseSession {
  const production = (id: string) => {
    proseId.parse(id);
    const matches = store.getBundle().productions.filter(p => p.meta.id === id);
    if (matches.length > 1) throw new Error("The production ID is ambiguous.");
    const found = matches[0];
    if (!found || !productionShape(found.meta).hasChapters) throw new Error("A prose production is required.");
    return found;
  };
  const chapter = (productionId: string, chapterId: string) => {
    proseId.parse(chapterId);
    // Public IDs are canonical: accepting a file alias here could bypass per-chapter policy.
    const matches = production(productionId).chapters.filter(c => c.id === chapterId);
    if (matches.length > 1) throw new Error("The chapter ID is ambiguous.");
    const found = matches[0];
    if (!found) throw new Error("That chapter is no longer in this production.");
    if (!found.file || /[\\/:]/.test(found.file) || found.file.includes("\0") || found.file === "." || found.file === "..") {
      throw new Error("The chapter filename is not a portable file stem.");
    }
    return found;
  };
  const precondition = (expected?: string, productionId?: string, chapterId?: string, file?: string): WorldStatePrecondition => () => {
    if (expected !== undefined && engineHash(store.getBundle()) !== expected) return "The world changed before this operation.";
    if (productionId) production(productionId);
    if (productionId && chapterId) {
      const current = chapter(productionId, chapterId);
      if (current.file !== file) return "The chapter identity changed.";
      if (current.retired) return "The chapter is retired.";
      const path = `productions/${productionId}/chapters/${current.file}.md`;
      if (store.getBundle().proposals.some(entry => entry.proposal.targets.some(target => target.path === path))) {
        return "Resolve the pending chapter proposal before direct editing.";
      }
    }
    return null;
  };
  return {
    async createProduction(input, key) {
      const productionId = await createProduction(store, { title: input.title, format: "story", logline: input.logline, requestId: key },
        { source: "engine", precondition: precondition(input.expectedRevision) });
      return { productionId };
    },
    async createChapter(productionId, input, key) {
      production(productionId);
      const chapterId = await createChapter(store, productionId, input,
        { source: "engine", requestId: key, precondition: precondition(input.expectedRevision, productionId) });
      return { productionId, chapterId };
    },
    async readChapter(productionId, chapterId) {
      const found = chapter(productionId, chapterId);
      const { title, order, body, version, hash, versions } = await openChapter(store, productionId, found.id, { canonicalId: true });
      return { productionId, chapterId, title, order, body, version, hash, versions };
    },
    async saveChapter(productionId, chapterId, input, key) {
      const found = chapter(productionId, chapterId);
      const result = await saveChapter(store, productionId, found.file, input.body,
        { baseHash: input.baseHash, source: "engine", requestId: key,
          precondition: precondition(input.expectedRevision, productionId, chapterId, found.file) });
      return { productionId, chapterId, ...result };
    },
  };
}
