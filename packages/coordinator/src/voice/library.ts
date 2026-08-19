import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { CLONED_VOICES_PATH, newClonedVoice, type ClonedVoice } from "@arke-studio/contracts";
import { fileArtifact } from "../artifacts/filing.js";
import { atomicWriteFile } from "../world/atomic.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";

/**
 * The cloned-voice write path (SPEC-022 T-4).
 *
 * Three things land, in an order chosen so no half-state is reachable:
 *
 *   1. the clip, at `voices/<id>.wav`   — the bytes dispatch resolves to `spk_audio_prompt`
 *   2. the artifact                     — a filed copy, for provenance
 *   3. `voices/voices.json`             — the entry that makes the voice exist
 *
 * The library is written LAST on purpose. It is the only one of the three the picker reads, so a
 * crash before it leaves an orphan clip and an artifact — inert, invisible, and re-creatable —
 * where writing it first would leave a voice the picker offers and dispatch cannot speak.
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

/**
 * The bytes, not the name. A file renamed to `.wav` passed the extension gate and became a voice
 * nothing could speak — the same reason `imageFormatOf` reads magic numbers rather than trusting
 * provider metadata (queue/verify.ts).
 */
export function audioBytesLookRight(data: Uint8Array, extension: string): boolean {
  if (extension === "wav") {
    return (
      data.length > 12 &&
      data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x41 && data[10] === 0x56 && data[11] === 0x45
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
}

export type CloneVoiceOutcome =
  | { ok: true; voice: ClonedVoice }
  | { ok: false; reason: string };

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
): Promise<CloneVoiceOutcome> {
  const extension = (input.sourcePath.split(".").pop() ?? "").toLowerCase();
  if (!AUDIO_EXTENSIONS.has(extension)) {
    return { ok: false, reason: `a voice is cloned from a recording — ${extension || "that file"} is not audio` };
  }

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

  const bytes = await readFile(toExtendedLength(input.sourcePath));
  if (!audioBytesLookRight(bytes, extension)) {
    return { ok: false, reason: `that file is named .${extension} but its contents are not ${extension} audio` };
  }

  // 1 — the clip. Outside the commit machinery because that path carries text only
  // (`CommitFileInput.content` is a string); binaries land beside it, as takes already do.
  await atomicWriteFile(clipAbsolute, bytes);

  // 2 — the artifact, filed FROM THE CLIP rather than the original source, so provenance and the
  // voice are the same bytes by construction. Reading the source twice left a window where a file
  // replaced in between gave the artifact different audio than the voice speaks with.
  let artifactId: string | undefined;
  try {
    const filed = await fileArtifact(store, {
      sourcePath: join(store.dir, fromPortable(clip)),
      links: [made.voice.id, ...(input.sheetId ? [input.sheetId] : [])],
      allowLarge: true,
    });
    // "deduplicated" is as good as "filed": the same recording cloned twice should point at the
    // one artifact rather than shelving a second copy of identical bytes.
    if (filed.outcome === "filed" || filed.outcome === "deduplicated") artifactId = filed.artifact.id;
  } catch {
    // A voice without provenance is a lesser voice, not a broken one.
  }

  const entry = { ...made.voice, clip, ...(artifactId !== undefined ? { artifactId } : {}) };

  // 3 — the library, appended to the entries AS READ. Rebuilding it from `parseVoiceLibrary`
  // dropped whatever failed to parse, so the next clone silently deleted a malformed line the
  // read path had deliberately preserved by ignoring. Unknown entries pass through untouched.
  try {
    await store.commit({
      kind: "voice-clone",
      source: "form",
      files: [
        {
          path: CLONED_VOICES_PATH,
          action: existingRaw === null ? "create" : "replace",
          content: JSON.stringify({ voices: [...existingEntries, entry] }, null, 2) + "\n",
          baseHash: existingRaw === null ? null : sha256(existingRaw),
        },
      ],
    });
  } catch (err) {
    // A refused commit is an outcome, not an exception: this function promises {ok, reason}. The
    // clip is removed rather than left orphaned — nothing points at it, and a retry re-creates it.
    await rm(clipAbsolute, { force: true }).catch(() => {});
    return { ok: false, reason: err instanceof Error ? err.message : "the voice library could not be written" };
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
 * The clip a voice speaks with, absolute — or null when the recording is gone.
 *
 * Null is a real answer the caller must handle: a voice whose clip was deleted has to report
 * itself unusable with the reason (§1.3), never dispatch and fail in the middle of a take.
 */
export async function clipFor(store: WorldStore, voice: ClonedVoice): Promise<string | null> {
  const absolute = join(store.dir, fromPortable(voice.clip));
  try {
    await stat(toExtendedLength(absolute));
    return absolute;
  } catch {
    return null;
  }
}
