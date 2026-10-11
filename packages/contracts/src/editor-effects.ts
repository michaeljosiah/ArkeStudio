import { z } from "zod";

/** SPEC-053 R-17: procedural clips have their own payload, never a fabricated media source. */
const frame = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const signedFrame = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const unit = z.number().finite().min(0).max(1);
const clipId = z.string().regex(/^cl_[A-Za-z0-9][A-Za-z0-9_-]*$/);
const trackId = z.string().regex(/^tr_[A-Za-z0-9][A-Za-z0-9_-]*$/);
export const EffectLineageIdSchema = z.string().regex(/^ef_[A-Za-z0-9][A-Za-z0-9_-]*$/);
export const EFFECT_CLIP_LIMIT = 4000;
export const EFFECT_POINT_LIMIT = 2000;
export const EffectPresetSchema = z.object({ id: z.enum(["dust", "embers", "snow", "lights", "rain", "smoke"]), version: z.literal(1) }).strict();
export const EffectTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("composition") }).strict(),
  z.object({ kind: z.literal("picture-track"), trackId }).strict(),
  z.object({ kind: z.literal("visual-clip"), clipId }).strict(),
]);
export const EffectAudioInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("composition-mix") }).strict(),
  z.object({ kind: z.literal("audio-track"), trackId }).strict(),
  z.object({ kind: z.literal("audio-clip"), clipId }).strict(),
  z.object({ kind: z.literal("video-sound"), clipId }).strict(),
]);
export const EffectCurvePointSchema = z.object({
  id: z.string().regex(/^ep_[A-Za-z0-9][A-Za-z0-9_-]*$/), offsetFrames: frame,
  value: unit, interpolation: z.enum(["hold", "linear", "smooth"]),
}).strict();
export const EffectCurveSchema = z.object({ points: z.array(EffectCurvePointSchema).max(EFFECT_POINT_LIMIT) }).strict().superRefine((curve, ctx) => {
  const ids = new Set<string>();
  for (const [index, point] of curve.points.entries()) {
    if (ids.has(point.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["points", index, "id"], message: "curve point IDs must be unique" });
    if (index > 0 && point.offsetFrames <= curve.points[index - 1]!.offsetFrames) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["points", index, "offsetFrames"], message: "curve points must have increasing unique frame offsets" });
    ids.add(point.id);
  }
});
export type EffectCurve = z.infer<typeof EffectCurveSchema>;
export const EffectAreaSchema = z.object({ x: unit, y: unit, width: unit, height: unit }).strict().refine(
  area => area.width > 0 && area.height > 0 && area.x + area.width <= 1 && area.y + area.height <= 1,
  "emitting area must have positive dimensions inside the target",
);
export const EffectAppearanceSchema = z.object({ amount: unit, size: unit, opacity: unit, colour: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).strict();
export const EffectMotionSchema = z.object({ direction: z.number().finite().min(-360).max(360), speed: unit, area: EffectAreaSchema }).strict();
/** The retained envelope is independent of the cropped segment bounds (R-8). */
export const EffectFadesSchema = z.object({ startFrame: signedFrame, endFrame: signedFrame, inFrames: frame, outFrames: frame }).strict().superRefine((fade, ctx) => {
  const duration = fade.endFrame - fade.startFrame;
  if (!Number.isSafeInteger(duration) || duration < 1 || fade.inFrames > duration || fade.outFrames > duration) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "fades must fit their authored envelope" });
});
export const EffectReactionSchema = z.object({
  enabled: z.boolean(), preset: z.enum(["gentle-shimmer", "beat-pulse", "build-with-energy", "custom"]), version: z.literal(1),
  strength: unit, beat: unit, bass: unit, energy: unit,
  property: z.enum(["brightness", "emission", "size", "speed"]), limit: unit, smoothingFrames: frame.max(300),
}).strict();
export const EffectCueSchema = z.object({
  id: z.string().regex(/^ec_[A-Za-z0-9][A-Za-z0-9_-]*$/), frame, strength: unit,
  durationFrames: frame.min(1).max(300), kind: z.enum(["accent", "suppress"]),
}).strict();
export const EffectCueOverridesSchema = z.array(EffectCueSchema).max(EFFECT_POINT_LIMIT).superRefine((cues, ctx) => {
  if (new Set(cues.map(cue => cue.id)).size !== cues.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cue IDs must be unique" });
  for (const cue of cues) if (!Number.isSafeInteger(cue.frame + cue.durationFrames)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cue end exceeds frame clock" });
});
export const EffectClipObjectSchema = z.object({
  id: clipId, kind: z.literal("procedural"), lineageId: EffectLineageIdSchema, order: frame,
  startFrame: frame, durationFrames: frame.min(1), simulationOriginFrame: signedFrame,
  seed: z.number().int().min(0).max(0xffffffff), preset: EffectPresetSchema, target: EffectTargetSchema,
  appearance: EffectAppearanceSchema, motion: EffectMotionSchema, fades: EffectFadesSchema,
  intensityCurve: EffectCurveSchema, reactionCurve: EffectCurveSchema,
  audioInput: EffectAudioInputSchema.optional(), reaction: EffectReactionSchema, cueOverrides: EffectCueOverridesSchema,
}).strict();
export const EffectClipSchema = EffectClipObjectSchema.superRefine((effect, ctx) => {
  if (!Number.isSafeInteger(effect.startFrame + effect.durationFrames)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["durationFrames"], message: "effect end exceeds the frame clock" });
  if (!Number.isSafeInteger(effect.startFrame - effect.simulationOriginFrame) || !Number.isSafeInteger(effect.startFrame + effect.durationFrames - effect.simulationOriginFrame)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["simulationOriginFrame"], message: "simulation phase must fit the safe frame clock" });
  if (effect.reaction.enabled && effect.audioInput === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["audioInput"], message: "enabled reaction requires an explicit audio input" });
});
export type EffectClip = z.infer<typeof EffectClipSchema>;
export type EffectTarget = z.infer<typeof EffectTargetSchema>;
export type EffectAudioInput = z.infer<typeof EffectAudioInputSchema>;
export type EffectReaction = z.infer<typeof EffectReactionSchema>;
export type EffectCue = z.infer<typeof EffectCueSchema>;

