// How correlated results the event bus does not carry land: handleFrame's blocks for them (issue 2800).
import type { DomainEvent } from "@arke-studio/contracts";
import { type FrameSlices, current } from "./core.js";
import {
  pendingQueueRequests, forgetGuideDrafting, commandFailureListeners, queueResultListeners,
  voiceUploadConfirmationListeners, audiobookActivityListeners, jobReadyListeners,
  seenRecoveryNotices, recoveryNoticeListeners, chapterCreateListeners, promptToolsListeners,
  mediaMeasurementListeners, chapterVersionListeners, dramaSourceListeners, dramaEditionListeners,
  sceneCreateListeners, frameRunQuoteListeners, frameRunStartKey, frameRunStartResultListeners,
  lastTallProgress, audiobookTallProgressListeners, audiobookVideoExportedListeners,
  noteGuideDrafting, takeReviewPreparedListeners,
} from "./events.js";
import { issuedChapterCreates, issuedSceneCreates } from "./productions.js";
import { audioHeardListeners } from "./audiobook.js";

/** handleFrame's blocks for correlated results the event bus does not carry, in their order (issue 2800). */
export function foldResultEvent(slices: FrameSlices, event: DomainEvent): void {
  if (event.type === "command.failed") {
    if (event.requestId) pendingQueueRequests.delete(event.requestId);
    if (event.command === "make-audiobook-picture" && event.requestId && slices.audiobookAsks[event.requestId]?.state === "working") {
      slices.audiobookAsks = { ...slices.audiobookAsks, [event.requestId]: { state: "failed", reason: event.reason } };
    }
    // A Draft refused before it ran (a world no longer open) sends no last word of its own; the
    // page stops saying Drafting with the refusal on the toaster (issue 2796).
    if (event.command === "draft-guide-description" && event.requestId) forgetGuideDrafting(event.requestId);
    for (const listener of commandFailureListeners) listener(event);
  }
  if (event.type === "queue.enqueue-result") {
    const expected = pendingQueueRequests.get(event.requestId);
    if (expected?.command === event.command) {
      pendingQueueRequests.delete(event.requestId);
      const result = {
        ...event,
        ...(expected.characterName ? { characterName: expected.characterName } : {}),
      };
      for (const listener of queueResultListeners) listener(result);
    }
  }
  if (event.type === "voice.upload-confirmation-required") {
    const expected = pendingQueueRequests.get(event.requestId);
    // The question is a pause in the request, not its end (SPEC-046 R-39): a page with a
    // cloned narrator and a cloned speaker is asked twice under one id, and the answer re-sends
    // the same id without registering it again. The entry goes with the enqueue result, or
    // with the connection.
    if (expected?.command === event.command) {
      for (const listener of voiceUploadConfirmationListeners) listener(event);
    }
  }
  if (event.type === "audiobook.activity") for (const listener of audiobookActivityListeners) listener(event.run);
  if (event.type === "job.ready") {
    for (const listener of jobReadyListeners) listener(event.job);
  }
  if (event.type === "recovery.notice") {
    const key = `${event.notice.incidentId}:${event.notice.at}:${event.notice.reason}`;
    if (!seenRecoveryNotices.has(key)) {
      seenRecoveryNotices.add(key);
      if (seenRecoveryNotices.size > 256) seenRecoveryNotices.delete(seenRecoveryNotices.values().next().value!);
      const history = current.state?.app.recoveryHistory;
      if (history?.audit === "available" && !history.preferences.transientMuted) {
        for (const listener of recoveryNoticeListeners) try { listener(event.notice, history); } catch { /* Alert delivery cannot interrupt state folding. */ }
      }
    }
  }
  if (event.type === "chapter.create-result") {
    for (const listener of chapterCreateListeners) listener(event);
    issuedChapterCreates.delete(event.requestId);
  }
  if (event.type === "prompt-tools.result") for (const listener of promptToolsListeners) listener(event);
  if (event.type === "media.measured") for (const listener of mediaMeasurementListeners) listener(event);
  if (event.type === "chapter.version-result") {
    for (const listener of chapterVersionListeners) listener(event);
  }
  if (event.type === "drama.source") {
    for (const listener of dramaSourceListeners) listener(event);
  }
  if (event.type === "drama.edition" || event.type === "drama.editions") {
    for (const listener of dramaEditionListeners) listener(event.type === "drama.edition"
      ? { requestId: event.requestId, editions: event.edition ? [event.edition] : [], ...(event.refused ? { refused: event.refused } : {}) }
      : { requestId: event.requestId, editions: event.editions, ...(event.mixes ? { mixes: event.mixes } : {}) });
  }
  if (event.type === "scene.create-result") {
    for (const listener of sceneCreateListeners) listener(event);
    // Forgotten after the listeners have asked, so a late duplicate reads as someone else's.
    issuedSceneCreates.delete(event.requestId);
  }
  if (event.type === "production.frame-run-quote") {
    const listeners = frameRunQuoteListeners.get(event.quote.requestId);
    frameRunQuoteListeners.delete(event.quote.requestId);
    if (listeners !== undefined) {
      slices.frameRunQuotes = { ...slices.frameRunQuotes, [event.quote.requestId]: event.quote };
      for (const listener of listeners) listener(event);
    }
  }
  if (event.type === "production.frame-run-start-result") {
    const key = frameRunStartKey(event.requestId, event.quoteId);
    const listeners = frameRunStartResultListeners.get(key);
    frameRunStartResultListeners.delete(key);
    if (listeners !== undefined) {
      slices.frameRunStartResults = { ...slices.frameRunStartResults, [key]: event };
      for (const listener of listeners) listener(event);
      // The listener consumes this one-shot result. Remove it from the pending fold rather
      // than relying on clearFrameRunStartResult, whose emit happens before this frame's final
      // emit and would otherwise be overwritten by the cached local value below.
      delete slices.frameRunStartResults[key];
    }
  }
  if (event.type === "audiobook.tall-progress") {
    lastTallProgress.set(`${event.worldId}/${event.productionId}`, event);
    for (const listener of audiobookTallProgressListeners) listener(event);
  }
  if (event.type === "audiobook.video-exported") {
    for (const listener of audiobookVideoExportedListeners) listener(event);
  }
  if (event.type === "guide.drafting") noteGuideDrafting(event);
  if (event.type === "audio-studio.heard") for (const listener of audioHeardListeners) listener(event);
  if (event.type === "conversation-action.take-review-prepared") {
    for (const listener of takeReviewPreparedListeners) listener(event);
  }
}
