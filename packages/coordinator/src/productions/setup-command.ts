import type { ConversationId, ProductionSetupCommand, ProductionSetupState, TurnId } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { WorldChatRunner } from "../world-chat/run.js";
import { productionSetups } from "./setup.js";
import { ProductionSetupConversationStore } from "./setup-store.js";

export async function handleProductionSetupCommand(
  world: WorldStore,
  command: ProductionSetupCommand,
  runner: () => WorldChatRunner,
  publish: (id: ConversationId) => Promise<void>,
): Promise<ProductionSetupState> {
  if (world.worldId !== command.worldId || world.isClosed()) throw new Error("Open the world this production setup belongs to.");
  const service = productionSetups(world);
  const id = command.setupId;
  const action = command.action;
  switch (action.operation) {
    case "start": return service.start(id);
    case "resume": return service.resume(id);
    case "update": return service.update(id, action.update);
    case "review": return service.review(id, action.expectedRevision);
    case "create": return service.create(id, action.expectedRevision, action.reviewId);
    case "discard": return service.discard(id);
    case "cancel":
      runner().cancel(id);
      return service.resume(id);
    case "send":
    case "retry": {
      const state = await service.resume(id);
      if (!["draft", "reviewed"].includes(state.status)) throw new Error("This setup is not open for conversation.");
      const log = new ProductionSetupConversationStore(world, id);
      const running = action.operation === "send"
        ? runner().send(log, id, action.text, [], undefined, action.modelId)
        : runner().retry(log, id, action.turnId as TurnId);
      // A progress refresh can fail independently. Always drain the turn and publish its
      // terminal transcript before answering, including the durable failure and Retry action.
      const [outcome] = await Promise.allSettled([running, publish(id)]);
      await publish(id);
      if (outcome.status === "rejected") throw outcome.reason;
      const result = outcome.value;
      if (result.status === "unavailable" || result.status === "failed") throw new Error(result.reason);
      return service.resume(id);
    }
  }
}
