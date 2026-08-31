import { z } from "zod";
import {
  ArtifactIdSchema,
  EpisodeIdSchema,
  IsoDateTimeSchema,
  JobIdSchema,
  PresetIdSchema,
  SceneIdSchema,
  SessionIdSchema,
  Sha256Schema,
  ShotIdSchema,
  SlugSchema,
  TakeIdSchema,
} from "./ids.js";
import { JobStatusSchema } from "./job.js";
import { SizeTierSchema, modeSpec, modeUnavailableReason, supportsMode, type ManifestModel, type TaskMode } from "./manifest.js";
import { MediaInfoSchema } from "./media.js";
import { PROVIDERS, type Capability } from "./provider.js";
import { ReferenceKindSchema, type ReferenceKind } from "./reference-budget.js";
import { ProvenanceSchema, TakeCostSchema } from "./take.js";
import { DeliverySchema } from "./voice.js";

/**
 * The bench (issue 305; design turns 68–69): one picture or one shot made with no production
 * waiting on it, reached from the world's Artifacts screen and filing back into it.
 *
 * A bench session is durable and event-sourced — `.sessions/<sessionId>/events.jsonl` under the
 * world, mirroring World Chat's append rules — because pressing Generate here authorizes paid
 * provider calls, and the record that authorized a charge cannot be a mutable file that a crash
 * half-wrote. Everything below is the *folded* view of that log plus the events themselves.
 */

export const BenchModeSchema = z.enum(["image", "video", "voice", "music"]);
export type BenchMode = z.infer<typeof BenchModeSchema>;

/**
 * The capability a mode dispatches against (design 70).
 *
 * `image` and `video` are both mode names *and* capability names, which let the two be compared
 * directly for as long as those were the only modes. Speech breaks that: the mode is `voice`
 * and the capability is `voice-tts`. Read through this map rather than compared, so the day a
 * fourth mode arrives the mismatch is a compile error rather than a model that silently never
 * matches.
 *
 * That day came: `music` is the fourth mode (design turn 73), and it is a mode name and a
 * capability name again — but it arrives through this map like the rest, because the next
 * mismatch should cost a compile error too.
 */
export function modeCapability(mode: BenchMode): Capability {
  switch (mode) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "voice":
      return "voice-tts";
    case "music":
      return "music";
  }
}

// ---------------------------------------------------------------------------
// Composer parameters — one shape per mode, discriminated so a video duration
// can never ride an image request unnoticed.
// ---------------------------------------------------------------------------

export const BenchImageParamsSchema = z
  .object({
    kind: z.literal("image"),
    /** The shape, in the chosen model's own vocabulary ("16:9"). Absent = provider default. */
    aspect: z.string().min(1).optional(),
    tier: SizeTierSchema.optional(),
    /** How many takes one press asks for. Each is its own numbered take and its own job. */
    count: z.number().int().min(1).max(4),
  })
  .strict();
export type BenchImageParams = z.infer<typeof BenchImageParamsSchema>;

export const BenchVideoParamsSchema = z
  .object({
    kind: z.literal("video"),
    aspect: z.string().min(1).optional(),
    /** Video keeps its own words — "720p", never a normalised tier (manifest.ts). */
    resolution: z.string().min(1).optional(),
    /** Authored board totals may be fractional; the provider route decides its own wire step. */
    durationSec: z.number().positive().optional(),
    /** Present only where the model declares the control; absent is "the control does not exist". */
    sound: z.boolean().optional(),
  })
  .strict();
export type BenchVideoParams = z.infer<typeof BenchVideoParamsSchema>;

/**
 * A spoken line (design 70). The words themselves live in the composer's brief, as the brief of
 * an image request holds the prompt — what differs is that these are the content rather than a
 * description of it, which is why nothing here rewrites them.
 */
export const BenchVoiceParamsSchema = z
  .object({
    kind: z.literal("voice"),
    /** The provider's own id for the voice reading this. Absent until one is chosen. */
    voiceId: z.string().min(1).optional(),
    /** Provider half of picker identity; prevents equal voice ids selecting each other. */
    voiceProvider: z.string().min(1).optional(),
    /** Concrete model half of picker identity. Optional only for existing session logs. */
    voiceModel: z.string().min(1).optional(),
    /** What the picker showed, kept so a take can name its voice without the catalogue. */
    voiceLabel: z.string().min(1).optional(),
    /** One of DELIVERIES (voice.ts); the row maps it, or states that it cannot. */
    delivery: DeliverySchema.optional(),
    /** How many reads one press asks for — each its own numbered take, as images are. */
    count: z.number().int().min(1).max(4),
  })
  .strict();
export type BenchVoiceParams = z.infer<typeof BenchVoiceParamsSchema>;

/**
 * A song (design turn 73). The route requires two things and neither can be derived from the
 * other, so the composer asks for exactly two: the STYLE — instrumentation, mood, arrangement —
 * which rides in the composer's `brief` the way every other mode's description does, and the
 * LYRICS, which live here because they are the words that get sung rather than a description
 * of them.
 *
 * There is no length control, and that is a decision rather than an omission. minimax-music-3
 * declares `duration` an *upper bound* — "the model may stop earlier; the actual duration is
 * returned in the output" — so a number here would not buy a song of that length, only a
 * ceiling. For a song with lyrics the length is implied by the words. The request goes at the
 * route's own default (MUSIC_DURATION_SEC) and the take states what was actually made, measured
 * from the file rather than taken from anyone's word.
 */
export const BenchMusicParamsSchema = z
  .object({
    kind: z.literal("music"),
    /**
     * The words to be sung. Structure tags the route understands — [intro], [verse], [chorus] —
     * are the author's to write or not; nothing here inserts them.
     */
    lyrics: z.string().max(20_000),
    /** How many songs one press asks for — each its own numbered take, as images are. */
    count: z.number().int().min(1).max(4),
  })
  .strict();
export type BenchMusicParams = z.infer<typeof BenchMusicParamsSchema>;

/**
 * The length every music request is made at, in seconds.
 *
 * minimax-music-3's own default, and deliberately the same number the estimate is computed
 * from: a request that runs at one length while the price was quoted at another is the bug
 * `durationParam` in the fal client exists to refuse. Because the route treats it as a ceiling,
 * the estimate is a ceiling too — the charge follows the song that was actually made.
 */
export const MUSIC_DURATION_SEC = 60;

export const BenchParamsSchema = z.discriminatedUnion("kind", [
  BenchImageParamsSchema,
  BenchVideoParamsSchema,
  BenchVoiceParamsSchema,
  BenchMusicParamsSchema,
]);
export type BenchParams = z.infer<typeof BenchParamsSchema>;

