import { z } from "zod";
import { FullSha256Schema } from "./audio.js";
import { DeliverySchema } from "./voice.js";
import type { ManifestModel } from "./manifest.js";

export const CadenceCueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pause"), at: z.number().int().nonnegative(), length: z.enum(["short", "long"]) }).strict(),
  z.object({ kind: z.literal("breath"), at: z.number().int().nonnegative(), action: z.enum(["inhale", "exhale"]) }).strict(),
  z.object({ kind: z.literal("emphasis"), span: z.object({ from: z.number().int().nonnegative(), to: z.number().int().positive(), text: z.string().min(1) }).strict(), level: z.enum(["moderate", "strong"]) }).strict(),
]);
export const CadencePlanSchema = z.object({ schemaVersion: z.literal(1), sourceTextHash: FullSha256Schema,
  delivery: DeliverySchema, speed: z.number().min(0.7).max(1.2), cues: z.array(CadenceCueSchema).max(40) }).strict();
export type CadencePlan = z.infer<typeof CadencePlanSchema>;
export const CadenceCapabilitiesSchema = z.object({
  deliveries: z.array(DeliverySchema), speed: z.object({ min: z.number().positive(), max: z.number().positive() }).strict().nullable(),
  pause: z.enum(["unsupported", "best-effort-audio-tag"]), emphasis: z.enum(["unsupported", "best-effort-capitalization"]),
  breath: z.enum(["unsupported", "best-effort-audio-tag"]), outputTimestamps: z.literal("none"),
  /**
   * How a tag is written into the text (SPEC-046 R-21). Absent is `bracket`, the ElevenLabs
   * rendering every row declared before there was a second vendor — `[short pause]`,
   * `[whispers] …`. Breeze reads English tags in parentheses, `(pause)`, `(whispers)`, so its row
   * says `paren` and nothing else changes: the plan, the cues and the control report are the same.
   */
  tagSyntax: z.enum(["bracket", "paren"]).optional(),
  /**
   * A delivery maps to settings, and optionally to a tag in the text or an instruction beside it
   * (R-21). The instruction is for a vendor that takes direction as a sentence — Breeze's
   * `instructions` field — and is lifted OUT of the text into the mapping's `instructions`, so the
   * spoken words stay exactly the authored ones.
   */
  deliveryMappings: z.record(z.string(), z.object({ settings: z.record(z.string(), z.number()), tag: z.string().optional(),
    instruction: z.string().optional() }).strict()),
}).strict();
export const CadenceMappingSchema = z.object({
  provider: z.string().min(1), model: z.string().min(1), providerModel: z.string().min(1),
  providerText: z.string().min(1), providerTextHash: FullSha256Schema, voiceSettings: z.record(z.string(), z.number()),
  /** The delivery's instruction, for a vendor that takes one beside the text (R-21). */
  instructions: z.string().optional(),
  controls: z.array(z.object({ control: z.enum(["delivery", "speed", "pause", "emphasis", "breath"]),
    cueIndex: z.number().int().nonnegative().optional(), status: z.enum(["mapped", "best-effort", "unsupported"]),
    method: z.string().optional(), reason: z.string().optional() }).strict()),
}).strict();
export function normalizeSpeechText(text: string): string { return text.replace(/\s+/g, " ").trim(); }

