import { z } from "zod";
import { ArtifactIdSchema, IsoDateTimeSchema, SlugSchema, UlidSchema, ulid } from "./ids.js";
import { AudiobookReaderSchema } from "./audiobook.js";
import { PERFORMANCE_NOTE_MAX } from "./cadence.js";
import { textDigest } from "./subtitles.js";

/**
 * The audio drama (SPEC-057, design turn 230): a Story production of its own kind, adapted for the
 * ear. Its episodes are scripts, not video seasons, so nothing here touches `season.json`, Series
 * or scene records; what setup decides lives in `productions/<id>/audio-drama.json`.
 */
export const AUDIO_DRAMA_KIND = "audio-drama";

/**
 * Whether a narrator guides the listener (SPEC-057 R-6, D-3) — the one question setup asks. It is
 * the default for each new scene's Heard as; `a-recording` is only ever set per scene.
 */
export const AudioDramaNarratorSchema = z.enum(["narrated", "in-the-room"]);
export type AudioDramaNarrator = z.infer<typeof AudioDramaNarratorSchema>;

/** A fact the drama must not give away before an episode (SPEC-057 R-8). */
export const KeptFromListenerSchema = z.object({
  fact: z.string().trim().min(1).max(240),
  revealEpisode: z.number().int().min(1).max(200),
}).strict();
export type KeptFromListener = z.infer<typeof KeptFromListenerSchema>;

/** The scene written first, before every episode is planned (SPEC-057 R-9, D-4). */
export const AudioDramaPilotSchema = z.object({
  title: z.string().trim().min(1).max(160),
  /** The source chapters, by number, the pilot is adapted from. */
  // Each chapter once: a repeat would have later pilot work read the same chapter twice.
  chapters: z.array(z.number().int().min(1).max(2000)).max(20)
    .refine(chapters => new Set(chapters).size === chapters.length, { message: "A pilot names each chapter once." }).default([]),
}).strict();
export type AudioDramaPilot = z.infer<typeof AudioDramaPilotSchema>;

/**
 * Setup's one plan (SPEC-057 R-7): proposed by Arke after reading the source and accepted or
 * changed whole. Episodes and minutes are targets, never limits (D-2).
 */
export const AudioDramaPlanSchema = z.object({
  episodes: z.number().int().min(1).max(200),
  minutes: z.number().int().min(1).max(180),
  narrator: AudioDramaNarratorSchema.optional(),
  keptFromListener: z.array(KeptFromListenerSchema).max(50).default([]),
  pilot: AudioDramaPilotSchema.optional(),
}).strict().superRefine((plan, ctx) => {
  // A fact withheld until an episode the plan does not have is never revealed (codex on PR 1866),
  // so lowering the count past a reveal is refused rather than silently dropping the secret.
  plan.keptFromListener.forEach((kept, index) => {
    if (kept.revealEpisode > plan.episodes) ctx.addIssue({
      code: "custom", path: ["keptFromListener", index, "revealEpisode"],
      message: `“${kept.fact}” is revealed in episode ${kept.revealEpisode}, but the plan has ${plan.episodes}. Reveal it in one of them, or plan more episodes.`,
    });
  });
});
export type AudioDramaPlan = z.infer<typeof AudioDramaPlanSchema>;

/** Where the plan starts before Arke has read anything, or with nothing to read (D-2). */
export const DEFAULT_AUDIO_DRAMA_PLAN: AudioDramaPlan = { episodes: 6, minutes: 25, keptFromListener: [] };

/**
 * A speaking role as this production plays it (SPEC-057 R-55..R-60, R-85), kept in the production
 * and never on the character's sheet. `sound` is the actor's note and `narration` the narrator's
 * when quoting them; neither ever reaches the other's request (R-58). A voice here is this
 * production's, over the character's, and the only one a speaker with no sheet can have.
 */
export const DramaRoleSchema = z.object({
  voice: AudiobookReaderSchema.optional(),
  sound: z.string().trim().min(1).max(PERFORMANCE_NOTE_MAX).optional(),
  narration: z.string().trim().min(1).max(PERFORMANCE_NOTE_MAX).optional(),
  /** Who the listener is told this is until `revealEpisode` (R-59). */
  publicLabel: z.string().trim().min(1).max(80).optional(),
  revealEpisode: z.number().int().min(2).max(200).optional(),
}).strict().refine((role) => (role.publicLabel === undefined) === (role.revealEpisode === undefined),
  { message: "A hidden identity needs a public label and the episode that reveals it." });
export type DramaRole = z.infer<typeof DramaRoleSchema>;

/**
 * What became of a source chapter (SPEC-057 R-61, SPEC-052 R-19): the stored values are SPEC-052's;
 * an audio drama says Hear for `show` (R-27). A chapter with no verdict and scenes is kept; with
 * neither, it is not yet planned.
 */
export const DramaVerdictSchema = z.enum(["keep", "show", "merge", "cut", "expand", "invent"]);
export type DramaVerdict = z.infer<typeof DramaVerdictSchema>;
export const DRAMA_VERDICT_LABEL: Record<DramaVerdict, string> = {
  keep: "Keep", show: "Hear", merge: "Merge", cut: "Cut", expand: "Expand", invent: "Invent",
};
export const DramaChapterDecisionSchema = z.object({
  verdict: DramaVerdictSchema,
  /** Why, in a line (SPEC-052 R-19). */
  reason: z.string().trim().min(1).max(300).optional(),
  /** What the drama leaves out of it (230m). */
  leavesOut: z.string().trim().min(1).max(300).optional(),
}).strict();
export type DramaChapterDecision = z.infer<typeof DramaChapterDecisionSchema>;

