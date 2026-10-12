import { effectAnalysisCanonicalJson, type EffectArrangementScope, type WorldBundle, type WorldChatSubject } from "@arke-studio/contracts";
import { worldChatSubjectExists } from "./context-validation.js";

/** A chat proposal names its bounds without granting Review, Apply or a protection release. */
export function effectProposalRequestContext(bundle: WorldBundle, productionId: string,
  proposedScope: EffectArrangementScope | undefined, subject: WorldChatSubject | undefined) {
  const attached = subject?.kind === "effect-arrangement" ? subject : undefined;
  if (attached && proposedScope && effectAnalysisCanonicalJson(attached.scope) !== effectAnalysisCanonicalJson(proposedScope)) {
    throw new Error("Keep the exact effects scope attached to this request; a proposed scope cannot override the person's selection.");
  }
  const scope = attached?.scope ?? proposedScope;
  if (!scope) throw new Error("Include an effects-only scope with a visual target, exact frame range, palette, direction and optional audio or Off. Resolve it from the current timeline and the person's request; ask only when the intended bindings are ambiguous.");
  if (!worldChatSubjectExists(bundle, { kind: "cut", productionId }, attached ?? { kind: "effect-arrangement", scope })) {
    throw new Error("The effects scope must name a current visual target, a range within delivery and an available audio source or Off.");
  }
  return { scope, ...(attached?.reviewed ? { reviewed: attached.reviewed } : {}) };
}

type ScopedResult = {
  actions: readonly { kind: string }[]; editorRequests: readonly unknown[]; bibleEdits: readonly unknown[];
  sceneEdits: readonly unknown[]; candidates: readonly unknown[]; groups: readonly unknown[];
  tombstones?: readonly unknown[]; setupUpdate?: unknown; productionPlan?: unknown;
};

/** An effects request cannot smuggle broader authoring through a sibling result channel. */
export function effectOnlyTurnProblem(subject: WorldChatSubject | undefined, result: ScopedResult): string | null {
  if (subject?.kind !== "effect-arrangement" && !result.actions.some(action => action.kind === "production-effects-propose")) return null;
  return result.actions.some(action => action.kind !== "production-effects-propose") || result.editorRequests.length ||
    result.bibleEdits.length || result.sceneEdits.length || result.candidates.length || result.groups.length ||
    result.tombstones?.length || result.setupUpdate || result.productionPlan
    ? "This request is effects-only. Return production-effects-propose actions or a reply; picture, sound and other authored changes require a separate request."
    : null;
}
