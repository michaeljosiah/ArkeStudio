import {
  audiobookDirectionHash,
  NOTE_TAG_HOLD,
  holdDirection,
  sentAs,
  mapCadence,
  markerSegments,
  normalizeSpeechText,
  speechInputFits,
  splitSpeechInput,
  type AudiobookDirectionInput,
  type CadencePlan,
  type HeldControl,
  type ManifestModel,
} from "@arke-studio/contracts";
import { audioHash } from "../audio/qc.js";
import { splitForSpeech } from "./split.js";

/**
 * One voice direction for every speech surface (design turn 181, SPEC-049 R-28): the plan made
 * from what a surface sends, checked against its words and its reader, and compiled into what
 * the reader is sent — in parts within the reader's cap for the audiobook, as one request for
 * the Bench and a shot's voice line. The audiobook's run, its block panel and its derivation
 * read it here; nothing else compiles a direction.
 */

/** The digest `mapCadence` verifies a plan against: the block's words, whitespace folded. */
export function directionSourceHash(text: string): string {
  return audioHash(Buffer.from(normalizeSpeechText(text)));
}

/** A plan from what a window or a derivation sends (R-6): the hashes are the block's, never the sender's. */
export function directionPlan(text: string, input: AudiobookDirectionInput): CadencePlan {
  return { schemaVersion: 1, sourceTextHash: directionSourceHash(text), ...(input.delivery !== undefined ? { delivery: input.delivery } : {}), speed: input.speed, cues: input.cues, ...(input.note !== undefined ? { note: input.note } : {}) };
}

/** One request's worth of a directed block: the words as sent, and the settings and sentence beside them. */
export interface RenderedPart {
  text: string;
  voiceSettings: Record<string, number>;
  instructions?: string;
}

export type DirectionCheck =
  | { ok: true; mapped: ReturnType<typeof mapCadence>; parts: RenderedPart[]; held: HeldControl[] }
  | { ok: false; reason: string };

/**
 * A directed block in parts, each rendered on its own (R-5; codex on PR 1186): the words are
 * split at sentence ends within the reader's cap, each piece carries the cues that fall in it
 * at their positions in the piece, and each is mapped whole, so the delivery's tag and the
 * phrase's lead every part rather than the first alone. A piece whose rendering still runs
 * over the cap — the tags are extra ink — is split again at half its size until it fits, so the
 * bound holds after rendering for any authored text. An emphasis whose span a seam would cut
 * cannot be carried by either piece: the direction is refused in one clause rather than sent
 * with the emphasis silently gone and its name on the take. One part for a block within the cap.
 *
 * Before the cap, a block is cut at the edges of every marker its row makes in parts (R-41):
 * a settings-only or sentence-carried delivery cannot change inside one request, so the
 * marker's words are a request of their own, with its delivery's settings and sentence, and
 * the block's reading resumes in the next.
 */
export function renderParts(text: string, plan: CadencePlan, model: ManifestModel, language: string | undefined, cap: number | undefined): RenderedPart[] {
  const out: RenderedPart[] = [];
  for (const segment of markerSegments(text, plan, model, language)) out.push(...renderSegment(segment.text, segment.plan, model, language, cap));
  return out;
}