/** UTF-16 coordinates refer to normalized authored text, never a decorated provider string. */
export function mapCadence(text: string, expectedHash: string, input: CadencePlan, model: Pick<ManifestModel, "id" | "provider" | "providerModelId" | "cadence">) {
  const plan = CadencePlanSchema.parse(input);
  text = normalizeSpeechText(text);
  if (plan.sourceTextHash !== expectedHash) throw new Error("Cadence was authored for different wording.");
  const boundary = (at: number) => at >= 0 && at <= text.length && !(at > 0 && at < text.length &&
    /[\uD800-\uDBFF]/.test(text[at - 1]!) && /[\uDC00-\uDFFF]/.test(text[at]!));
  let position = -1, emphasisEnd = -1;
  const positions = new Set<string>();
  for (const cue of plan.cues) {
    const at = cue.kind === "emphasis" ? cue.span.from : cue.at;
    if (!boundary(at) || at < position) throw new Error("Cadence cues must use valid text boundaries in position order.");
    position = at;
    if (cue.kind === "emphasis") {
      if (!boundary(cue.span.to) || cue.span.to <= at || at < emphasisEnd || text.slice(at, cue.span.to) !== cue.span.text) throw new Error("Emphasis must match one exact, non-overlapping authored span.");
      emphasisEnd = cue.span.to;
    } else {
      const key = `${cue.kind}/${at}`;
      if (positions.has(key)) throw new Error("Duplicate cadence cues at this position.");
      positions.add(key);
    }
  }
  const cap = model.cadence;
  const delivery = cap?.deliveries.includes(plan.delivery) ? cap.deliveryMappings[plan.delivery] : undefined;
  // A delivery carried by a tag or an instruction is best effort, like a cue: neither is a
  // parameter the vendor promises to honour. Settings alone are mapped.
  const directed = delivery !== undefined && (delivery.tag !== undefined || delivery.instruction !== undefined);
  const controls: z.infer<typeof CadenceMappingSchema>["controls"] = [{ control: "delivery", status: delivery ? directed ? "best-effort" : "mapped" : "unsupported",
    ...(delivery ? { method: delivery.instruction ? "instruction and declared settings" : delivery.tag ? "audio tag and declared settings" : "declared voice settings" }
      : { reason: "This model has no declared delivery mapping." }) }];
  const voiceSettings = { ...delivery?.settings };
  const speedSupported = cap?.speed && plan.speed >= cap.speed.min && plan.speed <= cap.speed.max;
  controls.push({ control: "speed", status: speedSupported || plan.speed === 1 ? "mapped" : "unsupported",
    method: speedSupported ? "native speed" : "delivery preset only" });
  if (speedSupported) voiceSettings.speed = plan.speed;
  // The two tag spellings the catalogue's vendors read (R-21): brackets with a phrase inside for
  // ElevenLabs, parentheses around one word for Breeze. Same cue, same position, different ink.
  const paren = cap?.tagSyntax === "paren";
  const tag = (word: string) => (paren ? `(${word})` : `[${word}]`);
  const cueTag = (cue: CadencePlan["cues"][number]) => cue.kind === "pause" ? (paren ? "pause" : `${cue.length} pause`)
    : cue.kind === "breath" ? (cue.action === "inhale" ? (paren ? "inhales" : "inhales deeply") : "exhales") : "";
  const edits: Array<{ at: number; end: number; text: string }> = [];
  plan.cues.forEach((cue, cueIndex) => {
    const supported = cap && cap[cue.kind] !== "unsupported";
    controls.push({ control: cue.kind, cueIndex, status: supported ? "best-effort" : "unsupported", method: cap?.[cue.kind] ?? "unsupported" });
    if (!supported) return;
    if (cue.kind === "emphasis") edits.push({ at: cue.span.from, end: cue.span.to, text: cue.span.text.toUpperCase() });
    else edits.push({ at: cue.at, end: cue.at, text: ` ${tag(cueTag(cue))} ` });
  });
  // Walk original UTF-16 coordinates: Unicode capitalization can expand without shifting cues.
  let providerText = "";
  for (let at = 0; at <= text.length; at++) {
    providerText += edits.filter(e => e.at === at && e.end === at).map(e => e.text).join("");
    if (at < text.length) providerText += edits.some(e => e.at <= at && e.end > at) ? text[at]!.toUpperCase() : text[at];
  }
  if (delivery?.tag) providerText = `${tag(delivery.tag)} ${providerText}`;
  return { provider: model.provider, model: model.id, providerModel: model.providerModelId ?? model.id,
    providerText, voiceSettings, ...(delivery?.instruction !== undefined ? { instructions: delivery.instruction } : {}), controls };
}

/** Text offsets are reusable only for the same normalized authored wording. */
export function seedCadencePlan(source: CadencePlan | undefined, delivery: CadencePlan["delivery"], sourceTextHash: string): CadencePlan {
  return { schemaVersion: 1, sourceTextHash, delivery, speed: source?.speed ?? 1,
    cues: source?.sourceTextHash === sourceTextHash ? structuredClone(source.cues) : [] };
}
