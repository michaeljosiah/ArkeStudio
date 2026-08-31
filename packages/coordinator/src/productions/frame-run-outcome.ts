import type { ConversationId, FrameRunState } from "@arke-studio/contracts";
import { serialiseSceneConversation } from "../bench/outcome.js";
import type { WorldStore } from "../world/store.js";
import { discoverConversations } from "../world-chat/discover.js";
import { conversationDir, WorldChatStore } from "../world-chat/store.js";

/** Append one terminal frame-run narration to its scene's Arke thread. */
export async function recordFrameRunOutcome(
  store: WorldStore,
  state: FrameRunState,
): Promise<ConversationId> {
  if (state.status !== "completed" && state.status !== "cancelled") {
    throw new Error("only a terminal frame run has an outcome");
  }
  // The schema commit must precede ownership: ensureSchemaVersion enters the store queue itself.
  // A close between the two phases is then refused by ownedWrite before conversation bytes move.
  await store.ensureSchemaVersion(4, "frame-run-outcome");
  return store.ownedWrite(() =>
    serialiseSceneConversation(
      store.dir,
      state.productionId,
      state.run.sceneId,
      () => recordFrameRunOutcomeUnserialised(store, state),
    ),
  );
}

async function recordFrameRunOutcomeUnserialised(
  store: WorldStore,
  state: FrameRunState,
): Promise<ConversationId> {
  const run = state.run;
  const requestId = `frame-run-outcome:${run.id}`;
  const matching = (await discoverConversations(store.dir)).summaries
    .filter(
      (summary) =>
        summary.entryContext?.kind === "scene" &&
        summary.entryContext.productionId === state.productionId &&
        summary.entryContext.sceneId === run.sceneId,
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  for (const summary of matching) {
    const log = new WorldChatStore(conversationDir(store.dir, summary.id));
    const { events } = await log.read();
    if (events.some((event) => event.requestId === requestId)) return summary.id;
  }

  let conversationId = matching.find((summary) => summary.status !== "archived")?.id;
  if (conversationId === undefined) {
    conversationId = `cv_${run.id.slice(3)}` as ConversationId;
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === state.productionId);
    const scene = production?.scenes.find((candidate) => candidate.id === run.sceneId);
    const log = new WorldChatStore(conversationDir(store.dir, conversationId));
    await log.create(conversationId, store.now());
    await log.append(
      {
        type: "conversation.created",
        title: `Arke · Scene ${scene?.number ?? run.sceneId}`,
        entryContext: { kind: "scene", productionId: state.productionId, sceneId: run.sceneId },
      },
      { at: store.now(), requestId: `frame-run-outcome-thread:${run.id}` },
    );
  }

  const suffix = run.id.slice(3);
  await new WorldChatStore(conversationDir(store.dir, conversationId)).append(
    {
      type: "frame-run.outcome-recorded",
      message: {
        id: `msg_${suffix}`,
        turnId: `turn_${suffix}`,
        role: "studio",
        text: frameRunNarration(state),
        attachmentIds: [],
        createdAt: store.now(),
      },
      report: { runId: run.id, productionId: state.productionId, sceneId: run.sceneId },
    },
    { at: store.now(), requestId },
  );
  return conversationId;
}

function frameRunNarration(state: FrameRunState): string {
  const filed = `${state.filedShots} shot${state.filedShots === 1 ? "" : "s"}`;
  if (state.status === "cancelled") {
    return state.filedShots === 0
      ? "The frame run was cancelled before any frames were filed."
      : `The frame run was cancelled after filing frames for ${filed}.`;
  }
  if (state.failedShots > 0) {
    const failed = `${state.failedShots} shot${state.failedShots === 1 ? "" : "s"}`;
    return state.filedShots === 0
      ? `The frame run finished with ${failed} still needing another try.`
      : `The frame run finished with frames filed for ${filed} and ${failed} still needing another try.`;
  }
  if (state.supersededShots > 0) {
    const preserved = `${state.supersededShots} newer frame${state.supersededShots === 1 ? "" : "s"}`;
    return state.filedShots === 0
      ? `The frame run finished and left ${preserved} in place.`
      : `The frame run finished with frames filed for ${filed} and ${preserved} left in place.`;
  }
  return state.filedShots === 0
    ? "The frame run finished without filing a frame."
    : `The frame run finished with frames filed for ${filed}.`;
}
