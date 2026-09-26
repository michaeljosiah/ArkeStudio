import { z } from "zod";
import { FullSha256Schema } from "./audio.js";
import { DeliverySchema } from "./voice.js";
import type { ManifestModel } from "./manifest.js";

/** The phrase's cap (SPEC-047 R-6): a direction in the author's own words, short enough to be one. */
export const CADENCE_PHRASE_MAX = 60;
const CadenceSpanSchema = z.object({ from: z.number().int().nonnegative(), to: z.number().int().positive(), text: z.string().min(1) }).strict();
export interface CadenceSpan { from: number; to: number; text: string }
export interface PauseCue { kind: "pause"; at: number; length: "short" | "long" }
export interface BreathCue { kind: "breath"; at: number; action: "inhale" | "exhale" }
export interface EmphasisCue { kind: "emphasis"; span: CadenceSpan; level: "moderate" | "strong" }
export interface DeliveryMarker { kind: "delivery"; span: CadenceSpan; delivery?: z.infer<typeof DeliverySchema>; phrase?: string }
/**
 * A cue, named rather than inferred: every record that holds a plan — the chapter's audiobook
 * record, the events that carry it — would otherwise spell the union out in full, and the
 * engine's declaration build refuses a type that long (TS7056).
 */
export type CadenceCue = PauseCue | BreathCue | EmphasisCue | DeliveryMarker;
export const CadenceCueSchema: z.ZodType<CadenceCue, z.ZodTypeDef, unknown> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pause"), at: z.number().int().nonnegative(), length: z.enum(["short", "long"]) }).strict(),
  z.object({ kind: z.literal("breath"), at: z.number().int().nonnegative(), action: z.enum(["inhale", "exhale"]) }).strict(),
  z.object({ kind: z.literal("emphasis"), span: CadenceSpanSchema, level: z.enum(["moderate", "strong"]) }).strict(),
  /**
   * A delivery marker (SPEC-047 R-40): one of the six deliveries, or a phrase, or both, over a
   * span of the block — `[whispered]` over “Not tonight.” The block's own delivery is the
   * reading outside every marker. At least one of the two is required; `mapCadence` refuses a
   * marker that holds neither, since a union member cannot carry the refinement.
   */
  z.object({ kind: z.literal("delivery"), span: CadenceSpanSchema, delivery: DeliverySchema.optional(), phrase: z.string().min(1).max(CADENCE_PHRASE_MAX).optional() }).strict(),
]);
/** Where a cue starts: a span's first character, or a point cue's position. */
export function cueStart(cue: CadenceCue): number {
  return cue.kind === "emphasis" || cue.kind === "delivery" ? cue.span.from : cue.at;
}
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
  let position = -1, emphasisEnd = -1, markerEnd = -1;
  const positions = new Set<string>();
  for (const cue of plan.cues) {
    const at = cueStart(cue);
    if (!boundary(at) || at < position) throw new Error("Cadence cues must use valid text boundaries in position order.");
    position = at;
    if (cue.kind === "emphasis") {
      if (!boundary(cue.span.to) || cue.span.to <= at || at < emphasisEnd || text.slice(at, cue.span.to) !== cue.span.text) throw new Error("Emphasis must match one exact, non-overlapping authored span.");
      emphasisEnd = cue.span.to;
    } else if (cue.kind === "delivery") {
      // Checked as emphasis is (R-40), against other markers only: an emphasis inside a
      // marker is allowed, one across its edge is not, since the parts a marker can make are
      // split at its edges and no part could carry half an emphasis.
      if (!boundary(cue.span.to) || cue.span.to <= at || at < markerEnd || text.slice(at, cue.span.to) !== cue.span.text) throw new Error("A marker must match one exact, non-overlapping authored span.");
      if (cue.delivery === undefined && cue.phrase === undefined) throw new Error("A marker needs a delivery or a phrase.");
      markerEnd = cue.span.to;
    } else {
      const key = `${cue.kind}/${at}`;
      if (positions.has(key)) throw new Error("Duplicate cadence cues at this position.");
      positions.add(key);
    }
  }
  for (const marker of plan.cues) {
    if (marker.kind !== "delivery") continue;
    for (const emphasis of plan.cues) {
      if (emphasis.kind !== "emphasis") continue;
      const overlaps = emphasis.span.from < marker.span.to && emphasis.span.to > marker.span.from;
      if (overlaps && (emphasis.span.from < marker.span.from || emphasis.span.to > marker.span.to)) throw new Error("An emphasis must sit inside a marker or outside it.");
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
  // The block's own lead, which an inline marker restores after its span (R-41).
  const blockLead = [
    ...(delivery?.tag && tagged ? [tag(delivery.tag)] : []),
    ...(plan.phrase !== undefined && cap?.phrase === "best-effort-tag" && tagged ? [tag(plan.phrase)] : []),
  ].join(" ");
  plan.cues.forEach((cue, cueIndex) => {
    if (cue.kind === "delivery") {
      // A marker in place (R-41): an inline tag before its span and the block's lead after it
      // on a row that writes tags; parts split at its edges, each with its own delivery, on a
      // row that carries delivery only as settings or a sentence — the parts are the caller's
      // to make (`markerParts`), so here the words are left alone.
      const mode = markerMode(cue, plan, model, language, text.length);
      if (mode.mode === "unsupported") {
        controls.push({ control: "delivery", cueIndex, status: "unsupported", reason: mode.reason });
        return;
      }
      controls.push({ control: "delivery", cueIndex, status: "best-effort", method: mode.mode === "inline" ? "audio tag" : "parts" });
      if (mode.mode === "inline") {
        edits.push({ at: cue.span.from, end: cue.span.from, text: `${markerLead(cue, model, language).join(" ")} ` });
        if (cue.span.to < text.length && blockLead !== "") edits.push({ at: cue.span.to, end: cue.span.to, text: ` ${blockLead}` });
      }
      return;
    }
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

export type MarkerMode = { mode: "inline" } | { mode: "parts" } | { mode: "unsupported"; reason: string };

/**
 * How a row carries one delivery marker (SPEC-047 R-41). `inline` when the marker's delivery
 * is a tag alone on this row, its phrase is a tag, and the block's own reading can be written
 * back after the span as a tag too — or the span runs to the block's end, so there is nothing
 * after it to restore; a marker whose tag would run on into the narration past it is made in
 * parts instead. `parts` when the row carries the marker's delivery or phrase at all — as
 * settings, a sentence, or a tag it cannot restore from. `unsupported` otherwise, with the
 * reason the menu strikes it with (R-42) and the view holds it under (R-47).
 */
export function markerMode(marker: DeliveryMarker, plan: Pick<CadencePlan, "delivery" | "phrase">, model: Pick<ManifestModel, "cadence">, language: string | undefined, textLength: number): MarkerMode {
  const cap = model.cadence;
  const tagged = cap?.tagSyntax !== "paren" || language === "en";
  const mapping = marker.delivery !== undefined && cap?.deliveries.includes(marker.delivery) ? cap.deliveryMappings[marker.delivery] : undefined;
  if (marker.delivery !== undefined) {
    if (mapping === undefined) {
      const reads = cap?.deliveries.join(" · ") ?? "";
      return { mode: "unsupported", reason: reads === "" ? "no delivery" : `reads ${reads}` };
    }
    if (mapping.tag !== undefined && !tagged && mapping.instruction === undefined) return { mode: "unsupported", reason: "tags need a line stated English" };
  }
  const phraseTag = cap?.phrase === "best-effort-tag" && tagged;
  if (marker.phrase !== undefined && !phraseTag && cap?.phrase !== "best-effort-instruction") {
    return { mode: "unsupported", reason: cap?.phrase === "best-effort-tag" ? "tags need a line stated English" : "no phrase" };
  }
  const deliveryInline = mapping === undefined || (mapping.tag !== undefined && tagged && mapping.instruction === undefined);
  const phraseInline = marker.phrase === undefined || phraseTag;
  const block = cap?.deliveries.includes(plan.delivery) ? cap.deliveryMappings[plan.delivery] : undefined;
  const restores = (block?.tag !== undefined && tagged) || (plan.phrase !== undefined && phraseTag);
  return deliveryInline && phraseInline && (restores || marker.span.to >= textLength) ? { mode: "inline" } : { mode: "parts" };
}

/** The tags an inline marker writes before its span: its delivery's, then its phrase. */
function markerLead(marker: DeliveryMarker, model: Pick<ManifestModel, "cadence">, language: string | undefined): string[] {
  const cap = model.cadence;
  const paren = cap?.tagSyntax === "paren";
  const tagged = !paren || language === "en";
  const tag = (word: string) => (paren ? `(${word})` : `[${word}]`);
  const mapping = marker.delivery !== undefined ? cap?.deliveryMappings[marker.delivery] : undefined;
  return [...(mapping?.tag !== undefined && tagged ? [tag(mapping.tag)] : []), ...(marker.phrase !== undefined && tagged ? [tag(marker.phrase)] : [])];
}

/**
 * A block cut at the edges of the markers its row makes in parts (R-41): each segment the
 * words it holds, the plan that reads it — the marker's delivery and phrase over the marker's
 * span, the block's elsewhere — and the other cues that fall inside it, at their positions in
 * the segment. A block with no such marker is one segment with its plan unchanged. The joined
 * segments are the block's words, spaces aside: each is trimmed, since a reader sent a leading
 * space reads nothing different and a cap counts it.
 */
export function markerSegments(text: string, plan: CadencePlan, model: Pick<ManifestModel, "cadence">, language?: string): Array<{ text: string; from: number; plan: CadencePlan }> {
  const whole = normalizeSpeechText(text);
  const split = plan.cues.filter((cue): cue is DeliveryMarker => cue.kind === "delivery" && markerMode(cue, plan, model, language, whole.length).mode === "parts");
  if (split.length === 0) return [{ text: whole, from: 0, plan }];
  const edges = [0, ...split.flatMap((marker) => [marker.span.from, marker.span.to]), whole.length];
  const out: Array<{ text: string; from: number; plan: CadencePlan }> = [];
  // A point cue on a shared edge goes to the first segment that holds it, never to both.
  const placed = new Set<CadenceCue>();
  for (let index = 0; index + 1 < edges.length; index++) {
    const start = edges[index]!;
    const end = edges[index + 1]!;
    const raw = whole.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const piece = raw.trim();
    if (piece === "") continue;
    const from = start + lead;
    const to = from + piece.length;
    const marker = split.find((candidate) => candidate.span.from === start && candidate.span.to === end);
    const cues = plan.cues
      .filter((cue) => !(cue.kind === "delivery" && split.includes(cue)))
      .filter((cue) => !placed.has(cue) && (cue.kind === "emphasis" || cue.kind === "delivery" ? cue.span.from >= from && cue.span.to <= to : cue.at >= from && cue.at <= to))
      .map((cue) => {
        placed.add(cue);
        return cue.kind === "emphasis" || cue.kind === "delivery" ? { ...cue, span: { ...cue.span, from: cue.span.from - from, to: cue.span.to - from } } : { ...cue, at: cue.at - from };
      });
    const { phrase: _blockPhrase, ...bare } = plan;
    const segmentPlan: CadencePlan =
      marker === undefined
        ? { ...plan, cues }
        : {
            ...bare,
            cues,
            delivery: marker.delivery ?? plan.delivery,
            // A marker's phrase stands over its span; a marker that names a delivery alone reads
            // it plain, rather than under a block phrase written for another delivery.
            ...(marker.phrase !== undefined ? { phrase: marker.phrase } : marker.delivery === undefined && plan.phrase !== undefined ? { phrase: plan.phrase } : {}),
          };
    out.push({ text: piece, from, plan: segmentPlan });
  }
  return out;
}

export interface HeldControl {
  control: "delivery" | "speed" | "phrase" | "pause" | "breath" | "emphasis" | "marker";
  cueIndex?: number;
  reason: string;
}

/**
 * Direction the reader cannot express, held rather than dropped (SPEC-047 R-47): what `mapCadence`
 * reports unsupported is left out of the plan that is sent — the phrase, a cue, a marker, a
 * speed off the row's range — and named, so the view can strike it and count it while the
 * record keeps it for a reader that can. A delivery the row lacks is held too, but stays in the
 * plan: the plan must name one, and an unmapped delivery renders nothing. Throws as `mapCadence`
 * does on a plan that is wrong for its words, which is an authoring fault, not a reader's limit.
 */
export function holdDirection(text: string, plan: CadencePlan, model: Pick<ManifestModel, "id" | "provider" | "providerModelId" | "cadence">, language?: string): { plan: CadencePlan; held: HeldControl[] } {
  const mapped = mapCadence(text, plan.sourceTextHash, plan, model, language);
  const held: HeldControl[] = [];
  const dropCue = new Set<number>();
  let speed = plan.speed;
  let phrase = plan.phrase;
  for (const control of mapped.controls) {
    if (control.status !== "unsupported") continue;
    const reason = control.reason ?? `no ${control.control}`;
    if (control.cueIndex !== undefined) {
      dropCue.add(control.cueIndex);
      held.push({ control: control.control === "delivery" ? "marker" : control.control, cueIndex: control.cueIndex, reason });
    } else if (control.control === "speed") {
      speed = 1;
      held.push({ control: "speed", reason: "no speed" });
    } else if (control.control === "phrase") {
      phrase = undefined;
      held.push({ control: "phrase", reason });
    } else if (control.control === "delivery") {
      held.push({ control: "delivery", reason });
    }
  }
  if (held.length === 0) return { plan, held };
  const { phrase: _was, ...rest } = plan;
  return { plan: { ...rest, speed, cues: plan.cues.filter((_, index) => !dropCue.has(index)), ...(phrase !== undefined ? { phrase } : {}) }, held };
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