export const EffectPatchSchema = z.object({
  preset: EffectPresetSchema.optional(), target: EffectTargetSchema.optional(), appearance: EffectAppearanceSchema.partial().strict().optional(),
  motion: EffectMotionSchema.partial().strict().optional(), fades: EffectFadesSchema.optional(),
  intensityCurve: EffectCurveSchema.optional(), reactionCurve: EffectCurveSchema.optional(),
  audioInput: EffectAudioInputSchema.nullable().optional(), reaction: EffectReactionSchema.partial().strict().optional(), cueOverrides: EffectCueOverridesSchema.optional(),
}).strict();
export type EffectPatch = z.infer<typeof EffectPatchSchema>;

export function effectCurveAt(curve: EffectCurve, offsetFrames: number): number {
  if (!curve.points.length) return 1;
  if (offsetFrames <= curve.points[0]!.offsetFrames) return curve.points[0]!.value;
  if (offsetFrames >= curve.points.at(-1)!.offsetFrames) return curve.points.at(-1)!.value;
  // A 2,000-point curve remains cheap during random-access particle evaluation.
  let low = 1, high = curve.points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (curve.points[middle]!.offsetFrames <= offsetFrames) low = middle + 1;
    else high = middle;
  }
  const left = curve.points[low - 1]!, right = curve.points[low]!;
  let t = (offsetFrames - left.offsetFrames) / (right.offsetFrames - left.offsetFrames);
  if (left.interpolation === "hold") return left.value;
  if (left.interpolation === "smooth") t = t * t * (3 - 2 * t);
  return left.value + (right.value - left.value) * t;
}

export function effectVisibilityAt(effect: EffectClip, productionFrame: number): number {
  if (productionFrame < effect.startFrame || productionFrame >= effect.startFrame + effect.durationFrames) return 0;
  const fade = effect.fades;
  const fadeIn = fade.inFrames === 0 ? 1 : Math.max(0, Math.min(1, (productionFrame - fade.startFrame) / fade.inFrames));
  const fadeOut = fade.outFrames === 0 ? 1 : Math.max(0, Math.min(1, (fade.endFrame - productionFrame) / fade.outFrames));
  return effect.appearance.opacity * effectCurveAt(effect.intensityCurve, productionFrame - effect.simulationOriginFrame) * fadeIn * fadeOut;
}

export function defaultEffectClip(input: { id: string; lineageId: string; startFrame: number; durationFrames: number; seed: number; preset?: EffectClip["preset"]["id"]; target?: EffectTarget; order?: number }): EffectClip {
  return EffectClipSchema.parse({ ...input, kind: "procedural", order: input.order ?? 0,
    preset: { id: input.preset ?? "dust", version: 1 }, target: input.target ?? { kind: "composition" }, simulationOriginFrame: input.startFrame,
    appearance: { amount: 0.3, size: 0.3, opacity: 0.5, colour: "#ffffff" }, motion: { direction: 0, speed: 0.2, area: { x: 0, y: 0, width: 1, height: 1 } },
    fades: { startFrame: input.startFrame, endFrame: input.startFrame + input.durationFrames, inFrames: 0, outFrames: 0 },
    intensityCurve: { points: [] }, reactionCurve: { points: [] }, cueOverrides: [],
    reaction: { enabled: false, preset: "gentle-shimmer", version: 1, strength: 0.5, beat: 0, bass: 0, energy: 0.3, property: "brightness", limit: 0.3, smoothingFrames: 10 },
  });
}
