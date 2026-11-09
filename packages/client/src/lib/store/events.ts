import {
  type StoryPublishAction, type RemoteCommandRefusal, type ClientMessage, type DomainEvent,
  type Frame, type Job, type QueueCommand, ulid,
} from "@arke-studio/contracts";
import { current, sendResults, emitChange, send } from "./core.js";

export type QueueEnqueueResult = Extract<DomainEvent, { type: "queue.enqueue-result" }> & {
  characterName?: string;
};
export const pendingQueueRequests = new Map<string, { command: QueueCommand; characterName?: string }>();
export const queueResultListeners = new Set<(result: QueueEnqueueResult) => void>();
export type VoiceAssignmentResult = Extract<DomainEvent, { type: "voice.assignment-result" }>;
export type DialogueResult = Extract<DomainEvent, { type: "dialogue.result" }>;
export const dialogueListeners = new Set<(result: DialogueResult) => void>();
export function subscribeDialogueResults(listener: (result: DialogueResult) => void): () => void { dialogueListeners.add(listener); return () => { dialogueListeners.delete(listener); }; }
export const transitionProposalListeners = new Set<(result: import("@arke-studio/contracts").TransitionReviewResult) => void>();
export const pictureProposalListeners = new Set<(result: import("@arke-studio/contracts").PictureReviewResult) => void>();
export function subscribeTransitionProposalResults(listener: (result: import("@arke-studio/contracts").TransitionReviewResult) => void): () => void { transitionProposalListeners.add(listener); return () => { transitionProposalListeners.delete(listener); }; }
export function subscribePictureProposalResults(listener: (result: import("@arke-studio/contracts").PictureReviewResult) => void): () => void { pictureProposalListeners.add(listener); return () => { pictureProposalListeners.delete(listener); }; }
export const effectProposalListeners = new Set<(result: import("@arke-studio/contracts").EffectReviewResult) => void>();
export function subscribeEffectProposalResults(listener: (result: import("@arke-studio/contracts").EffectReviewResult) => void): () => void {
  effectProposalListeners.add(listener); return () => { effectProposalListeners.delete(listener); };
}
export type RehearsalResult = Extract<DomainEvent, { type: "rehearsal.result" }>;
export const rehearsalListeners = new Set<(result: RehearsalResult) => void>();
export function subscribeRehearsalResults(listener: (result: RehearsalResult) => void): () => void { rehearsalListeners.add(listener); return () => { rehearsalListeners.delete(listener); }; }
export type PerformanceResult = Extract<DomainEvent, { type: "performance.result" }>;
export const performanceListeners = new Set<(result: PerformanceResult) => void>();
export function subscribePerformanceResults(listener: (result: PerformanceResult) => void): () => void { performanceListeners.add(listener); return () => { performanceListeners.delete(listener); }; }
export type VoiceSampleResult = Extract<DomainEvent, { type: "voice.sample-result" }>;
export const voiceSampleListeners = new Set<(result: VoiceSampleResult) => void>();
export function subscribeVoiceSampleResults(listener: (result: VoiceSampleResult) => void): () => void {
  voiceSampleListeners.add(listener); return () => { voiceSampleListeners.delete(listener); };
}
export function generateCharacterVoiceSample(input: Omit<Extract<ClientMessage, { kind: "generate-character-voice-sample" }>, "kind" | "requestId">): string | null {
  const requestId = queueRequest("generate-character-voice-sample");
  if (!send({ kind: "generate-character-voice-sample", ...input, requestId })) { pendingQueueRequests.delete(requestId); return null; }
  return requestId;
}
export const voiceAssignmentListeners = new Set<(result: VoiceAssignmentResult) => void>();
type DesignedVoiceSaved = Extract<DomainEvent, { type: "voice.designed-saved" }>;
type DesignedVoiceAudition = Extract<DomainEvent, { type: "voice.design-audition" }>;
type ProjectVoicesListed = Extract<DomainEvent, { type: "voice.designed-listed" }>;
export const projectVoiceListeners = new Set<(result: ProjectVoicesListed) => void>();
/** The connected Google project's designed voices, as the coordinator lists them (design turn 204). */
export function subscribeProjectVoices(listener: (result: ProjectVoicesListed) => void): () => void {
  projectVoiceListeners.add(listener);
  return () => { projectVoiceListeners.delete(listener); };
}
export const designedVoiceListeners = new Set<(result: DesignedVoiceSaved) => void>();
export const designedAuditionListeners = new Set<(result: DesignedVoiceAudition) => void>();
export function subscribeDesignedVoices(listener: (result: DesignedVoiceSaved) => void): () => void {
  designedVoiceListeners.add(listener);
  return () => { designedVoiceListeners.delete(listener); };
}
export function subscribeDesignedAuditions(listener: (result: DesignedVoiceAudition) => void): () => void {
  designedAuditionListeners.add(listener);
  return () => { designedAuditionListeners.delete(listener); };
}
export type VoiceUploadConfirmationRequired = Extract<
  DomainEvent,
  { type: "voice.upload-confirmation-required" }
>;
export const voiceUploadConfirmationListeners = new Set<(result: VoiceUploadConfirmationRequired) => void>();
export const jobReadyListeners = new Set<(job: Job) => void>();

