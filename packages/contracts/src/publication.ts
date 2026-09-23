import { z } from "zod";
import { LanguageTagSchema } from "./subtitles.js";

/**
 * The publication boundary (SPEC-048): a frozen delivery contract, never a serialized
 * ProductionBundle. These validators describe a package; they do not prove that its files
 * exist, match their hashes, decode, or were captured coherently. Those are host operations.
 */
export const PUBLICATION_MANIFEST_FILE = "publication.json";
export const PUBLICATION_VIDEO_CAPABILITIES = ["video-v1", "webvtt-v1"] as const;
export const MAX_PUBLICATION_ASSETS = 4096;

const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/, "expected a full lowercase SHA-256 digest");
const SafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const NameSchema = z.string().min(1).max(512).refine((value) => value.trim().length > 0, "expected nonblank text");
const KeySchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const CapabilitySchema = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);

/**
 * Package paths deliberately have a smaller vocabulary than world filenames. A compiler can
 * mint opaque names while retaining the author's Unicode title in metadata. This avoids URL
 * decoding, Unicode normalization and Windows filename aliases changing an asset's address.
 */
export const PublicationAssetPathSchema = z.string().min(1).max(512).refine((path) => {
  const segments = path.split("/");
  return segments.every((segment) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(segment) &&
    !segment.endsWith(".") &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment),
  ) && segments[0]!.toLowerCase() !== PUBLICATION_MANIFEST_FILE;
}, "expected a portable relative asset path, separate from publication.json");

export const PublicationAssetSchema = z.object({
  href: PublicationAssetPathSchema,
  mediaType: z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
  byteLength: SafeIntegerSchema,
  sha256: DigestSchema,
}).strict();
export type PublicationAsset = z.infer<typeof PublicationAssetSchema>;

export const PublicationTextTrackSchema = z.object({
  asset: KeySchema,
  kind: z.enum(["captions", "subtitles"]),
  language: LanguageTagSchema,
  label: NameSchema,
  default: z.boolean(),
}).strict();
export type PublicationTextTrack = z.infer<typeof PublicationTextTrackSchema>;

const CompilerSchema = z.object({ compiler: NameSchema, compilerVersion: NameSchema }).strict();
const BuildSchema = CompilerSchema.extend({ dependencyFingerprint: DigestSchema }).strict();

// Extensions are inert JSON metadata. Bounded traversal avoids accepting cyclic objects from
// local callers or unbounded nesting from packages; content instructions have their own schema.
function isMetadataJson(input: unknown): boolean {
  const pending = [{ value: input, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++visited > 4096 || depth > 16) return false;
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number" && Number.isFinite(value)) continue;
    if (typeof value !== "object" || value === null) return false;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    for (const item of Object.values(value)) pending.push({ value: item, depth: depth + 1 });
  }
  return true;
}

const MetadataSchema = z.record(z.string().url(), z.unknown()).refine(isMetadataJson, "expected bounded JSON metadata");

