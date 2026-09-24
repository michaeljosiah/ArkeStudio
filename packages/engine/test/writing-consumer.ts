import { createEngine, type EngineContext, type WritingRuntimeFactory, type WritingResult, type ProseManuscript,
  type PageIllustrationInput, type ChapterNarrationInput } from "@arke-studio/engine";
declare const engine: ReturnType<typeof createEngine>;
declare const context: EngineContext;
declare const runtime: WritingRuntimeFactory;
async function writingJourney() {
  const chapter = await engine.prose.readChapter(context, "world", "story", "chapter");
  const input = { operationId: "draft", modelId: "writer", instruction: "Write the chapter.",
    baseHash: chapter.hash, expectedRevision: (await engine.worlds.read(context, "world")).revision };
  const drafted: WritingResult = (await engine.writing.draft(context, "world", "story", "chapter", input)).value;
  await engine.proposals.accept(context, "world", drafted.proposal.id, { operationId: "accept", expectedDraftRevision: drafted.proposal.draftRevision });
  await engine.writing.revise(context, "world", "story", "chapter", { ...input, operationId: "revise" });
  const manuscript: ProseManuscript = (await engine.prose.manuscript(context, "world", "story")).value;
  const cancelled: boolean = await engine.writing.cancel(context, "world", "revise");
  return { manuscript, cancelled, runtime };
}
void writingJourney;

async function mediaJourney(page: PageIllustrationInput, narration: ChapterNarrationInput) {
  const image = await engine.storyMedia.illustratePage(context, "world", "story", "chapter", page);
  const audio = await engine.storyMedia.narrateChapter(context, "world", "story", "chapter", narration);
  const progress = await engine.storyMedia.reconcile(context, "world", narration.operationId);
  const cancelled = await engine.storyMedia.cancel(context, "world", narration.operationId);
  return {image, audio, progress, cancelled};
}
void mediaJourney;