/** A review note the author kept as written, or set aside (R-53): closed until its lines change. */
export const DramaReviewDecisionSchema = z.enum(["intentional", "dismissed"]);
export type DramaReviewDecision = z.infer<typeof DramaReviewDecisionSchema>;

/** `productions/<id>/audio-drama.json`: the plan, and the story it adapts when it adapts one. */
export const AudioDramaRecordSchema = z.object({
  version: z.literal(1),
  plan: AudioDramaPlanSchema,
  source: z.object({ productionId: SlugSchema }).strict().optional(),
  /** By speaker: a sheet id, a name no sheet carries, or the narrator (`@narrator`). */
  cast: z.record(z.string().min(1).max(80), DramaRoleSchema).optional(),
  /** By note key (`reviewDramaScript`). */
  review: z.record(z.string().min(1).max(200), DramaReviewDecisionSchema).optional(),
  /** By source chapter id: what became of it (R-61). */
  verdicts: z.record(z.string().min(1).max(200), DramaChapterDecisionSchema).optional(),
}).strict().superRefine((record, ctx) => {
  for (const [key, role] of Object.entries(record.cast ?? {})) {
    if (!DramaRoleKeySchema.safeParse(key).success) ctx.addIssue({ code: "custom", path: ["cast", key], message: `“${key}” is not a role.` });
    // A reveal the plan never reaches keeps the name hidden for good (codex on PR 1873).
    if (role.revealEpisode !== undefined && role.revealEpisode > record.plan.episodes) ctx.addIssue({
      code: "custom", path: ["cast", key, "revealEpisode"],
      message: `${role.publicLabel ?? key} is revealed in episode ${role.revealEpisode}, but the plan has ${record.plan.episodes}.`,
    });
  }
});
export type AudioDramaRecord = z.infer<typeof AudioDramaRecordSchema>;

// ---------------------------------------------------------------------------
// The episode script (SPEC-057 R-11..R-24, design turn 230d–f): one versioned document per
// episode, `productions/<id>/scripts/episode-<NN>.json`. Scenes are headings inside it, so a bed or
// a sting can run across a scene change without a second document to cross.
// ---------------------------------------------------------------------------

/** How a scene reaches the listener (D-3): set per scene; the plan's narrator is the default. */
export const HeardAsSchema = z.enum(["narrated", "in-the-room", "recording"]);
export type HeardAs = z.infer<typeof HeardAsSchema>;

/** Where a voice is heard from, under the speaker's name (230e): never a line of its words. */
export const ScriptChannelSchema = z.enum(["off-mic", "radio", "recording"]);
export type ScriptChannel = z.infer<typeof ScriptChannelSchema>;

const Words = z.string().max(4_000);
const Direction = z.string().trim().max(240).optional();
/** Source paragraphs, by their number in the pinned chapter version (1-based), never by text. */
const Paragraphs = z.array(z.number().int().min(1).max(100_000)).max(200).optional();

/** A scene's heading: what it adapts is pinned to one version of one chapter (R-20, R-84). */
export const ScriptHeadingSchema = z.object({
  id: UlidSchema, kind: z.literal("heading"),
  place: z.string().trim().min(1).max(160),
  time: z.string().trim().max(80).optional(),
  heardAs: HeardAsSchema.optional(),
  source: z.object({
    story: SlugSchema,
    chapter: z.string().min(1).max(200),
    version: z.number().int().min(1),
    /**
     * The chapter file's hash when pinned (codex on PR 1870): a direct chapter save keeps its
     * version, so the version alone cannot say the prose moved under the pin; the hash can.
     */
    hash: z.string().min(1).max(200).optional(),
    paragraphs: Paragraphs,
    /** Why the scene stays as it is against this version, when the author kept it (R-65, D-11). */
    keptReason: z.string().trim().min(1).max(300).optional(),
  }).strict().optional(),
  estimateSec: z.number().int().min(0).max(36_000).optional(),
}).strict();

/**
 * A line someone says. `direction` is how, never what: it sits above the words and is never part of
 * them (R-13). `cut` marks a line broken off by the next one, which must say `overlapsPrevious`: an
 * interruption is a stored relation, not a dash in the text (R-18).
 */
export const ScriptDialogueSchema = z.object({
  id: UlidSchema, kind: z.literal("dialogue"),
  speaker: SlugSchema,
  words: Words,
  direction: Direction,
  channel: ScriptChannelSchema.optional(),
  cut: z.boolean().optional(),
  overlapsPrevious: z.boolean().optional(),
  paragraphs: Paragraphs,
}).strict();

export const ScriptNarrationSchema = z.object({
  id: UlidSchema, kind: z.literal("narration"),
  words: Words,
  direction: Direction,
  paragraphs: Paragraphs,
}).strict();

/**
 * A sound, an ambience or music (R-38). `heard` is what the listener hears, in the script's words;
 * the artifact is the sound placed for it, once one exists. A bed (ambience, music) runs from its
 * row down to `until` — the block it stops before — or to the end of its scene.
 */
export const ScriptCueSchema = z.object({
  id: UlidSchema, kind: z.enum(["sound", "ambience", "music"]),
  heard: z.string().trim().min(1).max(600),
  purpose: z.string().trim().max(240).optional(),
  required: z.boolean().optional(),
  soundArtifact: z.string().min(1).max(200).optional(),
  until: UlidSchema.optional(),
  paragraphs: Paragraphs,
}).strict();

/** A measured gap: silence is authored, with its length (R-16). */
export const ScriptSilenceSchema = z.object({
  id: UlidSchema, kind: z.literal("silence"),
  seconds: z.number().min(0.1).max(120),
  note: z.string().trim().max(240).optional(),
}).strict();