function renderSegment(whole: string, plan: CadencePlan, model: ManifestModel, language: string | undefined, cap: number | undefined): RenderedPart[] {
  const render = (piece: string, cues: CadencePlan["cues"]): RenderedPart => {
    const mapped = mapCadence(piece, directionSourceHash(piece), { ...plan, sourceTextHash: directionSourceHash(piece), cues }, model, language);
    return { text: mapped.providerText, voiceSettings: mapped.voiceSettings, ...(mapped.instructions !== undefined ? { instructions: mapped.instructions } : {}) };
  };
  const limits = { ...model.limits, maxPromptChars: cap };
  if (cap === undefined && limits.maxSpeechUtf8Bytes === undefined) return [render(whole, plan.cues)];
  const out: RenderedPart[] = [];
  const placed = new Set<CadencePlan["cues"][number]>();
  const place = (piece: string, from: number, max: number): void => {
    const to = from + piece.length;
    for (const cue of plan.cues) {
      if ((cue.kind === "emphasis" || cue.kind === "delivery") && ((cue.span.from < from && cue.span.to > from) || (cue.span.from < to && cue.span.to > to))) {
        throw new Error(`${cue.kind === "emphasis" ? "emphasis" : "marker"} “${cue.span.text}” straddles the cap's split · shorten the span`);
      }
    }
    const cues = plan.cues
      .filter((cue) => !placed.has(cue) && (cue.kind === "emphasis" || cue.kind === "delivery" ? cue.span.from >= from && cue.span.to <= to : cue.at >= from && cue.at <= to))
      .map((cue) => (cue.kind === "emphasis" || cue.kind === "delivery" ? { ...cue, span: { ...cue.span, from: cue.span.from - from, to: cue.span.to - from } } : { ...cue, at: cue.at - from }));
    const rendered = render(piece, cues);
    if (speechInputFits(rendered.text, limits, rendered.instructions)) {
      out.push(rendered);
      for (const cue of plan.cues) {
        if (cue.kind !== "emphasis" && cue.kind !== "delivery" && cue.at >= from && cue.at <= to) placed.add(cue);
      }
      return;
    }
    if (piece.length <= 1 || max <= 1) throw new Error("The speech direction and words cannot fit this reader's request limit.");
    if (limits.maxSpeechUtf8Bytes !== undefined) {
      let smaller = splitSpeechInput(piece, limits, rendered.instructions);
      // Inline tags can make the rendered text larger than the source. If source packing
      // alone made no progress, reduce it before rendering its cues again.
      if (smaller.length === 1 && smaller[0]!.text === piece) smaller = splitSpeechInput(piece, { ...limits, maxPromptChars: Math.max(1, Math.floor(piece.length / 2)) }, rendered.instructions);
      for (const part of smaller) {
        place(part.text, from + part.from, part.text.length);
      }
      return;
    }
    let offset = 0;
    for (const smaller of splitForSpeech(piece, Math.max(1, Math.floor(max / 2)))) {
      const at = piece.indexOf(smaller, offset);
      place(smaller, from + Math.max(at, 0), Math.floor(max / 2));
      offset = Math.max(at, 0) + smaller.length;
    }
  };
  const pieces = limits.maxSpeechUtf8Bytes === undefined && cap !== undefined && whole.length > cap ? splitForSpeech(whole, cap) : [whole];
  let offset = 0;
  for (const piece of pieces) {
    const at = whole.indexOf(piece, offset);
    place(piece, Math.max(at, 0), cap ?? piece.length);
    offset = Math.max(at, 0) + piece.length;
  }
  return out;
}

/**
 * A direction held to its block and its reader (R-9): every cue is checked by `mapCadence`
 * against the words it names, and the parts the reader's cap makes of the block are rendered
 * here too, so a cue no part can carry is refused where the direction is written.
 *
 * `strict` is the author's write (R-42): a control the reader cannot express is refused in one
 * clause, never accepted to be flagged later — except one the stored direction already holds,
 * which a write of another control carries on unchanged. `hold` is everything after (R-47): a
 * reader change, a run, an accepted card — what the reader cannot express is left out of what
 * is sent and named in `held`, and the direction stands for a reader that can.
 */
