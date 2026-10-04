import type { WorldStore } from "../world/store.js";
import type { ConversationActionCard, PrepareConversationTakeReview } from "@arke-studio/contracts";
import { prepareConversationTakeReview, ConversationTakeReviewRefusal } from "./conversation-take-review.js";
export { ConversationTakeReviewRefusal } from "./conversation-take-review.js";
import type { ProposalManager } from "../gate/proposals.js";
import { ConversationActionLifecycle, recoverConversationActions,
  type ConversationActionAuthorityAdapter, type ConversationActionLifecycleOptions } from "../arke-actions/lifecycle.js";
import { worldChatActionAdapters, type WorldChatActionAdapterDeps } from "../world-chat/actions.js";

export interface ConversationActionDependencies {
  gate: ProposalManager | null;
  now(): string;
  isWorldOpen(): boolean;
  actions: Omit<WorldChatActionAdapterDeps, "archiveWorld">;
  supplied?: readonly ConversationActionAuthorityAdapter[];
  archiveWorld?: () => Promise<{ id: string; folder: string }>;
  archived?: (result: { id: string; folder: string }) => Promise<void>;
}

/**
 * One application boundary for live decisions and recovery. The existing lifecycle remains
 * the sole permission authority; host adapters can replace a kind without adding a second lane.
 */
export class ConversationActionService {
  readonly lifecycle: ConversationActionLifecycle;
  private readonly options: ConversationActionLifecycleOptions;

  constructor(private readonly store: WorldStore, private readonly deps: ConversationActionDependencies) {
    let worldPath = store.dir;
    const supplied = deps.supplied ?? [];
    const suppliedKinds = new Set(supplied.map(adapter => adapter.actionKind));
    const archive = deps.archiveWorld;
    const actions: WorldChatActionAdapterDeps = {
      ...deps.actions,
      ...(archive ? { archiveWorld: async () => {
        const result = await archive();
        // Relocate authority before notifying the UI: a failed publication must not send
        // the terminal card write back into the world's former directory.
        worldPath = result.folder;
        await deps.archived?.(result);
        return { id: result.id };
      } } : {}),
    };
    this.options = {
      worldPath: () => worldPath,
      worldId: store.worldId,
      adapters: [
        ...worldChatActionAdapters(store, deps.gate, deps.now, actions)
          .filter(adapter => !suppliedKinds.has(adapter.actionKind)),
        ...supplied,
      ],
      now: deps.now,
      isWorldOpen: deps.isWorldOpen,
    };
    this.lifecycle = new ConversationActionLifecycle(this.options);
  }

  decide(input: Parameters<ConversationActionLifecycle["decide"]>[0]) {
    return this.lifecycle.decide(input);
  }

  async project(cards: readonly ConversationActionCard[]): Promise<ConversationActionCard[]> {
    const actions = this.deps.actions;
    // Every quote service reads the same sealed authority files; no source compiler runs here.
    const quotes = actions.generationQuotes ?? actions.productionGenerationQuotes ?? actions.productionAudioQuotes ??
      actions.productionBatchQuotes ?? actions.buildGenerationQuotes ?? actions.benchGenerationQuotes;
    return Promise.all(cards.map(async card => {
      const generationWork = await quotes?.project(card).catch(() => undefined);
      return generationWork ? { ...card, generationWork } : card;
    }));
  }

  prepareTakeReview(input: PrepareConversationTakeReview) {
    if (!this.deps.isWorldOpen()) throw new ConversationTakeReviewRefusal("The world is no longer open.");
    return prepareConversationTakeReview(this.store, this.lifecycle, input, {
      project: async card => (await this.project([card]))[0]!, jobs: () => this.deps.actions.getJobs?.() ?? [],
    });
  }

  recover() {
    return recoverConversationActions(this.options);
  }
}
