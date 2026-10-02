import { z } from "zod";
import { FullSha256Schema } from "./audio.js";
import { DeliverySchema } from "./voice.js";
import type { ManifestModel } from "./manifest.js";

/**
 * A marker's phrase and a performed speaker's note (SPEC-047 R-6, R-44): a direction in the
 * author's own words, short enough to be one. It is also the longest note a tag reader takes as
 * a tag (design turn 181): Eleven v3 reads a bracket of sixty characters as it reads `[whispers]`.
 */
export const CADENCE_PHRASE_MAX = 60;
/**
 * The block's note (design turn 181, SPEC-049 R-21): the audiobook block's phrase and the Bench
 * line's direction in the author's words — `angry and hurt — quieter, not louder` — long enough
 * to say how, short enough to stay a direction. An instruction reader takes it whole; a tag
 * reader takes it as one tag only up to `CADENCE_PHRASE_MAX`.
 */
export const CADENCE_NOTE_MAX = 300;

/**
 * The portable vocal events (design turns 165b and 181; SPEC-049 R-22): a sound is a marker at
 * a point, written once in these words and sent to each reader in its own — `<sigh>` to Gemini,
 * `[sighs]` to Eleven v3, `(sigh)` to Breeze in English, `[sighing]` to Fish. What a reader
 * cannot make is held, never spoken.
 */
export const SOUNDS = ["laughs", "chuckles", "sighs", "gasps", "sobs", "clears throat", "coughs", "groans", "yawns"] as const;
export const SoundSchema = z.enum(SOUNDS);
export type Sound = z.infer<typeof SoundSchema>;

const CadenceSpanSchema = z.object({ from: z.number().int().nonnegative(), to: z.number().int().positive(), text: z.string().min(1) }).strict();
export interface CadenceSpan { from: number; to: number; text: string }
export interface PauseCue { kind: "pause"; at: number; length: "short" | "long" }
export interface BreathCue { kind: "breath"; at: number; action: "inhale" | "exhale" }
export interface EmphasisCue { kind: "emphasis"; span: CadenceSpan; level: "moderate" | "strong" }
export interface DeliveryMarker { kind: "delivery"; span: CadenceSpan; delivery?: z.infer<typeof DeliverySchema>; phrase?: string }
export interface SoundCue { kind: "sound"; at: number; sound: Sound }
/**
 * A cue, named rather than inferred: every record that holds a plan — the chapter's audiobook
 * record, the events that carry it — would otherwise spell the union out in full, and the
 * engine's declaration build refuses a type that long (TS7056).
 */
export type CadenceCue = PauseCue | BreathCue | EmphasisCue | DeliveryMarker | SoundCue;
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
  /** A vocal event at a point (design turn 165b): `[sighs]` after “time.” */
  z.object({ kind: z.literal("sound"), at: z.number().int().nonnegative(), sound: SoundSchema }).strict(),
]);
/** Where a cue starts: a span's first character, or a point cue's position. */
export function cueStart(cue: CadenceCue): number {
  return cue.kind === "emphasis" || cue.kind === "delivery" ? cue.span.from : cue.at;
}
/** A cue that sits at a point rather than over a span. */
export function isPointCue(cue: CadenceCue): cue is PauseCue | BreathCue | SoundCue {
  return cue.kind === "pause" || cue.kind === "breath" || cue.kind === "sound";
}

/**
 * The block's direction as a plan. `note` was `phrase` (≤ 60) until design turn 181: a plan
 * written before reads its phrase as its note — migrated on read, never rewritten in place —
 * and `audiobookDirectionHash` names the note by the old key, so a take made under a phrase
 * stays current under the same words as a note.
 */
export const CadencePlanObjectSchema = z.object({ schemaVersion: z.literal(1), sourceTextHash: FullSha256Schema,
  /**
   * The reading outside every marker. Absent is the reader's own reading (the Bench's
   * `Delivery · default`): nothing about delivery is sent, and nothing is held for it.
   */
  delivery: DeliverySchema.optional(), speed: z.number().min(0.7).max(1.2), cues: z.array(CadenceCueSchema).max(40),
  /**
   * The note (SPEC-047 R-7, design turn 181): how to read it, in the author's words, for the
   * readers that take language — the instruction beside the delivery's on a row that takes one,
   * one tag on a row that writes tags when it is short enough to be one, held elsewhere. Never
   * words a reader would speak.
   */
  note: z.string().min(1).max(CADENCE_NOTE_MAX).optional() }).strict();