/** A correlated filing request's answer (issue 305): ordered artifact ids, by requestId. */
export type FiledBatch = Extract<DomainEvent, { type: "artifact.filed-batch" }>;
export const filedBatchListeners = new Set<(batch: FiledBatch) => void>();
export type BriefEnhanced = Extract<DomainEvent, { type: "bench.brief-enhanced" }>;
type StageConstructionResult = Extract<DomainEvent, { type: "stage.construction" }>;
export const stageConstructionListeners = new Set<(result: StageConstructionResult) => void>();
export type ChapterReviewUpdate = Extract<DomainEvent, { type: "chapter-review.updated" }>;
export type ManuscriptReviewUpdate = Extract<DomainEvent, { type: "manuscript-review.updated" }>;
export const manuscriptReviewListeners = new Set<(event: ManuscriptReviewUpdate) => void>();
export function subscribeManuscriptReview(listener: (event: ManuscriptReviewUpdate) => void) { manuscriptReviewListeners.add(listener); return () => { manuscriptReviewListeners.delete(listener); }; }
export function requestManuscriptReview(message: Extract<ClientMessage, { kind: `manuscript-review-${string}` }>): boolean { return send(message); }
export const chapterReviewListeners = new Set<(value: ChapterReviewUpdate) => void>();
export function subscribeChapterReview(listener: (value: ChapterReviewUpdate) => void): () => void {
  chapterReviewListeners.add(listener); return () => { chapterReviewListeners.delete(listener); };
}
export function requestChapterReview(kind: "chapter-review-start" | "chapter-review-read" | "chapter-review-cancel",
  worldId: string, productionId: string, chapterId: string, checks?: import("@arke-studio/contracts").ChapterReviewCheck[], recoverFrom?: string): boolean {
  return send({ kind, worldId, productionId, chapterId, ...(kind === "chapter-review-start" ? { ...(checks ? { checks } : {}), ...(recoverFrom ? { recoverFrom } : {}) } : {}), requestId: ulid() });
}
export function requestChapterReviewPreflight(worldId: string, productionId: string, chapterId: string,
  checks: import("@arke-studio/contracts").ChapterReviewCheck[]): string | null {
  const requestId = ulid();
  return send({ kind: "chapter-review-preflight", worldId, productionId, chapterId, checks, requestId }) ? requestId : null;
}
export function decideChapterReview(worldId: string, productionId: string, chapterId: string, reviewId: string,
  findingId: string, decision: "open" | "intentional" | "dismissed", note?: string): boolean {
  return send({ kind: "chapter-review-decide", worldId, productionId, chapterId, reviewId, findingId, decision, ...(note ? { note } : {}), requestId: ulid() });
}
export function subscribeStageConstruction(listener: (result: StageConstructionResult) => void): () => void {
  stageConstructionListeners.add(listener); return () => { stageConstructionListeners.delete(listener); };
}
export const briefEnhancedListeners = new Set<(answer: BriefEnhanced) => void>();
export function subscribeBriefEnhanced(listener: (answer: BriefEnhanced) => void): () => void {
  briefEnhancedListeners.add(listener);
  return () => briefEnhancedListeners.delete(listener);
}

/** The audiobook's package, and the world's packages (design turn 186e): answered to the ask that named them. */
export type AudiobookExported = Extract<DomainEvent, { type: "audiobook.exported" }>;
export type CharacterLookImported = Extract<DomainEvent, { type: "character-look.imported" }>;
export const characterLookImportListeners = new Set<(answer: CharacterLookImported) => void>();
export function subscribeCharacterLookImport(listener: (answer: CharacterLookImported) => void): () => void {
  characterLookImportListeners.add(listener);
  return () => { characterLookImportListeners.delete(listener); };
}
export const audiobookExportedListeners = new Set<(answer: AudiobookExported) => void>();
export function subscribeAudiobookExported(listener: (answer: AudiobookExported) => void): () => void {
  audiobookExportedListeners.add(listener);
  return () => audiobookExportedListeners.delete(listener);
}
/** The world package for Arke Player (design turn 233c): answered to the export that named it. */
export type CreatorPublishingChanged = Extract<DomainEvent, { type: "creator-publishing.changed" }>;
export const creatorPublishingListeners = new Set<(answer: CreatorPublishingChanged) => void>();
export function subscribeCreatorPublishing(listener: (answer: CreatorPublishingChanged) => void): () => void {
  creatorPublishingListeners.add(listener); return () => creatorPublishingListeners.delete(listener);
}
export function creatorPublishing(command: Omit<Extract<ClientMessage, { kind: "creator-publishing-list" }>, "requestId"> | Omit<Extract<ClientMessage, { kind: "creator-publishing-prepare" }>, "requestId"> | Omit<Extract<ClientMessage, { kind: "creator-publishing-submit" }>, "requestId"> | Omit<Extract<ClientMessage, { kind: "creator-publishing-control" }>, "requestId">): string | null {
  const requestId = ulid(); return send({ ...command, requestId }) ? requestId : null;
}
export type ArkePlayerExported = Extract<DomainEvent, { type: "arke-player.exported" }>;
export const arkePlayerExportedListeners = new Set<(answer: ArkePlayerExported) => void>();
export function subscribeArkePlayerExported(listener: (answer: ArkePlayerExported) => void): () => void {
  arkePlayerExportedListeners.add(listener);
  return () => arkePlayerExportedListeners.delete(listener);
}
/** What Export → Arke Player would make of a story (design turn 245a – 245c), answered to the read that asked. */
export type StoryExportStateAnswer = Extract<DomainEvent, { type: "story.export-state" }>;
export const storyExportStateListeners = new Set<(answer: StoryExportStateAnswer) => void>();
export function subscribeStoryExportState(listener: (answer: StoryExportStateAnswer) => void): () => void {
  storyExportStateListeners.add(listener);
  return () => storyExportStateListeners.delete(listener);
}
/** `Make 290 tall` (design turn 235a): how many, how many landed, what was refused. */
export type AudiobookTallProgress = Extract<DomainEvent, { type: "audiobook.tall-progress" }>;
export const audiobookTallProgressListeners = new Set<(progress: AudiobookTallProgress) => void>();
export function subscribeAudiobookTallProgress(listener: (progress: AudiobookTallProgress) => void): () => void {
  audiobookTallProgressListeners.add(listener);
  return () => audiobookTallProgressListeners.delete(listener);
}
/**
 * Each book's last run progress, kept beyond the sheet that shows it: a sheet closed and opened
 * again while a picture is being made shows the run and Stop at once, rather than waiting for
 * the next picture to land (codex on PR 2166). Cleared on reconnect, before replay restores
 * the runs still going. Ordinary refreshes carry no replay.
 */
