import { z } from "zod";
import { FullSha256Schema } from "./audio.js";
import { DeliverySchema } from "./voice.js";
import type { ManifestModel } from "./manifest.js";

export const CadenceCueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pause"), at: z.number().int().nonnegative(), length: z.enum(["short", "long"]) }).strict(),
  z.object({ kind: z.literal("breath"), at: z.number().int().nonnegative(), action: z.enum(["inhale", "exhale"]) }).strict(),
  z.object({ kind: z.literal("emphasis"), span: z.object({ from: z.number().int().nonnegative(), to: z.number().int().positive(), text: z.string().min(1) }).strict(), level: z.enum(["moderate", "strong"]) }).strict(),
]);
/** The phrase's cap (SPEC-047 R-6): a direction in the author's own words, short enough to be one. */
export const CADENCE_PHRASE_MAX = 60;
export const CadencePlanSchema = z.object({ schemaVersion: z.literal(1), sourceTextHash: FullSha256Schema,
  delivery: DeliverySchema, speed: z.number().min(0.7).max(1.2), cues: z.array(CadenceCueSchema).max(40),
  /**
   * A free phrase beside the delivery (SPEC-047 R-7) — `to the water, flat` — for the readers
   * that take language: a tag on a row that renders one, an instruction on a row that takes
   * one, refused elsewhere. The one addition to the plan the audiobook makes; never words a
   * reader would speak.
   */
  phrase: z.string().min(1).max(CADENCE_PHRASE_MAX).optional() }).strict();
export type CadencePlan = z.infer<typeof CadencePlanSchema>;
export const CadenceCapabilitiesSchema = z.object({
  deliveries: z.array(DeliverySchema), speed: z.object({ min: z.number().positive(), max: z.number().positive() }).strict().nullable(),
  pause: z.enum(["unsupported", "best-effort-audio-tag"]), emphasis: z.enum(["unsupported", "best-effort-capitalization"]),
  breath: z.enum(["unsupported", "best-effort-audio-tag"]), outputTimestamps: z.literal("none"),
  /**
   * What a row does with a phrase (SPEC-047 R-7): a tag in the text, an instruction beside it,
   * or nothing. Absent is `unsupported` — every row declared before the phrase existed keeps
   * parsing and refuses one, which is the honest default for a reader nobody has asked.
   */
  phrase: z.enum(["unsupported", "best-effort-tag", "best-effort-instruction"]).optional(),
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
  controls: z.array(z.object({ control: z.enum(["delivery", "speed", "pause", "emphasis", "breath", "phrase"]),
    cueIndex: z.number().int().nonnegative().optional(), status: z.enum(["mapped", "best-effort", "unsupported"]),
    method: z.string().optional(), reason: z.string().optional() }).strict()),
}).strict();
export function normalizeSpeechText(text: string): string { return text.replace(/\s+/g, " ").trim(); }

/**
 * UTF-16 coordinates refer to normalized authored text, never a decorated provider string.
 *
 * `language` is the line's, when anything states it — a cloned voice's recording language
 * (issue 1163). A paren row's tags are English words (SPEC-046 R-23), so they go in only when
 * the line is stated to be English: unknown is not English, and the delivery's sentence carries
 * the direction instead. Bracket rows are untouched by it.
 */