/** A production note: read by the author, never performed. */
export const ScriptNoteSchema = z.object({
  id: UlidSchema, kind: z.literal("note"),
  text: z.string().trim().min(1).max(2_000),
}).strict();

export const EpisodeScriptBlockSchema = z.discriminatedUnion("kind", [
  ScriptHeadingSchema, ScriptDialogueSchema, ScriptNarrationSchema, ScriptCueSchema, ScriptSilenceSchema, ScriptNoteSchema,
]);
export type EpisodeScriptBlock = z.infer<typeof EpisodeScriptBlockSchema>;

/**
 * A block as Arke writes it (SPEC-057 R-9, R-54): an unchanged block keeps its id; a new one has
 * none, or a short key of Arke's own (`new-1`) so a bed's `until` can name it. Staging gives each
 * new block a ULID; nothing Arke writes reaches the script until the author keeps it.
 */
const DraftId = z.string().trim().min(1).max(40);
export const DraftScriptBlockSchema = z.discriminatedUnion("kind", [
  ScriptHeadingSchema.extend({ id: DraftId.optional() }),
  ScriptDialogueSchema.extend({ id: DraftId.optional() }),
  ScriptNarrationSchema.extend({ id: DraftId.optional() }),
  ScriptCueSchema.extend({ id: DraftId.optional(), until: DraftId.optional() }),
  ScriptSilenceSchema.extend({ id: DraftId.optional() }),
  ScriptNoteSchema.extend({ id: DraftId.optional() }),
]);
export type DraftScriptBlock = z.infer<typeof DraftScriptBlockSchema>;

/**
 * Arke's blocks as the script's: an id the current script holds is kept, once; any other id, or
 * none, becomes a new ULID; and a bed's `until` follows the block it named.
 */
export function settleDraftBlocks(draft: readonly DraftScriptBlock[], current: readonly EpisodeScriptBlock[]): EpisodeScriptBlock[] {
  // A key used twice could bind a bed's `until` to either block (codex on PR 1874): refused.
  const keys = draft.flatMap((block) => block.id === undefined ? [] : [block.id]);
  const twice = keys.find((key, i) => keys.indexOf(key) !== i);
  if (twice !== undefined) throw new Error(`The draft names block ${twice} twice. Give each block its own id or key.`);
  const known = new Set(current.map((block) => block.id));
  const used = new Set<string>();
  const renamed = new Map<string, string>();
  const settled = draft.map((block) => {
    const keep = block.id !== undefined && known.has(block.id) && !used.has(block.id);
    const id = keep ? block.id! : ulid();
    if (block.id !== undefined) { if (!renamed.has(block.id)) renamed.set(block.id, id); used.add(block.id); }
    return { ...block, id };
  });
  return settled.map((block) => "until" in block && block.until !== undefined
    ? { ...block, until: renamed.get(block.until) ?? block.until } : block) as EpisodeScriptBlock[];
}
export type ScriptHeading = z.infer<typeof ScriptHeadingSchema>;
export type ScriptDialogue = z.infer<typeof ScriptDialogueSchema>;
export type ScriptCue = z.infer<typeof ScriptCueSchema>;

/** The relations a script must keep whole, whoever wrote it (R-18, R-24). */
export function episodeScriptProblems(blocks: readonly EpisodeScriptBlock[]): string[] {
  const problems: string[] = [];
  const index = new Map<string, number>();
  blocks.forEach((block, i) => {
    if (index.has(block.id)) problems.push(`Block ${block.id} appears twice.`);
    index.set(block.id, i);
  });
  blocks.forEach((block, i) => {
    if (block.kind === "dialogue" && block.cut) {
      const next = blocks[i + 1];
      if (next?.kind !== "dialogue" || !next.overlapsPrevious) problems.push(`A line broken off (${block.id}) must be followed by the line that breaks in.`);
    }
    if (block.kind === "dialogue" && block.overlapsPrevious) {
      // Both sides of the relation (codex on PR 1870): the line above must be the one broken off.
      const previous = blocks[i - 1];
      if (previous?.kind !== "dialogue" || !previous.cut) problems.push(`A line that breaks in (${block.id}) must follow the line it breaks off.`);
    }
    if ((block.kind === "ambience" || block.kind === "music") && block.until !== undefined) {
      const at = index.get(block.until);
      if (at === undefined || at <= i) problems.push(`A bed (${block.id}) stops before a block that is not below it.`);
    }
    if (block.kind === "sound" && block.until !== undefined) problems.push(`A sound (${block.id}) is a moment, not a bed: it has no until.`);
  });
  return problems;
}

export const EpisodeScriptSchema = z.object({
  version: z.number().int().min(1),
  episode: z.number().int().min(1).max(200),
  title: z.string().trim().max(160).default(""),
  blocks: z.array(EpisodeScriptBlockSchema).max(4_000),
}).strict().superRefine((script, ctx) => {
  for (const message of episodeScriptProblems(script.blocks)) ctx.addIssue({ code: "custom", path: ["blocks"], message });
});
export type EpisodeScript = z.infer<typeof EpisodeScriptSchema>;

// ---------------------------------------------------------------------------
// Takes (SPEC-057 R-25..R-37, design turn 230g–i): a spoken line's performances. One kept take
// per line, and at most one waiting for the author — a replacement, or a take that was misread.
// `productions/<id>/drama-takes/episode-<NN>.json`; the audio is a production artifact.
// ---------------------------------------------------------------------------

/**
 * What a take answers to (R-31): who says it, the words, the direction and the channel. A take
 * made under any other is out of date; a take made for the same is still the line's.
 */
export function dramaLineHash(block: Extract<EpisodeScriptBlock, { kind: "dialogue" | "narration" }>): string {
  return textDigest(JSON.stringify([
    block.kind === "dialogue" ? block.speaker : "narrator",
    block.words.replace(/\s+/g, " ").trim(),
    block.direction?.trim() ?? "",
    block.kind === "dialogue" ? block.channel ?? "" : "",
  ]));
}