export const lastTallProgress = new Map<string, AudiobookTallProgress>();
export function lastAudiobookTallProgress(worldId: string, productionId: string): AudiobookTallProgress | null {
  return lastTallProgress.get(`${worldId}/${productionId}`) ?? null;
}
/** The audiobook's video (design turn 197): what a render would make, and what one made. */
export type AudiobookVideoExported = Extract<DomainEvent, { type: "audiobook.video-exported" }>;
export const audiobookVideoExportedListeners = new Set<(answer: AudiobookVideoExported) => void>();
export function subscribeAudiobookVideoExported(listener: (answer: AudiobookVideoExported) => void): () => void {
  audiobookVideoExportedListeners.add(listener);
  return () => audiobookVideoExportedListeners.delete(listener);
}
export type AudiobookVideoStateAnswer = Extract<DomainEvent, { type: "audiobook.video-state" }>;
export const audiobookVideoStateListeners = new Set<(answer: AudiobookVideoStateAnswer) => void>();
export type AudiobookMotionAnswer = Extract<DomainEvent, { type: "audiobook.motion" }>;
export const audiobookMotionListeners = new Set<(answer: AudiobookMotionAnswer) => void>();
export function subscribeAudiobookMotion(listener: (answer: AudiobookMotionAnswer) => void): () => void {
  audiobookMotionListeners.add(listener);
  return () => audiobookMotionListeners.delete(listener);
}
export type AudiobookWordTimingAnswer = Extract<DomainEvent, { type: "audiobook.word-timing" }>;
export type AudiobookWordsAnswer = Extract<DomainEvent, { type: "audiobook.words" }>;
export const audiobookWordsListeners = new Set<(answer: AudiobookWordsAnswer) => void>();
export function subscribeAudiobookWords(listener: (answer: AudiobookWordsAnswer) => void): () => void {
  audiobookWordsListeners.add(listener);
  return () => audiobookWordsListeners.delete(listener);
}
export function requestAudiobookWords(worldId: string, productionId: string, action: "read" | "check" | "stop",
  scope: { chapters?: string[]; blocks?: { chapterId: string; key: string }[] } = {}): string {
  const requestId = ulid();
  send({ kind: "audiobook-words", worldId, productionId, action, ...scope, requestId });
  return requestId;
}
export const audiobookWordTimingListeners = new Set<(answer: AudiobookWordTimingAnswer) => void>();
export function subscribeAudiobookWordTiming(listener: (answer: AudiobookWordTimingAnswer) => void): () => void {
  audiobookWordTimingListeners.add(listener);
  return () => audiobookWordTimingListeners.delete(listener);
}
export function subscribeAudiobookVideoState(listener: (answer: AudiobookVideoStateAnswer) => void): () => void {
  audiobookVideoStateListeners.add(listener);
  return () => audiobookVideoStateListeners.delete(listener);
}
export type GuideVoiceLines = Extract<DomainEvent, { type: "guide.voice-lines" }>;
export const guideVoiceLinesListeners = new Set<(answer: GuideVoiceLines) => void>();
export function subscribeGuideVoiceLines(listener: (answer: GuideVoiceLines) => void): () => void {
  guideVoiceLinesListeners.add(listener);
  return () => guideVoiceLinesListeners.delete(listener);
}
export type GuideDrafting = Extract<DomainEvent, { type: "guide.drafting" }>;
// Kept per world rather than per page: a Draft run outlives the Guide being open, and a Guide opened
// again mid-run must say so instead of offering Draft a second time (SPEC-059 R-40).
export const guideDrafting = new Map<string, GuideDrafting>();
export const guideDraftingListeners = new Set<() => void>();
export function subscribeGuideDrafting(listener: () => void): () => void {
  guideDraftingListeners.add(listener);
  return () => guideDraftingListeners.delete(listener);
}
/** Where the world's Draft run is, or undefined when none has run since the app opened. */
export function guideDraftingOf(worldId: string): GuideDrafting | undefined {
  return guideDrafting.get(worldId);
}
export const noteGuideDrafting = (event: GuideDrafting) => {
  guideDrafting.set(event.worldId, event);
  for (const listener of guideDraftingListeners) listener();
};
export const forgetGuideDrafting = (requestId: string) => {
  for (const [worldId, state] of guideDrafting) {
    if (state.requestId !== requestId || state.finished) continue;
    guideDrafting.delete(worldId);
    for (const listener of guideDraftingListeners) listener();
  }
};
export type WebPackagesListed = Extract<DomainEvent, { type: "web-packages.listed" }>;
export const webPackagesListeners = new Set<(answer: WebPackagesListed) => void>();
export function subscribeWebPackages(listener: (answer: WebPackagesListed) => void): () => void {
  webPackagesListeners.add(listener);
  return () => webPackagesListeners.delete(listener);
}

/** The book as a listener hears it (design turn 186): answered to the ask that named it. */
export type StoryPublishAnswer = Extract<DomainEvent, { type: "story.published" | "story.editions" }>;
export const storyPublishListeners = new Set<(answer: StoryPublishAnswer) => void>();
export function subscribeStoryPublications(listener: (answer: StoryPublishAnswer) => void): () => void {
  storyPublishListeners.add(listener); return () => { storyPublishListeners.delete(listener); };
}
export function publishStory(worldId: string, productionId: string, input: StoryPublishAction): string | null {
  const requestId = ulid(); return send({ kind: "publish-story", worldId, productionId, requestId, input }) ? requestId : null;
}
export function listStoryPublications(): string | null {
  const requestId = ulid(); return send({ kind: "list-story-publications", requestId }) ? requestId : null;
}
export type AudiobookListeningAnswer = Extract<DomainEvent, { type: "audiobook.listening" }>;
export const audiobookListeningListeners = new Set<(answer: AudiobookListeningAnswer) => void>();
export function subscribeAudiobookListening(listener: (answer: AudiobookListeningAnswer) => void): () => void {
  audiobookListeningListeners.add(listener);
  return () => audiobookListeningListeners.delete(listener);
}

/** A chapter's mix rendered (design turn 187): answered to the ask that named it. */
export type AudiobookMixAnswer = Extract<DomainEvent, { type: "audiobook.mix" }>;
export type AudioStudioAnswer = Extract<DomainEvent, { type: "audio-studio.state" }>;
export const audioStudioListeners = new Set<(answer: AudioStudioAnswer) => void>();
export function subscribeAudioStudio(listener: (answer: AudioStudioAnswer) => void): () => void {
  audioStudioListeners.add(listener);
  return () => audioStudioListeners.delete(listener);
}
export const audiobookMixListeners = new Set<(answer: AudiobookMixAnswer) => void>();
export function subscribeAudiobookMix(listener: (answer: AudiobookMixAnswer) => void): () => void {
  audiobookMixListeners.add(listener);
  return () => audiobookMixListeners.delete(listener);
}

/** Arke's timing for a chapter (design turn 187b): answered to the ask that named it. */
export type AudiobookTimingProposalAnswer = Extract<DomainEvent, { type: "audiobook.timing-proposal" }>;
export const audiobookTimingProposalListeners = new Set<(answer: AudiobookTimingProposalAnswer) => void>();
export function subscribeAudiobookTimingProposal(listener: (answer: AudiobookTimingProposalAnswer) => void): () => void {
  audiobookTimingProposalListeners.add(listener);
  return () => audiobookTimingProposalListeners.delete(listener);
}

export type BenchSubjectOpened = Extract<DomainEvent, { type: "bench.subject-opened" }>;
export const benchSubjectOpenedListeners = new Set<(answer: BenchSubjectOpened) => void>();
export function subscribeBenchSubjectOpened(listener: (answer: BenchSubjectOpened) => void): () => void {
  benchSubjectOpenedListeners.add(listener);
  return () => benchSubjectOpenedListeners.delete(listener);
}