// ---------------------------------------------------------------------------
// References — a token is the name the brief cites; the source is what it names.
// ---------------------------------------------------------------------------

/**
 * Where a reference's bytes come from. The hash is recorded at attach time so provenance can
 * say exactly which bytes rode along even after the artifact is superseded or the take's file
 * is later filed under another name.
 */
/**
 * A world-relative path, constrained where it enters rather than where it is used.
 *
 * A path arriving from a client is not permission to read the disk. This is the first of two
 * gates — the coordinator resolves against the world directory and re-checks besides — but the
 * schema is where the shape is settled, so a malformed path never reaches code that assumes it
 * is well formed. Forward slashes because a world moves across platforms (R-24).
 */
export const WorldFilePathSchema = z
  .string()
  .min(1)
  .max(400)
  .refine((value) => !value.startsWith("/"), "a world path is relative")
  .refine((value) => !value.includes("\\"), "a world path uses forward slashes")
  .refine((value) => !/^[a-zA-Z]:/.test(value), "a world path carries no drive letter")
  .refine((value) => !value.split("/").includes(".."), "a world path cannot climb out of the world");

export const BenchReferenceSourceSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("artifact"), artifactId: ArtifactIdSchema, hash: Sha256Schema }).strict(),
  z.object({ source: z.literal("take"), takeId: TakeIdSchema, hash: Sha256Schema }).strict(),
  /**
   * A picture that lives in the world but is not an artifact — everything under a character:
   * their accepted identity, their looks, the candidates still waiting on review, and every
   * take ever generated for them. The world holds far more pictures than the artifacts folder,
   * and until this variant existed none of them could be picked (reported 2026-08-18).
   *
   * The path is the identity, so the same file re-picked restores its old token. It is
   * world-relative and the coordinator confines it to the world directory — a path arriving
   * from a client is not permission to read the disk.
   */
  z.object({ source: z.literal("world-file"), path: WorldFilePathSchema, hash: Sha256Schema }).strict(),
]);
export type BenchReferenceSource = z.infer<typeof BenchReferenceSourceSchema>;

/** "Image 3" — the kind capitalised, then the 1-based number. The display form IS the identity. */
export const BENCH_TOKEN = /^(Image|Video|Audio) ([1-9][0-9]*)$/;

const TOKEN_PREFIX: Record<ReferenceKind, string> = { image: "Image", video: "Video", audio: "Audio" };

export function benchTokenFor(kind: ReferenceKind, n: number): string {
  return `${TOKEN_PREFIX[kind]} ${n}`;
}

/** The parsed identity of a token, or null for a string that is not one. */
export function parseBenchToken(token: string): { kind: ReferenceKind; n: number } | null {
  const m = BENCH_TOKEN.exec(token);
  if (!m) return null;
  const kind = (Object.entries(TOKEN_PREFIX).find(([, p]) => p === m[1])?.[0] ?? null) as ReferenceKind | null;
  return kind === null ? null : { kind, n: Number(m[2]) };
}

export const BenchReferenceTokenSchema = z
  .object({
    /** Display form, e.g. "Image 3" — stable for the session's life, never renumbered. */
    token: z.string().regex(BENCH_TOKEN),
    kind: ReferenceKindSchema,
    source: BenchReferenceSourceSchema,
    /** Subject-prefilled tiles name what they represent instead of only saying "Image 1". */
    label: z.string().min(1).max(200).optional(),
    detail: z.string().min(1).max(300).optional(),
    /** Frozen sheet provenance for a named subject reference. */
    sheetId: SlugSchema.optional(),
    sheetVersion: z.number().int().min(1).optional(),
    /** Measured length for subject audio/video that did not come through an artifact sidecar. */
    durationSec: z.number().positive().optional(),
    /** A subject audio tile remains visible when the chosen route cannot carry it. */
    ride: z.enum(["required", "when-supported"]).optional(),
    /** Production's attachment decision, used to bind the carried image in the provider prompt. */
    productionBinding: z
      .object({
        subject: z.string().min(1).max(200),
        rolePhrase: z.string().min(1).max(300),
        mode: z.enum(["designated", "main-photo", "scoped-look", "sketch-citation"]),
      })
      .strict()
      .optional(),
    /** Why a production prefill supplied this token; ordinary user references leave it absent. */
    subjectRole: z.enum(["reference", "audio", "board-frame"]).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const parsed = parseBenchToken(entry.token);
    if (parsed !== null && parsed.kind !== entry.kind) {
      ctx.addIssue({ code: "custom", message: `token "${entry.token}" does not spell its kind "${entry.kind}"` });
    }
  });
export type BenchReferenceToken = z.infer<typeof BenchReferenceTokenSchema>;

/** One stable identity per source, so the same artifact can never ride under two names. */
export function benchSourceKey(source: BenchReferenceSource): string {
  switch (source.source) {
    case "artifact":
      return `artifact:${source.artifactId}`;
    case "take":
      return `take:${source.takeId}`;
    case "world-file":
      return `file:${source.path}`;
  }
}

/**
 * What may sit immediately before a citation's "@" (issue 476).
 *
 * An address — write to me@image.example — is not an attempt to cite Image 1, and neither is
 * anything else with an at-sign buried inside a word. One set, exported, because the editor
 * decides where a menu may OPEN and this file decides what IS a mention: two spellings of that
 * rule would let the menu offer a completion the gate then refuses to recognise.
 */
const MENTION_OPENERS = [" ", "\t", "\n", "(", "[", "{", '"', "'", "/", "\u2014", "\u2013"] as const;
export const BENCH_MENTION_OPENERS: ReadonlySet<string> = new Set(MENTION_OPENERS);

/**
 * The openers as one character class. Written raw, which is safe for every character above and
 * for punctuation generally — but `]`, `^`, `-` and a backslash would each have to be escaped
 * before they could join the set, so add one of those and this line has to change with it.
 */
const OPENER_CLASS = MENTION_OPENERS.join("");

/**
 * A mention: the name a brief cites a reference by, written with an at-sign — "@Image 3"
 * (issue 476).
 *
 * The token is the identity; the at-sign is only what tells a citation apart from the author's
 * own prose, so the completion menu, the chip in the words, and the gate before dispatch all
 * agree on which characters name a reference. A bare "Image 3" stays prose: briefs written
 * before mentions existed are not retroactively bound to a reference that may since have gone.
 *
 * Bounded on both sides, and it has to be. Without the opener, "foo@Image 1" would read as a
 * citation the editor would never have offered; without the closing boundary, "@Image 1st of May"
 * reads as "@Image 1", and ordinary prose is refused at dispatch over a reference nobody cited.
 *
 * The closing boundary is in two halves because a full stop is both the end of a sentence and
 * the middle of a filename. A letter or a digit ends it outright; a dot, dash or underscore ends
 * it only when a word follows, so "cite @Image 1." is a citation and "@Image 1.foo" is not —
 * which is the same reading the editor's query gives those characters (raised on review).
 */