/** An old `phrase` read as the note (design turn 181); a record holding both keeps its note. */
export function migratePlanNote(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !("phrase" in raw)) return raw;
  const { phrase, ...rest } = raw as Record<string, unknown>;
  return rest["note"] === undefined && phrase !== undefined ? { ...rest, note: phrase } : rest;
}
export const CadencePlanSchema = z.preprocess(migratePlanNote, CadencePlanObjectSchema);
export type CadencePlan = z.infer<typeof CadencePlanObjectSchema>;

export const CadenceCapabilitiesSchema = z.object({
  deliveries: z.array(DeliverySchema), speed: z.object({ min: z.number().positive(), max: z.number().positive() }).strict().nullable(),
  /**
   * How a pause reaches the reader: a tag in its syntax (`[long pause]`, `<long pause>`), an
   * SSML break (`<break time="1.5s"/>`, Eleven Multilingual v2's only direction), or punctuation
   * for a reader that takes no direction at all (Voxtral, Kokoro: `,` and `…`).
   */
  pause: z.enum(["unsupported", "best-effort-audio-tag", "best-effort-break", "best-effort-punctuation"]), emphasis: z.enum(["unsupported", "best-effort-capitalization"]),
  breath: z.enum(["unsupported", "best-effort-audio-tag"]), outputTimestamps: z.literal("none"),
  /**
   * What a row does with direction in words (SPEC-047 R-7): the block's note, a marker's phrase,
   * a performed speaker's note — a tag in the text, an instruction beside it, or nothing. A tag
   * row takes a note as one tag when it is at most `CADENCE_PHRASE_MAX` long, and holds a longer
   * one; an instruction row takes it whole. Absent is `unsupported` — every row declared before
   * the phrase existed keeps parsing and refuses one, which is the honest default for a reader
   * nobody has asked.
   */
  phrase: z.enum(["unsupported", "best-effort-tag", "best-effort-instruction"]).optional(),
  /**
   * How a tag is written into the text (SPEC-046 R-21). Absent is `bracket`, the ElevenLabs
   * rendering every row declared before there was a second vendor — `[short pause]`,
   * `[whispers] …`. Breeze reads English tags in parentheses, `(pause)`, `(whispers)`. Gemini 3.8
   * reads its vocalizations in angle brackets, `<sigh>`, and speaks anything in square brackets
   * as words (design turn 181).
   */
  tagSyntax: z.enum(["bracket", "paren", "angle"]).optional(),
  /**
   * The words this row writes for a pause and a breath, where they differ from its syntax's
   * defaults (`cueTagWord`): Fish documents `[inhale]`, Breeze `(inhale)`.
   */
  cueTags: z.object({ short: z.string().min(1), long: z.string().min(1), inhale: z.string().min(1), exhale: z.string().min(1) }).partial().strict().optional(),
  /**
   * The sounds this row makes (design turn 181): each portable word (`SOUNDS`) to the row's own
   * word for it, written in the row's tag syntax. A sound the row does not list is held. Absent
   * is no sounds. Keyed by string so a newer build's sound reads as one this row does not make.
   */
  sounds: z.record(z.string(), z.string().min(1)).optional(),
  /**
   * A delivery maps to settings, and optionally to a tag in the text or an instruction beside it
   * (R-21). The instruction is for a vendor that takes direction as a sentence — Breeze's
   * `instructions` field, Gemini's `speech_metadata.style` — and is lifted OUT of the text into
   * the mapping's `instructions`, so the spoken words stay exactly the authored ones.
   */
  deliveryMappings: z.record(z.string(), z.object({ settings: z.record(z.string(), z.number()), tag: z.string().optional(),
    instruction: z.string().optional() }).strict()),
}).strict();
export type CadenceCapabilities = z.infer<typeof CadenceCapabilitiesSchema>;
export const CadenceMappingSchema = z.object({
  provider: z.string().min(1), model: z.string().min(1), providerModel: z.string().min(1),
  providerText: z.string().min(1), providerTextHash: FullSha256Schema, voiceSettings: z.record(z.string(), z.number()),
  /** The delivery's instruction, for a vendor that takes one beside the text (R-21). */
  instructions: z.string().optional(),
  /** `phrase` is how a record written before design turn 181 names the note; it still reads. */
  controls: z.array(z.object({ control: z.enum(["delivery", "speed", "pause", "emphasis", "breath", "phrase", "note", "sound"]),
    cueIndex: z.number().int().nonnegative().optional(), status: z.enum(["mapped", "best-effort", "unsupported"]),
    method: z.string().optional(), reason: z.string().optional() }).strict()),
}).strict();
export function normalizeSpeechText(text: string): string { return text.replace(/\s+/g, " ").trim(); }

