import {
  type TraversalEvidence, type GuideSheetKind, type SetGuideEntry, type SetGuideTeasers,
  type RoutingCommand, type ClientMessage, type DramaChapterDecision, type DramaRole,
  type EpisodeScriptBlock, type SizeTier, ulid,
} from "@arke-studio/contracts";
import { send } from "./core.js";
import {
  noteGuideDrafting, type ChapterVersionResult, chapterVersionListeners, VERSION_READ_TIMEOUT_MS,
} from "./events.js";

// ---- SPEC-012: productions, scenes, boards, dispatch -----------------------

export function createProduction(
  worldId: string,
  input: {
    title: string;
    /** The audience-facing medium (SPEC-023 R-1) — step one of the dialog. */
    medium: "story" | "video" | "interactive-video" | "music";
    /** The named format beneath it (SPEC-023 R-2), sent only when it says something. */
    productionKind?: string;
    /** The production a soundtrack is for (SPEC-060 R-1). */
    soundtrackFor?: string;
    /** A graphic novel from the door's Start empty (turn 272). */
    startEmpty?: true;
    seriesTitle?: string;
    aspect?: string;
    frameRate?: 24 | 25 | 30;
    defaults?: {
      episodeCount?: number;
      episodeSecondsMin?: number;
      episodeSecondsMax?: number;
      hookWindowSec?: number;
      episodeEnding?: string;
      exportPreset?: string;
    };
    logline?: string;
  },
): string {
  // Returns the requestId so the dialog can correlate the production.create-result: pending
  // until it arrives, navigating only on success, showing the named failure in place (issue 384).
  const requestId = ulid();
  send({ kind: "create-production", worldId, requestId, ...input });
  return requestId;
}

/** Stage the structured overview through the gate — nothing is written live (issue 385). */
export function proposeStoryOverview(
  worldId: string,
  productionId: string,
  overview: {
    logline?: string;
    spine?: string;
    targetLength?: string;
    acts?: Array<{ title: string; summary?: string }>;
  },
): string | null {
  const requestId = ulid();
  return send({ kind: "propose-story-overview", worldId, requestId, productionId, ...overview }) ? requestId : null;
}

/** Have the studio draft the overview into a staged proposal (issue 385). */
export function draftStoryOverview(worldId: string, productionId: string, instruction: string): void {
  send({ kind: "draft-story-overview", worldId, productionId, instruction });
}

/** Stage the season record through the gate — nothing is written live (issue 397). */
export function proposeSeason(
  worldId: string,
  productionId: string,
  season: {
    question?: string;
    ending?: string;
    direction?: string;
    arcs?: Array<{
      id: string;
      title: string;
      note?: string;
      setup?: string;
      turn?: string;
      payoff?: string;
    }>;
  },
): string | null {
  const requestId = ulid();
  return send({ kind: "propose-season", worldId, requestId, productionId, ...season }) ? requestId : null;
}

/**
 * Make an episode, live (issue 728) — as `New scene` already does. No proposal, so no press
 * that waits on an approvals screen the person never went to.
 */
export function createEpisode(
  worldId: string,
  productionId: string,
  episode: { title?: string; order?: number } = {},
): void {
  send({ kind: "create-episode", worldId, productionId, ...episode });
}

/** Stage one episode — a create mints identity from the title; an amend names its id (issue 397). */
export function proposeEpisode(
  worldId: string,
  productionId: string,
  episode: {
    episodeId?: string;
    title?: string;
    order?: number;
    promise?: { opens?: string; turn?: string; closes?: string };
    scenes?: string[];
  },
): string | null {
  const requestId = ulid();
  return send({ kind: "propose-episode", worldId, requestId, productionId, ...episode }) ? requestId : null;
}

/** Reorder episodes by stable id — order fields rewrite, nothing renames (issue 397). */
export function reorderEpisodes(worldId: string, productionId: string, orderedIds: string[]): void {
  send({ kind: "reorder-episodes", worldId, productionId, orderedIds });
}

/**
 * Make an empty scene and learn which one it was (SPEC-036 R-37). Returns the requestId the
 * `scene.create-result` will carry, or null when nothing was sent — a button that waited on an
 * answer to a frame that never left would wait for good.
 */
