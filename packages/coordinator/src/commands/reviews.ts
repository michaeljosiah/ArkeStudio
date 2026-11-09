import { describeCoordinatorError } from "../errors/user-message.js";
import type { ChapterReviewService } from "../productions/chapter-review.js";
import { manuscriptReviewHistory, readManuscriptReview, refreshManuscriptReview, type ManuscriptReviewService } from "../productions/manuscript-review.js";
import { manuscriptReviewPdf } from "../productions/manuscript-review-pdf.js";
import type { WorldStore } from "../world/store.js";
import type { CommandContext } from "./context.js";
import type { CommandModule, CommandOf } from "./router.js";

/**
 * Chapter and manuscript review. Review work keeps its owning world whatever is open, taking that
 * world's store in the background, so these act on any world. Each answers its own failure on
 * the review it belongs to rather than on the toaster.
 */
export function reviewCommands(ctx: CommandContext, deps: {
  manuscriptReviews: () => ManuscriptReviewService;
  chapterReviews: () => ChapterReviewService;
  /** The model the author set for the manuscript reviewer, if any. */
  manuscriptReviewerModel: () => string | undefined;
  validateLanguageModel: (modelId: string, needsImages: boolean) => Promise<{ reason?: string }>;
  withBackgroundWorldStore: (<T>(worldId: string, fn: (store: WorldStore) => Promise<T>) => Promise<T>) | undefined;
}) {
  const manuscript = {
    scope: "any-world" as const,
    async handle(msg: CommandOf<"manuscript-review-start" | "manuscript-review-read" | "manuscript-review-resume" | "manuscript-review-cancel" | "manuscript-review-decide" | "manuscript-review-export">) {
      const target = { worldId: msg.worldId, productionId: msg.productionId };
      try {
        if (ctx.stopping()) return;
        const reviews = deps.manuscriptReviews();
        if (msg.kind === "manuscript-review-start") {
          // Said before a report exists, as Review chapter does: a report of failed stages tells the author less.
          const model = deps.manuscriptReviewerModel();
          const selected = model === undefined ? undefined : await deps.validateLanguageModel(model, false);
          if (selected?.reason) throw new Error(selected.reason);
          await reviews.start(target, msg.requestId, msg.brief);
        }
        else if (msg.kind === "manuscript-review-resume") await reviews.start(target, msg.reviewId, "", true);
        else if (msg.kind === "manuscript-review-read") await reviews.read(target, msg.reviewId);
        else if (msg.kind === "manuscript-review-cancel") reviews.cancel(target);
        else if (msg.kind === "manuscript-review-decide") await reviews.decide(target, msg.reviewId, msg.findingId, msg.decision);
        else {
          if (!deps.withBackgroundWorldStore) throw new Error("Report export is unavailable on this host.");
          await deps.withBackgroundWorldStore(target.worldId, async store => {
            const saved = await readManuscriptReview(store, target, msg.reviewId);
            if (!saved || saved.status === "running") throw new Error("Wait for the report to stop before exporting.");
            const review = await refreshManuscriptReview(store, saved), pdf = (await manuscriptReviewPdf(review)).toString("base64");
            ctx.emit({ type: "manuscript-review.updated", at: new Date().toISOString(), ...target, requestId: msg.requestId, review, history: await manuscriptReviewHistory(store, target), pdf });
          });
        }
      } catch (error) {
        ctx.emit({ type: "manuscript-review.updated", at: new Date().toISOString(), ...target, requestId: msg.requestId, review: null, history: [], error: describeCoordinatorError(error) });
      }
    },
  };
  const chapter = {
    scope: "any-world" as const,
    async handle(msg: CommandOf<"chapter-review-start" | "chapter-review-preflight" | "chapter-review-read" | "chapter-review-cancel" | "chapter-review-decide">) {
      const target = { worldId: msg.worldId, productionId: msg.productionId, chapterId: msg.chapterId };
      try {
        if (ctx.stopping()) return;
        const reviews = deps.chapterReviews();
        if (msg.kind === "chapter-review-preflight") ctx.emit({ type: "chapter-review.updated", at: ctx.nowIso(), ...target, review: null,
          requestId: msg.requestId, preflight: await reviews.preflight(target, msg.checks) });
        else if (msg.kind === "chapter-review-start") await reviews.start(target, msg.requestId, msg.checks, msg.recoverFrom);
        else if (msg.kind === "chapter-review-read") await reviews.read(target);
        else if (msg.kind === "chapter-review-cancel") reviews.cancel(target);
        else await reviews.decide(target, msg.reviewId, msg.findingId, msg.decision, msg.note);
      } catch (error) {
        ctx.emit({ type: "chapter-review.updated", at: new Date().toISOString(), ...target, review: null, error: describeCoordinatorError(error),
          ...(msg.kind === "chapter-review-preflight" ? { requestId: msg.requestId } : {}) });
      }
    },
  };
  return {
    "manuscript-review-start": manuscript, "manuscript-review-read": manuscript, "manuscript-review-resume": manuscript,
    "manuscript-review-cancel": manuscript, "manuscript-review-decide": manuscript, "manuscript-review-export": manuscript,
    "chapter-review-start": chapter, "chapter-review-preflight": chapter, "chapter-review-read": chapter,
    "chapter-review-cancel": chapter, "chapter-review-decide": chapter,
  } satisfies CommandModule;
}