export const BENCH_MENTION = new RegExp(
  `(?<![^${OPENER_CLASS}])@(?:Image|Video|Audio) [1-9][0-9]*(?![\\p{L}\\p{N}])(?![._-][\\p{L}\\p{N}])`,
  "u",
);

/** The canonical spelling, in one place, so nothing writes a second dialect of it. */
export function benchMentionFor(token: string): string {
  return `@${token}`;
}

/** Every mention a brief makes, in order, each with the span it occupies. */
export function benchMentionsIn(text: string): Array<{ token: string; start: number; end: number }> {
  const found: Array<{ token: string; start: number; end: number }> = [];
  for (const match of text.matchAll(new RegExp(BENCH_MENTION.source, "gu"))) {
    const start = match.index ?? 0;
    found.push({ token: match[0].slice(1), start, end: start + match[0].length });
  }
  return found;
}

/**
 * The brief as the provider will read it: every citation renamed to the place its bytes will
 * actually occupy on the wire (raised on review, issue 476).
 *
 * A session token is stable for the session's whole life and never renumbered — that is what
 * makes "@Image 2" still mean the same picture after Image 1 has been taken off. A provider is
 * handed a dense array and counts from one. So the moment anything is removed, or restored in
 * another order, the two disagree: the prompt says "the second image" and the second image is
 * not there. The model cannot see the registry, only the array, and a take grounded on the
 * wrong picture is a take that was paid for.
 *
 * So the author keeps the stable names — on screen, in the snapshot, and therefore across a
 * re-run — and the provider is given the positions. Numbered per kind, because the kinds travel
 * in fields of their own, and derived from the ordered list that is being sent, which is what
 * makes a re-run of an old take reproduce that take's own numbering rather than today's.
 */
export function briefForProvider(
  brief: string,
  riding: readonly { token: string; kind: ReferenceKind }[],
): string {
  const place = new Map<string, string>();
  const used = new Map<ReferenceKind, number>();
  for (const entry of riding) {
    const n = (used.get(entry.kind) ?? 0) + 1;
    used.set(entry.kind, n);
    place.set(entry.token, benchTokenFor(entry.kind, n));
  }
  let out = "";
  let at = 0;
  for (const mention of benchMentionsIn(brief)) {
    const renamed = place.get(mention.token);
    if (renamed === undefined) continue; // the gate refuses these; nothing here invents a name
    out += brief.slice(at, mention.start) + benchMentionFor(renamed);
    at = mention.end;
  }
  return out + brief.slice(at);
}

/**
 * The tokens a brief cites that nothing attached answers for — de-duplicated, first mention
 * first. The one function the composer warns from and the coordinator refuses from, so a
 * sentence the screen calls fine is never one dispatch then rejects.
 */
export function unresolvedBenchMentions(text: string, attached: Iterable<string>): string[] {
  const riding = new Set(attached);
  const lost: string[] = [];
  for (const { token } of benchMentionsIn(text)) {
    if (!riding.has(token) && !lost.includes(token)) lost.push(token);
  }
  return lost;
}

// ---------------------------------------------------------------------------
// The request snapshot — immutable once a take is reserved. Selection and
// re-run read THIS, never the live composer, which is what makes an older
// take restorable after the composer has moved on.
// ---------------------------------------------------------------------------

export const BenchRequestSnapshotSchema = z
  .object({
    mode: BenchModeSchema,
    brief: z.string(),
    references: z.array(BenchReferenceTokenSchema),
    provider: z.string().min(1),
    model: z.string().min(1),
    /**
     * The recipe version, when the model is a local recipe (SPEC-021 R-13, R-15). The snapshot
     * is what re-run reads, and a recipe re-run must mean "that version", not "whatever the
     * catalogue holds now".
     */
    recipeVersion: z.number().int().min(1).optional(),
    params: BenchParamsSchema,
    /**
     * The keyframes that rode, in order, with their content hashes — the same self-contained
     * shape references take, so re-run resolves the exact frames without the live lane.
     */
    keyframes: z.array(BenchReferenceTokenSchema).default([]),
    /** Recorded only when one was asked for; providers do not universally return one. */
    requestedSeed: z.number().int().optional(),
    /** The production values frozen when this paid request was authorized. */
    productionProvenance: ProvenanceSchema.optional(),
    /** Fixed filing identities and segment boundaries for a subject-bound take. */
    filing: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("shot"),
            productionId: SlugSchema,
            sceneId: SceneIdSchema,
            shotId: ShotIdSchema,
            productionTakeId: TakeIdSchema,
            frameArtifactId: ArtifactIdSchema,
          })
          .strict(),
        z
          .object({
            kind: z.literal("board"),
            productionId: SlugSchema,
            sceneId: SceneIdSchema,
            productionTakeId: TakeIdSchema,
            members: z
              .array(
                z
                  .object({
                    shotId: ShotIdSchema,
                    number: z.number().int().min(1),
                    startSec: z.number().min(0),
                    endSec: z.number().positive(),
                    takeId: TakeIdSchema,
                  })
                  .strict(),
              )
              .min(1)
              .superRefine((members, ctx) => {
                const shots = new Set<string>();
                const takes = new Set<string>();
                for (const [index, member] of members.entries()) {
                  if (member.endSec <= member.startSec) {
                    ctx.addIssue({ code: "custom", path: [index, "endSec"], message: "a segment ends after it starts" });
                  }
                  if (shots.has(member.shotId)) {
                    ctx.addIssue({ code: "custom", path: [index, "shotId"], message: "a board files each shot once" });
                  }
                  if (takes.has(member.takeId)) {
                    ctx.addIssue({ code: "custom", path: [index, "takeId"], message: "a board gives each segment its own take" });
                  }
                  shots.add(member.shotId);
                  takes.add(member.takeId);
                }
                for (let index = 1; index < members.length; index++) {
                  if (members[index]!.startSec !== members[index - 1]!.endSec) {
                    ctx.addIssue({ code: "custom", path: [index, "startSec"], message: "board segments are contiguous" });
                  }
                }
              }),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.params.kind !== request.mode) {
      ctx.addIssue({ code: "custom", message: `params are for "${request.params.kind}" but the mode is "${request.mode}"` });
    }
    if (request.keyframes.length > 0 && request.mode !== "video") {
      ctx.addIssue({ code: "custom", message: "keyframes ride video, and nothing else" });
    }
    if (request.filing?.kind === "shot" && request.mode !== "image") {
      ctx.addIssue({ code: "custom", message: "shot filing belongs to an image request" });
    }
    if (request.filing?.kind === "board" && request.mode !== "video") {
      ctx.addIssue({ code: "custom", message: "board filing belongs to a video request" });
    }
    if ((request.filing === undefined) !== (request.productionProvenance === undefined)) {
      ctx.addIssue({ code: "custom", message: "production filing and provenance travel together" });
    }
    // minimax-music-3 declares `referenceImages: 0`. Refused at the snapshot rather than
    // dropped at dispatch, so a reference can never be attached, priced and silently ignored.
    if (request.references.length > 0 && request.mode === "music") {
      ctx.addIssue({ code: "custom", message: "a song takes no references" });
    }
  });