type CadenceRow = Pick<ManifestModel, "cadence">;
const UNTAGGED_SENTENCE = "the tag is an English word and the line is not stated to be English";
const UNTAGGED = "tags need a line stated English";

/** Whether this row's tags go into this line: a paren row's are English words (SPEC-046 R-23). */
function tagsGo(cap: CadenceCapabilities | undefined, language: string | undefined): boolean {
  return cap?.tagSyntax !== "paren" || language === "en";
}

/** A word in this row's tag ink: `[sighs]`, `(sigh)`, `<sigh>`. */
export function tagFor(model: CadenceRow, word: string): string {
  const syntax = model.cadence?.tagSyntax ?? "bracket";
  return syntax === "paren" ? `(${word})` : syntax === "angle" ? `<${word}>` : `[${word}]`;
}

/** The word a row writes for a pause or a breath: its own, else its syntax's. */
export function cueTagWord(model: CadenceRow, cue: PauseCue | BreathCue): string {
  const cap = model.cadence;
  const syntax = cap?.tagSyntax ?? "bracket";
  const own = cap?.cueTags?.[cue.kind === "pause" ? cue.length : cue.action];
  if (own !== undefined) return own;
  if (syntax === "paren") return cue.kind === "pause" ? "pause" : `${cue.action}s`;
  if (syntax === "angle") return cue.kind === "pause" ? `${cue.length} pause` : cue.action === "inhale" ? "breath" : "exhales";
  return cue.kind === "pause" ? `${cue.length} pause` : cue.action === "inhale" ? "inhales deeply" : "exhales";
}

/**
 * A note as a sentence beside the delivery's: capitalised and ended, so the two read as one
 * style. Only a note that ends in a Latin letter or a digit gains a full stop; one in another
 * script (`穏やかに`) is left as its author wrote it.
 */
export function noteSentence(note: string): string {
  const trimmed = note.trim();
  const capital = trimmed.charAt(0).toLocaleUpperCase() + trimmed.slice(1);
  return /[\p{Script=Latin}\p{N}]$/u.test(capital) ? `${capital}.` : capital;
}

/**
 * How a row takes the block's note (design turn 181): whole as an instruction, as one tag when
 * it is short enough to be one, or held with the reason.
 */
export function noteMode(note: string, model: CadenceRow, language?: string): { mode: "tag"; tag: string } | { mode: "instruction" } | { mode: "unsupported"; reason: string } {
  const cap = model.cadence;
  if (cap?.phrase === "best-effort-instruction") return { mode: "instruction" };
  if (cap?.phrase === "best-effort-tag") {
    if (!tagsGo(cap, language)) return { mode: "unsupported", reason: UNTAGGED };
    if (note.length > CADENCE_PHRASE_MAX) return { mode: "unsupported", reason: `a tag takes ${CADENCE_PHRASE_MAX} characters` };
    return { mode: "tag", tag: tagFor(model, note) };
  }
  return { mode: "unsupported", reason: "no note" };
}

