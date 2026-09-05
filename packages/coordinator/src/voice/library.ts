import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import {
  ArtifactSidecarSchema,
  CLONED_VOICES_PATH,
  newClonedVoice,
  ulid,
  type ArtifactSidecar,
  type ClonedVoice,
} from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import type { CommitFileInput } from "../world/commit.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import { WorldStateStaleError, type WorldStatePrecondition, type WorldStore } from "../world/store.js";
import type { DispatchVoiceReference } from "../queue/dispatcher.js";
import { verifyArtifact } from "../queue/verify.js";

/**
 * The cloned-voice write path (SPEC-022 T-4).
 *
 * Three things land, with the two product-visible records committed together:
 *
 *   1. the clip, at `voices/<id>.wav`   — the bytes dispatch resolves to `spk_audio_prompt`
 *   2. the artifact                     — a filed copy, for provenance
 *   3. `voices/voices.json`             — the entry that makes the voice exist
 *
 * The binary copies are staged first. The artifact sidecar and library entry then share the
 * world's journalled commit, so a crash may leave unreferenced bytes but can never publish a clone
 * without provenance or provenance for a clone that does not exist.
 *
 * The bytes exist twice, deliberately. `ArtifactSidecar.file` is a name within `artifacts/` and
 * cannot point outside it, so the only way for the voice to survive its artifact being deleted is
 * for the voice to own its own copy. A reference clip is seconds long; a character whose voice
 * broke because somebody tidied the artifacts shelf is not worth the half megabyte saved.
 */

/** Only the app writes these, so the name is ours to choose: the id, and the format it came in. */
function clipPathFor(id: string, extension: string): string {
  return `voices/${id}.${extension}`;
}

/**
 * What the engine can actually speak from, and nothing wider. Accepting m4a — the iOS voice-memo
 * default — meant capture succeeded and every dispatch against that voice failed at the engine,
 * which is the mid-take failure §1.3 exists to prevent. Transcoding is the way to widen this;
 * pretending is not.
 */
export const AUDIO_EXTENSIONS = new Set(["wav", "mp3"]);
export const MAX_CLONED_VOICE_BYTES = 50 * 1024 * 1024;

/**
 * The bytes, not the name. A file renamed to `.wav` passed the extension gate and became a voice
 * nothing could speak — the same reason `imageFormatOf` reads magic numbers rather than trusting
 * provider metadata (queue/verify.ts).
 */
export function audioBytesLookRight(data: Uint8Array, extension: string): boolean {
  if (extension === "wav") {
    return (
      data.length > 12 &&
      data[0] === 0x52 &&
      data[1] === 0x49 &&
      data[2] === 0x46 &&
      data[3] === 0x46 &&
      data[8] === 0x57 &&
      data[9] === 0x41 &&
      data[10] === 0x56 &&
      data[11] === 0x45
    );
  }
  // ID3 tag, or a bare MPEG frame sync.
  return (
    data.length > 3 &&
    ((data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) ||
      (data[0] === 0xff && (data[1]! & 0xe0) === 0xe0))
  );
}

/** A clip shorter than this is not enough voice to clone from, and 74c says so as a hint. */
export const MIN_CLONE_SECONDS = 3;

/**
 * How long a WAV runs, read from its own header.
 *
 * WAV alone among the two states its length arithmetically — data chunk over byte rate. MP3 does
 * not without decoding frames, so this returns null there and callers treat unknown as unknown
 * rather than refusing a clip they could not measure.
 */
export function wavSeconds(data: Uint8Array): number | null {
  if (!audioBytesLookRight(data, "wav")) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // Walk the chunks: `fmt ` carries the byte rate and `data` carries the length, and neither is
  // at a fixed offset once a file has a LIST or fact chunk in front of them.
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= data.byteLength) {
    const id = String.fromCharCode(data[offset]!, data[offset + 1]!, data[offset + 2]!, data[offset + 3]!);
    const size = view.getUint32(offset + 4, true);
    // Byte rate sits at +16 into the chunk body, four past the sample rate. Reading the sample
    // rate instead yields a plausible-looking duration that is wrong by the frame size.
    if (id === "fmt " && offset + 20 <= data.byteLength) byteRate = view.getUint32(offset + 16, true);
    if (id === "data") return byteRate > 0 ? size / byteRate : null;
    // Chunks are word-aligned: an odd size is followed by a pad byte that is not part of it.
    offset += 8 + size + (size % 2);
  }
  return null;
}

