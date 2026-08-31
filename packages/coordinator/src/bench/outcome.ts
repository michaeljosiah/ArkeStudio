import type { BenchSession, BenchTake, ConversationId } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { discoverConversations } from "../world-chat/discover.js";
import { conversationDir, WorldChatStore } from "../world-chat/store.js";
import type { SubjectFilingOutcome } from "./filing.js";

const sceneOutcomes = new Map<string, Promise<void>>();

export async function serialiseSceneConversation<T>(
  worldDir: string,
  productionId: string,
  sceneId: string,
  action: () => Promise<T>,
): Promise<T> {
  const key = `${worldDir}/${productionId}/${sceneId}`;
  const previous = sceneOutcomes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => held);
  sceneOutcomes.set(key, tail);
  await previous.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (sceneOutcomes.get(key) === tail) sceneOutcomes.delete(key);
  }
}

/** Append the filing narration to the scene's Arke thread, exactly once per Bench take. */
export async function recordBenchOutcome(
  store: WorldStore,
  session: BenchSession,
  take: BenchTake,
  filing: SubjectFilingOutcome,
): Promise<ConversationId> {
  const subject = session.subject;
  if (subject === undefined) throw new Error("a subject outcome needs a subject session");
  return serialiseSceneConversation(
    store.dir,
    subject.productionId,
    subject.sceneId,
    () => recordBenchOutcomeUnserialised(store, session, take, filing),
  );
}

async function recordBenchOutcomeUnserialised(
  store: WorldStore,
  session: BenchSession,
  take: BenchTake,
  filing: SubjectFilingOutcome,
): Promise<ConversationId> {
  const subject = session.subject!;
  const requestId = `bench-outcome:${session.id}/${take.id}`;
  const matching = (await discoverConversations(store.dir)).summaries
    .filter(
      (summary) =>
        summary.entryContext?.kind === "scene" &&
        summary.entryContext.productionId === subject.productionId &&
        summary.entryContext.sceneId === subject.sceneId,
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  for (const summary of matching) {
    const log = new WorldChatStore(conversationDir(store.dir, summary.id));
    const { events } = await log.read();
    if (events.some((event) => event.requestId === requestId)) return summary.id;
  }

  let conversationId = matching.find((summary) => summary.status !== "archived")?.id;
  if (conversationId === undefined) {
    await store.ensureSchemaVersion(2, "world-chat");
    // The world snapshot is refreshed after this operation. Deriving the fallback thread from
    // the subject session makes an immediate retry find the same log even before that refresh.
    conversationId = `cv_${session.id.slice(5)}` as ConversationId;
    const log = new WorldChatStore(conversationDir(store.dir, conversationId));
    await log.create(conversationId, store.now());
    await log.append(
      {
        type: "conversation.created",
        title: `Arke · Scene ${subject.sceneNumber}`,
        entryContext: { kind: "scene", productionId: subject.productionId, sceneId: subject.sceneId },
      },
      { at: store.now(), requestId: `bench-outcome-thread:${session.id}` },
    );
  }

  const suffix = take.id.slice(3);
  const shotCount = filing.affectedShotIds.length;
  const text =
    subject.kind === "shot"
      ? `Filed Bench take ${take.n} as the frame for shot ${subject.shotNumber}.`
      : `Filed Bench take ${take.n} as ${shotCount} shot segment${shotCount === 1 ? "" : "s"} from board ${subject.letter}.`;
  await new WorldChatStore(conversationDir(store.dir, conversationId)).append(
    {
      type: "bench.outcome-recorded",
      message: {
        id: `msg_${suffix}`,
        turnId: `turn_${suffix}`,
        role: "studio",
        text,
        attachmentIds: [],
        createdAt: store.now(),
      },
      sessionId: session.id,
      takeId: take.id,
      report: {
        productionId: subject.productionId,
        sceneId: subject.sceneId,
        rows: filing.affectedShotIds.map((shotId, index) => ({
          shotId: shotId as never,
          shotNumber:
            subject.kind === "shot"
              ? subject.shotNumber
              : subject.members.find((member) => member.shotId === shotId)!.number,
          productionTakeId: filing.productionTakeIds[subject.kind === "shot" ? index : index + 1] as never,
          ...(filing.artifactId !== undefined ? { artifactId: filing.artifactId as never } : {}),
        })),
      },
    },
    { at: store.now(), requestId },
  );
  return conversationId;
}