export const VideoPublicationManifestSchema = z.object({
  format: z.literal("arke-publication"),
  schemaVersion: z.literal(1),
  id: z.string().regex(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  edition: NameSchema,
  profile: z.literal("video"),
  profileVersion: z.literal(1),
  title: NameSchema,
  language: LanguageTagSchema,
  requires: z.array(CapabilitySchema).min(1).max(64),
  assets: z.record(KeySchema, PublicationAssetSchema),
  content: z.object({
    video: KeySchema,
    textTracks: z.array(PublicationTextTrackSchema).max(64),
  }).strict(),
  build: BuildSchema,
  metadata: MetadataSchema.optional(),
}).strict().superRefine((manifest, ctx) => {
  const problem = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  if (new Set(manifest.requires).size !== manifest.requires.length) problem(["requires"], "capabilities must be unique");
  if (!manifest.requires.includes("video-v1")) problem(["requires"], "video-v1 is required");
  if (manifest.content.textTracks.length && !manifest.requires.includes("webvtt-v1")) {
    problem(["requires"], "text tracks require webvtt-v1");
  }
  const entries = Object.entries(manifest.assets);
  if (!entries.length || entries.length > MAX_PUBLICATION_ASSETS) problem(["assets"], "asset inventory is empty or too large");
  const paths = new Set<string>();
  for (const [id, asset] of entries) {
    const key = asset.href.toLowerCase();
    if (paths.has(key)) problem(["assets", id, "href"], "asset paths collide ignoring case");
    paths.add(key);
  }
  for (const [id, asset] of entries) {
    const segments = asset.href.toLowerCase().split("/");
    for (let i = 1; i < segments.length; i++) {
      if (paths.has(segments.slice(0, i).join("/"))) problem(["assets", id, "href"], "an asset is also used as a directory");
    }
  }
  const referenced = new Set<string>();
  const reference = (id: string, path: (string | number)[], mediaTypes: string[]) => {
    referenced.add(id);
    const asset = Object.hasOwn(manifest.assets, id) ? manifest.assets[id] : undefined;
    if (!asset) problem(path, `asset ${id} is not in the inventory`);
    else if (!mediaTypes.includes(asset.mediaType)) problem(path, `asset ${id} has an incompatible media type`);
    else if (asset.byteLength === 0) problem(path, `asset ${id} is empty`);
  };
  reference(manifest.content.video, ["content", "video"], ["video/mp4", "video/webm"]);
  let defaults = 0;
  const tracks = new Set<string>();
  manifest.content.textTracks.forEach((track, index) => {
    const path = ["content", "textTracks", index];
    reference(track.asset, [...path, "asset"], ["text/vtt"]);
    if (tracks.has(track.asset)) problem([...path, "asset"], "a text track asset is listed more than once");
    tracks.add(track.asset);
    if (track.default) defaults++;
  });
  if (defaults > 1) problem(["content", "textTracks"], "at most one text track may be default");
  for (const [id] of entries) {
    if (!referenced.has(id)) problem(["assets", id], "video-v1 does not carry unreferenced assets");
  }
});
export type VideoPublicationManifest = z.infer<typeof VideoPublicationManifestSchema>;

export type PublicationManifestRead =
  | { ok: true; manifest: VideoPublicationManifest }
  | { ok: false; code: "invalid-manifest" | "unsupported-schema" | "unsupported-profile" | "unsupported-capability"; reason: string };

/** Validate compatibility before interpreting profile content. Codec and file checks follow at the host. */
export function readPublicationManifest(
  input: unknown,
  supportedCapabilities: readonly string[] = PUBLICATION_VIDEO_CAPABILITIES,
): PublicationManifestRead {
  const header = z.object({
    format: z.literal("arke-publication"),
    schemaVersion: z.number().int().positive(),
    profile: z.string().min(1),
    profileVersion: z.number().int().positive(),
  }).passthrough().safeParse(input);
  if (!header.success) return { ok: false, code: "invalid-manifest", reason: "This is not an Arke publication manifest." };
  if (header.data.schemaVersion !== 1) return { ok: false, code: "unsupported-schema", reason: `Publication schema ${header.data.schemaVersion} is not supported.` };
  if (header.data.profile !== "video" || header.data.profileVersion !== 1) {
    return { ok: false, code: "unsupported-profile", reason: `Publication profile ${header.data.profile} v${header.data.profileVersion} is not supported.` };
  }
  const parsed = VideoPublicationManifestSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return { ok: false, code: "invalid-manifest", reason: `${issue.path.join(".") || "manifest"}: ${issue.message}` };
  }
  const unsupported = parsed.data.requires.filter((capability) => !supportedCapabilities.includes(capability));
  if (unsupported.length) return { ok: false, code: "unsupported-capability", reason: `Required capabilities are not supported: ${unsupported.join(", ")}.` };
  return { ok: true, manifest: parsed.data };
}

/**
 * A capture receipt's fingerprint input, not a capture implementation. Record hashes include
 * selections/prose/direction; resolvedPlanSha256 includes order, concrete sources and ranges.
 * Hosts must hash complete canonical plans/settings and measured source bytes under their capture
 * boundary. None of these source keys are copied into public build provenance.
 */
const CaptureRecordSchema = z.object({ key: NameSchema, sha256: DigestSchema }).strict();
const CaptureMediaSchema = CaptureRecordSchema.extend({ byteLength: SafeIntegerSchema }).strict();
export const PublicationCaptureSchema = z.object({
  version: z.literal(1),
  compiler: CompilerSchema,
  timelineRevision: SafeIntegerSchema.nullable(),
  records: z.array(CaptureRecordSchema).min(1).max(MAX_PUBLICATION_ASSETS),
  media: z.array(CaptureMediaSchema).min(1).max(MAX_PUBLICATION_ASSETS),
  resolvedPlanSha256: DigestSchema,
  settingsSha256: DigestSchema,
}).strict().superRefine((capture, ctx) => {
  for (const field of ["records", "media"] as const) {
    const keys = capture[field].map((record) => record.key);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: [field], message: "capture keys must be unique" });
  }
});
export type PublicationCapture = z.infer<typeof PublicationCaptureSchema>;

/** Canonical bytes for this receipt only; plan and settings hashing belong to their compilers. */
export function publicationCaptureText(input: PublicationCapture): string {
  const capture = PublicationCaptureSchema.parse(input);
  const compare = (a: { key: string }, b: { key: string }) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  return JSON.stringify({
    version: capture.version,
    compiler: { compiler: capture.compiler.compiler, compilerVersion: capture.compiler.compilerVersion },
    timelineRevision: capture.timelineRevision,
    records: [...capture.records].sort(compare).map(({ key, sha256 }) => ({ key, sha256 })),
    media: [...capture.media].sort(compare).map(({ key, sha256, byteLength }) => ({ key, sha256, byteLength })),
    resolvedPlanSha256: capture.resolvedPlanSha256,
    settingsSha256: capture.settingsSha256,
  });
}

export async function fingerprintPublicationCapture(input: PublicationCapture): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(publicationCaptureText(input)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