/** How a row makes one sound (design turn 181): its word in its tag ink, or held with the reason. */
export function soundMode(sound: Sound, model: CadenceRow, language?: string): { mode: "tag"; tag: string } | { mode: "unsupported"; reason: string } {
  const cap = model.cadence;
  if (cap?.sounds === undefined || Object.keys(cap.sounds).length === 0) return { mode: "unsupported", reason: "no sounds" };
  const word = cap.sounds[sound];
  if (word === undefined) return { mode: "unsupported", reason: `no ${sound}` };
  if (!tagsGo(cap, language)) return { mode: "unsupported", reason: UNTAGGED };
  return { mode: "tag", tag: tagFor(model, word) };
}

/**
 * UTF-16 coordinates refer to normalized authored text, never a decorated provider string.
 *
 * `language` is the line's, when anything states it — a cloned voice's recording language
 * (issue 1163). A paren row's tags are English words (SPEC-046 R-23), so they go in only when
 * the line is stated to be English: unknown is not English, and the delivery's sentence carries
 * the direction instead. Bracket and angle rows are untouched by it.
 *
 * The compiled text is what the reader is sent and what `Sent as` shows (design turn 181), so
 * the spaces a tag brings are folded: `Ade. <long pause> Not THIS time. <sigh>`.
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
      // Two different sounds may share a point (`[sighs] [laughs]`); the same one twice may not.
      const key = cue.kind === "sound" ? `sound/${at}/${cue.sound}` : `${cue.kind}/${at}`;
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
  const delivery = plan.delivery !== undefined && cap?.deliveries.includes(plan.delivery) ? cap.deliveryMappings[plan.delivery] : undefined;
  const tagged = tagsGo(cap, language);
  // A delivery carried by a tag or an instruction is best effort, like a cue: neither is a
  // parameter the vendor promises to honour. Settings alone are mapped. A delivery whose only
  // direction is a tag that cannot go in carries nothing, and says so. No delivery at all is
  // the reader's own reading, and there is nothing to report.
  const carriedByTag = delivery?.tag !== undefined && tagged;
  const directed = delivery !== undefined && (carriedByTag || delivery.instruction !== undefined);
  const untagged = delivery !== undefined && delivery.tag !== undefined && !tagged && delivery.instruction === undefined;
  const reads = cap?.deliveries.join(" · ") ?? "";
  const controls: z.infer<typeof CadenceMappingSchema>["controls"] = plan.delivery === undefined ? [] : [{ control: "delivery", status: delivery ? untagged ? "unsupported" : directed ? "best-effort" : "mapped" : "unsupported",
    ...(delivery ? untagged ? { method: "declared voice settings", reason: UNTAGGED_SENTENCE }
      : { method: delivery.instruction ? "instruction and declared settings" : carriedByTag ? "audio tag and declared settings" : "declared voice settings" }
      : { reason: reads === "" ? "This model has no declared delivery mapping." : `reads ${reads}` }) }];
  const voiceSettings = { ...delivery?.settings };
  const speedSupported = cap?.speed && plan.speed >= cap.speed.min && plan.speed <= cap.speed.max;
  controls.push({ control: "speed", status: speedSupported || plan.speed === 1 ? "mapped" : "unsupported",
    method: speedSupported ? "native speed" : "delivery preset only" });
  if (speedSupported) voiceSettings.speed = plan.speed;
  const tag = (word: string) => tagFor(model, word);
  // Insertions at a point, capitals over a span, and a replaced character (a pause written as
  // punctuation turns the stop before it into `…`), all in the authored coordinates.
  const inserts: Array<{ at: number; text: string }> = [];
  const upper: Array<{ from: number; to: number }> = [];
  const replace = new Map<number, string>();
  // The block's own lead, which an inline marker restores after its span (R-41).
  const noteHow = plan.note === undefined ? undefined : noteMode(plan.note, model, language);
  const blockLead = [
    ...(delivery?.tag && tagged ? [tag(delivery.tag)] : []),
    ...(noteHow?.mode === "tag" ? [noteHow.tag] : []),
  ].join(" ");
  plan.cues.forEach((cue, cueIndex) => {
    if (cue.kind === "delivery") {
      // A marker in place (R-41): an inline tag before its span and the block's lead after it
      // on a row that writes tags; parts split at its edges, each with its own delivery, on a
      // row that carries delivery only as settings or a sentence — the parts are the caller's
      // to make (`markerSegments`), so here the words are left alone.
      const mode = markerMode(cue, plan, model, language, text.length);
      if (mode.mode === "unsupported") {
        controls.push({ control: "delivery", cueIndex, status: "unsupported", reason: mode.reason });
        return;
      }
      controls.push({ control: "delivery", cueIndex, status: "best-effort", method: mode.mode === "inline" ? "audio tag" : "parts" });
      if (mode.mode === "inline") {
        inserts.push({ at: cue.span.from, text: ` ${markerLead(cue, model, language).join(" ")} ` });
        if (cue.span.to < text.length && blockLead !== "") inserts.push({ at: cue.span.to, text: ` ${blockLead} ` });
      }
      return;
    }
    if (cue.kind === "sound") {
      const how = soundMode(cue.sound, model, language);
      if (how.mode === "unsupported") {
        controls.push({ control: "sound", cueIndex, status: "unsupported", reason: how.reason });
        return;
      }
      controls.push({ control: "sound", cueIndex, status: "best-effort", method: "audio tag" });
      inserts.push({ at: cue.at, text: ` ${how.tag} ` });
      return;
    }
    if (cue.kind === "emphasis") {
      // Capitals in the text, in any language and any syntax.
      const supported = cap !== undefined && cap.emphasis !== "unsupported";
      controls.push({ control: "emphasis", cueIndex, status: supported ? "best-effort" : "unsupported", method: cap?.emphasis ?? "unsupported" });
      if (supported) upper.push({ from: cue.span.from, to: cue.span.to });
      return;
    }
    const declared = cap?.[cue.kind] ?? "unsupported";
    if (declared === "unsupported") {
      controls.push({ control: cue.kind, cueIndex, status: "unsupported", method: "unsupported" });
      return;
    }
    if (cue.kind === "pause" && declared === "best-effort-break") {
      // Eleven Multilingual v2's one documented direction: an SSML break, up to three seconds.
      controls.push({ control: "pause", cueIndex, status: "best-effort", method: declared });
      inserts.push({ at: cue.at, text: ` <break time="${cue.length === "long" ? "1.5s" : "0.5s"}"/> ` });
      return;
    }
    if (cue.kind === "pause" && declared === "best-effort-punctuation") {
      controls.push({ control: "pause", cueIndex, status: "best-effort", method: declared });
      punctuate(text, cue, inserts, replace);
      return;
    }
    // A pause or a breath as a tag waits, on a paren row, for a line stated English.
    if (!tagged) {
      controls.push({ control: cue.kind, cueIndex, status: "unsupported", method: declared, reason: UNTAGGED_SENTENCE });
      return;
    }
    controls.push({ control: cue.kind, cueIndex, status: "best-effort", method: declared });
    inserts.push({ at: cue.at, text: ` ${tag(cueTagWord(model, cue))} ` });
  });
  // Walk original UTF-16 coordinates: Unicode capitalization can expand without shifting cues.
  let providerText = "";
  for (let at = 0; at <= text.length; at++) {
    providerText += inserts.filter((e) => e.at === at).map((e) => e.text).join("");
    if (at === text.length) break;
    const swapped = replace.get(at);
    providerText += swapped !== undefined ? swapped : upper.some((e) => e.from <= at && e.to > at) ? text[at]!.toUpperCase() : text[at];
  }
  // The note rides the same seam as a delivery's tag or sentence (SPEC-047 R-7): a tag after
  // the delivery's on a row that renders one — when it is short enough to be one, and with the
  // same English-only wait on a paren row — the instruction after the delivery's on a row that
  // takes one, and held where the row declares neither, so it is never rendered into words a
  // reader would speak. The lead is the delivery's tag then the note's, so the modifier follows
  // what it qualifies.
  const lead: string[] = [];
  if (delivery?.tag && tagged) lead.push(tag(delivery.tag));
  let instructions = delivery?.instruction;
  if (plan.note !== undefined && noteHow !== undefined) {
    if (noteHow.mode === "tag") {
      lead.push(noteHow.tag);
      controls.push({ control: "note", status: "best-effort", method: "audio tag" });
    } else if (noteHow.mode === "instruction") {
      const sentence = noteSentence(plan.note);
      instructions = instructions === undefined ? sentence : `${instructions} ${sentence}`;
      controls.push({ control: "note", status: "best-effort", method: "instruction" });
    } else {
      controls.push({ control: "note", status: "unsupported", reason: noteHow.reason });
    }
  }
  if (lead.length > 0) providerText = `${lead.join(" ")} ${providerText}`;
  providerText = providerText.replace(/ {2,}/g, " ").trim();
  return { provider: model.provider, model: model.id, providerModel: model.providerModelId ?? model.id,
    providerText, voiceSettings, ...(instructions !== undefined ? { instructions } : {}), controls };
}

/**
 * A pause as punctuation, for a reader that takes no direction (Voxtral, Kokoro): a short pause
 * is a comma where the words have no stop, a long one an ellipsis — the stop before it turned
 * into one (`Ade… Not this time.`), or one added. A stop that is already there carries a short
 * pause by itself.
 */