export function checkDirection(text: string, plan: CadencePlan, model: ManifestModel, language?: string, mode: "strict" | "hold" = "strict", alreadyHeld: readonly string[] = []): DirectionCheck {
  let sent: CadencePlan;
  let held: HeldControl[];
  let mapped: ReturnType<typeof mapCadence>;
  try {
    mapped = mapCadence(text, directionSourceHash(text), plan, model, language);
    ({ plan: sent, held } = holdDirection(text, plan, model, language));
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (mode === "strict") {
    // The note is written to 300 on every reader (design turn 181): a tag reader takes it as one
    // tag to sixty and holds a longer one, so that hold is the author's to see under Sent as,
    // not a refusal.
    const fresh = held.find((control) => !alreadyHeld.includes(heldKey(plan, control)) && !(control.control === "note" && control.reason === NOTE_TAG_HOLD));
    if (fresh !== undefined) {
      const name = fresh.control === "delivery" ? plan.delivery : fresh.control === "marker" ? markerName(plan, fresh.cueIndex) : fresh.control;
      return { ok: false, reason: `${name} · ${model.displayName} ${fresh.reason}`.replace(/\.$/, "") };
    }
  }
  let parts: RenderedPart[];
  try {
    parts = renderParts(text, sent, model, language, model.limits.maxPromptChars);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, mapped, parts, held };
}

function markerName(plan: CadencePlan, cueIndex: number | undefined): string {
  const cue = cueIndex === undefined ? undefined : plan.cues[cueIndex];
  return cue?.kind === "delivery" ? `[${cue.delivery ?? cue.phrase}]` : "marker";
}

/**
 * A held control named by what it is rather than where it sits, so the same control held
 * before and after a write matches although other cues moved around it.
 */
export function heldKey(plan: CadencePlan, control: HeldControl): string {
  if (control.cueIndex !== undefined) return `cue:${JSON.stringify(plan.cues[control.cueIndex])}`;
  if (control.control === "delivery") return `delivery:${plan.delivery}`;
  // The note keeps the phrase's key, so a note held before the rename matches after it.
  if (control.control === "note") return `phrase:${plan.note ?? ""}`;
  if (control.control === "speed") return `speed:${plan.speed}`;
  return control.control;
}

/** Why a line could not be compiled: no words, held direction (strict), words that cannot fit, or a plan wrong for its words. */
export type CompileFailure = "empty" | "held" | "limit" | "invalid";

/** One request's worth of a directed line, as a one-request surface sends it. */
export interface CompiledLine {
  /** The words with this reader's syntax in, as sent. */
  text: string;
  voiceSettings: Record<string, number>;
  /** The style beside the words, for a reader that takes one. */
  instructions?: string;
  /** The authored direction's name (`audiobookDirectionHash`): marks the job compiled, and names the take's direction. */
  directionHash: string;
  /** The plan as authored, kept whole for the take; what was sent is `text` and its neighbours. */
  plan: CadencePlan;
  /** What the reader could not take, named, never sent. */
  held: HeldControl[];
}

/**
 * A line directed for one request (design turn 181): the Bench's read and a shot's voice line
 * are one request each, so a marker its reader can only make in parts (R-41) is held there, by
 * name, as a control the reader cannot take is — the audiobook joins parts on this machine and
 * a one-request surface does not. `strict` refuses what would be held, in one clause, as the
 * audiobook's author write does (R-42); `hold` sends the rest and names it (R-47). Words and
 * direction that will not fit one request are refused rather than cut.
 */
export function compileLine(
  text: string,
  input: AudiobookDirectionInput,
  model: ManifestModel,
  language: string | undefined,
  mode: "strict" | "hold",
): { ok: true; line: CompiledLine } | { ok: false; kind: CompileFailure; reason: string } {
  if (normalizeSpeechText(text) === "") return { ok: false, kind: "empty", reason: "There are no words to read yet." };
  const plan = directionPlan(text, input);
  // One request is mapped whole, never cut at the reader's cap as the audiobook's parts are, so
  // a line too long for one request is refused as that, not as an emphasis across a seam.
  let compiled: ReturnType<typeof sentAs>;
  try {
    compiled = sentAs(text, plan, model, language, { oneRequest: true });
  } catch (err) {
    return { ok: false, kind: "invalid", reason: err instanceof Error ? err.message : String(err) };
  }
  const held = compiled.held;
  if (mode === "strict" && held.length > 0) {
    const first = held[0]!;
    const name = first.control === "delivery" ? (plan.delivery ?? "delivery") : first.control === "marker" ? markerName(plan, first.cueIndex) : first.control;
    return { ok: false, kind: "held", reason: `${name} · ${model.displayName} ${first.reason}`.replace(/\.$/, "") };
  }
  if (!speechInputFits(compiled.text, model.limits, compiled.style)) {
    return { ok: false, kind: "limit", reason: "The line and its direction exceed this model's request limit. Shorten it or use an audiobook read in parts." };
  }
  return {
    ok: true,
    line: {
      text: compiled.text,
      voiceSettings: compiled.voiceSettings,
      ...(compiled.style !== undefined ? { instructions: compiled.style } : {}),
      directionHash: audiobookDirectionHash(plan),
      plan,
      held,
    },
  };
}