export type BenchRequestSnapshot = z.infer<typeof BenchRequestSnapshotSchema>;

// ---------------------------------------------------------------------------
// Takes
// ---------------------------------------------------------------------------

/**
 * "allocating" is the crash window the recovery saga exists for: the take number is reserved
 * and fsynced, and no job yet records having been enqueued. Everything after that is the
 * queue's own status vocabulary, carried whole rather than projected down to four states.
 */
export const BenchTakeStatusSchema = z.enum(["allocating", ...JobStatusSchema.options]);
export type BenchTakeStatus = z.infer<typeof BenchTakeStatusSchema>;

export const BenchTakeMediaSchema = z
  .object({
    /** Filename within the take's own media directory — never a path. */
    file: z.string().min(1),
    hash: Sha256Schema,
    info: MediaInfoSchema.optional(),
  })
  .strict();
export type BenchTakeMedia = z.infer<typeof BenchTakeMediaSchema>;

export const BenchTakeDispositionSchema = z.enum(["open", "filed", "discarded"]);
export type BenchTakeDisposition = z.infer<typeof BenchTakeDispositionSchema>;

export const BenchTakeSchema = z
  .object({
    id: TakeIdSchema,
    /** 1-based, in the order asked for, oldest first. A queued take holds its number. */
    n: z.number().int().min(1),
    /** Idempotency: a retried dispatch command re-reads this instead of minting a sibling. */
    requestId: z.string().min(1),
    jobId: JobIdSchema.optional(),
    status: BenchTakeStatusSchema,
    request: BenchRequestSnapshotSchema,
    media: BenchTakeMediaSchema.optional(),
    cost: TakeCostSchema.optional(),
    disposition: BenchTakeDispositionSchema,
    keptArtifactId: ArtifactIdSchema.optional(),
    /** Production take ids filed by Accept when this session has a subject. Parent first. */
    filedTakeIds: z.array(TakeIdSchema).min(1).optional(),
    /** Hidden from the wall. Presentation state — the bytes and the number both stay. */
    clearedFromView: z.boolean().optional(),
    error: z.string().optional(),
    createdAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.optional(),
  })
  .strict();
export type BenchTake = z.infer<typeof BenchTakeSchema>;

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export const BenchComposerSchema = z
  .object({
    mode: BenchModeSchema,
    provider: z.string(),
    /** Empty means no model chosen yet — a state the screen shows, never dispatches from. */
    model: z.string(),
    params: BenchParamsSchema,
    brief: z.string(),
    /** Tokens currently riding, in attach order. Every one resolves in the registry. */
    activeTokens: z.array(z.string().regex(BENCH_TOKEN)),
    /**
     * The Keyframe lane (issue 305 §3): image tokens the shot must pass through, in order —
     * one is the first frame, two are first and last, more are a keyframe sequence. A lane
     * beside activeTokens rather than a params field, deliberately: params are pushed whole
     * from a client draft, and a lane the coordinator allocates into must not be clobberable
     * by a debounced composer-set that never knew the token. Defaulted so every log written
     * before the lane existed still folds.
     */
    keyframeTokens: z.array(z.string().regex(BENCH_TOKEN)).default([]),
  })
  .strict();
export type BenchComposer = z.infer<typeof BenchComposerSchema>;

const BenchSubjectContextShape = {
  productionId: SlugSchema,
  productionTitle: z.string().min(1),
  episode: z
    .object({
      id: EpisodeIdSchema,
      order: z.number().int().min(1),
      title: z.string().min(1),
    })
    .strict()
    .optional(),
  sceneId: SceneIdSchema,
  sceneNumber: z.number().int().min(1),
  sceneTitle: z.string().min(1),
  /** Sheet versions whose words were assembled into the subject's prompt at prefill time. */
  promptSheetVersions: z.record(SlugSchema, z.number().int().min(1)).optional(),
} as const;