function punctuate(text: string, cue: PauseCue, inserts: Array<{ at: number; text: string }>, replace: Map<number, string>): void {
  let before = cue.at - 1;
  while (before >= 0 && /\s/.test(text[before]!)) before--;
  if (before < 0) return;
  const stop = text[before]!;
  if (cue.length === "long") {
    if (/[.,;:]/.test(stop)) replace.set(before, "…");
    else if (stop !== "…") inserts.push({ at: before + 1, text: "…" });
    return;
  }
  if (!/[.,;:!?…—–-]/.test(stop)) inserts.push({ at: before + 1, text: "," });
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
export function markerMode(marker: DeliveryMarker, plan: Pick<CadencePlan, "delivery" | "note">, model: Pick<ManifestModel, "cadence">, language: string | undefined, textLength: number): MarkerMode {
  const cap = model.cadence;
  const tagged = tagsGo(cap, language);
  const mapping = marker.delivery !== undefined && cap?.deliveries.includes(marker.delivery) ? cap.deliveryMappings[marker.delivery] : undefined;
  if (marker.delivery !== undefined) {
    if (mapping === undefined) {
      const reads = cap?.deliveries.join(" · ") ?? "";
      return { mode: "unsupported", reason: reads === "" ? "no delivery" : `reads ${reads}` };
    }
    if (mapping.tag !== undefined && !tagged && mapping.instruction === undefined) return { mode: "unsupported", reason: UNTAGGED };
  }
  const phraseTag = cap?.phrase === "best-effort-tag" && tagged;
  if (marker.phrase !== undefined && !phraseTag && cap?.phrase !== "best-effort-instruction") {
    return { mode: "unsupported", reason: cap?.phrase === "best-effort-tag" ? UNTAGGED : "no phrase" };
  }
  const deliveryInline = mapping === undefined || (mapping.tag !== undefined && tagged && mapping.instruction === undefined);
  const phraseInline = marker.phrase === undefined || phraseTag;
  const block = plan.delivery !== undefined && cap?.deliveries.includes(plan.delivery) ? cap.deliveryMappings[plan.delivery] : undefined;
  const noteTag = plan.note !== undefined && noteMode(plan.note, model, language).mode === "tag";
  const restores = (block?.tag !== undefined && tagged) || noteTag;
  return deliveryInline && phraseInline && (restores || marker.span.to >= textLength) ? { mode: "inline" } : { mode: "parts" };
}

/** The tags an inline marker writes before its span: its delivery's, then its phrase. */
function markerLead(marker: DeliveryMarker, model: Pick<ManifestModel, "cadence">, language: string | undefined): string[] {
  const cap = model.cadence;
  const tagged = tagsGo(cap, language);
  const mapping = marker.delivery !== undefined ? cap?.deliveryMappings[marker.delivery] : undefined;
  return [...(mapping?.tag !== undefined && tagged ? [tagFor(model, mapping.tag)] : []), ...(marker.phrase !== undefined && tagged ? [tagFor(model, marker.phrase)] : [])];
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
    const { note: _blockNote, delivery: _blockDelivery, ...bare } = plan;
    const delivery = marker === undefined ? plan.delivery : (marker.delivery ?? plan.delivery);
    const segmentPlan: CadencePlan =
      marker === undefined
        ? { ...plan, cues }
        : {
            ...bare,
            cues,
            ...(delivery !== undefined ? { delivery } : {}),
            // A marker's phrase stands over its span; a marker that names a delivery alone reads
            // it plain, rather than under a block note written for another delivery.
            ...(marker.phrase !== undefined ? { note: marker.phrase } : marker.delivery === undefined && plan.note !== undefined ? { note: plan.note } : {}),
          };
    out.push({ text: piece, from, plan: segmentPlan });
  }
  return out;
}