export const DramaTakeSchema = z.object({
  artifactId: ArtifactIdSchema,
  /** The audio, relative to the world folder (`artifacts/<file>`). */
  file: z.string().min(1).max(400),
  textHash: z.string().min(1),
  /** The instruction it was read with — How they sound, the narrator's versions, the direction — as a digest. */
  instructionsHash: z.string().min(1).optional(),
  voice: AudiobookReaderSchema,
  /** Spoken in the narrator's voice because the speaker had none (R-28): labelled everywhere. */
  standIn: z.boolean().optional(),
  /** What the take was heard to say, when it was not the line (R-30). */
  misread: z.string().max(2_000).optional(),
  estimatedMicroUsd: z.number().int().min(0),
  madeAt: IsoDateTimeSchema,
}).strict();
export type DramaTake = z.infer<typeof DramaTakeSchema>;

export const EpisodeTakesSchema = z.object({
  version: z.literal(1),
  episode: z.number().int().min(1).max(200),
  /** By block id: the kept take, and one waiting for the author's decision. */
  lines: z.record(UlidSchema, z.object({ kept: DramaTakeSchema.optional(), waiting: DramaTakeSchema.optional() }).strict()),
}).strict();
export type EpisodeTakes = z.infer<typeof EpisodeTakesSchema>;

/** A line's take, as the score shows it (230i). */
export type DramaTakeState = "none" | "kept" | "stand-in" | "out of date" | "new or kept?" | "misread";
export function dramaTakeState(
  block: Extract<EpisodeScriptBlock, { kind: "dialogue" | "narration" }>,
  line: EpisodeTakes["lines"][string] | undefined,
  /** The role's voice now, where it is known: a take in another voice is out of date (R-60). */
  voice?: { provider: string; voiceId: string; model?: string | undefined },
): DramaTakeState {
  if (line?.waiting) return line.waiting.misread !== undefined ? "misread" : "new or kept?";
  if (!line?.kept) return "none";
  if (line.kept.textHash !== dramaLineHash(block)) return "out of date";
  // A voice of its own now outdates a stand-in too (codex on PR 1871): Hear would not reuse it.
  if (voice && (line.kept.standIn || line.kept.voice.provider !== voice.provider || line.kept.voice.voiceId !== voice.voiceId ||
    (voice.model !== undefined && line.kept.voice.model !== voice.model))) return "out of date";
  return line.kept.standIn ? "stand-in" : "kept";
}

/**
 * Whether a kept take plays in the episode's mix: while it is in the role's voice now. An edited
 * line's take keeps playing until it is retaken (R-36), marked out of date in the score; a take in
 * another voice does not (R-60, codex on PR 1879). The studio left both out (issue 1883).
 */
export function dramaTakePlays(
  block: Extract<EpisodeScriptBlock, { kind: "dialogue" | "narration" }>,
  kept: DramaTake,
  voice?: { provider: string; voiceId: string; model?: string | undefined },
): boolean {
  return dramaTakeState(block, { kept: { ...kept, textHash: dramaLineHash(block) } }, voice) !== "out of date";
}

/** What the author decides for a speaker with no voice (R-28): nothing is substituted unasked. */
export const MissingVoiceChoiceSchema = z.enum(["narrator", "leave-out"]);
export type MissingVoiceChoice = z.infer<typeof MissingVoiceChoiceSchema>;

/** One request as it is sent (R-27's What's sent): the words, the voice, how direction went. */
export const DramaRequestSchema = z.object({
  block: UlidSchema,
  speaker: z.string().min(1).max(200),
  voice: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  text: z.string().max(10_000),
  direction: z.object({ sent: z.enum(["tag", "instruction", "not sent"]), text: z.string().max(400).optional(), reason: z.string().max(400).optional() }).strict().optional(),
  /**
   * How they sound (R-57), or for the narrator its own note and its version of each role it
   * quotes (R-58): sent as an instruction where the reader takes one, said not sent otherwise.
   */
  note: z.object({ sent: z.enum(["instruction", "not sent"]), text: z.string().max(2_000), reason: z.string().max(400).optional() }).strict().optional(),
  standIn: z.boolean().optional(),
  estimatedMicroUsd: z.number().int().min(0),
  /** Already performed for these words in this voice: played, not sent again. */
  cached: z.boolean(),
}).strict();
export type DramaRequest = z.infer<typeof DramaRequestSchema>;

/** The default most a single Hear may spend without the dialog (R-26): $0.50. */
export const HEAR_ONE_PRESS_LIMIT_MICRO_USD = 500_000;

/** Where episode `n`'s takes are recorded: named as its script is. */
export function episodeTakesFile(episode: number): string {
  return episodeScriptFile(episode);
}

/** Where episode `n`'s script lives: three digits keep every allowed episode in order (codex on PR 1870). */
export function episodeScriptFile(episode: number): string {
  return `episode-${String(episode).padStart(3, "0")}.json`;
}

/**
 * What a script is heard for, roughly: spoken words at about 2.6 a second, plus silence and a
 * second for each sound. An estimate to steer by (the listening ring), never a measurement.
 */
export function estimateScriptSeconds(blocks: readonly EpisodeScriptBlock[]): number {
  let seconds = 0;
  for (const block of blocks) {
    if (block.kind === "dialogue" || block.kind === "narration") seconds += block.words.trim().split(/\s+/).filter(Boolean).length / 2.6;
    else if (block.kind === "silence") seconds += block.seconds;
    else if (block.kind === "sound") seconds += 1;
  }
  return Math.round(seconds);
}