export function createScene(
  worldId: string,
  productionId: string,
  input: { episodeId?: string; title?: string } = {},
): string | null {
  const requestId = ulid();
  if (!send({ kind: "create-scene", worldId, productionId, requestId, ...input })) return null;
  issuedSceneCreates.add(requestId);
  return requestId;
}

/**
 * The creates this window sent and has not yet heard back on. Every window hears every answer
 * (the coordinator broadcasts), so a refusal is only this window's to word when the request was.
 */
export const issuedSceneCreates = new Set<string>();
export function isOwnSceneCreate(requestId: string): boolean {
  return issuedSceneCreates.has(requestId);
}

type SceneCommandMessage = Extract<ClientMessage, { kind: "scene-command" }>;

/** Send one named, version-fenced scene edit; snapshots remain the success acknowledgement. */
export function sceneCommand(input: Omit<SceneCommandMessage, "kind">): boolean {
  return send({ kind: "scene-command", ...input });
}

type FrameRunMessage = Extract<ClientMessage, { kind: `frame-run-${string}` }>;

export function frameRunCommand(input: FrameRunMessage): boolean {
  return send(input);
}

/** Undo, at whatever depth: v<n> returns as a new version (turn 97). */
export function restoreScene(
  worldId: string,
  productionId: string,
  sceneFile: string,
  version: number,
): void {
  send({ kind: "restore-scene", worldId, productionId, sceneFile, version });
}

/**
 * Remove a scene. Refused with its reasons while accepted footage or a branch-map edge depends
 * on it — the refusal arrives as `scene.write-refused` and the toaster says it.
 */
export function deleteScene(worldId: string, productionId: string, sceneFile: string): void {
  send({ kind: "delete-scene", worldId, productionId, sceneFile });
}

/**
 * Save the Bible (master §4.5). No proposal, no accept — it saves where it stands.
 *
 * `baseVersion` is the version the editor loaded. Passing it is what makes an ungated file safe
 * to share between three writers: this screen, the Studio mid-conversation, and a text editor
 * outside the app. A save written against a version that has since moved is refused, not merged.
 */
export function saveBible(worldId: string, text: string, baseVersion?: number): void {
  send({ kind: "save-bible", worldId, text, ...(baseVersion !== undefined ? { baseVersion } : {}) });
}

/** One entry of the world's Guide (SPEC-059 R-4): its choices replaced whole, or cleared with null. */
export function setGuideEntry(worldId: string, change: SetGuideEntry): void {
  send({ kind: "set-guide-entry", worldId, change });
}

/** The Guide's teasers, replaced whole in the author's order (SPEC-059 R-24, R-27). */
export function setGuideTeasers(worldId: string, change: SetGuideTeasers): void {
  send({ kind: "set-guide-teasers", worldId, change });
}

/** The story every public section waits for (SPEC-059 R-41); null goes back to the first with chapters. */
export function setGuideStory(worldId: string, story: string | null): void {
  send({ kind: "set-guide-story", worldId, change: { story } });
}

/**
 * Draft (SPEC-059 R-40): one entry's description, or every public one still without. The run is
 * marked started here, so the press answers at once; `guide.drafting` carries it from there.
 */
export function draftGuideDescription(worldId: string, entry?: { entryKind: GuideSheetKind; id: string }): void {
  const requestId = ulid();
  if (!send({ kind: "draft-guide-description", worldId, requestId, ...(entry !== undefined ? { entry: { entryKind: entry.entryKind as "characters" | "locations" | "factions", id: entry.id } } : {}) })) return;
  noteGuideDrafting({ at: new Date().toISOString(), type: "guide.drafting", worldId, requestId, of: entry !== undefined ? 1 : 0, done: 0, failed: 0, ...(entry !== undefined ? { entry: { entryKind: entry.entryKind as "characters" | "locations" | "factions", id: entry.id } } : {}), finished: false });
}

/** Stop: the world's Draft run ends; a description being written now is not kept. */
export function stopGuideDrafting(worldId: string): void {
  send({ kind: "stop-guide-drafting", worldId });
}

/** A character's lines to choose a voice line from (R-6): answered as `guide.voice-lines` under the id returned. */
export function listGuideVoiceLines(worldId: string, character: string): string | null {
  const requestId = ulid();
  return send({ kind: "list-guide-voice-lines", worldId, requestId, character }) ? requestId : null;
}