/**
 * How a row plays a speaker's performance note (SPEC-047 R-45): the line's leading phrase, by
 * R-7's path — a tag ahead of the rendered words on a row that takes the phrase as a tag, an
 * instruction ahead of the rest on a row that takes one — or not at all, with the reason: a
 * narrator whose row takes no phrase cannot perform.
 */
export function performanceNote(note: string, model: Pick<ManifestModel, "cadence">, language?: string): { mode: "tag"; tag: string } | { mode: "instruction" } | { mode: "unsupported"; reason: string } {
  const cap = model.cadence;
  const tagged = tagsGo(cap, language);
  if (cap?.phrase === "best-effort-tag" && tagged) return { mode: "tag", tag: tagFor(model, note) };
  if (cap?.phrase === "best-effort-instruction") return { mode: "instruction" };
  return { mode: "unsupported", reason: cap?.phrase === "best-effort-tag" ? UNTAGGED : "no phrase" };
}

export interface HeldControl {
  control: "delivery" | "speed" | "note" | "pause" | "breath" | "emphasis" | "marker" | "sound";
  cueIndex?: number;
  reason: string;
}

/**
 * Direction the reader cannot express, held rather than dropped (SPEC-047 R-47): what `mapCadence`
 * reports unsupported is left out of the plan that is sent — the note, a cue, a marker, a sound,
 * a speed off the row's range — and named, so the view can strike it and count it while the
 * record keeps it for a reader that can. A delivery the row lacks is held too, but stays in the
 * plan: an unmapped delivery renders nothing. Throws as `mapCadence` does on a plan that is wrong
 * for its words, which is an authoring fault, not a reader's limit.
 */
