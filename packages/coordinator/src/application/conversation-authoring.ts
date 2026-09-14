import type { ConversationId, TurnId, WorldChatSubject } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { WorldChatRunner, TurnOutcome } from "../world-chat/run.js";
import { WorldChatService } from "../world-chat/service.js";
import { WorldChatStore, conversationDir } from "../world-chat/store.js";
import { worldChatContextExists, worldChatSubjectExists } from "../world-chat/context-validation.js";
import { titleFrom } from "../world-chat/title.js";
import { productionSetups } from "../productions/setup.js";

export interface ConversationAuthoringDependencies {
  runner(id: ConversationId): Pick<WorldChatRunner, "send" | "retry" | "cancel">;
  name(id: ConversationId, text: string, fallback: string): Promise<boolean>;
}

export interface ConversationSendInput {
  conversationId: ConversationId;
  text: string;
  attachmentIds?: readonly string[];
  subject?: WorldChatSubject;
  modelId?: string;
  replyOnly?: boolean;
}

/** The host can publish the admitted turn before awaiting the model or optional naming pass. */
export interface StartedConversationTurn {
  completion: Promise<TurnOutcome>;
  naming: Promise<boolean> | null;
}

/** Local authoring orchestration; the caller supplies an already selected, authorized world. */
export class ConversationAuthoringService {
  constructor(private readonly store: WorldStore, private readonly deps: ConversationAuthoringDependencies) {}

  async send(input: ConversationSendInput): Promise<StartedConversationTurn | null> {
    const service = new WorldChatService(this.store.dir);
    const log = new WorldChatStore(conversationDir(this.store.dir, input.conversationId));
    if (!(await log.readMeta())) return null;
    const conversation = await service.load(input.conversationId);
    const entry = conversation?.entryContext ?? { kind: "world" as const };
    const exists = entry.kind === "attachment"
      ? conversation?.attachments.some(attachment => attachment.id === entry.attachmentId) === true
      : worldChatContextExists(this.store.getBundle(), entry);
    if (!conversation || !exists || input.subject !== undefined &&
      !worldChatSubjectExists(this.store.getBundle(), entry, input.subject)) return null;

    // Give the row a usable title before starting the model. Naming is an optional promotion
    // after the author's turn has first claim on the harness, never a prerequisite for a reply.
    const before = await log.read();
    const first = !before.events.some(event => event.event.type === "turn.started");
    const title = first ? titleFrom(input.text) : null;
    if (title !== null) await service.rename(input.conversationId, title).catch(() => {});
    const completion = this.deps.runner(input.conversationId).send(log, input.conversationId,
      input.text, input.attachmentIds, input.subject, input.modelId, input.replyOnly === true);
    const naming = title === null ? null : this.deps.name(input.conversationId, input.text, title);
    return { completion, naming };
  }

  async retry(conversationId: ConversationId, turnId: TurnId): Promise<StartedConversationTurn | null> {
    const log = new WorldChatStore(conversationDir(this.store.dir, conversationId));
    if (!(await log.readMeta())) return null;
    return { completion: this.deps.runner(conversationId).retry(log, conversationId, turnId), naming: null };
  }

  async cancel(conversationId: ConversationId): Promise<void> {
    const loaded = await this.store.ownedWrite(() => new WorldChatService(this.store.dir).load(conversationId));
    if (this.deps.runner(conversationId).cancel(conversationId) && loaded?.entryContext?.kind === "production-setup") {
      await productionSetups(this.store).stop(conversationId);
    }
  }
}
