import type { WorldChatActionTurn } from "./actions.js";

/** An explicit drafting press must return manuscript, not a successful editorial reply. */
export function chapterDraftResult(turn: Pick<WorldChatActionTurn, "actions" | "candidates" | "groups" | "bibleEdits" | "sceneEdits" | "editorRequests"> & { tombstones?: readonly unknown[]; productionPlan?: unknown },
  productionId: string | undefined, chapterId: string): { body: string; title?: string } | { problem: string } {
  const action = turn.actions[0];
  if (!productionId || turn.candidates.length || turn.groups.length || turn.bibleEdits.length ||
    turn.sceneEdits.length || turn.editorRequests.length || turn.tombstones?.length || turn.productionPlan || turn.actions.length !== 1 ||
    action?.kind !== "production-chapter" || action.productionId !== productionId ||
    action.change.operation !== "edit" || action.change.chapterId !== chapterId ||
    !action.change.changes.body?.trim() || action.change.changes.body.length > 2_000_000 ||
    (action.change.changes.status !== undefined && action.change.changes.status !== "draft") ||
    Object.keys(action.change.changes).some(key => !["body", "title", "status"].includes(key))) {
    return { problem: "Return exactly one complete manuscript for the requested chapter in a production-chapter edit action's changes.body, with optional title and status draft only. Editorial advice, questions and unrelated changes do not complete this drafting request." };
  }
  return { body: action.change.changes.body, ...(action.change.changes.title !== undefined ? { title: action.change.changes.title } : {}) };
}