export function holdDirection(text: string, plan: CadencePlan, model: Pick<ManifestModel, "id" | "provider" | "providerModelId" | "cadence">, language?: string): { plan: CadencePlan; held: HeldControl[] } {
  const mapped = mapCadence(text, plan.sourceTextHash, plan, model, language);
  const held: HeldControl[] = [];
  const dropCue = new Set<number>();
  let speed = plan.speed;
  let note = plan.note;
  for (const control of mapped.controls) {
    if (control.status !== "unsupported") continue;
    const reason = control.reason ?? `no ${control.control}`;
    if (control.cueIndex !== undefined) {
      dropCue.add(control.cueIndex);
      held.push({ control: control.control === "delivery" ? "marker" : control.control === "phrase" ? "note" : control.control, cueIndex: control.cueIndex, reason });
    } else if (control.control === "speed") {
      speed = 1;
      held.push({ control: "speed", reason: "no speed" });
    } else if (control.control === "note" || control.control === "phrase") {
      note = undefined;
      held.push({ control: "note", reason });
    } else if (control.control === "delivery") {
      held.push({ control: "delivery", reason });
    }
  }
  if (held.length === 0) return { plan, held };
  const { note: _was, ...rest } = plan;
  return { plan: { ...rest, speed, cues: plan.cues.filter((_, index) => !dropCue.has(index)), ...(note !== undefined ? { note } : {}) }, held };
}

/**
 * What a reader gets for one request's words (design turn 181's `Sent as`): the style beside
 * the text, the text with this reader's syntax in, the numbers, and what is held with the
 * reason. A marker the row makes in parts is a request of its own on the audiobook (R-41); it
 * is named in `parts` (by its index in the plan) so a one-request surface can hold it. Throws
 * as `mapCadence` does on a plan that is wrong for its words.
 */