type BenchReferenceUsed = Extract<DomainEvent, { type: "bench.reference-used" }>;
export const benchReferenceUsedListeners = new Set<(answer: BenchReferenceUsed) => void>();
export function subscribeBenchReferenceUsed(listener: (answer: BenchReferenceUsed) => void): () => void {
  benchReferenceUsedListeners.add(listener);
  return () => benchReferenceUsedListeners.delete(listener);
}

export type BenchSubjectAccepted = Extract<DomainEvent, { type: "bench.subject-accepted" }>;
export const benchSubjectAcceptedListeners = new Set<(answer: BenchSubjectAccepted) => void>();
export function subscribeBenchSubjectAccepted(listener: (answer: BenchSubjectAccepted) => void): () => void {
  benchSubjectAcceptedListeners.add(listener);
  return () => benchSubjectAcceptedListeners.delete(listener);
}

/** What a take's Delete would remove, and the answer to the Delete itself (design turn 180). */
export type BenchTakeFiles = Extract<DomainEvent, { type: "bench.take-files" }>;
export const benchTakeFilesListeners = new Set<(answer: BenchTakeFiles) => void>();
export function subscribeBenchTakeFiles(listener: (answer: BenchTakeFiles) => void): () => void {
  benchTakeFilesListeners.add(listener);
  return () => benchTakeFilesListeners.delete(listener);
}
export type BenchTakeDeleted = Extract<DomainEvent, { type: "bench.take-deleted" }>;
export const benchTakeDeletedListeners = new Set<(answer: BenchTakeDeleted) => void>();
export function subscribeBenchTakeDeleted(listener: (answer: BenchTakeDeleted) => void): () => void {
  benchTakeDeletedListeners.add(listener);
  return () => benchTakeDeletedListeners.delete(listener);
}

export type ReferenceImagesResult = Extract<DomainEvent, { type: "reference.images" }>;
export type LookRenameResult = Extract<DomainEvent, { type: "reference.look-renamed" }>;
export const lookRenameListeners = new Set<(result: LookRenameResult) => void>();
export function subscribeLookRename(listener: (result: LookRenameResult) => void): () => void {
  lookRenameListeners.add(listener);
  return () => { lookRenameListeners.delete(listener); };
}
export function renameSavedLook(worldId: string, sheetId: string, lookId: string, name: string, expectedName: string | null): string | null {
  const requestId = ulid();
  return send({ kind: "rename-character-look", worldId, sheetId, lookId, name, expectedName, requestId }) ? requestId : null;
}
export const referenceImageListeners = new Set<(result: ReferenceImagesResult) => void>();
export function subscribeReferenceImages(listener: (result: ReferenceImagesResult) => void): () => void {
  referenceImageListeners.add(listener);
  return () => { referenceImageListeners.delete(listener); };
}
export function browseReferenceImages(slug: string, requestId: string): void {
  send({ kind: "browse-reference-images", slug, requestId });
}

/** Another world's placeable files, for the Cut's Library (issue 1033). */
export type WorldArtifactsResult = Extract<DomainEvent, { type: "world.artifacts" }>;
export const worldArtifactListeners = new Set<(result: WorldArtifactsResult) => void>();
export function subscribeWorldArtifacts(listener: (result: WorldArtifactsResult) => void): () => void {
  worldArtifactListeners.add(listener);
  return () => { worldArtifactListeners.delete(listener); };
}
export function browseWorldArtifacts(slug: string, requestId: string): void {
  send({ kind: "browse-world-artifacts", slug, requestId });
}
/**
 * Copy files from another world into this one, then list or place them as an upload would
 * (issue 1033). Answered like an upload, through the queue results, under the returned request.
 */
export function borrowArtifacts(
  worldId: string, slug: string, files: readonly string[],
  editor: Extract<ClientMessage, { kind: "borrow-artifacts" }>["editor"],
): { requestId: string | null; reason?: string } {
  if (files.length === 0 || files.length > 16) return { requestId: null, reason: "Copy up to 16 files at a time." };
  const requestId = queueRequest("borrow-artifacts");
  if (!send({ kind: "borrow-artifacts", worldId, requestId, slug, files: [...files], editor })) {
    pendingQueueRequests.delete(requestId);
    return { requestId: null, reason: "The files could not be copied. Check the connection and try again." };
  }
  return { requestId };
}

export const browserUploadResults = new Map<string, (reason?: string) => void>();

export type WorldChatMediaOpened = Extract<DomainEvent, { type: "world-chat.media-opened" }>;
export const worldChatMediaListeners = new Set<(answer: WorldChatMediaOpened) => void>();
export function subscribeWorldChatMediaOpened(listener: (answer: WorldChatMediaOpened) => void): () => void {
  worldChatMediaListeners.add(listener);
  return () => worldChatMediaListeners.delete(listener);
}

export type ConversationActionDecisionResult = Extract<
  DomainEvent,
  { type: "conversation-action.decision-result" }
>;
export const conversationActionDecisionListeners = new Set<(answer: ConversationActionDecisionResult) => void>();
export type TakeReviewPrepared = Extract<DomainEvent, { type: "conversation-action.take-review-prepared" }>;
export const takeReviewPreparedListeners = new Set<(answer: TakeReviewPrepared) => void>();
export function subscribeConversationActionDecision(
  listener: (answer: ConversationActionDecisionResult) => void,
): () => void {
  conversationActionDecisionListeners.add(listener);
  return () => conversationActionDecisionListeners.delete(listener);
}

export type LyricsDrafted = Extract<DomainEvent, { type: "bench.lyrics-drafted" }>;
export const lyricsDraftedListeners = new Set<(answer: LyricsDrafted) => void>();
export function subscribeLyricsDrafted(listener: (answer: LyricsDrafted) => void): () => void {
  lyricsDraftedListeners.add(listener);
  return () => lyricsDraftedListeners.delete(listener);
}