export interface CloneVoiceInput {
  /** Absolute path to the recording the user chose or made. */
  sourcePath: string;
  name: string;
  description: string;
  consent: boolean;
  /** The sheet this was cloned while casting, if any — a link, never ownership (§2.3). */
  sheetId?: string;
  mutation?: { source?: string; requestId?: string; precondition?: WorldStatePrecondition };
}

export type CloneVoiceOutcome = { ok: true; voice: ClonedVoice } | { ok: false; reason: string };

export interface CloneVoiceHooks {
  /** Test-only pause/fault after binary staging and before the records commit. */
  afterArtifactFiled?: () => void | Promise<void>;
}

/**
 * Clone a voice into the world's library.
 *
 * Refusals come from `newClonedVoice` so the rule lives in one place and the client can state the
 * same reason before ever reaching here — a description is required because `rankVoices` buries a
 * candidate without one, and consent is required because the model cannot ask.
 */
export async function cloneVoice(
  store: WorldStore,
  bundleVoices: readonly ClonedVoice[],
  input: CloneVoiceInput,
  hooks: CloneVoiceHooks = {},
): Promise<CloneVoiceOutcome> {
  const extension = (input.sourcePath.split(".").pop() ?? "").toLowerCase();
  if (!AUDIO_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      reason: `a voice is cloned from a recording — ${extension || "that file"} is not audio`,
    };
  }

  try {
    // Allocation, both binary writes and the records commit are one world mutation. Normal
    // artifact filing uses this same gate, so neither path can reserve a filename from a stale
    // bundle and later overwrite the other path's media. `commitUnserialised` below is deliberate:
    // re-entering `store.commit` while this gate is held would deadlock the store queue.
    return await store.gateOp(() => cloneVoiceSerialised(store, bundleVoices, input, extension, hooks));
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "the voice library could not be written",
    };
  }
}