/** Stable production identity and current display/timing snapshots carried by a subject session. */
export const BenchSubjectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("shot"),
      ...BenchSubjectContextShape,
      shotId: ShotIdSchema,
      shotNumber: z.number().int().min(1),
      shotTitle: z.string().min(1),
      durationSec: z.number().positive(),
      aspect: z.string().min(1).max(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal("board"),
      ...BenchSubjectContextShape,
      letter: z.string().min(1).max(8),
      durationSec: z.number().positive(),
      aspect: z.string().min(1).max(20),
      /** The production route constraints that made these exact members one board. */
      packing: z
        .object({
          maxDurationSec: z.number().positive(),
          maxMembers: z.number().int().positive().optional(),
        })
        .strict(),
      members: z
        .array(
          z
            .object({
              shotId: ShotIdSchema,
              number: z.number().int().min(1),
              title: z.string().min(1),
              durationSec: z.number().positive(),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
]);
export type BenchSubject = z.infer<typeof BenchSubjectSchema>;

function sameBenchSubjectIdentity(left: BenchSubject, right: BenchSubject): boolean {
  if (
    left.kind !== right.kind ||
    left.productionId !== right.productionId ||
    left.sceneId !== right.sceneId
  ) {
    return false;
  }
  return left.kind === "shot" && right.kind === "shot"
    ? left.shotId === right.shotId
    : left.kind === "board" && right.kind === "board"
      ? left.members.map((member) => member.shotId).join("\n") ===
        right.members.map((member) => member.shotId).join("\n")
      : false;
}

export function benchSubjectTitle(subject: BenchSubject): string {
  const compact = (value: string): string =>
    value.length <= 32 ? value : `${value.slice(0, 29)}...`;
  const chain = [
    compact(subject.productionTitle),
    subject.episode ? `Episode ${subject.episode.order} · ${compact(subject.episode.title)}` : null,
    `Scene ${subject.sceneNumber} · ${compact(subject.sceneTitle)}`,
    subject.kind === "shot"
      ? `Shot ${subject.shotNumber}`
      : `Board ${subject.letter} · ${subject.members.length} shots · ${subject.durationSec}s · one pass`,
  ].filter((part): part is string => part !== null);
  return chain.join(" · ");
}

export const BenchSessionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: SessionIdSchema,
    subject: BenchSubjectSchema.optional(),
    /** Null renders as "Untitled session". */
    title: z.string().max(200).nullable(),
    composer: BenchComposerSchema,
    /**
     * Every token ever allocated, active or not. Inactive entries are retained so re-adding
     * the same source restores its old name instead of minting a new one — "Image 2" means the
     * same bytes for the whole life of the session, in every brief that ever cited it.
     */
    tokenRegistry: z.array(BenchReferenceTokenSchema),
    /** The current prefill's tokens; the registry also retains historical rebuild entries. */
    subjectTokens: z.array(z.string().regex(BENCH_TOKEN)).default([]),
    /** Next number per kind. Monotonic; never reused within the session. */
    nextToken: z.record(ReferenceKindSchema, z.number().int().min(1)),
    nextTake: z.number().int().min(1),
    selectedTakeId: TakeIdSchema.optional(),
    takes: z.array(BenchTakeSchema),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((session, ctx) => {
    const seenN = new Set<number>();
    const seenId = new Set<string>();
    const seenRequest = new Set<string>();
    for (const take of session.takes) {
      if (seenN.has(take.n)) ctx.addIssue({ code: "custom", message: `take number ${take.n} is used twice` });
      if (seenId.has(take.id)) ctx.addIssue({ code: "custom", message: `take id ${take.id} is used twice` });
      if (seenRequest.has(take.requestId)) {
        ctx.addIssue({ code: "custom", message: `take requestId ${take.requestId} is used twice` });
      }
      seenN.add(take.n);
      seenId.add(take.id);
      seenRequest.add(take.requestId);
      if (take.n >= session.nextTake) {
        ctx.addIssue({ code: "custom", message: `nextTake ${session.nextTake} does not clear allocated take ${take.n}` });
      }
      if (take.disposition === "filed" && take.keptArtifactId === undefined && take.filedTakeIds === undefined) {
        ctx.addIssue({ code: "custom", message: `take ${take.n} is filed but names no filed output` });
      }
      if (take.filedTakeIds !== undefined) {
        const expected =
          take.request.filing?.kind === "shot"
            ? [take.request.filing.productionTakeId]
            : take.request.filing?.kind === "board"
              ? [take.request.filing.productionTakeId, ...take.request.filing.members.map((member) => member.takeId)]
              : null;
        if (expected === null || expected.join("\n") !== take.filedTakeIds.join("\n")) {
          ctx.addIssue({ code: "custom", message: `take ${take.n} filed ids do not match its dispatch plan` });
        }
      }
    }
    if (session.selectedTakeId !== undefined && !seenId.has(session.selectedTakeId)) {
      ctx.addIssue({ code: "custom", message: "selectedTakeId names no take in this session" });
    }
    const tokens = new Set<string>();
    const sources = new Set<string>();
    for (const entry of session.tokenRegistry) {
      if (tokens.has(entry.token)) ctx.addIssue({ code: "custom", message: `token "${entry.token}" is allocated twice` });
      tokens.add(entry.token);
      const key = benchSourceKey(entry.source);
      if (sources.has(key)) ctx.addIssue({ code: "custom", message: `source ${key} carries two tokens` });
      sources.add(key);
      const parsed = parseBenchToken(entry.token);
      if (parsed !== null) {
        const next = session.nextToken[parsed.kind] ?? 1;
        if (parsed.n >= next) {
          ctx.addIssue({ code: "custom", message: `nextToken.${parsed.kind} ${next} does not clear "${entry.token}"` });
        }
      }
    }
    const currentSubjectTokens = new Set<string>();
    for (const token of session.subjectTokens) {
      if (currentSubjectTokens.has(token)) {
        ctx.addIssue({ code: "custom", message: `subject token "${token}" is current twice` });
      }
      currentSubjectTokens.add(token);
      if (!tokens.has(token)) ctx.addIssue({ code: "custom", message: `subject token "${token}" is not in the registry` });
    }
    const active = new Set<string>();
    for (const token of session.composer.activeTokens) {
      if (active.has(token)) ctx.addIssue({ code: "custom", message: `token "${token}" is active twice` });
      active.add(token);
      if (!tokens.has(token)) ctx.addIssue({ code: "custom", message: `active token "${token}" is not in the registry` });
    }
    const frames = new Set<string>();
    for (const token of session.composer.keyframeTokens) {
      if (frames.has(token)) ctx.addIssue({ code: "custom", message: `token "${token}" rides the keyframe lane twice` });
      frames.add(token);
      if (!tokens.has(token)) ctx.addIssue({ code: "custom", message: `keyframe token "${token}" is not in the registry` });
      const entry = session.tokenRegistry.find((e) => e.token === token);
      if (entry !== undefined && entry.kind !== "image") {
        ctx.addIssue({ code: "custom", message: `keyframe token "${token}" is ${entry.kind} — only an image can ride as a keyframe` });
      }
    }
    if (session.composer.params.kind !== session.composer.mode) {
      ctx.addIssue({ code: "custom", message: "composer params do not match the composer mode" });
    }
    if (session.subject?.kind === "shot" && session.composer.mode !== "image") {
      ctx.addIssue({ code: "custom", message: "a shot subject uses image mode" });
    }
    if (session.subject?.kind === "board" && session.composer.mode !== "video") {
      ctx.addIssue({ code: "custom", message: "a board subject uses video mode" });
    }
  });
export type BenchSession = z.infer<typeof BenchSessionSchema>;

/** What the world bundle carries: enough to resume, never the takes themselves. */
export const BenchSessionSummarySchema = z
  .object({
    id: SessionIdSchema,
    /** Present only for production-bound sessions; the id-less Bench never resumes one. */
    subject: BenchSubjectSchema.optional(),
    title: z.string().max(200).nullable(),
    mode: BenchModeSchema,
    updatedAt: IsoDateTimeSchema,
    takeCount: z.number().int().min(0),
    runningCount: z.number().int().min(0),
    failedCount: z.number().int().min(0),
  })
  .strict();
export type BenchSessionSummary = z.infer<typeof BenchSessionSummarySchema>;

/** The loaded workspace on ClientState — one session at a time, like World Chat's. */
export const BenchWorkspaceSchema = z
  .object({
    worldId: z.string().min(1),
    session: BenchSessionSchema,
  })
  .strict();
export type BenchWorkspace = z.infer<typeof BenchWorkspaceSchema>;

// ---------------------------------------------------------------------------
// The event log
// ---------------------------------------------------------------------------

export const BenchSessionMetaSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: SessionIdSchema,
    createdAt: IsoDateTimeSchema,
    subject: BenchSubjectSchema.optional(),
  })
  .strict();