// A music production's answers (design turn 238, SPEC-060): a track's drafted lyrics, where its
// tracks are heard, and Play all's render, each to the window that asked by its request id.
export type MusicLyricsDrafted = Extract<DomainEvent, { type: "music.lyrics-drafted" }>;
export type MusicHeardIn = Extract<DomainEvent, { type: "music.heard-in" }>;
export type MusicRendered = Extract<DomainEvent, { type: "music.rendered" }>;
export const musicLyricsListeners = new Set<(answer: MusicLyricsDrafted) => void>();
export const musicHeardListeners = new Set<(answer: MusicHeardIn) => void>();
export const musicRenderedListeners = new Set<(answer: MusicRendered) => void>();
export function subscribeMusicLyricsDrafted(listener: (answer: MusicLyricsDrafted) => void): () => void {
  musicLyricsListeners.add(listener);
  return () => musicLyricsListeners.delete(listener);
}
export function subscribeMusicHeardIn(listener: (answer: MusicHeardIn) => void): () => void {
  musicHeardListeners.add(listener);
  return () => musicHeardListeners.delete(listener);
}
export function subscribeMusicRendered(listener: (answer: MusicRendered) => void): () => void {
  musicRenderedListeners.add(listener);
  return () => musicRenderedListeners.delete(listener);
}
// A track's takes (238i), asked for or pushed when the album's session moves, and a file's
// waveform (238j, 238k), each to whoever is listening.
export type MusicTakes = Extract<DomainEvent, { type: "music.takes" }>;
export type MusicWaveformAnswer = Extract<DomainEvent, { type: "music.waveform" }>;
export const musicTakesListeners = new Set<(answer: MusicTakes) => void>();
export const musicWaveformListeners = new Set<(answer: MusicWaveformAnswer) => void>();
export function subscribeMusicTakes(listener: (answer: MusicTakes) => void): () => void {
  musicTakesListeners.add(listener);
  return () => musicTakesListeners.delete(listener);
}
export function subscribeMusicWaveform(listener: (answer: MusicWaveformAnswer) => void): () => void {
  musicWaveformListeners.add(listener);
  return () => musicWaveformListeners.delete(listener);
}


export function subscribeFiledBatch(listener: (batch: FiledBatch) => void): () => void {
  filedBatchListeners.add(listener);
  return () => filedBatchListeners.delete(listener);
}

export const audiobookActivityListeners = new Set<(run: import("@arke-studio/contracts").AudiobookActivity) => void>();
export function subscribeAudiobookActivity(listener: (run: import("@arke-studio/contracts").AudiobookActivity) => void): () => void {
  audiobookActivityListeners.add(listener);
  return () => { audiobookActivityListeners.delete(listener); };
}

export function subscribeQueueResults(listener: (result: QueueEnqueueResult) => void): () => void {
  queueResultListeners.add(listener);
  return () => queueResultListeners.delete(listener);
}

export function subscribeVoiceAssignmentResults(
  listener: (result: VoiceAssignmentResult) => void,
): () => void {
  voiceAssignmentListeners.add(listener);
  return () => voiceAssignmentListeners.delete(listener);
}

export function subscribeVoiceUploadConfirmations(
  listener: (result: VoiceUploadConfirmationRequired) => void,
): () => void {
  voiceUploadConfirmationListeners.add(listener);
  return () => voiceUploadConfirmationListeners.delete(listener);
}

/** The outcome of deleting a cloned voice (SPEC-046 R-15), by requestId: the library's part and each vendor copy's. */
export type VoiceDeleteResult = Extract<DomainEvent, { type: "voice.deleted" }>;
export const voiceDeleteListeners = new Set<(result: VoiceDeleteResult) => void>();
export function subscribeVoiceDeleteResults(listener: (result: VoiceDeleteResult) => void): () => void {
  voiceDeleteListeners.add(listener);
  return () => voiceDeleteListeners.delete(listener);
}

/** The correlated answer to one create-production request (issue 384), by requestId. */
export type ProductionCreateResult = Extract<DomainEvent, { type: "production.create-result" }>;
/** Refused direct scene writes (review 2026-08-22), delivered to the storyboard that sent them. */
type CommandFailure = Extract<DomainEvent, { type: "command.failed" }>;
export const commandFailureListeners = new Set<(event: CommandFailure) => void>();
export const worldImportListeners = new Set<(event: Extract<DomainEvent, { type: "world.import-result" }>) => void>();
export function subscribeWorldImport(listener: (event: Extract<DomainEvent, { type: "world.import-result" }>) => void): () => void {
  worldImportListeners.add(listener); return () => { worldImportListeners.delete(listener); };
}
export function importWorld(): string | null {
  const requestId = ulid(); return send({ kind: "import-world", requestId }) ? requestId : null;
}
export function subscribeCommandFailures(listener: (event: CommandFailure) => void): () => void {
  commandFailureListeners.add(listener);
  return () => commandFailureListeners.delete(listener);
}
/**
 * A command the coordinator could not read (issue 2778) ends the way any failed command does:
 * its request is let go and the screens waiting on a failure hear it, so a control held for the
 * answer is released and the toaster says why.
 */
export type HostOnlyRefusal = Extract<RemoteCommandRefusal, { refused: "host-only" }>;
export function refuseInvalidCommand(refusal: Extract<RemoteCommandRefusal, { refused: "invalid" }>): void {
  if (refusal.requestId !== undefined) pendingQueueRequests.delete(refusal.requestId);
  const failure: CommandFailure = { type: "command.failed", at: new Date().toISOString(), command: refusal.command ?? "unknown",
    requestId: refusal.requestId ?? null, reason: "Studio could not read that request. Try again." };
  for (const listener of commandFailureListeners) listener(failure);
}

export const sceneRefusalListeners = new Set<
  (event: { productionId: string; sceneFile: string; reason: string }) => void
>();

export function subscribeSceneRefusals(
  listener: (event: { productionId: string; sceneFile: string; reason: string }) => void,
): () => void {
  sceneRefusalListeners.add(listener);
  return () => sceneRefusalListeners.delete(listener);
}

export type TimelineCommandRefusal = Extract<DomainEvent, { type: "timeline.command-refused" }>;
export const timelineRefusalListeners = new Set<(event: TimelineCommandRefusal) => void>();
export function subscribeTimelineRefusals(listener: (event: TimelineCommandRefusal) => void): () => void {
  timelineRefusalListeners.add(listener);
  return () => timelineRefusalListeners.delete(listener);
}

export const productionCreateListeners = new Set<(result: ProductionCreateResult) => void>();
export type ProductionSetupResult = Extract<DomainEvent, { type: "production-setup.result" }>;
export type WorldChatCreateResult = Extract<DomainEvent, { type: "world-chat.create-result" }>;
export const worldChatCreateListeners = new Set<(result: WorldChatCreateResult) => void>();
export function subscribeWorldChatCreateResults(listener: (result: WorldChatCreateResult) => void): () => void {
  worldChatCreateListeners.add(listener);
  return () => { worldChatCreateListeners.delete(listener); };
}
export const productionSetupListeners = new Set<(result: ProductionSetupResult) => void>();
export const narrativeSavedListeners = new Set<(result: Extract<DomainEvent, { type: "production-narrative.saved" }>) => void>();
export function subscribeNarrativeSaved(listener: (result: Extract<DomainEvent, { type: "production-narrative.saved" }>) => void): () => void {
  narrativeSavedListeners.add(listener);
  return () => { narrativeSavedListeners.delete(listener); };
}
export function subscribeProductionSetupResults(listener: (result: ProductionSetupResult) => void): () => void {
  productionSetupListeners.add(listener);
  return () => { productionSetupListeners.delete(listener); };
}
export function subscribeProductionCreateResults(
  listener: (result: ProductionCreateResult) => void,
): () => void {
  productionCreateListeners.add(listener);
  return () => productionCreateListeners.delete(listener);
}