/** Undo, at whatever depth: v<n> returns as a new version and the ones after it stay in history. */
export function restoreBible(worldId: string, version: number): void {
  send({ kind: "restore-bible", worldId, version });
}


/**
 * `New chapter` (turn 126): returns the requestId `chapter.create-result` will carry, or null
 * when nothing was sent — a press that waited on a message that never left would wait forever.
 */
export function createChapter(worldId: string, productionId: string, title: string, order: number): string | null {
  const requestId = ulid();
  if (!send({ kind: "create-chapter", worldId, productionId, requestId, title, order })) return null;
  issuedChapterCreates.add(requestId);
  return requestId;
}

/** The chapter presses this window made and has not heard back on; every window hears every answer. */
export const issuedChapterCreates = new Set<string>();
export function isOwnChapterCreate(requestId: string): boolean {
  return issuedChapterCreates.has(requestId);
}

/** Stop a page read this window started (codex, PR 879); the coordinator stops at the next block. */
export function stopProsePage(worldId: string, requestId: string): void {
  send({ kind: "stop-prose-page", worldId, requestId });
}

/** Ask for a chapter's body (turn 126). The answer is `chapter.open-result`, by requestId. */
export function openChapter(worldId: string, productionId: string, chapterId: string): string | null {
  const requestId = ulid();
  if (!send({ kind: "open-chapter", worldId, productionId, requestId, chapterId })) return null;
  return requestId;
}

/**
 * Save a chapter in place (SPEC-012 R-5). `baseHash` is the hash of the file the editor read;
 * a save against a file that has since moved is refused, not merged. The answer, by requestId,
 * carries the new base for the next save.
 */
export function saveChapter(
  worldId: string,
  productionId: string,
  chapterFile: string,
  body: string,
  baseHash?: string,
): string | null {
  const requestId = ulid();
  if (
    !send({
      kind: "save-chapter",
      worldId,
      productionId,
      requestId,
      chapterFile,
      body,
      ...(baseHash !== undefined ? { baseHash } : {}),
    })
  ) {
    return null;
  }
  return requestId;
}

/**
 * Save an audio drama's episode script whole (SPEC-057 R-83). `baseHash` is the file the score
 * read, null for an episode with no script yet; the answer, by requestId, carries the next base.
 */
export function saveEpisodeScript(
  worldId: string,
  productionId: string,
  episode: number,
  title: string,
  blocks: EpisodeScriptBlock[],
  baseHash: string | null,
): string | null {
  const requestId = ulid();
  return send({ kind: "save-episode-script", requestId, worldId, productionId, episode, title, blocks, baseHash }) ? requestId : null;
}

/**
 * Hear an audio drama's lines (SPEC-057 R-25): `quoteOnly` prices them and names any speaker with
 * no voice; a press sends the token it was quoted. Answered, by requestId, as `drama.heard`.
 */
export function hearDramaLines(
  worldId: string,
  productionId: string,
  episode: number,
  blocks: string[],
  scriptHash: string,
  options: { quoteOnly?: boolean; quoteToken?: string; decisions?: Record<string, "narrator" | "leave-out">; retake?: boolean } = {},
): string | null {
  const requestId = ulid();
  return send({ kind: "hear-drama-lines", requestId, worldId, productionId, episode, blocks, scriptHash, ...options }) ? requestId : null;
}

/** Price, then make, a sound for an audio drama's cue (SPEC-057 R-39..R-42); answered as `drama.sound`. */
export function generateDramaSound(
  worldId: string,
  productionId: string,
  input: { cue: "sound" | "ambience" | "music"; heard: string; prompt: string; durationSec: number | null; loop?: boolean; name: string; quoteOnly?: boolean; quoteToken?: string },
): string | null {
  const requestId = ulid();
  return send({ kind: "generate-drama-sound", requestId, worldId, productionId, ...input }) ? requestId : null;
}

/** A role as this production plays it (SPEC-057 R-55..R-60); null clears it back to the sheet. */
export function setDramaRole(worldId: string, productionId: string, role: string, value: DramaRole | null): boolean {
  return send({ kind: "set-drama-role", worldId, productionId, role, value });
}

