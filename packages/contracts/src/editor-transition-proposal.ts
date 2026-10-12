import { z } from "zod";
import { ConversationActionIdSchema, ConversationIdSchema, SlugSchema, UlidSchema } from "./ids.js";
import { CrossfadeSchema, TransitionCommandSchema, transitionKey, type TransitionCommand, type Crossfade } from "./editor-transitions.js";
import { compileTrustedTimelineSteps, type ProductionTimeline, type TrustedTimelineCompileOptions } from "./timeline.js";
import { EffectProposalDependenciesSchema } from "./editor-effect-proposal.js";
import { effectAnalysisCanonicalJson as canonical } from "./editor-effect-analysis.js";

const id = z.string().min(1).max(128), hash = z.string().min(1).max(128);
export const TransitionCreativeCommandSchema = z.discriminatedUnion("kind", [TransitionCommandSchema.options[0], TransitionCommandSchema.options[1]]);
export const ModelTransitionProposalSchema = z.object({ summary: z.string().min(1).max(500),
  commands: z.array(TransitionCreativeCommandSchema).min(1).max(50),
  family: z.object({ id, parentVersionId: id, candidateHash: hash }).strict().optional() }).strict();
export type ModelTransitionProposal = z.infer<typeof ModelTransitionProposalSchema>;
export const TransitionVersionRefSchema = z.object({ familyId: id, versionId: id, candidateHash: hash }).strict();
export type TransitionVersionRef = z.infer<typeof TransitionVersionRefSchema>;
export const TransitionStickySchema = z.object({ key: id, commands: z.array(TransitionCommandSchema).max(4), baseline: CrossfadeSchema.optional() }).strict();
export type TransitionSticky = z.infer<typeof TransitionStickySchema>;
export const TransitionProposalVersionSchema = z.object({ id, number: z.number().int().min(1), parentVersionId: id.optional(), actionId: ConversationActionIdSchema.optional(),
  origin: z.enum(["model", "adjustment", "release", "update", "history"]), summary: z.string().min(1).max(500), createdAt: z.string(),
  baseRevision: z.number().int().nonnegative(), baseHash: hash, candidateHash: hash,
  model: ModelTransitionProposalSchema, sticky: z.array(TransitionStickySchema).max(200),
  before: z.array(CrossfadeSchema).max(4000), transitions: z.array(CrossfadeSchema).max(4000),
  conflicts: z.array(z.string().max(500)).max(100), notes: z.array(z.string().max(500)).max(100),
  dependencies: EffectProposalDependenciesSchema,
}).strict();
export type TransitionProposalVersion = z.infer<typeof TransitionProposalVersionSchema>;
export const TransitionProposalFamilySchema = z.object({ id, productionId: SlugSchema, conversationId: ConversationIdSchema, status: z.enum(["pending", "applied", "discarded"]),
  versions: z.array(TransitionProposalVersionSchema).min(1).max(100), headVersionId: id,
  undo: z.array(id).max(100), redo: z.array(id).max(100),
  grants: z.array(z.object({ id, versionId: id, candidateHash: hash }).strict()).max(100),
  receipt: z.object({ versionId: id, candidateHash: hash, resultRevision: z.number().int(), historyEntryDigest: hash, appliedAt: z.string(), undoneAt: z.string().optional() }).strict().optional(),
}).strict();
export type TransitionProposalFamily = z.infer<typeof TransitionProposalFamilySchema>;
export function transitionVersionRef(familyId: string, version: TransitionProposalVersion): TransitionVersionRef { return { familyId, versionId: version.id, candidateHash: version.candidateHash }; }
export function transitionDelta(before: readonly Crossfade[], after: readonly Crossfade[]): Array<{ key: string; before: Crossfade | null; after: Crossfade | null }> {
  return [...new Set([...before, ...after].map(transitionKey))].flatMap(key => {
    const left = before.find(value => transitionKey(value) === key) ?? null, right = after.find(value => transitionKey(value) === key) ?? null;
    return canonical(left) === canonical(right) ? [] : [{ key, before: left, after: right }];
  });
}
/** Restore only the named pair. Keep Current is durable human intent, not model permission. */
export function restoreTransitionCommands(pair: Pick<Crossfade, "trackId" | "leftClipId" | "rightClipId">, value: Crossfade | undefined,
  proposed: Crossfade | undefined): TransitionCommand[] {
  if (!value) return proposed ? [{ kind: "transition-remove", ...pair }] : [];
  const commands: TransitionCommand[] = [{ kind: "transition-set", ...pair, durationFrames: value.durationFrames }];
  for (const setting of ["join", "duration"] as const) {
    const key = setting === "join" ? "protectJoin" : "protectDuration";
    if (value[key] !== (proposed?.[key] ?? false)) commands.push({ kind: value[key] ? "transition-protect" : "transition-release", ...pair, setting });
  }
  return commands;
}
/** Suggestions are admitted together; preserved values and human scopes are never model authority. */
export function compileTransitionProposal(base: ProductionTimeline, model: ModelTransitionProposal, sticky: readonly TransitionSticky[], options: TrustedTimelineCompileOptions) {
  const notes: string[] = [], conflicts: string[] = [];
  const ruleCommands = sticky.flatMap(value => value.commands.filter(command => command.kind === "transition-release" || command.kind === "transition-protect"));
  const protectedBaselines = sticky.filter(value => value.baseline && value.commands.some(command => command.kind === "transition-protect"));
  const seeds = [...new Map(protectedBaselines.filter(value => value.commands.some(command => command.kind === "transition-protect" && command.setting === "duration") || !base.transitions?.some(row => transitionKey(row) === transitionKey(value.baseline!)))
    .map(value => [transitionKey(value.baseline!), value.baseline!])).values()];
  const released = (key: string, setting: "join" | "duration") => ruleCommands.some(command => command.kind === "transition-release" && transitionKey(command) === key && command.setting === setting);
  const adjusted = new Set(sticky.map(value => value.key));
  const admitted = model.commands.filter(command => {
    const key = transitionKey(command), current = base.transitions?.find(value => transitionKey(value) === key);
    const value = { ...current, ...protectedBaselines.find(row => row.commands.some(command => command.kind === "transition-protect" && command.setting === "duration") && transitionKey(row.baseline!) === key)?.baseline };
    const protectedSetting = (setting: "join" | "duration") => !released(key, setting) && (current?.[setting === "join" ? "protectJoin" : "protectDuration"] || ruleCommands.some(row => row.kind === "transition-protect" && row.setting === setting && transitionKey(row) === key));
    if (adjusted.has(`${key}/value`)) { notes.push(`${command.leftClipId} → ${command.rightClipId}: adjusted by you, retained`); return false; }
    if (command.kind === "transition-remove" && (protectedSetting("join") || protectedSetting("duration")) || command.kind === "transition-set" && protectedSetting("duration") && command.durationFrames !== value.durationFrames) {
      notes.push(`${command.leftClipId} → ${command.rightClipId}: protected setting kept`); return false;
    }
    return true;
  });
  try {
    const reduction = compileTrustedTimelineSteps(base, [
      { id: "transition-human-seed", authority: "human", commands: seeds.map(value => ({ kind: "transition-set", trackId: value.trackId, leftClipId: value.leftClipId, rightClipId: value.rightClipId, durationFrames: value.durationFrames })) },
      { id: "transition-human-release", authority: "human", commands: ruleCommands.filter(command => command.kind === "transition-release" && base.transitions?.some(value => transitionKey(value) === transitionKey(command))) },
      { id: "transition-model", authority: "suggestion", commands: admitted },
      ...sticky.map((value, index) => ({ id: `transition-human-${index}`, authority: "human" as const, commands: value.commands.filter(command => command.kind === "transition-set" || command.kind === "transition-remove" && base.transitions?.some(row => transitionKey(row) === transitionKey(command))) })),
      { id: "transition-human-protection", authority: "human", commands: ruleCommands.filter(command => command.kind === "transition-protect" || !base.transitions?.some(value => transitionKey(value) === transitionKey(command))) },
    ], options);
    return { reduction, candidate: reduction.timeline, notes, conflicts };
  } catch (error) {
    conflicts.push(error instanceof Error ? error.message.slice(0, 500) : "Transition arrangement is invalid");
    return { reduction: null, candidate: base, notes, conflicts };
  }
}
export const TransitionReviewOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("review"), ref: TransitionVersionRefSchema }).strict(),
  z.object({ kind: z.literal("edit"), ref: TransitionVersionRefSchema, commands: z.array(TransitionCommandSchema).min(1).max(50) }).strict(),
  z.object({ kind: z.literal("keep"), ref: TransitionVersionRefSchema, pair: CrossfadeSchema.pick({ trackId: true, leftClipId: true, rightClipId: true }) }).strict(),
  z.object({ kind: z.literal("history"), ref: TransitionVersionRefSchema, direction: z.enum(["undo", "redo"]) }).strict(),
  z.object({ kind: z.literal("update"), ref: TransitionVersionRefSchema }).strict(),
  z.object({ kind: z.literal("discard"), ref: TransitionVersionRefSchema }).strict(),
  z.object({ kind: z.literal("apply"), ref: TransitionVersionRefSchema, reviewId: id }).strict(),
]);
export const TransitionReviewCommandSchema = z.object({ kind: z.literal("editor-transition-proposal"), worldId: UlidSchema,
  productionId: SlugSchema, requestId: id, operation: TransitionReviewOperationSchema }).strict();
export type TransitionReviewCommand = z.infer<typeof TransitionReviewCommandSchema>;
export type TransitionReviewOperation = z.infer<typeof TransitionReviewOperationSchema>;
export const TransitionReviewResultSchema = z.object({ type: z.literal("editor-transition.proposal-result"), at: z.string(), worldId: UlidSchema, productionId: SlugSchema,
  requestId: id, outcome: z.enum(["reviewed", "updated", "applied", "discarded", "refused"]), ref: TransitionVersionRefSchema,
  reviewId: id.optional(), reason: z.string().max(1000).optional() }).strict();
export type TransitionReviewResult = z.infer<typeof TransitionReviewResultSchema>;