/** The correlated answer to one `New chapter` press (turn 126), by requestId. */
export type ChapterCreateResult = Extract<DomainEvent, { type: "chapter.create-result" }>;
export const chapterCreateListeners = new Set<(result: ChapterCreateResult) => void>();
export function subscribeChapterCreateResults(listener: (result: ChapterCreateResult) => void): () => void {
  chapterCreateListeners.add(listener);
  return () => chapterCreateListeners.delete(listener);
}

/** A chapter's body, answered to the screen that asked (turn 126), by requestId. */
export type ChapterOpenResult = Extract<DomainEvent, { type: "chapter.open-result" }>;
export const chapterOpenListeners = new Set<(result: ChapterOpenResult) => void>();
export type ChapterVersionResult = Extract<DomainEvent, { type: "chapter.version-result" }>;
export const chapterVersionListeners = new Set<(result: ChapterVersionResult) => void>();
/** A file read, so a long wait is a lost answer rather than a slow one. */
export const VERSION_READ_TIMEOUT_MS = 20_000;
export function subscribeChapterOpenResults(listener: (result: ChapterOpenResult) => void): () => void {
  chapterOpenListeners.add(listener);
  return () => chapterOpenListeners.delete(listener);
}

/** An audio drama's lines heard (SPEC-057 R-25..R-28): a quote, the speakers with no voice, or what was made. */
export type DramaHeard = Extract<DomainEvent, { type: "drama.heard" }>;
export const dramaHeardListeners = new Set<(result: DramaHeard) => void>();
export function subscribeDramaHeard(listener: (result: DramaHeard) => void): () => void {
  dramaHeardListeners.add(listener);
  return () => dramaHeardListeners.delete(listener);
}

/** A sound for an audio drama's cue (SPEC-057 R-39..R-42): a quote, or the artifacts made. */
export type DramaSound = Extract<DomainEvent, { type: "drama.sound" }>;
export const dramaSoundListeners = new Set<(result: DramaSound) => void>();
export function subscribeDramaSound(listener: (result: DramaSound) => void): () => void {
  dramaSoundListeners.add(listener);
  return () => dramaSoundListeners.delete(listener);
}

/** What became of one comic script save (SPEC-064 R-10): the new base, or a refusal by name. */
export type ComicScriptSaveResult = Extract<DomainEvent, { type: "comic-script.save-result" }>;
export const comicScriptSaveListeners = new Set<(result: ComicScriptSaveResult) => void>();
export function subscribeComicScriptSaveResults(listener: (result: ComicScriptSaveResult) => void): () => void {
  comicScriptSaveListeners.add(listener);
  return () => comicScriptSaveListeners.delete(listener);
}

/** A page's price and brief (SPEC-064 R-19, R-23), and a page being made (R-25). */
export type ComicPageQuote = Extract<DomainEvent, { type: "comic.page-quote" }>;
export type ComicPageMade = Extract<DomainEvent, { type: "comic.page-made" }>;
export type ComicTakeResult = Extract<DomainEvent, { type: "comic.take-result" }>;
export type ComicPageLettered = Extract<DomainEvent, { type: "comic.page-lettered" }>;
export type ComicLetteringPlaced = Extract<DomainEvent, { type: "comic.lettering-placed" }>;
type ComicPageEvent = ComicPageQuote | ComicPageMade | ComicTakeResult | ComicPageLettered | ComicLetteringPlaced;
export const comicPageListeners = new Set<(event: ComicPageEvent) => void>();
export function subscribeComicPages(listener: (event: ComicPageEvent) => void): () => void {
  comicPageListeners.add(listener);
  return () => comicPageListeners.delete(listener);
}

/** What became of a book's export (SPEC-064 R-47, R-49). */
export type ComicExported = Extract<DomainEvent, { type: "comic.exported" }>;
export const comicExportListeners = new Set<(event: ComicExported) => void>();
export function subscribeComicExported(listener: (event: ComicExported) => void): () => void {
  comicExportListeners.add(listener);
  return () => comicExportListeners.delete(listener);
}

/** What became of one episode script save (SPEC-057 R-83): the new base, or a refusal by name. */
export type EpisodeScriptSaveResult = Extract<DomainEvent, { type: "episode-script.save-result" }>;
export const episodeScriptSaveListeners = new Set<(result: EpisodeScriptSaveResult) => void>();
export function subscribeEpisodeScriptSaveResults(listener: (result: EpisodeScriptSaveResult) => void): () => void {
  episodeScriptSaveListeners.add(listener);
  return () => episodeScriptSaveListeners.delete(listener);
}

type DramaEditionAnswer = { requestId: string; editions: Extract<DomainEvent, { type: "drama.editions" }>["editions"]; mixes?: Extract<DomainEvent, { type: "drama.editions" }>["mixes"]; refused?: string };
export const dramaEditionListeners = new Set<(answer: DramaEditionAnswer) => void>();
/** An edition published or refused, or the production's editions listed (SPEC-057 R-71). */
export function subscribeDramaEditions(listener: (answer: DramaEditionAnswer) => void): () => void {
  dramaEditionListeners.add(listener);
  return () => dramaEditionListeners.delete(listener);
}
export function publishDramaEdition(worldId: string, productionId: string, input: { name: string; delivery: "podcast" | "archive"; episodes: number[]; stems?: boolean }): string | null {
  const requestId = ulid();
  return send({ kind: "publish-drama-edition", requestId, worldId, productionId, ...input }) ? requestId : null;
}
export function listDramaEditions(worldId: string, productionId: string): string | null {
  const requestId = ulid();
  return send({ kind: "list-drama-editions", requestId, worldId, productionId }) ? requestId : null;
}

export const dramaSourceListeners = new Set<(result: Extract<DomainEvent, { type: "drama.source" }>) => void>();
/** The exact text a scene was adapted from, by its pinned hash (SPEC-057 R-65). Rejects with why. */
export function readDramaSource(worldId: string, productionId: string, hash: string): Promise<string> {
  const requestId = ulid();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { dramaSourceListeners.delete(listener); reject(new Error("No answer.")); }, 15_000);
    const listener = (result: Extract<DomainEvent, { type: "drama.source" }>) => {
      if (result.requestId !== requestId) return;
      clearTimeout(timer); dramaSourceListeners.delete(listener);
      if (result.body !== undefined) resolve(result.body); else reject(new Error(result.reason ?? "Not kept."));
    };
    dramaSourceListeners.add(listener);
    if (!send({ kind: "read-drama-source", requestId, worldId, productionId, hash })) { clearTimeout(timer); dramaSourceListeners.delete(listener); reject(new Error("Not connected.")); }
  });
}