async function cloneVoiceSerialised(
  store: WorldStore,
  bundleVoices: readonly ClonedVoice[],
  input: CloneVoiceInput,
  extension: string,
  hooks: CloneVoiceHooks,
): Promise<CloneVoiceOutcome> {
  const stale = input.mutation?.precondition?.();
  if (stale) throw new WorldStateStaleError(stale);
  // The library FIRST, and the ids come from it. Deriving `taken` from the caller's bundle let a
  // stale snapshot mint an id that already existed — and since the clip path is the id, step 2
  // then overwrote the earlier voice's recording before anything noticed.
  const existingRaw = await readLibraryRaw(store);
  const existingEntries = rawEntries(existingRaw);
  const taken = [
    ...existingEntries.map((e) => (typeof e?.id === "string" ? e.id : "")).filter(Boolean),
    ...bundleVoices.map((v) => v.id),
  ];

  const made = newClonedVoice({
    name: input.name,
    description: input.description,
    clip: "pending",
    consent: input.consent,
    created: store.now(),
    taken,
  });
  if (!made.ok) return made;

  const clip = clipPathFor(made.voice.id, extension);
  const clipAbsolute = toExtendedLength(join(store.dir, fromPortable(clip)));

  const sourceInfo = await lstat(toExtendedLength(input.sourcePath)).catch(() => null);
  if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink()) {
    return { ok: false, reason: "that recording is not a regular file" };
  }
  if (sourceInfo.size <= 0 || sourceInfo.size > MAX_CLONED_VOICE_BYTES) {
    return { ok: false, reason: "that recording is over 50 MB — choose a shorter clip" };
  }
  const sourceHandle = await open(toExtendedLength(input.sourcePath), "r");
  let bytes: Uint8Array;
  try {
    const opened = await sourceHandle.stat();
    if (opened.dev !== sourceInfo.dev || opened.ino !== sourceInfo.ino || !opened.isFile()) {
      return { ok: false, reason: "that recording changed while it was being prepared" };
    }
    bytes = Uint8Array.from(await sourceHandle.readFile());
  } finally {
    await sourceHandle.close();
  }
  if (!audioBytesLookRight(bytes, extension)) {
    return {
      ok: false,
      reason: `that file is named .${extension} but its contents are not ${extension} audio`,
    };
  }
  if (bytes.length > MAX_CLONED_VOICE_BYTES) {
    return { ok: false, reason: "that recording is over 50 MB — choose a shorter clip" };
  }
  const contentType = extension === "wav" ? "audio/wav" : "audio/mpeg";
  if (verifyArtifact({ name: `recording.${extension}`, contentType, data: bytes }) !== null) {
    return {
      ok: false,
      reason: `that ${extension.toUpperCase()} is incomplete or has no playable audio data`,
    };
  }

  // 1 — the clip. Outside the commit machinery because that path carries text only
  // (`CommitFileInput.content` is a string); binaries land beside it, as takes already do.
  await atomicWriteFile(clipAbsolute, bytes);

  // 2 — prepare provenance from the same bytes. Its sidecar joins the library in one journalled
  // commit below, so either both become product-visible or neither does.
  const artifactHash = `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
  const links = [made.voice.id, ...(input.sheetId ? [input.sheetId] : [])];
  let provenance: ArtifactSidecar | null = null;
  let provenanceFile: CommitFileInput | null = null;
  let newArtifactMedia: string | null = null;
  for (const candidate of store.getBundle().artifacts.filter((artifact) => artifact.hash === artifactHash)) {
    const safeName = basename(candidate.file) === candidate.file && candidate.file !== "..";
    const media = safeName ? join(store.dir, "artifacts", candidate.file) : "";
    const info = safeName ? await lstat(toExtendedLength(media)).catch(() => null) : null;
    const mediaBytes =
      info?.isFile() && !info.isSymbolicLink()
        ? await readFile(toExtendedLength(media)).catch(() => null)
        : null;
    const mediaMatches =
      mediaBytes !== null &&
      `sha256:${createHash("sha256").update(mediaBytes).digest("hex").slice(0, 16)}` === artifactHash;
    const raw = mediaMatches
      ? await readFile(toExtendedLength(`${media}.json`), "utf8").catch(() => null)
      : null;
    let parsed: ReturnType<typeof ArtifactSidecarSchema.safeParse> | null = null;
    if (raw !== null) {
      try {
        parsed = ArtifactSidecarSchema.safeParse(JSON.parse(raw));
      } catch {
        parsed = null;
      }
    }
    if (
      raw !== null &&
      parsed?.success &&
      parsed.data.id === candidate.id &&
      parsed.data.file === candidate.file &&
      parsed.data.hash === artifactHash
    ) {
      const next = { ...parsed.data, links: [...new Set([...parsed.data.links, ...links])] };
      provenance = next;
      if (next.links.length !== parsed.data.links.length) {
        provenanceFile = {
          path: `artifacts/${next.file}.json`,
          action: "replace",
          content: JSON.stringify(next, null, 2) + "\n",
          baseHash: sha256(raw),
        };
      }
      break;
    }
  }
  if (provenance === null) {
    let file = `${made.voice.id}.${extension}`;
    for (let n = 2; ; n += 1) {
      const media = join(store.dir, "artifacts", file);
      const occupied =
        (await lstat(toExtendedLength(media)).catch(() => null)) !== null ||
        (await lstat(toExtendedLength(`${media}.json`)).catch(() => null)) !== null;
      if (!occupied) {
        newArtifactMedia = media;
        break;
      }
      file = `${made.voice.id}-${n}.${extension}`;
    }
    provenance = {
      id: `ar_${ulid()}`,
      kind: "audio",
      file,
      hash: artifactHash as ArtifactSidecar["hash"],
      origin: { by: "user" },
      links,
      created: store.now(),
    };
    try {
      await atomicWriteFile(newArtifactMedia!, bytes);
    } catch (err) {
      await rm(clipAbsolute, { force: true }).catch(() => {});
      return {
        ok: false,
        reason: err instanceof Error ? err.message : "the recording provenance could not be filed",
      };
    }
    provenanceFile = {
      path: `artifacts/${file}.json`,
      action: "create",
      content: JSON.stringify(provenance, null, 2) + "\n",
      baseHash: null,
    };
  }

  const entry = { ...made.voice, clip, artifactId: provenance.id };

  // 3 — the library, appended to the entries AS READ. Rebuilding it from `parseVoiceLibrary`
  // dropped whatever failed to parse, so the next clone silently deleted a malformed line the
  // read path had deliberately preserved by ignoring. Unknown entries pass through untouched.
  let recordsCommitStarted = false;
  try {
    await hooks.afterArtifactFiled?.();
    recordsCommitStarted = true;
    await store.commitUnserialised({
      kind: "voice-clone",
      source: input.mutation?.source ?? "form",
      files: [
        ...(provenanceFile !== null ? [provenanceFile] : []),
        {
          path: CLONED_VOICES_PATH,
          action: existingRaw === null ? "create" : "replace",
          content: JSON.stringify({ voices: [...existingEntries, entry] }, null, 2) + "\n",
          baseHash: existingRaw === null ? null : sha256(existingRaw),
        },
      ],
      ...(input.mutation?.requestId !== undefined ? { requestId: input.mutation.requestId } : {}),
    });
  } catch (err) {
    // Before commit(), no record can ever name these bytes, so compensation is safe. Once
    // commit() starts, rejection is ambiguous: the journal may be committing (and recover will
    // roll it forward), or the records may already be durable and only WorldStore's rescan failed.
    // In either case deleting media would turn a recoverable clone into dangling records. An
    // orphan left by a pre-point-of-no-return refusal is inert and is the safe side of the trade.
    if (!recordsCommitStarted) {
      await rm(clipAbsolute, { force: true }).catch(() => {});
      if (newArtifactMedia !== null) {
        await rm(toExtendedLength(newArtifactMedia), { force: true }).catch(() => {});
      }
    }
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "the voice library could not be written",
    };
  }

  return { ok: true, voice: entry };
}

/**
 * The library's entries exactly as written, unparsed. The append path uses these rather than
 * `parseVoiceLibrary`'s output so an entry this build does not understand survives a clone
 * instead of being quietly rewritten out of existence.
 */
function rawEntries(raw: string | null): Array<Record<string, unknown>> {
  if (raw === null) return [];
  try {
    const list = (JSON.parse(raw) as { voices?: unknown }).voices;
    return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

async function readLibraryRaw(store: WorldStore): Promise<string | null> {
  try {
    return await readFile(toExtendedLength(join(store.dir, fromPortable(CLONED_VOICES_PATH))), "utf8");
  } catch {
    return null;
  }
}

/**
 * A confined source clip ready for a provider call. The bytes are ephemeral; only `voiceId`
 * and a boolean marker enter the durable job.
 *
 * Null is a real answer the caller must handle: a voice whose clip was deleted has to report
 * itself unusable with the reason (§1.3), never dispatch and fail in the middle of a take.
 */
export async function clipFor(store: WorldStore, voice: ClonedVoice): Promise<DispatchVoiceReference | null> {
  const portable = voice.clip;
  if (
    portable.length === 0 ||
    portable.includes("\\") ||
    portable.includes("\0") ||
    portable.includes(":") ||
    isAbsolute(portable)
  )
    return null;
  const segments = portable.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  const extension = (segments.at(-1)?.split(".").pop() ?? "").toLowerCase();
  if (!AUDIO_EXTENSIONS.has(extension)) return null;
  try {
    const root = await realpath(toExtendedLength(store.dir));
    let cursor = root;
    let validated: Awaited<ReturnType<typeof lstat>> | null = null;
    for (const segment of segments) {
      cursor = join(cursor, fromPortable(segment));
      const info = await lstat(toExtendedLength(cursor));
      if (info.isSymbolicLink()) return null;
      validated = info;
    }
    const resolved = await realpath(toExtendedLength(cursor));
    const rel = relative(root, resolved);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    const handle = await open(toExtendedLength(resolved), "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || !validated || info.dev !== validated.dev || info.ino !== validated.ino)
        return null;
      if (info.size <= 0 || info.size > MAX_CLONED_VOICE_BYTES) return null;
      const data = new Uint8Array(info.size);
      const read = await handle.read(data, 0, data.length, 0);
      if (read.bytesRead !== data.length) return null;
      const after = await handle.stat();
      if (after.size !== info.size || after.dev !== info.dev || after.ino !== info.ino) return null;
      const contentType = extension === "wav" ? ("audio/wav" as const) : ("audio/mpeg" as const);
      if (verifyArtifact({ name: segments.at(-1)!, contentType, data }) !== null) return null;
      const digest = createHash("sha256").update(data).digest("hex");
      return {
        name: `${digest}.${extension}`,
        contentType,
        data,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
