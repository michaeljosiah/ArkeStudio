import { readFile, stat } from "node:fs/promises";
import { stagedReferenceKey, stagedWorldImage } from "@arke-studio/contracts";
import { ProposalManager } from "../gate/proposals.js";
import { createSheetFromSentence } from "../sheets/authoring.js";
import { recordResolution } from "../world-chat/resolution.js";
import { readKit } from "../references/kit.js";
import { mainPhotoRequests } from "../references/generate.js";
import type { WorldProvider } from "../world-provider.js";
import type { WorldStore } from "../world/store.js";
import type { EngineWorldRepository, EngineWorldSession } from "./contracts.js";
import { engineHash } from "./operations.js";
import { localProse } from "./local-prose.js";
import { localWriting } from "./local-writing.js";

export interface LocalWorldRepositoryOptions {
  /** The composition, not each service, decides who closes the shared provider. */
  closeProvider?: boolean;
  /** A hosted materialisation must finalise remotely here before a save receipt is returned. */
  finalise?: (worldId: string, operationKey: string) => Promise<void>;
}

function localSession(store: WorldStore, provider: WorldProvider, options: LocalWorldRepositoryOptions): EngineWorldSession {
  const gate = provider.openStore?.() === store ? provider.gate?.() ?? new ProposalManager(store) : new ProposalManager(store);
  const snapshot = async () => {
    const bundle = structuredClone(store.getBundle());
    return { bundle, revision: engineHash(bundle) };
  };
  const precondition = (expected?: string) => expected === undefined ? undefined :
    () => engineHash(store.getBundle()) === expected ? null : "The world changed before this operation.";
  return {
    prose: localProse(store),
    writing: localWriting(store),
    snapshot,
    propose: (input, expected) => createSheetFromSentence(store, gate, input, precondition(expected)),
    proposal: id => gate.readManifest(id),
    accept: (id, opts) => gate.accept(id, { ...opts, precondition: precondition(opts.expectedRevision) }),
    discard: (id, expected) => gate.discard(id, precondition(expected)),
    resolution: (proposal, outcome) => recordResolution(store, proposal, outcome, () => store.now()),
    illustrations: (input, expected) => store.gateOp(async () => {
      const bundle = store.getBundle();
      const sheet = bundle.sheets.find(candidate => candidate.id === input.sheetId);
      if (!sheet) throw new Error("The character or image model is no longer available.");
      const kit = (await readKit(store, input.sheetId))?.kit ?? null;
      const staged = stagedWorldImage(bundle, stagedReferenceKey("main-photo", input.sheetId));
      return mainPhotoRequests(bundle.meta, bundle.artDirection, sheet, kit, input.model,
        { ...input, ...(staged ? { staged } : {}) }).map(request => request.input);
    }, precondition(expected)),
    async artifact(id) {
      // The provider owns traversal, symlink and extension checks. The public API returns bytes,
      // never its absolute path, and caps the initial portrait-only surface before allocating.
      const file = await provider.serveMedia?.(store.getBundle().meta.slug, id);
      if (!file) throw new Error("Artifact not found.");
      if ((await stat(file.path)).size > 32 * 1024 * 1024) throw new Error("Artifact exceeds the initial engine read limit.");
      const bytes = await readFile(file.path);
      if (bytes.length > 32 * 1024 * 1024) throw new Error("Artifact exceeds the initial engine read limit.");
      return { id, contentType: file.contentType, bytes };
    },
    async saved(key) {
      // Action binding/resolution can append conversation events after the domain writer's scan.
      // Refresh under ownership before finalisation; the precondition makes scan failures visible.
      await store.gateOp(async () => {}, () => null);
      if (options.finalise) await options.finalise(store.worldId, key);
      return { revision: (await snapshot()).revision };
    },
  };
}

/** Reuses materialised-world domain services without requiring a global selected world. */
export function createLocalWorldRepository(provider: WorldProvider, options: LocalWorldRepositoryOptions = {}): EngineWorldRepository {
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  // A provider may reopen an unselected world per operation. Serialise these complete lifetimes,
  // rather than acquiring a second local lock when two service calls arrive together.
  const tails = new Map<string, Promise<unknown>>();
  return {
    async use<T>(worldId: string, action: (session: EngineWorldSession) => Promise<T>): Promise<T> {
      if (closed) throw new Error("The world repository is closed.");
      const operation = (tails.get(worldId) ?? Promise.resolve()).catch(() => {}).then(async () => {
        const run = (store: WorldStore) => {
          if (store.worldId !== worldId || store.isClosed()) throw new Error("The owning world is unavailable.");
          return action(localSession(store, provider, options));
        };
        if (provider.withWorldStore) return provider.withWorldStore(worldId, run);
        const selected = provider.openStore?.();
        if (!selected || selected.worldId !== worldId) throw new Error("The owning world is unavailable.");
        return run(selected);
      });
      tails.set(worldId, operation);
      pending.add(operation);
      try { return await operation; }
      finally { pending.delete(operation); if (tails.get(worldId) === operation) tails.delete(worldId); }
    },
    async close() {
      closed = true;
      await Promise.allSettled(pending);
      if (options.closeProvider) await provider.close?.();
    },
  };
}