/** What became of one chapter save (turn 126): the new base, or a refusal by name. */
export type ChapterSaveResult = Extract<DomainEvent, { type: "chapter.save-result" }>;
export const chapterSaveListeners = new Set<(result: ChapterSaveResult) => void>();
export function subscribeChapterSaveResults(listener: (result: ChapterSaveResult) => void): () => void {
  chapterSaveListeners.add(listener);
  return () => chapterSaveListeners.delete(listener);
}

/** The correlated answer to one create-scene request (SPEC-036 R-37), by requestId. */
export type SceneCreateResult = Extract<DomainEvent, { type: "scene.create-result" }>;
export const sceneCreateListeners = new Set<(result: SceneCreateResult) => void>();
export function subscribeSceneCreateResults(listener: (result: SceneCreateResult) => void): () => void {
  sceneCreateListeners.add(listener);
  return () => sceneCreateListeners.delete(listener);
}

export type SheetEditResult = Extract<DomainEvent, { type: "sheet.edit-result" }>;
export const sheetEditResultListeners = new Set<(result: SheetEditResult) => void>();
export function subscribeSheetEditResults(listener: (result: SheetEditResult) => void): () => void {
  sheetEditResultListeners.add(listener);
  return () => sheetEditResultListeners.delete(listener);
}

export type SingleActResult = Extract<DomainEvent, { type: "single-act.result" }>;
export const singleActResultListeners = new Set<(result: SingleActResult) => void>();
export const proposalResolutionListeners = new Set<
  (result: Extract<DomainEvent, { type: "proposal.resolved" }>) => void
>();
export function subscribeSingleActResults(listener: (result: SingleActResult) => void): () => void {
  singleActResultListeners.add(listener);
  return () => singleActResultListeners.delete(listener);
}

export function subscribeProposalResolutions(
  listener: (result: Extract<DomainEvent, { type: "proposal.resolved" }>) => void,
): () => void {
  proposalResolutionListeners.add(listener);
  return () => proposalResolutionListeners.delete(listener);
}

/**
 * Refusals by the request they answer, kept past the moment they arrive (codex on PR 1232): the
 * notice on a proposal is only its latest, and another window's refusal on the same proposal
 * would otherwise overwrite the one a screen is holding its controls for. Only this window's own
 * requests are kept, and each until the screen holding it lets go or the world closes — not by
 * count (codex on PR 1232): a chapter put away while others are refused would come back to a
 * hold whose answer had been dropped. Refreshed with each notice, so a screen reading this on
 * render sees it as soon as it lands.
 */
export const gateRequests = new Set<string>();
export const gateAnswers = new Set<string>();
/** Whether the gate has refused this request, by its id. */
export function gateAnswered(requestId: string): boolean {
  return gateAnswers.has(requestId);
}
/** The screen that sent this request has settled it; its answer is no longer wanted. */
export function forgetGateRequest(requestId: string): void {
  gateRequests.delete(requestId);
  gateAnswers.delete(requestId);
}

export type WorldChatSendResult = Extract<DomainEvent, { type: "world-chat.send-result" }>;
export type WorldChatInputResult = Extract<DomainEvent, { type: "world-chat.input-result" }>;
export const inputResultListeners = new Set<(result: WorldChatInputResult) => void>();
export function subscribeWorldChatInputResults(listener: (result: WorldChatInputResult) => void): () => void {
  inputResultListeners.add(listener);
  return () => inputResultListeners.delete(listener);
}
export function sendWorldChatInput(worldId: string, conversationId: string, input: import("@arke-studio/contracts").WorldChatInputRequest): boolean {
  return send({ kind: "world-chat-input", worldId, conversationId: conversationId as never, input });
}
export function worldChatInputStatus(worldId: string, conversationId: string, requestId: string): boolean {
  return send({ kind: "world-chat-input-status", worldId, conversationId: conversationId as never, requestId });
}
export function removeWorldChatInput(worldId: string, conversationId: string, messageId: string, revision: number): string | null {
  const requestId = crypto.randomUUID();
  return send({ kind: "world-chat-input-remove", worldId, conversationId: conversationId as never, requestId, messageId, revision }) ? requestId : null;
}
export function continueWorldChatInputs(worldId: string, conversationId: string, revision: number, routing: import("@arke-studio/contracts").WorldChatInputRouting): string | null {
  const requestId = crypto.randomUUID();
  return send({ kind: "world-chat-input-continue", worldId, conversationId: conversationId as never, requestId, revision, routing }) ? requestId : null;
}
export const sendResultListeners = new Set<(result: WorldChatSendResult) => void>();
/** Whether a line sent into a conversation was taken as a turn, answered for its request id. */
export function subscribeWorldChatSendResults(listener: (result: WorldChatSendResult) => void): () => void {
  sendResultListeners.add(listener);
  return () => sendResultListeners.delete(listener);
}
/** The answer already given for a request, if one has arrived. */
export function worldChatSendResult(requestId: string): boolean | undefined {
  return sendResults.get(requestId)?.admitted;
}

export type CanonContradictions = Extract<DomainEvent, { type: "canon.contradictions" }>;
export const canonContradictionListeners = new Set<(result: CanonContradictions) => void>();
export function subscribeCanonContradictions(listener: (result: CanonContradictions) => void): () => void {
  canonContradictionListeners.add(listener);
  return () => canonContradictionListeners.delete(listener);
}

export type PlanResult = Extract<DomainEvent, { type: "production.plan-result" }>;
export type PlanStateEvent = Extract<DomainEvent, { type: "production.plan-state" }>;
export const planResultListeners = new Set<(result: PlanResult) => void>();
export const planStateListeners = new Set<(event: PlanStateEvent) => void>();

export type FrameRunQuoteEvent = Extract<DomainEvent, { type: "production.frame-run-quote" }>;
export const frameRunQuoteListeners = new Map<string, Set<(event: FrameRunQuoteEvent) => void>>();
export type FrameRunStartResultEvent = Extract<DomainEvent, { type: "production.frame-run-start-result" }>;
export const frameRunStartResultListeners = new Map<string, Set<(event: FrameRunStartResultEvent) => void>>();
export const frameRunStartKey = (requestId: string, quoteId: string): string => `${requestId}:${quoteId}`;

