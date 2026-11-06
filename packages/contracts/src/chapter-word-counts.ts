import type { ConversationActionCard } from "./arke-actions.js";
import { countWords } from "./prose.js";

export interface ChapterWordChange { title: string; before: number; after: number }
// Counts fit the existing frozen before/after field protocol; older readers still show them.
export const CHAPTER_WORD_COUNT_LABEL = "Proposed words · ";

/** Measure complete captured proposal bodies before the conversation's excerpts are clipped. */
export function proposedChapterWords(targets: readonly {
  kind: string; label: string; fields: readonly { field: string; before: string | null; proposed: string | null }[];
}[]): ChapterWordChange[] {
  return targets.flatMap(target => {
    if (!/^(?:new )?chapter(?: ·|$)/.test(target.kind)) return [];
    const prose = target.fields.find(field => field.field === "Prose");
    return prose ? [{ title: target.label, before: countWords(prose.before ?? ""), after: countWords(prose.proposed ?? "") }] : [];
  });
}

/** Only coordinator-created chapter cards own this numeric field; other sheet labels do not. */
export function measuredChapterWords(action: Pick<ConversationActionCard, "actionKind" | "shown">): ChapterWordChange[] {
  if (action.actionKind !== "world-chat-production-chapter" || action.shown.body.family !== "authored-diff") return [];
  return action.shown.body.fields.flatMap(field => {
    if (!field.label.startsWith(CHAPTER_WORD_COUNT_LABEL) || !/^\d+$/.test(field.before ?? "") || !/^\d+$/.test(field.after ?? "")) return [];
    const before = Number(field.before), after = Number(field.after);
    return Number.isSafeInteger(before) && Number.isSafeInteger(after) ? [{ title: field.label.slice(CHAPTER_WORD_COUNT_LABEL.length), before, after }] : [];
  });
}

export function proposedBatchWords(actions: readonly ConversationActionCard[]): ChapterWordChange[] {
  return actions.filter(action => ["pending", "approved", "awaiting-host", "queued", "running", "completed"].includes(action.status)).flatMap(measuredChapterWords);
}

export function chapterWordTotal(changes: readonly ChapterWordChange[]): { before: number; after: number; delta: number } {
  const before = changes.reduce((sum, change) => sum + change.before, 0);
  const after = changes.reduce((sum, change) => sum + change.after, 0);
  return { before, after, delta: after - before };
}

export function chapterWordChangeLabel(change: Pick<ChapterWordChange, "before" | "after">): string {
  const delta = change.after - change.before;
  return `${change.before.toLocaleString("en-US")} → ${change.after.toLocaleString("en-US")} (${delta > 0 ? "+" : ""}${delta.toLocaleString("en-US")})`;
}