export type BenchSessionMeta = z.infer<typeof BenchSessionMetaSchema>;

/**
 * The reservation is its own event, fsynced before any job exists, because it is the record
 * that authorizes provider spend: recovery finding a reserved take with no job knows the crash
 * happened before enqueue and nothing was charged. Count N reserves N in one event so sibling
 * numbers are consecutive whatever lands between them.
 */
export const BenchReservedTakeSchema = z
  .object({
    id: TakeIdSchema,
    n: z.number().int().min(1),
    requestId: z.string().min(1),
    request: BenchRequestSnapshotSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type BenchReservedTake = z.infer<typeof BenchReservedTakeSchema>;

export const BenchEventSchema = z.discriminatedUnion("type", [
  /** One durable prefill: a subject session never opens with half its prompt or references. */
  z
    .object({
      type: z.literal("subject-prefill-set"),
      subject: BenchSubjectSchema,
      title: z.string().min(1).max(200),
      composer: BenchComposerSchema,
      references: z.array(BenchReferenceTokenSchema),
    })
    .strict(),
  z.object({ type: z.literal("title-set"), title: z.string().max(200).nullable() }).strict(),
  z
    .object({
      type: z.literal("composer-set"),
      mode: BenchModeSchema,
      provider: z.string(),
      model: z.string(),
      params: BenchParamsSchema,
      brief: z.string(),
      subjectRouting: z
        .object({
          activeTokens: z.array(z.string().regex(BENCH_TOKEN)),
          keyframeTokens: z.array(z.string().regex(BENCH_TOKEN)),
        })
        .strict()
        .optional(),
    })
    .strict(),
  /** `lane` absent means the reference lane — every event written before the Keyframe lane. */
  z
    .object({
      type: z.literal("reference-added"),
      entry: BenchReferenceTokenSchema,
      lane: z.enum(["reference", "keyframe"]).optional(),
    })
    .strict(),
  /** Re-adding a source whose token already exists in the registry: the old name comes back. */
  z
    .object({
      type: z.literal("reference-restored"),
      token: z.string().regex(BENCH_TOKEN),
      lane: z.enum(["reference", "keyframe"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("reference-removed"),
      token: z.string().regex(BENCH_TOKEN),
      lane: z.enum(["reference", "keyframe"]).optional(),
    })
    .strict(),
  /** The at-capacity path: one out, one in, atomically, so the set is never over the ceiling. */
  z
    .object({
      type: z.literal("reference-replaced"),
      removed: z.string().regex(BENCH_TOKEN),
      entry: BenchReferenceTokenSchema,
    })
    .strict(),
  z.object({ type: z.literal("takes-reserved"), takes: z.array(BenchReservedTakeSchema).min(1) }).strict(),
  z.object({ type: z.literal("take-job"), takeId: TakeIdSchema, jobId: JobIdSchema }).strict(),
  z
    .object({
      type: z.literal("take-status"),
      takeId: TakeIdSchema,
      status: JobStatusSchema,
      error: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("take-completed"),
      takeId: TakeIdSchema,
      media: BenchTakeMediaSchema,
      cost: TakeCostSchema.optional(),
      completedAt: IsoDateTimeSchema,
    })
    .strict(),
  z.object({ type: z.literal("take-filed"), takeId: TakeIdSchema, artifactId: ArtifactIdSchema }).strict(),
  z
    .object({
      type: z.literal("take-subject-filed"),
      takeId: TakeIdSchema,
      productionTakeIds: z.array(TakeIdSchema).min(1),
      artifactId: ArtifactIdSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("take-discarded"), takeId: TakeIdSchema }).strict(),
  z.object({ type: z.literal("take-cleared"), takeId: TakeIdSchema }).strict(),
  z.object({ type: z.literal("take-selected"), takeId: TakeIdSchema }).strict(),
]);
export type BenchEvent = z.infer<typeof BenchEventSchema>;

export const BenchEventEnvelopeSchema = z
  .object({
    seq: z.number().int().min(1),
    at: IsoDateTimeSchema,
    /** Carried when a client command asked for this, so a resent command deduplicates. */
    requestId: z.string().min(1).optional(),
    event: BenchEventSchema,
  })
  .strict();
export type BenchEventEnvelope = z.infer<typeof BenchEventEnvelopeSchema>;

// ---------------------------------------------------------------------------
// The fold — events in, session out. Pure, shared by the coordinator's writer
// and any test that wants to assert what a log means.
// ---------------------------------------------------------------------------

const EMPTY_COMPOSER: BenchComposer = {
  mode: "image",
  provider: "",
  model: "",
  params: { kind: "image", count: 1 },
  brief: "",
  activeTokens: [],
  keyframeTokens: [],
};

export function foldBenchSession(meta: BenchSessionMeta, envelopes: readonly BenchEventEnvelope[]): BenchSession {
  const session: BenchSession = {
    schemaVersion: 1,
    id: meta.id,
    ...(meta.subject !== undefined ? { subject: meta.subject } : {}),
    title: null,
    composer: { ...EMPTY_COMPOSER, params: { ...EMPTY_COMPOSER.params } as BenchParams, activeTokens: [], keyframeTokens: [] },
    tokenRegistry: [],
    subjectTokens: [],
    nextToken: {},
    nextTake: 1,
    takes: [],
    createdAt: meta.createdAt,
    updatedAt: meta.createdAt,
  };
  const takesById = new Map<string, BenchTake>();
  const claimToken = (entry: BenchReferenceToken): void => {
    session.tokenRegistry.push(entry);
    const parsed = parseBenchToken(entry.token);
    if (parsed !== null) {
      const next = session.nextToken[parsed.kind] ?? 1;
      if (parsed.n >= next) session.nextToken[parsed.kind] = parsed.n + 1;
    }
  };
  // Each lane activates into its own list; the registry underneath them is one.
  const activate = (token: string, lane: "reference" | "keyframe" = "reference"): void => {
    const list = lane === "keyframe" ? session.composer.keyframeTokens : session.composer.activeTokens;
    if (!list.includes(token)) list.push(token);
  };
  for (const { at, event } of envelopes) {
    session.updatedAt = at;
    switch (event.type) {
      case "subject-prefill-set":
        // Rebuild refreshes script-derived snapshots but cannot turn one durable production
        // subject into another, even if a malformed log record names a different target.
        if (session.subject === undefined || !sameBenchSubjectIdentity(session.subject, event.subject)) break;
        session.subject = event.subject;
        session.title = event.title;
        // Rebuild replaces what rides now, not the registry's history. Old take snapshots cite
        // the tokens they were made with, and dropping those entries made selecting one restore
        // its words against newly numbered pictures. Reuse a token for the same source, allocate
        // around collisions for a new source, and keep entries no longer in the current prefill.
        {
          const remapped = new Map<string, string>();
          for (const incoming of event.references) {
            const sourceKey = benchSourceKey(incoming.source);
            const existingIndex = session.tokenRegistry.findIndex(
              (entry) => benchSourceKey(entry.source) === sourceKey,
            );
            if (existingIndex >= 0) {
              const token = session.tokenRegistry[existingIndex]!.token;
              session.tokenRegistry[existingIndex] = { ...incoming, token };
              remapped.set(incoming.token, token);
              continue;
            }
            let entry = incoming;
            if (session.tokenRegistry.some((candidate) => candidate.token === incoming.token)) {
              entry = {
                ...incoming,
                token: benchTokenFor(incoming.kind, session.nextToken[incoming.kind] ?? 1),
              };
            }
            claimToken(entry);
            remapped.set(incoming.token, entry.token);
          }
          session.composer = {
            ...event.composer,
            params: { ...event.composer.params } as BenchParams,
            brief: (() => {
              let brief = "";
              let at = 0;
              for (const mention of benchMentionsIn(event.composer.brief)) {
                const token = remapped.get(mention.token);
                if (token === undefined) continue;
                brief += event.composer.brief.slice(at, mention.start) + benchMentionFor(token);
                at = mention.end;
              }
              return brief + event.composer.brief.slice(at);
            })(),
            activeTokens: event.composer.activeTokens.map((token) => remapped.get(token) ?? token),
            keyframeTokens: event.composer.keyframeTokens.map((token) => remapped.get(token) ?? token),
          };
          session.subjectTokens = event.references.map((entry) => remapped.get(entry.token) ?? entry.token);
        }
        break;
      case "title-set":
        session.title = event.title;
        break;
      case "composer-set":
        session.composer = {
          mode: event.mode,
          provider: event.provider,
          model: event.model,
          params: event.params,
          brief: event.brief,
          activeTokens: event.subjectRouting?.activeTokens ?? session.composer.activeTokens,
          keyframeTokens: event.subjectRouting?.keyframeTokens ?? session.composer.keyframeTokens,
        };
        break;
      case "reference-added":
        claimToken(event.entry);
        activate(event.entry.token, event.lane ?? "reference");
        break;
      case "reference-restored":
        if (session.subject !== undefined) {
          const restored = session.tokenRegistry.find((entry) => entry.token === event.token);
          if (restored?.subjectRole !== undefined && !session.subjectTokens.includes(event.token)) {
            session.subjectTokens.push(event.token);
          }
        }
        activate(event.token, event.lane ?? "reference");
        break;
      case "reference-removed":
        session.subjectTokens = session.subjectTokens.filter((t) => t !== event.token);
        if ((event.lane ?? "reference") === "keyframe") {
          session.composer.keyframeTokens = session.composer.keyframeTokens.filter((t) => t !== event.token);
        } else {
          session.composer.activeTokens = session.composer.activeTokens.filter((t) => t !== event.token);
        }
        break;
      case "reference-replaced":
        session.composer.activeTokens = session.composer.activeTokens.filter((t) => t !== event.removed);
        session.subjectTokens = session.subjectTokens.filter((t) => t !== event.removed);
        claimToken(event.entry);
        activate(event.entry.token);
        break;
      case "takes-reserved":
        for (const reserved of event.takes) {
          const take: BenchTake = {
            id: reserved.id,
            n: reserved.n,
            requestId: reserved.requestId,
            status: "allocating",
            request: reserved.request,
            disposition: "open",
            createdAt: reserved.createdAt,
          };
          session.takes.push(take);
          takesById.set(take.id, take);
          if (reserved.n >= session.nextTake) session.nextTake = reserved.n + 1;
          session.selectedTakeId = take.id;
        }
        break;
      case "take-job": {
        const take = takesById.get(event.takeId);
        if (take) {
          take.jobId = event.jobId;
          if (take.status === "allocating") take.status = "queued";
        }
        break;
      }
      case "take-status": {
        const take = takesById.get(event.takeId);
        if (take) {
          take.status = event.status;
          if (event.error !== undefined) take.error = event.error;
        }
        break;
      }
      case "take-completed": {
        const take = takesById.get(event.takeId);
        if (take) {
          take.status = "succeeded";
          take.media = event.media;
          if (event.cost !== undefined) take.cost = event.cost;
          take.completedAt = event.completedAt;
          session.selectedTakeId = take.id;
          // A start frame is spent by the take that used it. Nothing used to retire one, so it
          // sat in the lane for every request after — invisible unless the Keyframe tab happened
          // to be open, and fatal to the next request that also carried references, which is
          // refused outright ("References and keyframes cannot ride one request yet"). Someone
          // adding a reference for a new shot met a refusal naming frames they could not see.
          //
          // Exactly the tokens that rode, not the whole lane: a frame staged for the NEXT take
          // while this one was in flight is a live choice and survives. The take's own request
          // snapshot keeps its copy, so re-run still replays the frames it was made with.
          if (take.request.keyframes.length > 0) {
            const spent = new Set(take.request.keyframes.map((entry) => entry.token));
            // Production-owned board frames describe the durable subject, so they remain visible
            // and ready for its next take. Only ad hoc session keyframes are one-use choices.
            const subjectOwned = new Set(session.subjectTokens);
            session.composer.keyframeTokens = session.composer.keyframeTokens.filter(
              (token) => !spent.has(token) || subjectOwned.has(token),
            );
          }
        }
        break;
      }
      case "take-filed": {
        const take = takesById.get(event.takeId);
        if (take) {
          take.disposition = "filed";
          take.keptArtifactId = event.artifactId;
        }
        break;
      }
      case "take-subject-filed": {
        const take = takesById.get(event.takeId);
        if (take) {
          take.disposition = "filed";
          take.filedTakeIds = event.productionTakeIds;
          if (event.artifactId !== undefined) take.keptArtifactId = event.artifactId;
        }
        break;
      }
      case "take-discarded": {
        const take = takesById.get(event.takeId);
        if (take) take.disposition = "discarded";
        break;
      }
      case "take-cleared": {
        const take = takesById.get(event.takeId);
        if (take) take.clearedFromView = true;
        break;
      }
      case "take-selected":
        if (takesById.has(event.takeId)) session.selectedTakeId = event.takeId;
        break;
    }
  }
  return session;
}

/** The summary a world bundle carries, derived the one way everywhere. */
export function benchSessionSummary(session: BenchSession): BenchSessionSummary {
  const running = session.takes.filter(
    (t) => t.status === "allocating" || t.status === "queued" || t.status === "submitting" || t.status === "running",
  ).length;
  const failed = session.takes.filter((t) => t.status === "failed" || t.status === "needs-reconciliation").length;
  return {
    id: session.id,
    ...(session.subject !== undefined ? { subject: session.subject } : {}),
    title: session.title,
    mode: session.composer.mode,
    updatedAt: session.updatedAt,
    takeCount: session.takes.length,
    runningCount: running,
    failedCount: failed,
  };
}

// ---------------------------------------------------------------------------
// The Keyframe lane's plan — shared by the composer that offers the tab and
// the dispatch gate that enqueues, so a lane the screen admitted is a lane
// the coordinator would have admitted (issue 305 §3).
// ---------------------------------------------------------------------------

export const FRAME_TASK_MODES = ["first-frame", "first-and-last-frame", "keyframe-sequence"] as const satisfies readonly TaskMode[];

/** The frame modes this model actually declares. Empty means no Keyframe tab exists. */
export function frameTaskModes(model: ManifestModel): TaskMode[] {
  return FRAME_TASK_MODES.filter((mode) => supportsMode(model, mode));
}

export type KeyframePlan = { ok: true; mode: TaskMode } | { ok: false; reason: string };

/**
 * Which task mode a keyframe count dispatches as: one frame is the first frame, two are first
 * and last, more are a sequence. The mapping is strict — riding two frames on a sequence route
 * would change what they mean — and every refusal is worded, because availability "derived from
 * verified task modes" (issue 305 §3) has to say which verification is missing. A sequence
 * whose route declares no `maxFrames` refuses past two: probing a paid route for its ceiling
 * is not verification.
 */
export function keyframePlan(model: ManifestModel, count: number): KeyframePlan {
  if (count <= 0) return { ok: false, reason: "no keyframes ride this request" };
  const mode: TaskMode = count === 1 ? "first-frame" : count === 2 ? "first-and-last-frame" : "keyframe-sequence";
  if (!supportsMode(model, mode)) {
    return { ok: false, reason: modeUnavailableReason(model, mode) ?? `${model.displayName} has no ${mode} route` };
  }
  if (mode === "keyframe-sequence") {
    const ceiling = modeSpec(model, mode)?.maxFrames;
    if (ceiling === undefined) {
      return { ok: false, reason: `${model.displayName}'s keyframe sequence declares no ceiling, so ${count} frames cannot be admitted` };
    }
    if (count > ceiling) {
      return { ok: false, reason: `${model.displayName} takes at most ${ceiling} keyframes` };
    }
  }
  return { ok: true, mode };
}

/** The most frames one more pick may bring the lane to, for the tile that offers the pick. */
export function keyframeCapacity(model: ManifestModel): number {
  const sequenceCeiling = supportsMode(model, "keyframe-sequence")
    ? (modeSpec(model, "keyframe-sequence")?.maxFrames ?? 2)
    : 0;
  const pairCeiling = supportsMode(model, "first-and-last-frame") ? 2 : 0;
  const singleCeiling = supportsMode(model, "first-frame") ? 1 : 0;
  return Math.max(sequenceCeiling, pairCeiling, singleCeiling);
}

// ---------------------------------------------------------------------------
// Presets (issue 305 §3): a saved dispatch setup — model, controls, and an
// optional brief scaffold — app-level, because what makes a good setup is the
// model's, not any one world's.
// ---------------------------------------------------------------------------

export const BenchPresetSchema = z
  .object({
    id: PresetIdSchema,
    /** The name the menu shows. Saving under an existing name replaces that preset. */
    name: z.string().min(1).max(80),
    mode: BenchModeSchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    params: BenchParamsSchema,
    /** A brief to start from. Absent means the preset sets controls and leaves the words alone. */
    brief: z.string().max(100_000).optional(),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((preset, ctx) => {
    if (preset.params.kind !== preset.mode) {
      ctx.addIssue({ code: "custom", message: `preset params are for "${preset.params.kind}" but the mode is "${preset.mode}"` });
    }
  });
export type BenchPreset = z.infer<typeof BenchPresetSchema>;

export type PresetFault = { ok: true } | { ok: false; reason: string };

/**
 * Whether a preset can be applied under this manifest — stated, never repaired. A preset whose
 * model left the manifest or is switched off shows its reason in the menu rather than vanishing:
 * hiding saved work reads as losing it (the routing-faults posture, SPEC-008 §2.7).
 */
export function presetFault(
  preset: BenchPreset,
  manifest: { models: readonly ManifestModel[] } | null,
  disabled: readonly string[],
  /** Providers whose stored key unlocks this capability. Absent = do not judge credentials. */
  unlocked?: readonly string[],
): PresetFault {
  const model = manifest?.models.find((m) => m.id === preset.model && m.provider === preset.provider);
  if (!model) return { ok: false, reason: `"${preset.model}" is no longer in the manifest` };
  if (model.capability !== modeCapability(preset.mode)) {
    return { ok: false, reason: `${model.displayName} is a ${model.capability} model, not ${preset.mode}` };
  }
  if (disabled.includes(preset.model)) {
    return { ok: false, reason: `${model.displayName} is switched off in Providers` };
  }
  if (unlocked !== undefined && !unlocked.includes(preset.provider) && PROVIDERS[model.provider]?.local !== true) {
    return { ok: false, reason: `no provider key unlocks ${model.displayName}` };
  }
  return { ok: true };
}

/**
 * Whether one more frame can be picked at this count — reachability, not the next count's
 * legality. A mode set with a gap (first-frame and a sequence, no first-and-last) must be
 * fillable THROUGH its illegal middle: the pick is admitted when any larger count the lane
 * can grow to dispatches legally, and the composer states the middle's refusal until it does.
 */
export function keyframeAddable(model: ManifestModel, count: number): boolean {
  const ceiling = keyframeCapacity(model);
  for (let n = count + 1; n <= ceiling; n++) {
    if (keyframePlan(model, n).ok) return true;
  }
  return false;
}