/** A quote is a one-shot answer to one option set; changing options abandons its request id. */
export function subscribeFrameRunQuote(
  requestId: string,
  listener: (event: FrameRunQuoteEvent) => void,
): () => void {
  const listeners = frameRunQuoteListeners.get(requestId) ?? new Set();
  listeners.add(listener);
  frameRunQuoteListeners.set(requestId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) frameRunQuoteListeners.delete(requestId);
  };
}

export function clearFrameRunQuote(requestId: string): void {
  if (!(requestId in current.frameRunQuotes)) return;
  const frameRunQuotes = { ...current.frameRunQuotes };
  delete frameRunQuotes[requestId];
  emitChange({ ...current, frameRunQuotes });
}

export function subscribeFrameRunStartResult(
  requestId: string,
  quoteId: string,
  listener: (event: FrameRunStartResultEvent) => void,
): () => void {
  const key = frameRunStartKey(requestId, quoteId);
  const listeners = frameRunStartResultListeners.get(key) ?? new Set();
  listeners.add(listener);
  frameRunStartResultListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) frameRunStartResultListeners.delete(key);
  };
}

export function clearFrameRunStartResult(requestId: string, quoteId: string): void {
  const key = frameRunStartKey(requestId, quoteId);
  if (!(key in current.frameRunStartResults)) return;
  const frameRunStartResults = { ...current.frameRunStartResults };
  delete frameRunStartResults[key];
  emitChange({ ...current, frameRunStartResults });
}

export type RoutingFindingsEvent = Extract<DomainEvent, { type: "production.routing-findings" }>;
export type InteractiveExportEvent = Extract<DomainEvent, { type: "production.interactive-export-result" }>;
export const routingFindingsListeners = new Set<(event: RoutingFindingsEvent) => void>();
export const interactiveExportListeners = new Set<(event: InteractiveExportEvent) => void>();
export function subscribeRoutingFindings(listener: (event: RoutingFindingsEvent) => void): () => void {
  routingFindingsListeners.add(listener);
  return () => routingFindingsListeners.delete(listener);
}
export function subscribeInteractiveExports(listener: (event: InteractiveExportEvent) => void): () => void {
  interactiveExportListeners.add(listener);
  return () => interactiveExportListeners.delete(listener);
}
export function subscribePlanResults(listener: (result: PlanResult) => void): () => void {
  planResultListeners.add(listener);
  return () => planResultListeners.delete(listener);
}
export function subscribePlanStates(listener: (event: PlanStateEvent) => void): () => void {
  planStateListeners.add(listener);
  return () => planStateListeners.delete(listener);
}

export function subscribeJobReady(listener: (job: Job) => void): () => void {
  jobReadyListeners.add(listener);
  return () => jobReadyListeners.delete(listener);
}

export const recoveryNoticeListeners = new Set<(notice: import("@arke-studio/contracts").RecoveryNotice, history: import("@arke-studio/contracts").RecoveryHistorySnapshot) => void>();
export const seenRecoveryNotices = new Set<string>();
export function subscribeRecoveryNotices(listener: (notice: import("@arke-studio/contracts").RecoveryNotice, history: import("@arke-studio/contracts").RecoveryHistorySnapshot) => void): () => void {
  recoveryNoticeListeners.add(listener); return () => recoveryNoticeListeners.delete(listener);
}

export function queueRequest(command: QueueCommand, characterName?: string): string {
  const requestId = ulid();
  if (current.connection === "open") {
    pendingQueueRequests.set(requestId, { command, ...(characterName ? { characterName } : {}) });
  }
  return requestId;
}

export const remoteRefusalListeners = new Set<(refusal: HostOnlyRefusal) => void>();
export const studioAssistantReplyListeners = new Set<(frame: Extract<Frame, { kind: "studio-assistant" }>) => void>();
/** Private panel subscription only: no transcript is folded into app/world state. */
export function onStudioAssistantReply(listener: (frame: Extract<Frame, { kind: "studio-assistant" }>) => void): () => void {
  studioAssistantReplyListeners.add(listener); return () => studioAssistantReplyListeners.delete(listener);
}
export function subscribeRemoteRefusals(listener: (refusal: HostOnlyRefusal) => void): () => void {
  remoteRefusalListeners.add(listener);
  return () => remoteRefusalListeners.delete(listener);
}

export const promptToolsListeners = new Set<(event: Extract<DomainEvent, { type: "prompt-tools.result" }>) => void>();
export const mediaMeasurementListeners = new Set<(event: Extract<DomainEvent, { type: "media.measured" }>) => void>();
export function requestMediaMeasurement(message: Omit<Extract<ClientMessage, { kind: "measure-production-media" }>, "kind" | "requestId">,
  signal: AbortSignal): Promise<import("@arke-studio/contracts").MediaMeasurementResult> {
  const requestId = ulid();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); mediaMeasurementListeners.delete(listener); signal.removeEventListener("abort", cancel); };
    const cancel = () => { cleanup(); reject(new Error("Measurement dismissed.")); };
    const listener = (event: Extract<DomainEvent, { type: "media.measured" }>) => {
      if (event.requestId !== requestId || event.worldId !== message.worldId) return;
      cleanup(); resolve(event.result);
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("No answer. Try the measurement again.")); }, 60_000);
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener("abort", cancel, { once: true });
    mediaMeasurementListeners.add(listener);
    if (!send({ kind: "measure-production-media", ...message, requestId })) { cleanup(); reject(new Error("Not connected. Reconnect to try again.")); }
  });
}
export function setPromptTools(enabled: boolean): void { send({ kind: "set-prompt-tools", enabled }); }
export function requestPromptTools(message: Omit<Extract<ClientMessage, { kind: "prompt-history-read" }>, "requestId"> |
  Omit<Extract<ClientMessage, { kind: "prompt-history-restore" }>, "requestId"> |
  Omit<Extract<ClientMessage, { kind: "prompt-request-inspect" }>, "requestId">): Promise<import("@arke-studio/contracts").PromptToolsResult> {
  const requestId = ulid();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { promptToolsListeners.delete(listener); reject(new Error("No answer. Read again to retry.")); }, 20_000);
    const listener = (event: Extract<DomainEvent, { type: "prompt-tools.result" }>) => {
      if (event.requestId !== requestId || event.worldId !== message.worldId) return;
      clearTimeout(timer); promptToolsListeners.delete(listener);
      if (event.result.kind === "failed") reject(new Error(event.result.reason)); else resolve(event.result);
    };
    promptToolsListeners.add(listener);
    if (!send({ ...message, requestId })) { clearTimeout(timer); promptToolsListeners.delete(listener); reject(new Error("Not connected.")); }
  });
}
