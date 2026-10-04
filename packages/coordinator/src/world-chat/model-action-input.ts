import { ModelWorldChatActionSchema, WorldChatTurnResultSchema, ProductionChatTurnResultSchema, turnActionGroups, type WorldChatTurnResult } from "@arke-studio/contracts";
import { z } from "zod";
import { worldChatActionDescriptor } from "../arke-actions/registry.js";

// Persisted actions retain their structural schema so old cards remain readable. New model
// input is held to today's execution support before a preparation intent or card is written
// (SPEC-050 R-10); listing an unavailable kind in the guide is not an authorization to send it.
function executionRefusal(kind: string): string | null {
  const descriptor = worldChatActionDescriptor(kind);
  if (!descriptor) return "No approval adapter handles this model action.";
  return descriptor.support.execution.state === "blocked" ? descriptor.support.execution.reason : null;
}

export const ModelWorldChatActionInputSchema = ModelWorldChatActionSchema.superRefine((action, context) => {
  const refusal = executionRefusal(action.kind);
  if (refusal) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["kind"],
      message: refusal,
    });
  }
  if (action.kind === "production-scene-command" && (action.command === undefined) === (action.commands === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["commands"], message: "Use command or commands, never both." });
  }
});

function validateModelTurn(result: WorldChatTurnResult, context: z.RefinementCtx) {
  try { turnActionGroups(result.actions); }
  catch (error) { context.addIssue({ code: z.ZodIssueCode.custom, path: ["actions"], message: String((error as Error).message) }); }
  for (const [index, action] of result.actions.entries()) {
    const checked = ModelWorldChatActionInputSchema.safeParse(action);
    if (!checked.success) for (const issue of checked.error.issues) {
      context.addIssue({ ...issue, path: ["actions", index, ...issue.path] });
    }
  }
}
export const WorldChatModelTurnResultSchema = WorldChatTurnResultSchema.superRefine(validateModelTurn);
export const ProductionChatModelTurnResultSchema = ProductionChatTurnResultSchema.superRefine(validateModelTurn);

export function modelActionInputRefusal(value: { kind: string }): string | null {
  // Internal callers and old prepared records have their own structural validation. Recheck
  // the policy here without imposing new receipt requirements on those historical records.
  const checked = ModelWorldChatActionSchema.safeParse(value);
  if (!checked.success && checked.error.issues.some((issue) => issue.code === z.ZodIssueCode.unrecognized_keys && issue.keys.includes("visualFacts"))) {
    return "Visual facts require the person's review on the shot panel; chat cannot author them.";
  }
  return executionRefusal(value.kind);
}