export function mapCadence(text: string, expectedHash: string, input: CadencePlan, model: Pick<ManifestModel, "id" | "provider" | "providerModelId" | "cadence">, language?: string) {
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
  // The two tag spellings the catalogue's vendors read (R-21): brackets with a phrase inside for
  // ElevenLabs and Fish, parentheses around one English word for Breeze — which is why the
  // parentheses wait for the line to be stated English (R-23) and the brackets do not.
  const paren = cap?.tagSyntax === "paren";
  const tagged = !paren || language === "en";
  const UNTAGGED = "the tag is an English word and the line is not stated to be English";
  // A delivery carried by a tag or an instruction is best effort, like a cue: neither is a
  // parameter the vendor promises to honour. Settings alone are mapped. A delivery whose only
  // direction is a tag that cannot go in carries nothing, and says so.
  const carriedByTag = delivery?.tag !== undefined && tagged;
  const directed = delivery !== undefined && (carriedByTag || delivery.instruction !== undefined);
  const untagged = delivery !== undefined && delivery.tag !== undefined && !tagged && delivery.instruction === undefined;
  const controls: z.infer<typeof CadenceMappingSchema>["controls"] = [{ control: "delivery", status: delivery ? untagged ? "unsupported" : directed ? "best-effort" : "mapped" : "unsupported",
    ...(delivery ? untagged ? { method: "declared voice settings", reason: UNTAGGED }
      : { method: delivery.instruction ? "instruction and declared settings" : carriedByTag ? "audio tag and declared settings" : "declared voice settings" }
      : { reason: "This model has no declared delivery mapping." }) }];
  const voiceSettings = { ...delivery?.settings };
  const speedSupported = cap?.speed && plan.speed >= cap.speed.min && plan.speed <= cap.speed.max;
  controls.push({ control: "speed", status: speedSupported || plan.speed === 1 ? "mapped" : "unsupported",
    method: speedSupported ? "native speed" : "delivery preset only" });
  if (speedSupported) voiceSettings.speed = plan.speed;
  // Same cue, same position, different ink.
  const tag = (word: string) => (paren ? `(${word})` : `[${word}]`);
  const cueTag = (cue: CadencePlan["cues"][number]) => cue.kind === "pause" ? (paren ? "pause" : `${cue.length} pause`)
    : cue.kind === "breath" ? (cue.action === "inhale" ? (paren ? "inhales" : "inhales deeply") : "exhales") : "";
  const edits: Array<{ at: number; end: number; text: string }> = [];
  plan.cues.forEach((cue, cueIndex) => {
    const declared = cap && cap[cue.kind] !== "unsupported";
    // Emphasis is capitals in the text, in any language; a pause or a breath is a tag.
    const supported = declared && (cue.kind === "emphasis" || tagged);
    controls.push({ control: cue.kind, cueIndex, status: supported ? "best-effort" : "unsupported", method: cap?.[cue.kind] ?? "unsupported",
      ...(declared && !supported ? { reason: UNTAGGED } : {}) });
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
  // The phrase rides the same seam as a delivery's tag or sentence (SPEC-047 R-7): a tag after
  // the delivery's on a row that renders one — the same English-only wait on a paren row — an
  // instruction after the delivery's on a row that takes one, and refused where the row
  // declares neither, so it is never rendered into words a reader would speak. The lead is
  // the delivery's tag then the phrase's, so the modifier follows what it qualifies.
  const lead: string[] = [];
  if (delivery?.tag && tagged) lead.push(tag(delivery.tag));
  let instructions = delivery?.instruction;
  if (plan.phrase !== undefined) {
    const how = cap?.phrase ?? "unsupported";
    if (how === "best-effort-tag" && tagged) {
      lead.push(tag(plan.phrase));
      controls.push({ control: "phrase", status: "best-effort", method: "audio tag" });
    } else if (how === "best-effort-instruction") {
      instructions = instructions === undefined ? plan.phrase : `${instructions} ${plan.phrase}`;
      controls.push({ control: "phrase", status: "best-effort", method: "instruction" });
    } else {
      controls.push({ control: "phrase", status: "unsupported", ...(how === "best-effort-tag" ? { reason: UNTAGGED } : { reason: "This model takes no phrase." }) });
    }
  }
  if (lead.length > 0) providerText = `${lead.join(" ")} ${providerText}`;
  return { provider: model.provider, model: model.id, providerModel: model.providerModelId ?? model.id,
    providerText, voiceSettings, ...(instructions !== undefined ? { instructions } : {}), controls };
}

export interface CadenceControlSupport { status: "mapped" | "best-effort" | "unsupported"; method?: string; reason?: string }

/**
 * What a reader does with each control before any plan is written (SPEC-047 R-9): the block
 * panel says it on the control, one clause, and a derivation drops what a reader declares
 * `unsupported` rather than accepting a direction the read could only flag (R-10). Read off the
 * row and the line's language, so it agrees with `mapCadence` on every plan that reaches it: a
 * paren row's tags are English words that go in only when the line is stated English (SPEC-046
 * R-23), so on such a row a tag-carried delivery, a pause, a breath and a tagged phrase are
 * `unsupported` for a line not stated English — a preset's, a French clone's — rather than
 * offered and then refused (codex on PR 1186).
 */
export function cadenceSupport(model: Pick<ManifestModel, "cadence">, language?: string): {
  deliveries: Record<string, CadenceControlSupport>; speed: CadenceControlSupport;
  pause: CadenceControlSupport; breath: CadenceControlSupport; emphasis: CadenceControlSupport; phrase: CadenceControlSupport;
} {
  const cap = model.cadence;
  const tagged = cap?.tagSyntax !== "paren" || language === "en";
  const UNTAGGED = "tags need a line stated English";
  const reads = cap?.deliveries.join(" · ") ?? "";
  const deliveries: Record<string, CadenceControlSupport> = {};
  for (const delivery of DeliverySchema.options) {
    const mapping = cap?.deliveries.includes(delivery) ? cap.deliveryMappings[delivery] : undefined;
    deliveries[delivery] = mapping === undefined ? { status: "unsupported", reason: reads === "" ? "no delivery" : `reads ${reads}` }
      : mapping.instruction !== undefined ? { status: "best-effort", method: "instruction" }
      : mapping.tag !== undefined ? (tagged ? { status: "best-effort", method: "tag" } : { status: "unsupported", reason: UNTAGGED })
      : { status: "mapped", method: "settings" };
  }
  const cue = (declared: string | undefined, name: string): CadenceControlSupport =>
    declared === undefined || declared === "unsupported" ? { status: "unsupported", reason: `no ${name}` }
      : declared === "best-effort-capitalization" ? { status: "best-effort", method: "capitals" }
      : tagged ? { status: "best-effort", method: "tag" } : { status: "unsupported", reason: UNTAGGED };
  return {
    deliveries,
    speed: cap?.speed ? { status: "mapped", method: `${cap.speed.min}–${cap.speed.max}` } : { status: "unsupported", reason: "no speed" },
    pause: cue(cap?.pause, "pause"), breath: cue(cap?.breath, "breath"), emphasis: cue(cap?.emphasis, "emphasis"),
    phrase: cap?.phrase === "best-effort-tag" ? (tagged ? { status: "best-effort", method: "tag" } : { status: "unsupported", reason: UNTAGGED })
      : cap?.phrase === "best-effort-instruction" ? { status: "best-effort", method: "instruction" } : { status: "unsupported", reason: "no phrase" },
  };
}

/** Text offsets are reusable only for the same normalized authored wording. */
export function seedCadencePlan(source: CadencePlan | undefined, delivery: CadencePlan["delivery"], sourceTextHash: string): CadencePlan {
  return { schemaVersion: 1, sourceTextHash, delivery, speed: source?.speed ?? 1,
    cues: source?.sourceTextHash === sourceTextHash ? structuredClone(source.cues) : [] };
}