/** What became of a source chapter (SPEC-057 R-61); null clears it. */
export function setDramaVerdict(worldId: string, productionId: string, chapter: string, value: DramaChapterDecision | null): boolean {
  return send({ kind: "set-drama-verdict", worldId, productionId, chapter, value });
}

/** Decide a review note Intentional or Dismiss (SPEC-057 R-53); null opens it again. */
export function decideDramaNote(worldId: string, productionId: string, key: string, decision: "intentional" | "dismissed" | null): boolean {
  return send({ kind: "decide-drama-note", worldId, productionId, key, decision });
}

/** Keep the take that waits, or the one kept before it (SPEC-057 R-30). */
export function decideDramaTake(worldId: string, productionId: string, episode: number, block: string, keep: "new" | "kept", waiting: string): void {
  send({ kind: "decide-drama-take", worldId, productionId, episode, block, keep, waiting: waiting as never });
}

/**
 * One kept version's prose, for Compare (SPEC-056 R-13): asked once, answered by requestId.
 * Rejects with the coordinator's reason, or when the frame cannot be sent.
 */
export function readChapterVersion(worldId: string, productionId: string, chapterFile: string, version: number): Promise<string> {
  const requestId = ulid();
  return new Promise((resolve, reject) => {
    // A connection lost after the send may never answer (codex on PR 1802): give up rather than
    // leave Compare opening for good.
    const timer = setTimeout(() => {
      chapterVersionListeners.delete(listener);
      reject(new Error("No answer. Try again."));
    }, VERSION_READ_TIMEOUT_MS);
    const listener = (result: ChapterVersionResult) => {
      if (result.requestId !== requestId) return;
      clearTimeout(timer);
      chapterVersionListeners.delete(listener);
      if (result.disposition === "read") resolve(result.body ?? "");
      else reject(new Error(result.reason ?? "That version could not be read."));
    };
    chapterVersionListeners.add(listener);
    if (!send({ kind: "read-chapter-version", worldId, productionId, requestId, chapterFile, version })) {
      clearTimeout(timer);
      chapterVersionListeners.delete(listener);
      reject(new Error("Not connected."));
    }
  });
}

/** Undo for a chapter (turn 126): v<n> returns as a new version and nothing between is lost. */
export function restoreChapter(worldId: string, productionId: string, chapterFile: string, version: number): void {
  send({ kind: "restore-chapter", worldId, productionId, chapterFile, version });
}

/** The plan on the chapter (turn 127): saved in place, no proposal, no version cut. `null` clears. */
export function setChapterRetired(worldId: string, productionId: string, chapterFile: string, retired: boolean) {
  send({ kind: retired ? "retire-chapter" : "restore-chapter-retired", worldId, productionId, chapterFile });
}

export function editChapterPlan(
  worldId: string,
  productionId: string,
  chapterFile: string,
  changes: Extract<ClientMessage, { kind: "edit-chapter-plan" }>["changes"],
): void {
  send({ kind: "edit-chapter-plan", worldId, productionId, chapterFile, changes });
}

export function reorderChapters(worldId: string, productionId: string, orderedFiles: string[]): void {
  send({ kind: "reorder-chapters", worldId, productionId, orderedFiles });
}

/** Reorder scenes by stable id — order fields rewrite, nothing renames (issue 387). */
export function reorderScenes(worldId: string, productionId: string, orderedIds: string[]): void {
  send({ kind: "reorder-scenes", worldId, productionId, orderedIds });
}

/** Change the aspect a production delivers in (issue 389) — validated and normalized server-side. */
export function setProductionAspect(worldId: string, productionId: string, aspect: string): void {
  send({ kind: "set-production-aspect", worldId, productionId, aspect });
}

/**
 * Dispatch a scene under a durable plan (SPEC-024): the aggregate is written and authorized
 * before any pass reaches a provider. Returns the requestId the plan-result answers to.
 */
