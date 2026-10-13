import { z } from "zod";
import { EffectClipSchema, EffectLineageIdSchema, EffectPatchSchema, type EffectClip } from "./editor-effects.js";
import { EffectProtectionInputSchema } from "./editor-effect-protection.js";

const frame = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const signed = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const clipId = z.string().regex(/^cl_[A-Za-z0-9][A-Za-z0-9_-]*$/);
const trackId = z.string().regex(/^tr_[A-Za-z0-9][A-Za-z0-9_-]*$/);
export const EffectCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("effect-create"), trackId, effect: EffectClipSchema }).strict(),
  z.object({ kind: z.literal("effect-patch"), clipId, patch: EffectPatchSchema }).strict(),
  z.object({ kind: z.literal("effect-move"), clipId, startFrame: frame }).strict(),
  z.object({ kind: z.literal("effect-trim"), clipId, edge: z.enum(["head", "tail"]), deltaFrames: signed }).strict(),
  z.object({ kind: z.literal("effect-split"), clipId, atFrame: frame, newClipId: clipId }).strict(),
  z.object({ kind: z.literal("effect-duplicate"), clipId, newClipId: clipId, newLineageId: EffectLineageIdSchema, startFrame: frame, seed: z.number().int().min(0).max(0xffffffff) }).strict(),
  z.object({ kind: z.literal("effect-remove"), clipId }).strict(),
  z.object({ kind: z.literal("effect-reorder"), clipId, order: frame }).strict(),
  z.object({ kind: z.literal("effect-protect"), rule: EffectProtectionInputSchema }).strict(),
  z.object({ kind: z.literal("effect-release"), ruleId: z.string().regex(/^pr_[A-Za-z0-9][A-Za-z0-9_-]*$/) }).strict(),
]);
export type EffectCommand = z.infer<typeof EffectCommandSchema>;
export const isEffectCommand = (command: { kind: string }): command is EffectCommand => command.kind.startsWith("effect-");

export function patchEffect(effect: EffectClip, patch: z.infer<typeof EffectPatchSchema>): EffectClip {
  const { audioInput, ...rest } = patch;
  const next = { ...effect, ...rest,
    appearance: { ...effect.appearance, ...patch.appearance }, motion: { ...effect.motion, ...patch.motion },
    reaction: { ...effect.reaction, ...patch.reaction },
    ...(audioInput === undefined ? {} : { audioInput: audioInput ?? undefined }),
  };
  if (patch.reaction && Object.keys(patch.reaction).some(key => ["beat", "bass", "energy", "property", "limit", "smoothingFrames"].includes(key)) && patch.reaction.preset === undefined) next.reaction.preset = "custom";
  return EffectClipSchema.parse(next);
}

export function moveEffect(effect: EffectClip, startFrame: number): EffectClip {
  const delta = startFrame - effect.startFrame;
  return EffectClipSchema.parse({ ...effect, startFrame, simulationOriginFrame: effect.simulationOriginFrame + delta,
    fades: { ...effect.fades, startFrame: effect.fades.startFrame + delta, endFrame: effect.fades.endFrame + delta },
    // Beat corrections belong to the selected sound's production clock, which an effect move does not retime.
    cueOverrides: effect.cueOverrides,
  });
}

export function trimEffect(effect: EffectClip, edge: "head" | "tail", deltaFrames: number): EffectClip {
  return EffectClipSchema.parse(edge === "head"
    ? { ...effect, startFrame: effect.startFrame + deltaFrames, durationFrames: effect.durationFrames - deltaFrames }
    : { ...effect, durationFrames: effect.durationFrames + deltaFrames });
}

export function duplicateEffect(effect: EffectClip, input: Extract<EffectCommand, { kind: "effect-duplicate" }>): EffectClip {
  const moved = moveEffect(effect, input.startFrame);
  const suffix = input.newClipId.slice(3);
  return EffectClipSchema.parse({ ...moved, id: input.newClipId, lineageId: input.newLineageId, seed: input.seed,
    intensityCurve: { points: moved.intensityCurve.points.map((point, index) => ({ ...point, id: `ep_${suffix}-i${index}` })) },
    reactionCurve: { points: moved.reactionCurve.points.map((point, index) => ({ ...point, id: `ep_${suffix}-r${index}` })) },
    cueOverrides: moved.cueOverrides.map((cue, index) => ({ ...cue, id: `ec_${suffix}-${index}` })),
  });
}
