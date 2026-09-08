import type { ConversationId } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { foldConversation } from "../world-chat/fold.js";
import { WorldChatStore, conversationDir } from "../world-chat/store.js";

/** The shared runner writes this log under the same ownership gate as setup commands. */
export class ProductionSetupConversationStore extends WorldChatStore {
  constructor(private readonly world: WorldStore, private readonly id: ConversationId) {
    super(conversationDir(world.dir, id));
  }

  override read(): ReturnType<WorldChatStore["read"]> {
    // Reads can repair a torn tail. That repair is a world write too.
    return this.world.ownedWrite(() => super.read());
  }

  override append(
    event: Parameters<WorldChatStore["append"]>[0],
    options: Parameters<WorldChatStore["append"]>[1] = { at: this.world.now() },
  ): ReturnType<WorldChatStore["append"]> {
    return this.world.ownedWrite(async () => {
      const meta = await super.readMeta();
      if (!meta) throw new Error("This production setup no longer exists.");
      const { events } = await super.read();
      const state = foldConversation(this.id, meta.createdAt, events).view.productionSetup;
      if (!state || state.draft.worldId !== this.world.worldId) throw new Error("This setup belongs to another world.");
      if ((event.type === "turn.started" || event.type === "run.retry-started") && !["draft", "reviewed"].includes(state.status)) {
        throw new Error("Finish resolving this production's creation before continuing the conversation.");
      }
      if (event.type === "turn.completed") {
        if (!["draft", "reviewed"].includes(state.status) || !event.productionSetup ||
            event.candidates.length || event.groups.length || event.tombstones.length || event.actionPrepareIntents?.length) {
          throw new Error("Setup can only update its private outline.");
        }
        const revision = event.productionSetup.draft.revision;
        if (revision !== state.draft.revision && revision !== state.draft.revision + 1) throw new Error("Production so far changed.");
      }
      return super.append(event, options);
    });
  }
}