export function dispatchScenePlanned(
  worldId: string,
  productionId: string,
  sceneFile: string,
  mode: "per-shot" | "whole-scene",
  modelId: string,
  policy: "review-gated" | "pre-authorized",
  resolution?: string,
  tier?: SizeTier,
): string {
  const requestId = ulid();
  // The scene page chooses nothing per dispatch (SPEC-044 R-26, R-29, R-34): the coordinator
  // resolves the scene's cast when it plans, and dialogue guidance is not drawn, so no
  // recommendation can have been acknowledged.
  send({
    kind: "dispatch-scene-planned",
    requestId,
    worldId,
    productionId,
    sceneFile,
    mode,
    modelId,
    policy,
    acknowledgedRecommendationIds: [],
    ...(resolution !== undefined ? { resolution } : {}),
    ...(tier !== undefined ? { tier } : {}),
  });
  return requestId;
}

/** The visible act a review-gated plan requires before its next pass (SPEC-024 R-16). */
export function planContinue(worldId: string, productionId: string, planId: string, passIndex: number): void {
  send({ kind: "plan-continue", worldId, productionId, planId, passIndex });
}

/** The fresh act that covers an estimate the authorization did not (SPEC-024 R-17). */
export function planReconfirm(
  worldId: string,
  productionId: string,
  planId: string,
  passIndex: number,
): void {
  send({ kind: "plan-reconfirm", worldId, productionId, planId, passIndex });
}

/** Stop all future materialisation; landed work is untouched (SPEC-024 R-25). */
export function planCancel(worldId: string, productionId: string, planId: string): void {
  send({ kind: "plan-cancel", worldId, productionId, planId });
}

/** Ask for the folded states of a production's plans — also the restart reconciliation. */
export function listPlans(worldId: string, productionId: string): void {
  send({ kind: "list-plans", worldId, productionId });
}

/** What the scene's lines can play (SPEC-044 R-33); the answer is a rehearsal result under this id. */
export function planTableRead(worldId: string, productionId: string, sceneId: string): string | null {
  const requestId = ulid();
  return send({ kind: "plan-table-read", requestId, worldId, productionId, sceneId }) ? requestId : null;
}

/** Prepare the lines that have no read, at the cost the plan quoted (R-33); answered as the plan is. */
export function prepareTableRead(worldId: string, productionId: string, sceneId: string, confirmationToken: string, confirmedMicroUsd: number): string | null {
  const requestId = ulid();
  return send({ kind: "prepare-table-read", requestId, worldId, productionId, sceneId, confirmationToken, confirmedMicroUsd }) ? requestId : null;
}

/** Save the routing record (epic 401): the strict parse server-side is the no-state gate. */
export function saveRouting(worldId: string, productionId: string, routing: unknown): void {
  send({ kind: "save-routing", worldId, productionId, routing });
}

/**
 * One edit to the routing, as a closed command (design turn 157): applied to the file on disk,
 * so two quick edits from the branch map both land rather than the second overwriting the first.
 */
export function sendRoutingCommand(worldId: string, productionId: string, command: RoutingCommand): void {
  send({ kind: "routing-command", worldId, productionId, command });
}

/** One preview traversal, appended durably (epic 401, brief §4). */
export function recordTraversal(
  worldId: string,
  productionId: string,
  choiceId: string,
  from: string,
  to: string,
  route: string[],
  story?: TraversalEvidence["story"],
): void {
  send({ kind: "record-traversal", worldId, productionId, choiceId, from, to, route, ...(story ? { story } : {}) });
}

/** Ask for the named routing findings (epic 401) — evidence, never a score. */
export function listRoutingFindings(worldId: string, productionId: string): void {
  send({ kind: "list-routing-findings", worldId, productionId });
}

/** Promote a branch outcome to canon — explicit, gated, with the route named (brief §7). */
export function proposeBranchCanon(
  worldId: string,
  productionId: string,
  sceneId: string,
  route: string[],
  title: string,
  body: string,
): void {
  send({ kind: "propose-branch-canon", worldId, productionId, sceneId, route, title, body });
}

/** Export the self-hostable package (brief §6); refused while blocking findings stand. */
export function exportInteractive(worldId: string, productionId: string): void {
  send({ kind: "export-interactive", worldId, productionId });
}

export function compileSceneBoard(worldId: string, productionId: string, sceneFile: string): void {
  send({ kind: "compile-scene-board", worldId, productionId, sceneFile });
}

export function exportSceneBoard(worldId: string, productionId: string, sceneFile: string): void {
  send({ kind: "export-scene-board", worldId, productionId, sceneFile });
}
