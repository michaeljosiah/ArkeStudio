import { z } from "zod";
import { PUBLICATION_MANIFEST_FILE, PublicationAssetPathSchema } from "./publication.js";
import { StoryEffectSchema, StoryPredicateSchema, type StoryPredicate } from "./story-state-schema.js";
import { validateStoryProgram, type StoryProgram } from "./story-state.js";

/**
 * Arke Player's world package (Player ADR 0005; SPEC-058 R-9 – R-16): `world.json` at a ZIP's root,
 * naming the world as published and its productions, each made of files the Player plays, with an
 * inventory of every file. Schema 2 adds a production's listening document: the illustrated
 * narration as data, a file a chapter with its pictures and phrases. Schema 3 (SPEC-059 R-9, R-10)
 * adds the world's guide, and lets a package carry the guide alone, so a world can be explored
 * before it is installed. Schema 4 (SPEC-058 R-46) is a part: the chapters released since an
 * edition, naming that edition, so a serial's listener never downloads the world again. Schema 5
 * (R-68 – R-70) is a production package: one production published alone, beside the world's
 * edition, which may be a music production with its music document. Schema 6 (R-79, R-80) is a
 * story package: an interactive movie or a visual novel published alone, with its story document.
 *
 * One reader in two languages (R-16): this one and Arke Player's `arke_world` (Dart) read the same
 * shared fixtures to the same verdicts. Both are strict as SPEC-048 R-17 asks: a key, schema or
 * required capability a reader does not know is `newer-arke`, never skipped; only `metadata` (and
 * world.json's `provenance`) may be ignored. Anything else wrong is `not-a-package`.
 *
 * These validators describe a package. Whether its files exist and match their hashes is the host's
 * check, as for a publication.
 */

export const WORLD_MANIFEST_FILE = "world.json";
export const WORLD_PACKAGE_FORMAT = "arke-world-package";
export const WORLD_SCHEMA_VERSION = 6;
export const LISTENING_MEDIA_TYPE = "application/vnd.arke.listening+json";
export const LISTENING_FORMAT = "arke-listening";
export const LISTENING_VERSION = 1;
export const MUSIC_MEDIA_TYPE = "application/vnd.arke.music+json";
export const MUSIC_FORMAT = "arke-music";
export const MUSIC_VERSION = 1;
/** A music production's kinds (SPEC-060 R-1): tracks in order, one song, or tracks for one production. */
export const MUSIC_KINDS = ["album", "single", "soundtrack"] as const;
export type MusicKind = (typeof MUSIC_KINDS)[number];
export const MUSIC_AUDIO_MEDIA_TYPES: readonly string[] = ["audio/mp4"];
export const MAX_MUSIC_TRACKS = 64;
/** A track is a song, not an hour (R-70). */
export const MAX_MUSIC_TRACK_MS = 15 * 60_000;
export const STORY_MEDIA_TYPE = "application/vnd.arke.story+json";
export const STORY_FORMAT = "arke-story";
export const STORY_VERSION = 1;

/** A world's media, by the role it plays. */
export const WORLD_BOOK_MEDIA_TYPES: readonly string[] = ["application/epub+zip"];
export const WORLD_NARRATION_MEDIA_TYPES: readonly string[] = ["audio/mp4", "audio/x-m4b", "audio/mpeg"];
export const WORLD_PICTURE_MEDIA_TYPES: readonly string[] = ["image/jpeg", "image/png"];

/**
 * The long side a package's narration pictures ship at (design turn 235d, SPEC-058 R-41): `full` is
 * R-6's 2048, the default. Key art, the cover and the production's picture always ship at full.
 */
export const ARKE_PLAYER_PICTURE_SIZES = ["full", "1280", "960"] as const;
export type ArkePlayerPictureSize = (typeof ARKE_PLAYER_PICTURE_SIZES)[number];
export const arkePlayerPictureEdge = (size: ArkePlayerPictureSize | undefined): number | undefined => (size === "1280" ? 1280 : size === "960" ? 960 : undefined);
export const LISTENING_AUDIO_MEDIA_TYPES: readonly string[] = ["audio/mp4"];
export const LISTENING_MOTION_MEDIA_TYPES: readonly string[] = ["video/mp4"];

export const MAX_WORLD_ASSETS = 4096;
const MAX_ASSET_BYTES = 64 * 1024 ** 3;
const MAX_CHAPTERS = 1000;
const MAX_PICTURES = 2000;
const MAX_PHRASES = 20000;

export type WorldRefusal = "not-a-package" | "newer-arke";

/** A Studio slug as a package id: the same vocabulary, at most 64 long. */
export const packageSlug = (slug: string) => slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 64).replace(/-+$/, "") || "world";

const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const text = (max: number) => z.string().max(max).refine((value) => value.trim().length > 0);
const TicksSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Ignorable = z.unknown().optional();

/** A package path: a publication's portable vocabulary, never `world.json` itself. */
export const WorldAssetPathSchema = PublicationAssetPathSchema.refine(
  (path) => path.split("/")[0]!.toLowerCase() !== WORLD_MANIFEST_FILE && path.split("/")[0]!.toLowerCase() !== PUBLICATION_MANIFEST_FILE,
);