export function sentAs(text: string, plan: CadencePlan, model: Pick<ManifestModel, "id" | "provider" | "providerModelId" | "cadence">, language?: string): {
  text: string; style?: string; voiceSettings: Record<string, number>; held: HeldControl[]; parts: number[];
} {
  const { plan: sent, held } = holdDirection(text, plan, model, language);
  const whole = normalizeSpeechText(text);
  const parts: number[] = [];
  for (const cue of sent.cues) {
    if (cue.kind === "delivery" && markerMode(cue, sent, model, language, whole.length).mode === "parts") parts.push(plan.cues.indexOf(cue));
  }
  const mapped = mapCadence(text, sent.sourceTextHash, sent, model, language);
  return { text: mapped.providerText, ...(mapped.instructions !== undefined ? { style: mapped.instructions } : {}), voiceSettings: mapped.voiceSettings, held, parts };
}

export interface CadenceControlSupport { status: "mapped" | "best-effort" | "unsupported"; method?: string; reason?: string }

/**
 * What a reader does with each control before any plan is written (SPEC-047 R-9): the block
 * panel says it on the control, one clause, and a derivation drops what a reader declares
 * `unsupported` rather than accepting a direction the read could only flag (R-10). Read off the
 * row and the line's language, so it agrees with `mapCadence` on every plan that reaches it: a
 * paren row's tags are English words that go in only when the line is stated English (SPEC-046
 * R-23), so on such a row a tag-carried delivery, a pause, a breath, a sound and a tagged phrase
 * are `unsupported` for a line not stated English — a preset's, a French clone's — rather than
 * offered and then refused (codex on PR 1186). `phrase` is a marker's phrase (≤ 60); `note` the
 * block's (≤ 300), which a tag row takes as a tag only when it fits one.
 */
export function cadenceSupport(model: Pick<ManifestModel, "cadence">, language?: string): {
  deliveries: Record<string, CadenceControlSupport>; speed: CadenceControlSupport;
  pause: CadenceControlSupport; breath: CadenceControlSupport; emphasis: CadenceControlSupport; phrase: CadenceControlSupport;
  note: CadenceControlSupport; sounds: Record<Sound, CadenceControlSupport>;
} {
  const cap = model.cadence;
  const tagged = tagsGo(cap, language);
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
      : declared === "best-effort-break" ? { status: "best-effort", method: "break" }
      : declared === "best-effort-punctuation" ? { status: "best-effort", method: "punctuation" }
      : tagged ? { status: "best-effort", method: "tag" } : { status: "unsupported", reason: UNTAGGED };
  const sounds = {} as Record<Sound, CadenceControlSupport>;
  for (const sound of SOUNDS) {
    const how = soundMode(sound, model, language);
    sounds[sound] = how.mode === "tag" ? { status: "best-effort", method: "tag" } : { status: "unsupported", reason: how.reason };
  }
  return {
    deliveries,
    speed: cap?.speed ? { status: "mapped", method: `${cap.speed.min}–${cap.speed.max}` } : { status: "unsupported", reason: "no speed" },
    pause: cue(cap?.pause, "pause"), breath: cue(cap?.breath, "breath"), emphasis: cue(cap?.emphasis, "emphasis"),
    phrase: cap?.phrase === "best-effort-tag" ? (tagged ? { status: "best-effort", method: "tag" } : { status: "unsupported", reason: UNTAGGED })
      : cap?.phrase === "best-effort-instruction" ? { status: "best-effort", method: "instruction" } : { status: "unsupported", reason: "no phrase" },
    note: cap?.phrase === "best-effort-tag" ? (tagged ? { status: "best-effort", method: `tag · ${CADENCE_PHRASE_MAX}` } : { status: "unsupported", reason: UNTAGGED })
      : cap?.phrase === "best-effort-instruction" ? { status: "best-effort", method: "instruction" } : { status: "unsupported", reason: "no note" },
    sounds,
  };
}

/** Text offsets are reusable only for the same normalized authored wording. */
export function seedCadencePlan(source: CadencePlan | undefined, delivery: CadencePlan["delivery"], sourceTextHash: string): CadencePlan {
  return { schemaVersion: 1, sourceTextHash, ...(delivery !== undefined ? { delivery } : {}), speed: source?.speed ?? 1,
    cues: source?.sourceTextHash === sourceTextHash ? structuredClone(source.cues) : [] };
}
