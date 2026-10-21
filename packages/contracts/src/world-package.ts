import { z } from "zod";
import { PUBLICATION_MANIFEST_FILE, PublicationAssetPathSchema } from "./publication.js";

/**
 * Arke Player's world package (Player ADR 0005; SPEC-058 R-9 – R-16): `world.json` at a ZIP's root,
 * naming the world as published and its productions, each made of files the Player plays, with an
 * inventory of every file. Schema 2 adds a production's listening document: the illustrated
 * narration as data, a file a chapter with its pictures and phrases.
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
export const WORLD_SCHEMA_VERSION = 2;
export const LISTENING_MEDIA_TYPE = "application/vnd.arke.listening+json";
export const LISTENING_FORMAT = "arke-listening";
export const LISTENING_VERSION = 1;

/** A world's media, by the role it plays. */
export const WORLD_BOOK_MEDIA_TYPES: readonly string[] = ["application/epub+zip"];
export const WORLD_NARRATION_MEDIA_TYPES: readonly string[] = ["audio/mp4", "audio/x-m4b", "audio/mpeg"];
export const WORLD_PICTURE_MEDIA_TYPES: readonly string[] = ["image/jpeg", "image/png"];
export const LISTENING_AUDIO_MEDIA_TYPES: readonly string[] = ["audio/mp4"];
export const LISTENING_MOTION_MEDIA_TYPES: readonly string[] = ["video/mp4"];

export const MAX_WORLD_ASSETS = 4096;
const MAX_ASSET_BYTES = 64 * 1024 ** 3;
const MAX_CHAPTERS = 1000;
const MAX_PICTURES = 2000;
const MAX_PHRASES = 20000;

export type WorldRefusal = "not-a-package" | "newer-arke";

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
export type WorldProduction = z.infer<typeof ProductionV2Schema>;

const manifestShape = (production: typeof ProductionV1Schema | typeof ProductionV2Schema) => z.object({
  format: z.literal(WORLD_PACKAGE_FORMAT),
  schemaVersion: z.number().int(),
  id: SlugSchema,
  edition: text(64),
  name: text(200),
  logline: text(400).optional(),
  keyArt: z.string().optional(),
  productions: z.array(production).min(1).max(64),
  assets: z.record(z.string(), WorldAssetSchema),
  requires: z.array(z.unknown()).max(0).optional(),
  metadata: Ignorable,
  provenance: Ignorable,
}).strict();

export interface WorldManifest {
  schemaVersion: number;
  id: string;
  edition: string;
  name: string;
  logline?: string;
  keyArt?: string;
  productions: WorldProduction[];
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

  const parsed = manifestShape(version >= 2 ? ProductionV2Schema : ProductionV1Schema).safeParse(raw);
  if (!parsed.success) return refusedBy(parsed.error, "world.json");
  const manifest = parsed.data;

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
  const productionIds = new Set<string>();
  for (const production of manifest.productions) {
    if (productionIds.has(production.id)) return notAPackage("production id or title");
    productionIds.add(production.id);
    const listening = "listening" in production ? production.listening : undefined;
    if (
      !role(production.picture, WORLD_PICTURE_MEDIA_TYPES) ||
      !role(production.book, WORLD_BOOK_MEDIA_TYPES) ||
      !role(production.narration, WORLD_NARRATION_MEDIA_TYPES) ||
      !role(listening, [LISTENING_MEDIA_TYPE])
    ) {
      return notAPackage(`production ${production.id} names an asset it cannot use`);
    }
    if (production.narration !== undefined && listening !== undefined) return notAPackage(`production ${production.id} names a narration and a listening document`);
    if (production.book === undefined && production.narration === undefined && listening === undefined) return notAPackage(`production ${production.id} has nothing to play`);
  }
  // Every file is one the world uses (SPEC-048 R-13). A listening document's files are known only
  // once it is read, so with one the package check makes this check instead.
  if (manifest.productions.every((production) => !("listening" in production) || production.listening === undefined)) {
    const unused = assetIds.filter((assetId) => !used.has(assetId));
    if (unused.length > 0) return notAPackage(`unused assets ${unused.join(", ")}`);
  }
  const { metadata: _metadata, provenance: _provenance, requires: _requires, format: _format, ...kept } = manifest;
  return {
    ok: true,
    manifest: { ...kept, productions: manifest.productions.map(({ metadata: _m, ...production }) => production) },
  };
}

/** The point Slow push keeps still, 0 to 1 across and down. */
const FocusSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), metadata: Ignorable }).strict();

const ListeningWordSchema = z.object({ at: TicksSchema, end: TicksSchema, text: text(200), metadata: Ignorable }).strict();
const ListeningPhraseSchema = z.object({ at: TicksSchema, end: TicksSchema, text: text(2000), words: z.array(ListeningWordSchema).optional(), metadata: Ignorable }).strict();
const ListeningPictureSchema = z.object({
  at: TicksSchema,
  hold: TicksSchema.optional(),
  picture: z.string(),
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
      before = picture;
    }
    for (const phrase of chapter.phrases ?? []) {
      if (phrase.at >= phrase.end || phrase.end > chapter.duration) return notAPackage(`${where}: a phrase out of its chapter`);
      for (const word of phrase.words ?? []) {
        if (word.at >= word.end || word.at < phrase.at || word.end > phrase.end) return notAPackage(`${where}: a word outside its phrase`);
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