export const WorldAssetSchema = z.object({
  path: WorldAssetPathSchema,
  mediaType: z.string(),
  byteLength: z.number().int().nonnegative().max(MAX_ASSET_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type WorldAsset = z.infer<typeof WorldAssetSchema>;

const productionShape = {
  id: SlugSchema,
  title: text(200),
  author: text(200).optional(),
  picture: z.string().optional(),
  book: z.string().optional(),
  narration: z.string().optional(),
  metadata: Ignorable,
};
const ProductionV1Schema = z.object(productionShape).strict();
const ProductionV2Schema = z.object({ ...productionShape, listening: z.string().optional() }).strict();
// Schema 5 lets a production be music: its music document in place of a book or a narration (R-69).
const ProductionV5Schema = z.object({ ...productionShape, listening: z.string().optional(), music: z.string().optional() }).strict();
// Schema 6 lets a production be an interactive story: its story document in place of the others,
// and its Tall cover beside its wide one (R-79).
const ProductionV6Schema = ProductionV5Schema.extend({ story: z.string().optional(), tall: z.string().optional() }).strict();
export type WorldProduction = z.infer<typeof ProductionV6Schema>;

const manifestFields = {
  format: z.literal(WORLD_PACKAGE_FORMAT),
  schemaVersion: z.number().int(),
  id: SlugSchema,
  edition: text(64),
  name: text(200),
  logline: text(400).optional(),
  keyArt: z.string().optional(),
  assets: z.record(z.string(), WorldAssetSchema),
  requires: z.array(z.unknown()).max(0).optional(),
  metadata: Ignorable,
  provenance: Ignorable,
};
const ManifestV1Schema = z.object({ ...manifestFields, productions: z.array(ProductionV1Schema).min(1).max(64) }).strict();
const ManifestV2Schema = z.object({ ...manifestFields, productions: z.array(ProductionV2Schema).min(1).max(64) }).strict();
// A guide alone carries no production (R-10); that it carries something is checked once read.
const ManifestV3Schema = z.object({ ...manifestFields, productions: z.array(ProductionV2Schema).max(64), guide: z.string().optional() }).strict();

/** The days an author's schedule may name (SPEC-058 R-48): a weekday, or every day. */
export const PART_SCHEDULE_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "daily"] as const;
export type PartScheduleDay = (typeof PART_SCHEDULE_DAYS)[number];
/** A calendar day, `2026-11-06`, that exists. */
export const CalendarDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((day) => {
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(day);
});
/** The author's word on when new chapters come (R-48), never a promise the Studio keeps. */
export const PartScheduleSchema = z.object({ day: z.enum(PART_SCHEDULE_DAYS).optional(), next: CalendarDaySchema.optional() }).strict();
export type PartSchedule = z.infer<typeof PartScheduleSchema>;
/**
 * What makes a package a part (R-46): the edition it was made after, by label and fingerprint, so
 * it can never land on another world's edition, and its place among the parts after that edition.
 */
export const WorldPartSchema = z.object({
  follows: text(64),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  number: z.number().int().min(1),
  schedule: PartScheduleSchema.optional(),
}).strict();
export type WorldPart = z.infer<typeof WorldPartSchema>;
// A part says so; that it carries one production and no guide is checked once read, as not an Arke
// package rather than newer.
const ManifestV4Schema = z.object({ ...manifestFields, productions: z.array(ProductionV2Schema).max(64), guide: z.string().optional(), part: WorldPartSchema.optional() }).strict();
// A production package says so with `alone`; that it carries one production, and no guide, key art
// or part, is checked once read, as not an Arke package rather than newer.
const ManifestV5Schema = z.object({
  ...manifestFields,
  productions: z.array(ProductionV5Schema).max(64),
  guide: z.string().optional(),
  part: WorldPartSchema.optional(),
  alone: z.boolean().optional(),
}).strict();
const ManifestV6Schema = ManifestV5Schema.extend({ productions: z.array(ProductionV6Schema).max(64) }).strict();

export interface WorldManifest {
  schemaVersion: number;
  id: string;
  edition: string;
  name: string;
  logline?: string;
  keyArt?: string;
  productions: WorldProduction[];
  /** The guide document's asset id (SPEC-059 R-9). */
  guide?: string;
  /** Present on a part, schema 4 (SPEC-058 R-46). */
  part?: WorldPart;
  /** True on a production package, schema 5, and a story package, schema 6: one production published alone (SPEC-058 R-68, R-79). */
  alone?: boolean;
  assets: Record<string, WorldAsset>;
}

export type WorldManifestRead = { ok: true; manifest: WorldManifest } | { ok: false; refusal: WorldRefusal; reason: string };

/** The first issue decides, as the Dart reader stops at the first thing wrong: a key it does not know is newer. */
function refusedBy(error: z.ZodError, what: string): { ok: false; refusal: WorldRefusal; reason: string } {
  const issue = error.issues[0]!;
  const where = `${what}${issue.path.length > 0 ? ` ${issue.path.join(".")}` : ""}`;
  return issue.code === "unrecognized_keys" ? { ok: false, refusal: "newer-arke", reason: `${where} keys ${issue.keys.join(", ")}` } : { ok: false, refusal: "not-a-package", reason: where };
}

/** Reads `world.json`'s text (SPEC-058 R-9, R-15; Player ADR 0005). */
export function readWorldManifest(source: string): WorldManifestRead {
  const notAPackage = (reason: string) => ({ ok: false as const, refusal: "not-a-package" as const, reason });
  const newer = (reason: string) => ({ ok: false as const, refusal: "newer-arke" as const, reason });
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    return notAPackage("world.json is not JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return notAPackage("world.json is not an object");
  const raw = json as Record<string, unknown>;
  if (raw["format"] !== WORLD_PACKAGE_FORMAT) return notAPackage(`not an ${WORLD_PACKAGE_FORMAT}`);
  const version = raw["schemaVersion"];
  if (typeof version !== "number" || !Number.isInteger(version)) return notAPackage("no schema version");
  if (version > WORLD_SCHEMA_VERSION) return newer(`schema version ${version}`);
  if (version < 1) return notAPackage(`schema version ${version}`);
  const requires = raw["requires"] ?? [];
  if (!Array.isArray(requires)) return notAPackage("requires is not a list");
  if (requires.length > 0) return newer(`requires ${requires.join(", ")}`);

  const parsed = (version >= 6 ? ManifestV6Schema : version === 5 ? ManifestV5Schema : version === 4 ? ManifestV4Schema : version === 3 ? ManifestV3Schema : version === 2 ? ManifestV2Schema : ManifestV1Schema).safeParse(raw);
  if (!parsed.success) return refusedBy(parsed.error, "world.json");
  // Every older manifest is a schema 6 one with less in it.
  const manifest: z.infer<typeof ManifestV6Schema> = parsed.data;
  const guide = manifest.guide;
  if (manifest.productions.length === 0 && guide === undefined) return notAPackage("productions");
  if (version === 4) {
    // Schema 4 exists for parts (R-46); an edition is still made at 2 or 3.
    if (manifest.part === undefined) return notAPackage("a schema 4 package is a part");
    if (guide !== undefined) return notAPackage("a part carries no guide");
    if (manifest.productions.length !== 1) return notAPackage("a part extends one production");
    // A single narration file cannot be added to: a part's chapters come as a listening document.
    if (manifest.productions[0]!.narration !== undefined) return notAPackage("a part names no narration");
  }
  if (version >= 5) {
    // Schema 5 exists for production packages (R-68): one production published alone, beside the
    // world's edition, which carries the world's guide and key art; a part is still made at 4.
    if (manifest.alone !== true) return notAPackage(`a schema ${version} package is a production published alone`);
    if (manifest.part !== undefined) return notAPackage("a production package is not a part");
    if (guide !== undefined) return notAPackage("a production package carries no guide");
    if (manifest.keyArt !== undefined) return notAPackage("a production package carries no key art");
    if (manifest.productions.length !== 1) return notAPackage("a production package holds one production");
  }
  // Schema 6 exists for stories (R-79), as 5 does for production packages: music is still made at 5,
  // so a Player that reads 5 and not 6 is never kept from a package it could play.
  if (version >= 6 && manifest.productions[0]!.story === undefined) return notAPackage("a schema 6 package is a story published alone");

  const assetIds = Object.keys(manifest.assets);
  if (assetIds.length === 0 || assetIds.length > MAX_WORLD_ASSETS) return notAPackage("assets");
  const paths = new Set<string>();
  for (const [assetId, asset] of Object.entries(manifest.assets)) {
    if (!SlugSchema.safeParse(assetId).success) return notAPackage(`asset ${assetId}`);
    // Unique after case folding, so no two assets are one file on a case-insensitive phone.
    if (paths.has(asset.path.toLowerCase())) return notAPackage(`asset ${assetId} path repeats`);
    paths.add(asset.path.toLowerCase());
  }

  const used = new Set<string>();
  const role = (assetId: string | undefined, mediaTypes: readonly string[]) => {
    if (assetId === undefined) return true;
    const asset = manifest.assets[assetId];
    if (asset === undefined || !mediaTypes.includes(asset.mediaType)) return false;
    used.add(assetId);
    return true;
  };
  if (!role(manifest.keyArt, WORLD_PICTURE_MEDIA_TYPES)) return notAPackage("keyArt");
  if (!role(guide, [GUIDE_MEDIA_TYPE])) return notAPackage("guide");
  const productionIds = new Set<string>();
  for (const production of manifest.productions) {
    if (productionIds.has(production.id)) return notAPackage("production id or title");
    productionIds.add(production.id);
    const { listening, music, story, tall } = production;
    if (
      !role(production.picture, WORLD_PICTURE_MEDIA_TYPES) ||
      !role(tall, WORLD_PICTURE_MEDIA_TYPES) ||
      !role(production.book, WORLD_BOOK_MEDIA_TYPES) ||
      !role(production.narration, WORLD_NARRATION_MEDIA_TYPES) ||
      !role(listening, [LISTENING_MEDIA_TYPE]) ||
      !role(music, [MUSIC_MEDIA_TYPE]) ||
      !role(story, [STORY_MEDIA_TYPE])
    ) {
      return notAPackage(`production ${production.id} names an asset it cannot use`);
    }
    if (production.narration !== undefined && listening !== undefined) return notAPackage(`production ${production.id} names a narration and a listening document`);
    // Music is heard on its own terms (R-69): its document in place of a book and a narration.
    if (music !== undefined && (production.book !== undefined || production.narration !== undefined || listening !== undefined)) return notAPackage(`production ${production.id} names music beside a book or a narration`);
    // And a story is played on its own (R-79): its document in place of all of them.
    if (story !== undefined && (production.book !== undefined || production.narration !== undefined || listening !== undefined || music !== undefined)) return notAPackage(`production ${production.id} names a story beside a book, a narration or music`);
    if (production.book === undefined && production.narration === undefined && listening === undefined && music === undefined && story === undefined) return notAPackage(`production ${production.id} has nothing to play`);
  }
  // Every file is one the world uses (SPEC-048 R-13). A listening document's, a music document's, a
  // story's or a guide's files are known only once it is read, so with one the package check makes
  // this check instead.
  if (guide === undefined && manifest.productions.every((production) => production.listening === undefined && production.music === undefined && production.story === undefined)) {
    const unused = assetIds.filter((assetId) => !used.has(assetId));
    if (unused.length > 0) return notAPackage(`unused assets ${unused.join(", ")}`);
  }
  const { metadata: _metadata, provenance: _provenance, requires: _requires, format: _format, alone, ...kept } = manifest;
  return {
    ok: true,
    manifest: { ...kept, ...(alone === true ? { alone: true } : {}), productions: manifest.productions.map(({ metadata: _m, ...production }) => production) },
  };
}

// ---- The music document (SPEC-058 R-70) -----------------------------------------------------------

const MusicSectionSchema = z.object({ label: text(100), at: TicksSchema, metadata: Ignorable }).strict();
const MusicLyricsSchema = z.object({ text: text(20_000), sections: z.array(MusicSectionSchema).max(200).optional(), metadata: Ignorable }).strict();
const MusicHeardInSchema = z.object({ production: SlugSchema, chapter: SlugSchema, at: TicksSchema, metadata: Ignorable }).strict();
const MusicTrackSchema = z.object({
  id: SlugSchema,
  title: text(200),
  audio: z.string(),
  /** Milliseconds. */
  duration: z.number().int().min(1).max(MAX_MUSIC_TRACK_MS),
  lyrics: MusicLyricsSchema.optional(),
  heardIn: z.array(MusicHeardInSchema).max(200).optional(),
  metadata: Ignorable,
}).strict();
const MusicDocumentSchema = z.object({
  format: z.literal(MUSIC_FORMAT),
  version: z.literal(MUSIC_VERSION),
  requires: z.array(z.unknown()).max(0).optional(),
  kind: z.enum(MUSIC_KINDS),
  for: SlugSchema.optional(),
  tracks: z.array(MusicTrackSchema).min(1).max(MAX_MUSIC_TRACKS),
  metadata: Ignorable,
}).strict();

/** The music document as written: times in milliseconds on each track's own clock. */
export type MusicDocument = z.infer<typeof MusicDocumentSchema>;
export type MusicTrack = MusicDocument["tracks"][number];
export type MusicRead = { ok: true; document: MusicDocument } | { ok: false; refusal: WorldRefusal; reason: string };

/**
 * Reads a music document against its package's inventory (SPEC-058 R-70), as strictly as the listening
 * document: an id that repeats, an asset missing or not audio, a section outside its track or out of
 * order, a single with more than one track, or a `for` on anything but a soundtrack is not an Arke
 * package. `heardIn` names the world's productions, not only the package's, so it is not checked
 * against the package: the Player shows a row only when its production is installed.
 */
export function readMusic(source: string, assets: Readonly<Record<string, WorldAsset>>): MusicRead {
  const notAPackage = (reason: string) => ({ ok: false as const, refusal: "not-a-package" as const, reason });
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    return notAPackage("the music document is not JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json) || (json as Record<string, unknown>)["format"] !== MUSIC_FORMAT) return notAPackage(`not an ${MUSIC_FORMAT}`);
  const raw = json as Record<string, unknown>;
  const version = raw["version"];
  if (typeof version !== "number" || !Number.isInteger(version)) return notAPackage("no version");
  if (version > MUSIC_VERSION) return { ok: false, refusal: "newer-arke", reason: `music version ${version}` };
  if (version !== MUSIC_VERSION) return notAPackage(`music version ${version}`);
  const requires = raw["requires"] ?? [];
  if (!Array.isArray(requires)) return notAPackage("requires is not a list");
  if (requires.length > 0) return { ok: false, refusal: "newer-arke", reason: `requires ${requires.join(", ")}` };

  const parsed = MusicDocumentSchema.safeParse(raw);
  if (!parsed.success) return refusedBy(parsed.error, "the music document");
  const document = parsed.data;
  if (document.kind === "single" && document.tracks.length !== 1) return notAPackage("a single holds one track");
  if (document.kind === "soundtrack" && document.for === undefined) return notAPackage("a soundtrack names the production it is for");
  if (document.kind !== "soundtrack" && document.for !== undefined) return notAPackage(`an ${document.kind} is for no production`);
  const ids = new Set<string>();
  for (const track of document.tracks) {
    const where = `track ${track.id}`;
    if (ids.has(track.id)) return notAPackage(`${where} repeats`);
    ids.add(track.id);
    const audio = assets[track.audio];
    if (audio === undefined || !MUSIC_AUDIO_MEDIA_TYPES.includes(audio.mediaType)) return notAPackage(`${where} audio`);
    let before = -1;
    for (const section of track.lyrics?.sections ?? []) {
      if (section.at >= track.duration) return notAPackage(`${where}: a section after its end`);
      if (section.at <= before) return notAPackage(`${where}: sections out of order`);
      before = section.at;
    }
  }
  return { ok: true, document };
}

/** Every asset a music document names, so a package can be checked for files nothing uses. */
export function musicAssetIds(document: MusicDocument): Set<string> {
  return new Set(document.tracks.map((track) => track.audio));
}

// ---- The story document (SPEC-058 R-80) -----------------------------------------------------------

/** An interactive movie plays clips; a visual novel reads beats (SPEC-023, SPEC-063). */
export const STORY_KINDS = ["movie", "novel"] as const;
export type StoryKind = (typeof STORY_KINDS)[number];
/** The production's aspect (SPEC-019 R-36): the Player plays a story at its own shape (R-84). */
export const STORY_SHAPES = ["16:9", "9:16"] as const;
export type StoryShape = (typeof STORY_SHAPES)[number];
export const STORY_CLIP_MEDIA_TYPES: readonly string[] = ["video/mp4"];
export const STORY_VOICE_MEDIA_TYPES: readonly string[] = ["audio/mp4"];
/**
 * The document's bounds. Facts, values, effects and a condition's size are SPEC-063 R-3 and R-4's,
 * as routing has them, so whatever routing can hold compiles; the rest bound a document as the
 * other readers bound theirs. The shared fixtures' cases.json repeats them for arke_world.
 */
export const STORY_LIMITS = {
  facts: 32,
  values: 16,
  effects: 32,
  conditionDepth: 8,
  conditionNodes: 128,
  scenes: 1000,
  items: 2000,
  choices: 4000,
  presentation: 20_000,
  endings: 1000,
  // Routing sets no bound on an ending's variants, and R-80 refuses only what routing cannot hold.
  // First Contact's ending has 104, so 64 refused the story the format was made for.
  variants: 1000,
} as const;

const StorySceneIdSchema = z.string().max(128).regex(/^sc_[a-z0-9-]+$/);
const StoryFactIdSchema = z.string().max(64).regex(/^[a-z][a-z0-9-]*$/);
const StoryValueSchema = z.string().min(1).max(64);
// No label: a listener never sees a fact (P18 call 23), so the document does not carry one. A fact
// that names one is a key this reader does not know, which is newer, as any such key is.
const StoryDocumentFactSchema = z.discriminatedUnion("type", [
  z.object({ id: StoryFactIdSchema, type: z.literal("boolean"), default: z.boolean(), metadata: Ignorable }).strict(),
  z.object({ id: StoryFactIdSchema, type: z.literal("enum"), values: z.array(StoryValueSchema).min(1).max(STORY_LIMITS.values), default: StoryValueSchema, metadata: Ignorable }).strict(),
]);
/** A window into an MP4, in ms of that file: the part of it the scene plays (SPEC-063 R-23's windows). */
const StoryClipSchema = z.object({ asset: z.string(), from: TicksSchema, to: TicksSchema, metadata: Ignorable }).strict();
const StoryBeatSchema = z.object({
  picture: z.string(),
  /** The same moment made Tall (R-37): upright, it fills the phone (R-87). */
  tall: z.string().optional(),
  /** Absent for narration, and for a picture held without a line. */
  speaker: text(200).optional(),
  line: text(20_000).optional(),
  voice: z.string().optional(),
  metadata: Ignorable,
}).strict();
const StorySceneSchema = z.object({
  id: StorySceneIdSchema,
  title: text(500),
  clips: z.array(StoryClipSchema).min(1).max(STORY_LIMITS.items).optional(),
  beats: z.array(StoryBeatSchema).min(1).max(STORY_LIMITS.items).optional(),
  metadata: Ignorable,
}).strict();
/**
 * A clip or beat that plays only while its condition holds (SPEC-063 R-7), named by its index in
 * its scene rather than copied, so one scene's items are written once whatever the state.
 */
const StoryPresentationRowSchema = z.object({ scene: StorySceneIdSchema, index: z.number().int().min(0).max(STORY_LIMITS.items - 1), when: StoryPredicateSchema, metadata: Ignorable }).strict();
const StoryChoiceSchema = z.object({
  id: z.string().max(128).regex(/^ch_[a-z0-9-]+$/),
  from: StorySceneIdSchema,
  to: StorySceneIdSchema,
  label: text(600),
  /** Absent, the choice is always open (SPEC-063 R-4). */
  when: StoryPredicateSchema.optional(),
  effects: z.array(StoryEffectSchema).max(STORY_LIMITS.effects),
  /** Only where the author wrote one; without it a closed choice is hidden (SPEC-063 R-11, R-85). */
  unavailable: z.object({ label: text(256).optional(), reason: text(600), metadata: Ignorable }).strict().optional(),
  metadata: Ignorable,
}).strict();
// One shape for both kinds of variant, so a variant that is both, or neither, is wrong rather than
// a key this reader does not know.
const StoryVariantSchema = z.object({
  id: z.string().min(1).max(64),
  title: text(256),
  text: z.string().max(20_000),
  when: StoryPredicateSchema.optional(),
  fallback: z.literal(true).optional(),
  metadata: Ignorable,
}).strict();
const StoryEndingSchema = z.object({ scene: StorySceneIdSchema, title: text(256), variants: z.array(StoryVariantSchema).min(1).max(STORY_LIMITS.variants).optional(), metadata: Ignorable }).strict();
const StoryDocumentSchema = z.object({
  format: z.literal(STORY_FORMAT),
  version: z.literal(STORY_VERSION),
  requires: z.array(z.unknown()).max(0).optional(),
  kind: z.enum(STORY_KINDS),
  shape: z.enum(STORY_SHAPES),
  start: StorySceneIdSchema,
  /** SPEC-063 R-14's content fingerprint: what a save is checked against (R-88). Not checked here. */
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  facts: z.array(StoryDocumentFactSchema).max(STORY_LIMITS.facts),
  scenes: z.array(StorySceneSchema).min(1).max(STORY_LIMITS.scenes),
  presentation: z.array(StoryPresentationRowSchema).max(STORY_LIMITS.presentation),
  choices: z.array(StoryChoiceSchema).max(STORY_LIMITS.choices),
  endings: z.array(StoryEndingSchema).max(STORY_LIMITS.endings),
  metadata: Ignorable,
}).strict();

/** The story document as written: clip windows in ms of their files, everything else by id. */
export type StoryDocument = z.infer<typeof StoryDocumentSchema>;
export type StoryDocumentScene = StoryDocument["scenes"][number];
export type StoryDocumentClip = NonNullable<StoryDocumentScene["clips"]>[number];
export type StoryDocumentBeat = NonNullable<StoryDocumentScene["beats"]>[number];
export type StoryDocumentChoice = StoryDocument["choices"][number];
export type StoryDocumentEnding = StoryDocument["endings"][number];
export type StoryRead = { ok: true; document: StoryDocument } | { ok: false; refusal: WorldRefusal; reason: string };

/** A scene's clips or beats, which the presentation rows count into. */
export const storySceneItems = (scene: StoryDocumentScene): ReadonlyArray<StoryDocumentClip | StoryDocumentBeat> => scene.clips ?? scene.beats ?? [];

/**
 * The document as SPEC-063's rules read it, so the reader and the route walk use the one evaluator
 * (R-23) rather than a second. The rules key presentation by shot and a document by index, so each
 * guarded item stands as a shot of its own, `sh_<index>`, that no other item shares.
 */
export function storyDocumentProgram(document: Pick<StoryDocument, "start" | "facts" | "choices" | "presentation" | "endings">): StoryProgram {
  const shots = new Map<string, Array<{ shotId: string; when: StoryPredicate }>>();
  for (const row of document.presentation) shots.set(row.scene, [...(shots.get(row.scene) ?? []), { shotId: storyItemShot(row.index), when: row.when }]);
  return {
    start: document.start,
    facts: document.facts.map(({ metadata: _metadata, ...fact }) => fact),
    choices: document.choices.map(({ id, from, to, label, when, effects, unavailable }) => ({ id, from, to, label, ...(when === undefined ? {} : { when }), effects, ...(unavailable === undefined ? {} : { unavailable }) })),
    presentation: [...shots].map(([sceneId, rules]) => ({ sceneId, blocks: [], shots: rules })),
    endings: document.endings.map((ending) => ({
      sceneId: ending.scene,
      title: ending.title,
      ...(ending.variants === undefined
        ? {}
        : { variants: ending.variants.map(({ id, title, text, when, fallback }) => (fallback === true || when === undefined ? { id, title, text, fallback: true as const } : { id, title, text, when })) }),
    })),
  };
}

/** The shot a document's item stands as for the rules (see storyDocumentProgram). */
export const storyItemShot = (index: number) => `sh_${index}`;

/**
 * What is wrong with a parsed document, if anything: the checks of R-80 that a schema cannot make.
 * Without an inventory the assets go unchecked, which is how the compiler checks what it wrote.
 */
export function storyDocumentProblem(document: StoryDocument, assets: Readonly<Record<string, WorldAsset>> | null): string | null {
  const asset = (assetId: string | undefined, mediaTypes: readonly string[]) => assets === null || assetId === undefined || (assets[assetId] !== undefined && mediaTypes.includes(assets[assetId]!.mediaType));
  const counts = new Map<string, number>();
  for (const scene of document.scenes) {
    const where = `scene ${scene.id}`;
    if (counts.has(scene.id)) return `${where} repeats`;
    // A movie's scene is footage and a novel's is beats: one player per story (R-84, R-87).
    if (document.kind === "movie" ? scene.clips === undefined || scene.beats !== undefined : scene.beats === undefined || scene.clips !== undefined) return `${where}: a ${document.kind} scene ${document.kind === "movie" ? "plays clips" : "reads beats"}`;
    for (const [index, clip] of (scene.clips ?? []).entries()) {
      if (clip.to <= clip.from) return `${where}: clip ${index + 1} ends before it starts`;
      if (!asset(clip.asset, STORY_CLIP_MEDIA_TYPES)) return `${where}: clip ${index + 1}`;
    }
    for (const [index, beat] of (scene.beats ?? []).entries()) {
      if (!asset(beat.picture, WORLD_PICTURE_MEDIA_TYPES)) return `${where}: beat ${index + 1}'s picture`;
      if (!asset(beat.tall, WORLD_PICTURE_MEDIA_TYPES)) return `${where}: beat ${index + 1}'s tall picture`;
      if (!asset(beat.voice, STORY_VOICE_MEDIA_TYPES)) return `${where}: beat ${index + 1}'s voice`;
    }
    counts.set(scene.id, storySceneItems(scene).length);
  }
  if (!counts.has(document.start)) return `the start, ${document.start}, is not a scene`;
  const choices = new Set<string>();
  for (const choice of document.choices) {
    if (choices.has(choice.id)) return `choice ${choice.id} repeats`;
    choices.add(choice.id);
    if (!counts.has(choice.from) || !counts.has(choice.to)) return `choice ${choice.id} names a scene that is not there`;
  }
  const guarded = new Set<string>();
  for (const row of document.presentation) {
    const count = counts.get(row.scene);
    if (count === undefined) return `a presentation row names ${row.scene}, which is not there`;
    if (row.index >= count) return `a presentation row names item ${row.index} of ${row.scene}, which has ${count}`;
    if (guarded.has(`${row.scene} ${row.index}`)) return `item ${row.index} of ${row.scene} has two presentation rows`;
    guarded.add(`${row.scene} ${row.index}`);
  }
  const endings = new Set<string>();
  for (const ending of document.endings) {
    const where = `ending ${ending.scene}`;
    if (!counts.has(ending.scene)) return `${where} is not a scene`;
    if (endings.has(ending.scene)) return `${where} repeats`;
    endings.add(ending.scene);
    if (document.choices.some((choice) => choice.from === ending.scene)) return `${where} offers a choice`;
    for (const variant of ending.variants ?? []) if ((variant.when === undefined) === (variant.fallback === undefined)) return `${where}: variant ${variant.id} has a condition or is the fallback, one or the other`;
  }
  // The rest is the rules' own check (SPEC-063 R-3 – R-5, R-10): a fact or value declared twice, a
  // condition or effect naming one that is not declared, a fact assigned twice by one choice, a
  // condition past its bounds, a variant id repeated, more than one fallback.
  try {
    validateStoryProgram(storyDocumentProgram(document));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

/**
 * Reads a story document against its package's inventory (SPEC-058 R-80), as strictly as the music
 * document: an id that repeats; a choice, presentation row or ending naming a scene or item that is
 * not there; a condition or effect naming a fact or value that is not declared; an asset missing or
 * not of its kind; an ending with an outgoing choice; or a document past STORY_LIMITS is not an Arke
 * package. The fingerprint is not recomputed: it is the identity a save is checked against, not a
 * checksum, and the package's own hashes cover the bytes.
 */
export function readStory(source: string, assets: Readonly<Record<string, WorldAsset>>): StoryRead {
  const notAPackage = (reason: string) => ({ ok: false as const, refusal: "not-a-package" as const, reason });
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    return notAPackage("the story document is not JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json) || (json as Record<string, unknown>)["format"] !== STORY_FORMAT) return notAPackage(`not an ${STORY_FORMAT}`);
  const raw = json as Record<string, unknown>;
  const version = raw["version"];
  if (typeof version !== "number" || !Number.isInteger(version)) return notAPackage("no version");
  if (version > STORY_VERSION) return { ok: false, refusal: "newer-arke", reason: `story version ${version}` };
  if (version !== STORY_VERSION) return notAPackage(`story version ${version}`);
  const requires = raw["requires"] ?? [];
  if (!Array.isArray(requires)) return notAPackage("requires is not a list");
  if (requires.length > 0) return { ok: false, refusal: "newer-arke", reason: `requires ${requires.join(", ")}` };

  const parsed = StoryDocumentSchema.safeParse(raw);
  if (!parsed.success) return refusedBy(parsed.error, "the story document");
  const problem = storyDocumentProblem(parsed.data, assets);
  return problem === null ? { ok: true, document: parsed.data } : notAPackage(problem);
}

/** Checks a document the compiler made against the reader's shape: the reason it would be refused, or null. */
export function storyDocumentRefusal(document: unknown): string | null {
  const parsed = StoryDocumentSchema.safeParse(document);
  if (!parsed.success) return refusedBy(parsed.error, "the story document").reason;
  return storyDocumentProblem(parsed.data, null);
}

/** Every asset a story document names, so a package can be checked for files nothing uses. */
export function storyAssetIds(document: StoryDocument): Set<string> {
  const ids = new Set<string>();
  for (const scene of document.scenes) {
    for (const clip of scene.clips ?? []) ids.add(clip.asset);
    for (const beat of scene.beats ?? []) {
      ids.add(beat.picture);
      if (beat.tall !== undefined) ids.add(beat.tall);
      if (beat.voice !== undefined) ids.add(beat.voice);
    }
  }
  return ids;
}

/** The point Slow push keeps still, 0 to 1 across and down. */
const FocusSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), metadata: Ignorable }).strict();

const ListeningWordSchema = z.object({ at: TicksSchema, end: TicksSchema, text: text(200), metadata: Ignorable }).strict();
const ListeningPhraseSchema = z.object({ at: TicksSchema, end: TicksSchema, text: text(2000), words: z.array(ListeningWordSchema).optional(), metadata: Ignorable }).strict();
const ListeningPictureSchema = z.object({
  at: TicksSchema,
  hold: TicksSchema.optional(),
  picture: z.string(),
  /** The same moment made Tall, 9:16 (R-37): a phone in portrait shows it over the whole screen (R-39). */
  tall: z.string().optional(),
  focus: FocusSchema.optional(),
  motion: z.object({ video: z.string(), behavior: z.enum(["repeat", "hold"]), metadata: Ignorable }).strict().optional(),
  metadata: Ignorable,
}).strict();
const ListeningChapterSchema = z.object({
  id: SlugSchema,
  order: z.number().int().min(1),
  title: text(200),
  duration: TicksSchema,
  audio: z.string(),
  book: z.string().min(1).max(512).optional(),
  opening: z.string().optional(),
  pictures: z.array(ListeningPictureSchema).max(MAX_PICTURES).optional(),
  phrases: z.array(ListeningPhraseSchema).max(MAX_PHRASES).optional(),
  metadata: Ignorable,
}).strict();
const ListeningDocumentSchema = z.object({
  format: z.literal(LISTENING_FORMAT),
  version: z.literal(LISTENING_VERSION),
  requires: z.array(z.unknown()).max(0).optional(),
  timescale: z.number().int().min(1).max(1_000_000),
  title: text(200),
  cover: z.string().optional(),
  chapters: z.array(ListeningChapterSchema).min(1).max(MAX_CHAPTERS),
  metadata: Ignorable,
}).strict();

/** The listening document as written: times in `timescale` ticks on each chapter's own clock. */
export type ListeningDocument = z.infer<typeof ListeningDocumentSchema>;
export type ListeningDocumentChapter = ListeningDocument["chapters"][number];
export type ListeningDocumentPicture = NonNullable<ListeningDocumentChapter["pictures"]>[number];
export type ListeningDocumentPhrase = NonNullable<ListeningDocumentChapter["phrases"]>[number];

export type ListeningRead = { ok: true; document: ListeningDocument } | { ok: false; refusal: WorldRefusal; reason: string };

/**
 * Reads a listening document against its package's inventory (SPEC-058 R-10, R-13, R-15). The
 * chapters come back in `order`.
 */
export function readListening(source: string, assets: Readonly<Record<string, WorldAsset>>): ListeningRead {
  const notAPackage = (reason: string) => ({ ok: false as const, refusal: "not-a-package" as const, reason });
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    return notAPackage("the listening document is not JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json) || (json as Record<string, unknown>)["format"] !== LISTENING_FORMAT) return notAPackage(`not an ${LISTENING_FORMAT}`);
  const raw = json as Record<string, unknown>;
  const version = raw["version"];
  if (typeof version !== "number" || !Number.isInteger(version)) return notAPackage("no version");
  if (version > LISTENING_VERSION) return { ok: false, refusal: "newer-arke", reason: `listening version ${version}` };
  if (version !== LISTENING_VERSION) return notAPackage(`listening version ${version}`);
  const requires = raw["requires"] ?? [];
  if (!Array.isArray(requires)) return notAPackage("requires is not a list");
  if (requires.length > 0) return { ok: false, refusal: "newer-arke", reason: `requires ${requires.join(", ")}` };

  const parsed = ListeningDocumentSchema.safeParse(raw);
  if (!parsed.success) return refusedBy(parsed.error, "the listening document");
  const document = parsed.data;

  const asset = (assetId: string | undefined, mediaTypes: readonly string[]) => assetId === undefined || (assets[assetId] !== undefined && mediaTypes.includes(assets[assetId]!.mediaType));
  if (!asset(document.cover, WORLD_PICTURE_MEDIA_TYPES)) return notAPackage("cover");
  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const chapter of document.chapters) {
    const where = `chapter ${chapter.id}`;
    if (ids.has(chapter.id)) return notAPackage(`chapter id ${chapter.id}`);
    if (orders.has(chapter.order)) return notAPackage(`${where} order`);
    ids.add(chapter.id);
    orders.add(chapter.order);
    if (chapter.duration <= 0) return notAPackage(`${where} duration`);
    let before: ListeningDocumentPicture | undefined;
    for (const picture of chapter.pictures ?? []) {
      if (picture.at >= chapter.duration) return notAPackage(`${where}: a picture after its end`);
      if (picture.hold !== undefined && (picture.hold <= 0 || picture.at + picture.hold > chapter.duration)) return notAPackage(`${where}: a hold past its end`);
      if (before !== undefined) {
        if (picture.at <= before.at) return notAPackage(`${where}: pictures out of order`);
        if (before.hold !== undefined && before.at + before.hold > picture.at) return notAPackage(`${where}: holds overlap`);
      }
      if (picture.motion !== undefined && !asset(picture.motion.video, LISTENING_MOTION_MEDIA_TYPES)) return notAPackage(`${where}: a motion`);
      if (!asset(picture.picture, WORLD_PICTURE_MEDIA_TYPES)) return notAPackage(`${where}: a picture`);
      if (picture.tall !== undefined && !asset(picture.tall, WORLD_PICTURE_MEDIA_TYPES)) return notAPackage(`${where}: a tall picture`);
      before = picture;
    }
    let heard: ListeningDocumentPhrase | undefined;
    for (const phrase of chapter.phrases ?? []) {
      if (phrase.at >= phrase.end || phrase.end > chapter.duration) return notAPackage(`${where}: a phrase out of its chapter`);
      // In time order and apart: Text shows the first phrase still being heard, so one starting
      // before the last has ended could never be shown.
      if (heard !== undefined && phrase.at < heard.end) return notAPackage(`${where}: phrases out of order or overlapping`);
      heard = phrase;
      let spoken: { at: number; end: number } | undefined;
      for (const word of phrase.words ?? []) {
        if (word.at >= word.end || word.at < phrase.at || word.end > phrase.end) return notAPackage(`${where}: a word outside its phrase`);
        // Words follow one another too, or a highlight has no single way through them.
        if (spoken !== undefined && word.at < spoken.end) return notAPackage(`${where}: words out of order or overlapping`);
        spoken = word;
      }
    }
    if (!asset(chapter.audio, LISTENING_AUDIO_MEDIA_TYPES)) return notAPackage(`${where} audio`);
    if (!asset(chapter.opening, WORLD_PICTURE_MEDIA_TYPES)) return notAPackage(`${where} opening`);
  }
  return { ok: true, document: { ...document, chapters: [...document.chapters].sort((a, b) => a.order - b.order) } };
}

/** Every asset a listening document names, so a package can be checked for files nothing uses. */
export function listeningAssetIds(document: ListeningDocument): Set<string> {
  const ids = new Set<string>();
  if (document.cover !== undefined) ids.add(document.cover);
  for (const chapter of document.chapters) {
    ids.add(chapter.audio);
    if (chapter.opening !== undefined) ids.add(chapter.opening);
    for (const picture of chapter.pictures ?? []) {
      ids.add(picture.picture);
      if (picture.tall !== undefined) ids.add(picture.tall);
      if (picture.motion !== undefined) ids.add(picture.motion.video);
    }
  }
  return ids;
}

/** The picture showing [time] ticks into a chapter (R-14): from its `at` for its hold, else until the next or the end. */
export function listeningPictureAt(chapter: ListeningDocumentChapter, time: number): ListeningDocumentPicture | null {
  const pictures = chapter.pictures ?? [];
  let showing: ListeningDocumentPicture | null = null;
  for (const [index, picture] of pictures.entries()) {
    if (picture.at > time) break;
    const until = picture.hold !== undefined ? picture.at + picture.hold : (pictures[index + 1]?.at ?? chapter.duration);
    showing = time < until ? picture : null;
  }
  return showing;
}

/** The phrase heard [time] ticks into a chapter, if any. */
export function listeningPhraseAt(chapter: ListeningDocumentChapter, time: number): ListeningDocumentPhrase | null {
  for (const phrase of chapter.phrases ?? []) {
    if (phrase.at > time) break;
    if (time < phrase.end) return phrase;
  }
  return null;
}

// ---- The guide (SPEC-059 R-11 – R-14) -----------------------------------------------------------

export const GUIDE_MEDIA_TYPE = "application/vnd.arke.guide+json";
export const GUIDE_FORMAT = "arke-guide";
/**
 * Version 2 adds teasers (SPEC-059 R-28); version 3 (R-37) a character's or place's theme and a song
 * teaser. A writer writes the lowest version that holds what it carries, so a guide without them
 * reads in every Player that reads the rest.
 */
export const GUIDE_VERSION = 3;
/** At most six teasers a world (turn 236 call 2). */
export const MAX_GUIDE_TEASERS = 6;
/** A clip is a moment, not a scene: at most 30 seconds of its narration (R-25). */
export const MAX_TEASER_CLIP_MS = 30_000;
/** Canon's entry types; the Player files them under Lore, Rules and Timeline, the rest under All. */
export const GUIDE_LORE_KINDS = ["lore", "rule", "timeline", "location", "faction", "tone", "thread"] as const;
export const GUIDE_VOICE_MEDIA_TYPES: readonly string[] = ["audio/mp4"];
/** A line in a character's voice is a sentence, not a scene (R-6). */
export const MAX_GUIDE_VOICE_MS = 15_000;

const MAX_GUIDE_ENTRIES = 2000;
const MAX_GUIDE_SECTIONS = 64;
const MAX_GUIDE_LINKS = 200;

const GuideAfterSchema = z.object({ production: SlugSchema, chapter: SlugSchema, metadata: Ignorable }).strict();
const after = GuideAfterSchema.nullable().optional();
const links = z.array(z.string()).max(MAX_GUIDE_LINKS).optional();
const GuideSectionSchema = z.object({ heading: text(200), text: text(20_000), after, metadata: Ignorable }).strict();
const sections = z.array(GuideSectionSchema).max(MAX_GUIDE_SECTIONS);
const GuideVoiceSchema = z.object({
  audio: z.string(),
  text: text(2000),
  duration: z.number().int().min(1).max(MAX_GUIDE_VOICE_MS),
  production: SlugSchema,
  chapter: SlugSchema,
  metadata: Ignorable,
}).strict();
const GuideCharacterSchema = z.object({
  id: SlugSchema,
  name: text(200),
  role: text(200).optional(),
  portrait: z.string().optional(),
  after,
  sections,
  voice: GuideVoiceSchema.optional(),
  links,
  metadata: Ignorable,
}).strict();
const GuidePlaceSchema = z.object({ id: SlugSchema, name: text(200), role: text(200).optional(), picture: z.string().optional(), after, sections, links, metadata: Ignorable }).strict();
/**
 * A character's or place's theme (R-35, R-37): a track of the world's music, named with its title and
 * length so a guide alone can show it before the music is installed. No audio rides with it.
 */
const GuideThemeSchema = z.object({ production: SlugSchema, track: SlugSchema, title: text(200), duration: z.number().int().min(1).max(MAX_MUSIC_TRACK_MS), metadata: Ignorable }).strict();
const GuideCharacterV3Schema = GuideCharacterSchema.extend({ theme: GuideThemeSchema.optional() }).strict();
const GuidePlaceV3Schema = GuidePlaceSchema.extend({ theme: GuideThemeSchema.optional() }).strict();
const GuideLoreSchema = z.object({ id: SlugSchema, kind: z.enum(GUIDE_LORE_KINDS), title: text(200), text: text(20_000), after, links, metadata: Ignorable }).strict();
// What an `after` or a voice line names: a production's chapters in manuscript order, each with the
// number a reader knows it by. The guide carries them because a guide alone has no production to
// read them from, and After Chapter 6 needs the 6.
const GuideChapterSchema = z.object({ id: SlugSchema, number: z.number().int().min(1), book: z.string().min(1).max(512).optional(), metadata: Ignorable }).strict();
const GuideProductionSchema = z.object({ id: SlugSchema, title: text(200), chapters: z.array(GuideChapterSchema).max(MAX_CHAPTERS), metadata: Ignorable }).strict();
// A teaser (R-28): an entry public from the start, by id, or a picture or clip with its own files and
// the chapter it comes from, which the Player shows on its card.
const teaserKinds = [
  z.object({ kind: z.literal("character"), id: SlugSchema, metadata: Ignorable }).strict(),
  z.object({ kind: z.literal("place"), id: SlugSchema, metadata: Ignorable }).strict(),
  z.object({ kind: z.literal("picture"), title: text(200), picture: z.string(), production: SlugSchema, chapter: SlugSchema, metadata: Ignorable }).strict(),
  z.object({
    kind: z.literal("clip"),
    title: text(200),
    picture: z.string(),
    audio: z.string(),
    duration: z.number().int().min(1).max(MAX_TEASER_CLIP_MS),
    motion: z.string().optional(),
    production: SlugSchema,
    chapter: SlugSchema,
    metadata: Ignorable,
  }).strict(),
] as const;
const GuideTeaserSchema = z.discriminatedUnion("kind", [...teaserKinds]);
/**
 * A song (R-36, R-37, version 3): a track's excerpt of at most 30 seconds, rendered at the export,
 * with its music production's square cover. It names its track, not a chapter: music has none.
 */
const GuideSongTeaserSchema = z.object({
  kind: z.literal("song"),
  title: text(200),
  picture: z.string(),
  audio: z.string(),
  duration: z.number().int().min(1).max(MAX_TEASER_CLIP_MS),
  production: SlugSchema,
  track: SlugSchema,
  metadata: Ignorable,
}).strict();
const GuideTeaserV3Schema = z.discriminatedUnion("kind", [...teaserKinds, GuideSongTeaserSchema]);
const guideFields = {
  format: z.literal(GUIDE_FORMAT),
  requires: z.array(z.unknown()).max(0).optional(),
  productions: z.array(GuideProductionSchema).max(64),
  characters: z.array(GuideCharacterSchema).max(MAX_GUIDE_ENTRIES),
  places: z.array(GuidePlaceSchema).max(MAX_GUIDE_ENTRIES),
  lore: z.array(GuideLoreSchema).max(MAX_GUIDE_ENTRIES),
  metadata: Ignorable,
};
// A version 1 guide does not know teasers, so one naming them is newer, never skipped; a version 2
// guide does not know a theme, so one naming it is newer too.
const GuideDocumentV1Schema = z.object({ ...guideFields, version: z.literal(1) }).strict();
const GuideDocumentV2Schema = z.object({ ...guideFields, version: z.literal(2), teasers: z.array(GuideTeaserSchema).max(MAX_GUIDE_TEASERS).optional() }).strict();
const GuideDocumentV3Schema = z.object({
  ...guideFields,
  characters: z.array(GuideCharacterV3Schema).max(MAX_GUIDE_ENTRIES),
  places: z.array(GuidePlaceV3Schema).max(MAX_GUIDE_ENTRIES),
  version: z.literal(3),
  teasers: z.array(GuideTeaserV3Schema).max(MAX_GUIDE_TEASERS).optional(),
}).strict();

export type GuideDocument = z.infer<typeof GuideDocumentV1Schema> | z.infer<typeof GuideDocumentV2Schema> | z.infer<typeof GuideDocumentV3Schema>;
export type GuideTeaser = z.infer<typeof GuideTeaserV3Schema>;
/** The teasers a version 2 guide may carry: everything but a song. */
export type GuideTeaserV2 = z.infer<typeof GuideTeaserSchema>;
export type GuideTeaserKind = GuideTeaser["kind"];
export type GuideSongTeaser = z.infer<typeof GuideSongTeaserSchema>;
export type GuideTheme = z.infer<typeof GuideThemeSchema>;

/** A guide's teasers in the author's order; a version 1 guide has none. */
export const guideTeasers = (guide: GuideDocument): GuideTeaser[] => (guide.version === 1 ? [] : (guide.teasers ?? []));

/** An entry's theme, which only a version 3 guide carries. */
export const guideTheme = (entry: GuideCharacter | GuidePlace): GuideTheme | undefined => ("theme" in entry ? entry.theme : undefined);
export type GuideAfter = z.infer<typeof GuideAfterSchema>;
export type GuideSection = z.infer<typeof GuideSectionSchema>;
export type GuideVoice = z.infer<typeof GuideVoiceSchema>;
export type GuideCharacter = z.infer<typeof GuideCharacterV3Schema>;
export type GuidePlace = z.infer<typeof GuidePlaceV3Schema>;
export type GuideLore = z.infer<typeof GuideLoreSchema>;
export type GuideLoreKind = (typeof GUIDE_LORE_KINDS)[number];
export type GuideProduction = z.infer<typeof GuideProductionSchema>;

export type GuideRead = { ok: true; guide: GuideDocument } | { ok: false; refusal: WorldRefusal; reason: string };

/**
 * Reads a guide document against its package's inventory (SPEC-059 R-11 – R-14), as strictly as
 * the listening document: an id that repeats anywhere in the guide (a link names an entry without
 * its kind), a link or `after` that names nothing, an empty section, an asset that is missing or
 * of the wrong kind, or a voice line over 15 seconds is not an Arke package.
 */
export function readGuide(source: string, assets: Readonly<Record<string, WorldAsset>>): GuideRead {
  const notAPackage = (reason: string) => ({ ok: false as const, refusal: "not-a-package" as const, reason });
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    return notAPackage("the guide is not JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json) || (json as Record<string, unknown>)["format"] !== GUIDE_FORMAT) return notAPackage(`not an ${GUIDE_FORMAT}`);
  const raw = json as Record<string, unknown>;
  const version = raw["version"];
  if (typeof version !== "number" || !Number.isInteger(version)) return notAPackage("no version");
  if (version > GUIDE_VERSION) return { ok: false, refusal: "newer-arke", reason: `guide version ${version}` };
  if (version < 1) return notAPackage(`guide version ${version}`);
  const requires = raw["requires"] ?? [];
  if (!Array.isArray(requires)) return notAPackage("requires is not a list");
  if (requires.length > 0) return { ok: false, refusal: "newer-arke", reason: `requires ${requires.join(", ")}` };

  const parsed = (version === 3 ? GuideDocumentV3Schema : version === 2 ? GuideDocumentV2Schema : GuideDocumentV1Schema).safeParse(raw);
  if (!parsed.success) return refusedBy(parsed.error, "the guide");
  const guide: GuideDocument = parsed.data;

  const chapters = new Map<string, Set<string>>();
  for (const production of guide.productions) {
    if (chapters.has(production.id)) return notAPackage(`production ${production.id} repeats`);
    const ids = new Set<string>();
    let number = 0;
    for (const chapter of production.chapters) {
      if (ids.has(chapter.id)) return notAPackage(`production ${production.id}: chapter ${chapter.id} repeats`);
      if (chapter.number <= number) return notAPackage(`production ${production.id}: chapters out of order`);
      ids.add(chapter.id);
      number = chapter.number;
    }
    chapters.set(production.id, ids);
  }
  const names = (place: { production: string; chapter: string } | null | undefined) => place == null || chapters.get(place.production)?.has(place.chapter) === true;
  const asset = (assetId: string | undefined, mediaTypes: readonly string[]) => assetId === undefined || (assets[assetId] !== undefined && mediaTypes.includes(assets[assetId]!.mediaType));

  const entries = [...guide.characters, ...guide.places, ...guide.lore];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) return notAPackage(`entry ${entry.id} repeats`);
    ids.add(entry.id);
  }
  for (const entry of entries) {
    const where = `entry ${entry.id}`;
    if (!names(entry.after)) return notAPackage(`${where}: after names no chapter of the guide`);
    if ("sections" in entry && entry.sections.some((section) => !names(section.after))) return notAPackage(`${where}: a section's after names no chapter of the guide`);
    for (const link of entry.links ?? []) if (!ids.has(link)) return notAPackage(`${where}: a link to ${link}, which is not in the guide`);
  }
  for (const character of guide.characters) {
    if (!asset(character.portrait, WORLD_PICTURE_MEDIA_TYPES)) return notAPackage(`entry ${character.id}: portrait`);
    if (character.voice !== undefined) {
      if (!asset(character.voice.audio, GUIDE_VOICE_MEDIA_TYPES)) return notAPackage(`entry ${character.id}: voice`);
      if (!names(character.voice)) return notAPackage(`entry ${character.id}: the voice names no chapter of the guide`);
    }
  }
  for (const place of guide.places) if (!asset(place.picture, WORLD_PICTURE_MEDIA_TYPES)) return notAPackage(`entry ${place.id}: picture`);

  // Teasers show to anyone in Discover, before a world is installed (R-26, R-29), so a character or
  // place among them must be public from the start; a picture's or clip's chapter is the author's call.
  const teasers = new Set<string>();
  for (const [index, teaser] of guideTeasers(guide).entries()) {
    const where = `teaser ${index + 1}`;
    if (teaser.kind === "character" || teaser.kind === "place") {
      // An entry is one teaser at most. Two moments may share a still, and a package ships that
      // file once (codex on PR 2173), so a picture or clip is never a repeat by its picture.
      if (teasers.has(teaser.id)) return notAPackage(`${where} repeats`);
      teasers.add(teaser.id);
      const entry = (teaser.kind === "character" ? guide.characters : guide.places).find((candidate) => candidate.id === teaser.id);
      if (entry === undefined) return notAPackage(`${where} names no ${teaser.kind} of the guide`);
      if (entry.after != null) return notAPackage(`${where} waits for a chapter`);
      continue;
    }
    // A song names its track, which is the world's music and need not be in this package; its files are its own.
    if (teaser.kind === "song") {
      if (!asset(teaser.picture, WORLD_PICTURE_MEDIA_TYPES)) return notAPackage(`${where}: picture`);
      if (!asset(teaser.audio, GUIDE_VOICE_MEDIA_TYPES)) return notAPackage(`${where}: audio`);
      continue;
    }
    if (!names(teaser)) return notAPackage(`${where} names no chapter of the guide`);
    if (!asset(teaser.picture, WORLD_PICTURE_MEDIA_TYPES)) return notAPackage(`${where}: picture`);
    if (teaser.kind === "clip" && (!asset(teaser.audio, GUIDE_VOICE_MEDIA_TYPES) || !asset(teaser.motion, LISTENING_MOTION_MEDIA_TYPES))) return notAPackage(`${where}: audio or motion`);
  }
  return { ok: true, guide };
}

/** Every asset a guide names, so a package can be checked for files nothing uses. */
export function guideAssetIds(guide: GuideDocument): Set<string> {
  const ids = new Set<string>();
  for (const character of guide.characters) {
    if (character.portrait !== undefined) ids.add(character.portrait);
    if (character.voice !== undefined) ids.add(character.voice.audio);
  }
  for (const place of guide.places) if (place.picture !== undefined) ids.add(place.picture);
  for (const teaser of guideTeasers(guide)) {
    if (teaser.kind !== "picture" && teaser.kind !== "clip" && teaser.kind !== "song") continue;
    ids.add(teaser.picture);
    if (teaser.kind === "clip" || teaser.kind === "song") ids.add(teaser.audio);
    if (teaser.kind === "clip" && teaser.motion !== undefined) ids.add(teaser.motion);
  }
  return ids;
}

/** The number of the chapter an `after` waits for, as a reader knows it; null when it waits for none. */
export function guideChapterNumber(guide: GuideDocument, place: GuideAfter | null | undefined): number | null {
  if (place == null) return null;
  return guide.productions.find((production) => production.id === place.production)?.chapters.find((chapter) => chapter.id === place.chapter)?.number ?? null;
}
