import type { WorldChatSubject } from "@arke-studio/contracts";

type ScopedResult = {
  actions: readonly { kind: string }[]; editorRequests: readonly unknown[]; bibleEdits: readonly unknown[];
  sceneEdits: readonly unknown[]; candidates: readonly unknown[]; groups: readonly unknown[];
  tombstones?: readonly unknown[]; setupUpdate?: unknown; productionPlan?: unknown;
};

/** An effects request cannot smuggle broader authoring through a sibling result channel. */
export function effectOnlyTurnProblem(subject: WorldChatSubject | undefined, result: ScopedResult): string | null {
  if (subject?.kind !== "effect-arrangement") return null;
  return result.actions.some(action => action.kind !== "production-effects-propose") || result.editorRequests.length ||
    result.bibleEdits.length || result.sceneEdits.length || result.candidates.length || result.groups.length ||
    result.tombstones?.length || result.setupUpdate || result.productionPlan
    ? "This request is effects-only. Return production-effects-propose actions or a reply; picture, sound and other authored changes require a separate request."
    : null;
}