// ---------------------------------------------------------------------------
// Cast (SPEC-057 R-55..R-60, design turn 230k): who speaks, in what voice, and how they sound here.
// ---------------------------------------------------------------------------

/**
 * A fact as it reads inside a sentence (issue 1883): "tells the listener the cost…", not "The
 * cost…". Only a word that opens a sentence is lowered; a name ("Ilo is alive") keeps its capital.
 */
const OPENERS = new Set(["the", "a", "an", "this", "that", "these", "those", "his", "her", "their", "its", "it", "there", "what", "who", "why", "how", "where", "when", "someone", "something", "nobody", "no", "one", "every", "each", "all", "some", "she", "he", "they", "we", "you", "i"]);
export function midSentence(fact: string): string {
  const first = /^\p{Lu}[\p{Ll}'’]*/u.exec(fact)?.[0];
  return first && first !== "I" && OPENERS.has(first.toLowerCase()) ? first.toLowerCase() + fact.slice(first.length) : fact;
}

/** The role key the narrator is kept under in `cast`. */
export const DRAMA_NARRATOR = "@narrator";

/**
 * A speaker no sheet carries (R-55), named from its key: "crowd" is Crowd, "someone-2" Someone 2,
 * "a-dockhand" A dockhand. Shared so Hear's planner and every page say the same name (issue 1888):
 * the Hear dialog read "crowd has no voice" and the show page "Ends on crowd".
 */
export function dramaSpeakerLabel(key: string): string {
  const words = key.replace(/-(\d+)$/u, " $1").split("-").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
/** A role's key: a sheet id, a name no sheet carries, or the narrator — which no slug can be (codex on PR 1873). */
export const DramaRoleKeySchema = z.union([SlugSchema, z.literal(DRAMA_NARRATOR)]);

/** The name a role is heard by in an episode (R-59): its public label until the episode that reveals it. */
export function dramaRoleName(name: string, role: Pick<DramaRole, "publicLabel" | "revealEpisode"> | undefined, episode: number): string {
  return role?.publicLabel !== undefined && role.revealEpisode !== undefined && episode < role.revealEpisode ? role.publicLabel : name;
}

/** Where How they sound starts (R-57): the first paragraph of the sheet's Voice section. */
export function sheetSound(sheet: { sections?: ReadonlyArray<{ heading: string; body: string }> } | undefined): string | undefined {
  const section = sheet?.sections?.find((candidate) => /^voice\b/i.test(candidate.heading.trim()));
  const first = section?.body.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim();
  return first ? first.slice(0, PERFORMANCE_NOTE_MAX) : undefined;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const firstOf = (name: string) => name.trim().toLowerCase().split(/\s+/)[0] ?? "";
/**
 * A name as it is said: in full, and by its first word — only where no other role shares that
 * first word (codex on PR 1873), so a narration naming Maren Kest never names Maren Vale.
 */
function nameForms(name: string, shared: ReadonlySet<string>): string[] {
  const full = name.trim().toLowerCase();
  const first = firstOf(name);
  // A full name always counts, however short (codex on PR 1873); a first word only from three letters.
  return [...new Set([full, shared.has(first) || first.length < 3 ? "" : first].filter((form) => form.length > 0))];
}
/** First words more than one role answers to. */
function sharedFirsts(all: Iterable<string>): Set<string> {
  const seen = new Set<string>(), shared = new Set<string>();
  for (const name of all) { const first = firstOf(name); if (seen.has(first)) shared.add(first); seen.add(first); }
  return shared;
}
function names(words: string, name: string, shared: ReadonlySet<string> = new Set()): boolean {
  const text = words.toLowerCase();
  return nameForms(name, shared).some((form) => new RegExp(`(^|[^\\p{L}])${escapeRegExp(form)}($|[^\\p{L}])`, "u").test(text));
}

/**
 * Whose words a narration quotes (R-58): a role it names in a narration holding quoted speech.
 * Those roles show the narrator's version on Cast, and only their narration notes reach the
 * narrator's request for that block.
 */
export function narrationQuotes(words: string, roles: Readonly<Record<string, string>>): string[] {
  if (!/["“”]/.test(words)) return [];
  const shared = sharedFirsts(Object.values(roles));
  return Object.entries(roles).filter(([, name]) => names(words, name, shared)).map(([key]) => key);
}

// ---------------------------------------------------------------------------
// Review (SPEC-057 R-49..R-54, design turn 230j): one review, every note saying what it rests on.
// These checks read the script; nothing here has heard audio, and the coverage says so.
// ---------------------------------------------------------------------------

export const DRAMA_REVIEW_CHECKS = ["fidelity", "clarity", "pacing", "emotion", "mystery", "intelligibility"] as const;
export type DramaReviewCheck = (typeof DRAMA_REVIEW_CHECKS)[number];

export interface DramaReviewNote {
  /** Stable while the lines it quotes and what it says stay the same: the decision's key. */
  key: string;
  check: DramaReviewCheck;
  /** What it rests on (R-50): `script v3`. */
  evidence: string;
  blocks: string[];
  quote: string;
  says: string;
}

export interface DramaReview {
  /** The header (R-51): `Script v3 · no audio heard yet`, or `heard 0:00–14:40 of 24:10`. */
  coverage: string;
  notes: DramaReviewNote[];
  /** Checks with nothing to say, listed closed (R-53), and the one that needs heard audio. */
  checked: Array<{ check: DramaReviewCheck; says: string }>;
}

const clockOf = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** How much has been heard (R-51): exact, merged, and never a clean review for partial listening. */
export function reviewCoverage(version: number, heard: ReadonlyArray<readonly [number, number]>, totalSec: number): string {
  const spans = [...heard]
    .map(([from, to]) => [Math.max(0, Math.min(from, to)), Math.min(totalSec, Math.max(from, to))] as [number, number])
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  if (merged.length === 0) return `Script v${version} · no audio heard yet`;
  return `heard ${merged.map(([from, to]) => `${clockOf(from)}–${clockOf(to)}`).join(", ")} of ${clockOf(totalSec)}`;
}

const STOP = new Set(["the", "and", "was", "were", "is", "are", "has", "had", "have", "his", "her", "hers", "him", "who", "that", "this",
  "with", "for", "not", "but", "from", "they", "them", "she", "he", "it", "its", "into", "onto", "been", "be", "of", "to", "in", "on", "at", "a", "an"]);
const termsOf = (text: string) => (text.toLowerCase().match(/\p{L}+/gu) ?? []).filter((word) => word.length >= 3 && !STOP.has(word));
/** Every significant word of the fact, in the line, allowing a word's ending to differ. */
function tells(words: string, fact: string): boolean {
  const facts = termsOf(fact);
  if (facts.length === 0) return false;
  const line = termsOf(words);
  // A one-word secret is matched whole (codex on PR 1873): "pregnant", never any word near it.
  if (facts.length === 1) return line.includes(facts[0]!);
  return facts.every((term) => line.some((word) => word.startsWith(term.slice(0, Math.max(4, term.length - 2))) || term.startsWith(word) && word.length >= 4));
}

/**
 * A short, stable key for a note's decision, over what it says and every line it rests on (codex
 * on PR 1873): rewrite a line and the note opens again, decided afresh.
 */
function noteKey(check: string, blocks: readonly string[], says: string, evidence: string): string {
  let hash = 5381;
  for (const char of `${says}\n${evidence}`) hash = ((hash << 5) + hash + char.charCodeAt(0)) >>> 0;
  return `${check}:${blocks.slice(0, 3).join("+")}${blocks.length > 3 ? `+${blocks.length - 3}` : ""}:${hash.toString(36)}`;
}

export interface DramaReviewInput {
  episode: number;
  version: number;
  blocks: readonly EpisodeScriptBlock[];
  plan?: Pick<AudioDramaPlan, "minutes" | "keptFromListener">;
  /** Each speaker's name, by speaker key. */
  names: Readonly<Record<string, string>>;
  /** Each speaker's voice as `provider/voiceId`, where it has one. */
  voices?: Readonly<Record<string, string>>;
  cast?: AudioDramaRecord["cast"];
  /** The pinned chapters as they are now. */
  chapters?: ReadonlyArray<{ story: string; chapter: string; version: number; hash?: string | undefined }>;
  /** Intervals of this episode's audio actually heard, in seconds, on its mix as it is now. */
  heard?: ReadonlyArray<readonly [number, number]>;
  /** That mix's length, which heard coverage is counted against (issue 1882); else the script's estimate. */
  heardOf?: number;
}

const LONG_SPEECH_WORDS = 70;
const LONG_DIRECTION_WORDS = 12;
const LONG_SILENCE_SEC = 8;
const OFF_MIC_RUN = 5;

/**
 * The script's review (R-52): fidelity to the source, clarity by ear, pacing, emotion as written and
 * mystery against Kept from the listener, each note resting on `script v<n>`. Intelligibility is
 * judged on heard audio only, so with none heard it is listed as waiting, never as passed.
 */
export function reviewDramaScript(input: DramaReviewInput): DramaReview {
  const { blocks, episode } = input;
  const evidence = `script v${input.version}`;
  const index = new Map(blocks.map((block, i) => [block.id, i]));
  const raw: Array<Omit<DramaReviewNote, "key" | "evidence">> = [];
  const checked: DramaReview["checked"] = [];
  const add = (check: DramaReviewCheck, ids: string[], says: string) => {
    const first = ids.length > 0 ? blocks[index.get(ids[0]!) ?? -1] : undefined;
    const quote = first === undefined ? "" : "words" in first ? first.words
      : first.kind === "heading" ? first.place : "heard" in first ? first.heard : first.kind === "note" ? first.text : `${first.seconds} s`;
    raw.push({ check, blocks: ids, quote, says });
  };
  const nameOf = (speaker: string) => speaker === DRAMA_NARRATOR ? "The narrator" : input.names[speaker] ?? speaker;
  type Spoken = Extract<EpisodeScriptBlock, { kind: "dialogue" | "narration" }>;
  const spoken = (block: EpisodeScriptBlock): block is Spoken => block.kind === "dialogue" || block.kind === "narration";

  // Scenes: what sits under each heading, and whatever comes before the first.
  const scenes: Array<{ heading: ScriptHeading | null; blocks: EpisodeScriptBlock[] }> = [{ heading: null, blocks: [] }];
  for (const block of blocks) {
    if (block.kind === "heading") scenes.push({ heading: block, blocks: [] });
    else scenes[scenes.length - 1]!.blocks.push(block);
  }
  const before = raw.length;
  const since = (check: DramaReviewCheck, says: string, from: number) => { if (raw.length === from) checked.push({ check, says }); };

  // Fidelity: lines a sourced scene adds, and scenes whose chapter has moved since.
  let sourced = 0;
  for (const scene of scenes) {
    const source = scene.heading?.source;
    if (!source || !scene.heading) continue;
    sourced += 1;
    const added = scene.blocks.filter((block) => spoken(block) && !block.paragraphs?.length);
    if (added.length > 0) add("fidelity", added.map((block) => block.id), added.length === 1 ? "This line is not in the source." : `${added.length} lines in this scene are not in the source.`);
    const now = input.chapters?.find((chapter) => chapter.story === source.story && chapter.chapter === source.chapter);
    if (now && now.version > source.version) add("fidelity", [scene.heading.id], `Written from v${source.version}. The chapter is now v${now.version}.`);
    else if (now && source.hash !== undefined && now.hash !== undefined && now.hash !== source.hash) add("fidelity", [scene.heading.id], "The chapter was edited after this scene was written.");
  }
  since("fidelity", sourced === 0 ? "No scene names its source." : "Every sourced line cites its passage.", before);

  // Clarity by ear: where we are, and who is speaking.
  const clarity = raw.length;
  for (const scene of scenes) {
    // Lines before any heading are a scene too (codex on PR 1873): the listener is placed or not.
    if (!scene.heading && scene.blocks.length === 0) continue;
    const opener = scene.blocks.find((block) => block.kind !== "note" && block.kind !== "silence");
    if (opener?.kind === "dialogue") add("clarity", [opener.id], "The scene opens on a line. Nothing yet tells the listener where we are.");
    const offMic = new Map<string, string[]>();
    const byVoice = new Map<string, string[]>();
    for (const block of scene.blocks) {
      // The narrator is a speaker too (codex on PR 1873): a character in its voice is not told apart.
      if (block.kind === "narration") {
        const voice = input.voices?.[DRAMA_NARRATOR];
        if (voice !== undefined && !(byVoice.get(voice) ?? []).includes(DRAMA_NARRATOR)) byVoice.set(voice, [...(byVoice.get(voice) ?? []), DRAMA_NARRATOR]);
        continue;
      }
      if (block.kind !== "dialogue") continue;
      if (block.channel === "off-mic") offMic.set(block.speaker, [...(offMic.get(block.speaker) ?? []), block.id]);
      const voice = input.voices?.[block.speaker];
      if (voice !== undefined && !(byVoice.get(voice) ?? []).includes(block.speaker)) byVoice.set(voice, [...(byVoice.get(voice) ?? []), block.speaker]);
    }
    for (const [speaker, ids] of offMic) {
      if (ids.length >= OFF_MIC_RUN) add("clarity", ids, `${nameOf(speaker)} is off-mic for ${ids.length} lines. The listener may lose where they are.`);
    }
    for (const speakers of byVoice.values()) {
      if (speakers.length < 2) continue;
      const firsts = speakers.map((speaker) => scene.blocks.find((block) => speaker === DRAMA_NARRATOR ? block.kind === "narration" : block.kind === "dialogue" && block.speaker === speaker)!.id);
      add("clarity", firsts, `${speakers.map(nameOf).join(" and ")} speak in the same voice here.`);
    }
  }
  since("clarity", "Every scene places the listener, and every speaker is told apart.", clarity);

  // Pacing: what the ear can hold in one breath, dead air, and the episode against its target.
  const pacing = raw.length;
  for (const block of blocks) {
    if (spoken(block)) {
      const words = block.words.trim().split(/\s+/).filter(Boolean).length;
      if (words > LONG_SPEECH_WORDS) add("pacing", [block.id], `About ${Math.round(words / 2.6)} s in one breath. Long for the ear.`);
    } else if (block.kind === "silence" && block.seconds > LONG_SILENCE_SEC) add("pacing", [block.id], `${block.seconds} s of silence may sound like dead air.`);
  }
  const minutes = estimateScriptSeconds(blocks) / 60;
  if (input.plan && minutes > input.plan.minutes * 1.25) add("pacing", [], `About ${Math.round(minutes)} min against a ${input.plan.minutes} min target.`);
  since("pacing", "Speeches and silences sit within what the ear holds.", pacing);

  // Emotion as written: a direction a reader can play, and only how, never what.
  const emotion = raw.length;
  for (const block of blocks) {
    if (!spoken(block) || !block.direction) continue;
    if (/["“”]/.test(block.direction)) add("emotion", [block.id], "This direction holds words to say. Direction is how, never what.");
    else if (block.direction.trim().split(/\s+/).length > LONG_DIRECTION_WORDS) add("emotion", [block.id], "A direction this long is hard to play. Keep its feeling in a few words.");
  }
  since("emotion", "Every direction is short enough to play.", emotion);

  // Mystery: each fact kept from the listener, and each hidden name, before its episode.
  const mystery = raw.length;
  const withheld = (input.plan?.keptFromListener ?? []).filter((kept) => kept.revealEpisode > episode);
  const hidden = Object.entries(input.cast ?? {}).filter(([, role]) => role.publicLabel !== undefined && role.revealEpisode !== undefined && role.revealEpisode > episode);
  for (const kept of withheld) {
    const leaks = blocks.filter((block) => spoken(block) && tells(block.words, kept.fact));
    for (const block of leaks) add("mystery", [block.id], `This may tell the listener “${kept.fact}” before episode ${kept.revealEpisode}.`);
    if (leaks.length === 0) checked.push({ check: "mystery", says: `Nothing here tells the listener ${midSentence(kept.fact.replace(/\.$/, ""))}.` });
  }
  const shared = sharedFirsts(Object.values(input.names));
  for (const [speaker, role] of hidden) {
    const name = nameOf(speaker);
    const leaks = blocks.filter((block) => spoken(block) && names(block.words, name, shared));
    for (const block of leaks) add("mystery", [block.id], `${name} is named here, before episode ${role.revealEpisode}.`);
    if (leaks.length === 0) checked.push({ check: "mystery", says: `${role.publicLabel} is not named before episode ${role.revealEpisode}.` });
  }
  if (withheld.length === 0 && hidden.length === 0 && raw.length === mystery) checked.push({ check: "mystery", says: "Nothing is kept from the listener here." });

  // Intelligibility needs ears: with nothing heard it waits, and is never counted as passed. Its
  // notes are the heard audio's own, made where the audio was measured, not here.
  if ((input.heard ?? []).length === 0) checked.push({ check: "intelligibility", says: "Needs heard audio." });
  else checked.push({ check: "intelligibility", says: "Checked on what was heard; its notes rest on their heard intervals." });

  const at = (note: Omit<DramaReviewNote, "key" | "evidence">) => note.blocks.length === 0 ? Number.MAX_SAFE_INTEGER : index.get(note.blocks[0]!) ?? Number.MAX_SAFE_INTEGER;
  const notes = raw
    .map((note, order) => ({ note, order }))
    .sort((a, b) => at(a.note) - at(b.note) || a.order - b.order)
    .map(({ note }) => ({ ...note, evidence,
      // Scoped to the episode (codex on PR 1873): two episodes' like notes are decided apart.
      key: noteKey(`e${episode}:${note.check}`, note.blocks, note.says, note.blocks.map((id) => JSON.stringify(blocks[index.get(id) ?? -1] ?? null)).join("\n")) }));
  return { coverage: reviewCoverage(input.version, input.heard ?? [], input.heardOf ?? estimateScriptSeconds(blocks)), notes, checked };
}

// ---------------------------------------------------------------------------
// Changed source (SPEC-057 R-64, R-65, design turn 230n).
// ---------------------------------------------------------------------------

const sameText = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Which paragraphs of the adapted version are gone from the chapter now, by number in the adapted
 * version (1-based). A paragraph is found by its words, wherever it now sits: a split or a join
 * changes the paragraphs it touched, a move or a repeat changes nothing.
 */
export function changedParagraphs(adapted: readonly string[], now: readonly string[]): number[] {
  const placed = alignParagraphs(adapted, now);
  return adapted.flatMap((_, i) => placed.has(i + 1) ? [] : [i + 1]);
}

/**
 * Each adapted paragraph's place now, one to one (codex on PR 1878): the longest run kept in order
 * first, so a repeated paragraph is told by its occurrence, then any paragraph moved elsewhere.
 */
function alignParagraphs(adapted: readonly string[], now: readonly string[]): Map<number, number> {
  const a = adapted.map(sameText), b = now.map(sameText);
  const placed = new Map<number, number>(), used = new Set<number>();
  const keep = (i: number, j: number) => { placed.set(i + 1, j + 1); used.add(j); };
  // The unchanged head and tail first (codex on PR 1878): an edit is usually local, and the table
  // below grows with the product of what is left. Both always belong to a longest run.
  let head = 0, tail = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) { keep(head, head); head++; }
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) { keep(a.length - 1 - tail, b.length - 1 - tail); tail++; }
  const m = a.length - head - tail, n = b.length - head - tail, width = n + 1;
  // Past a few million cells the order is let go, and the words alone place each paragraph.
  if (m > 0 && n > 0 && (m + 1) * width <= 4_000_000) {
    const lcs = new Uint16Array((m + 1) * width);
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) {
      lcs[i * width + j] = a[head + i] === b[head + j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
    for (let i = 0, j = 0; i < m && j < n;) {
      if (a[head + i] === b[head + j]) { keep(head + i, head + j); i++; j++; }
      else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) i++;
      else j++;
    }
  }
  a.forEach((text, i) => {
    if (placed.has(i + 1)) return;
    const j = b.findIndex((candidate, at) => !used.has(at) && candidate === text);
    if (j >= 0) keep(i, j);
  });
  return new Map([...placed].sort(([x], [y]) => x - y));
}

/** The blocks of a scene that rest on changed paragraphs: its lines' own, else the scene's pin. */
export function affectedBlocks(scene: readonly EpisodeScriptBlock[], pinned: readonly number[] | undefined, changed: readonly number[]): string[] {
  const moved = new Set(changed);
  const sceneHit = (pinned ?? []).some((n) => moved.has(n));
  return scene.flatMap((block) => {
    // A cue rests on its passage as a line does (codex on PR 1878).
    if (block.kind === "heading" || block.kind === "note" || block.kind === "silence") return [];
    const own = block.paragraphs ?? [];
    return (own.length > 0 ? own.some((n) => moved.has(n)) : sceneHit) ? [block.id] : [];
  });
}

/**
 * A placed sound a production cannot play (SPEC-057 R-43): not audio, retired, gone, or another
 * production's. Checked wherever a script lands — a save, an Arke draft staged, a draft kept.
 */
export function unusableSound(
  blocks: readonly EpisodeScriptBlock[],
  artifacts: ReadonlyArray<{ id: string; kind: string; retiredAt?: unknown; production?: string | undefined }>,
  productionId: string,
): string | null {
  for (const block of blocks) {
    if ((block.kind !== "sound" && block.kind !== "ambience" && block.kind !== "music") || !block.soundArtifact) continue;
    const artifact = artifacts.find((candidate) => candidate.id === block.soundArtifact);
    if (!artifact || artifact.kind !== "audio" || artifact.retiredAt !== undefined || (artifact.production !== undefined && artifact.production !== productionId)) {
      return `“${block.heard}” is placed with a sound this production cannot use. Choose its sound again.`;
    }
  }
  return null;
}

/**
 * Where each paragraph of the adapted version now stands (codex on PR 1878): by its words, each
 * matched once, in order. A changed paragraph has no place, and pins to it are let go.
 */
export function remapParagraphs(adapted: readonly string[], now: readonly string[]): Map<number, number> {
  return alignParagraphs(adapted, now);
}

/** Where an adapted chapter's exact text is kept, by the hash it was pinned at. */
export function dramaSourceSnapshotPath(productionId: string, hash: string): string {
  return `productions/${productionId}/source-snapshots/${hash.replace(/^sha256:/, "").replace(/[^a-zA-Z0-9]/g, "")}.md`;
}
