import { join } from "node:path";
import { CLONED_VOICES_PATH, newClonedVoice, parseVoiceLibrary, type ClonedVoice } from "@arke-studio/contracts";
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

const AUDIO_EXTENSIONS = new Set(["wav", "mp3", "m4a", "flac", "ogg", "webm"]);

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

  const made = newClonedVoice({
    name: input.name,
    description: input.description,
    clip: "pending",
    consent: input.consent,
    created: store.now(),
    taken: bundleVoices.map((v) => v.id),
  });
  if (!made.ok) return made;

  const clip = clipPathFor(made.voice.id, extension);

  // 1 — the clip. Outside the commit machinery because that path carries text only
  // (`CommitFileInput.content` is a string); binaries land beside it, as takes already do.
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(toExtendedLength(input.sourcePath));
  await atomicWriteFile(toExtendedLength(join(store.dir, fromPortable(clip))), bytes);

  // 2 — the artifact, linked to the voice and to whoever it was cloned for. Provenance answers
  // where a voice came from months later (SPEC-011 §2.7); it is not what dispatch reads.
  let artifactId: string | undefined;
  try {
    const filed = await fileArtifact(store, {
      sourcePath: input.sourcePath,
      links: [made.voice.id, ...(input.sheetId ? [input.sheetId] : [])],
      allowLarge: true,
    });
    // "deduplicated" is as good as "filed" here: the same recording cloned twice should point at
    // the one artifact rather than shelving a second copy of identical bytes.
    if (filed.outcome === "filed" || filed.outcome === "deduplicated") artifactId = filed.artifact.id;
  } catch {
    // A voice without provenance is a lesser voice, not a broken one. The clip is already
    // written and the library entry below will still point at it.
  }

  // 3 — the library. Read-modify-write of the whole file, because it is small and because the
  // committer wants full content; the base hash is what makes a concurrent edit fail loudly.
  const existingRaw = await readLibraryRaw(store);
  const voices = [...parseVoiceLibrary(existingRaw === null ? null : safeJson(existingRaw)), {
    ...made.voice,
    clip,
    ...(artifactId !== undefined ? { artifactId } : {}),
  }];
  await store.commit({
    kind: "voice-clone",
    source: "form",
    files: [
      {
        path: CLONED_VOICES_PATH,
        action: existingRaw === null ? "create" : "replace",
        content: JSON.stringify({ voices }, null, 2) + "\n",
        baseHash: existingRaw === null ? null : sha256(existingRaw),
      },
    ],
  });

  return { ok: true, voice: { ...made.voice, clip, ...(artifactId !== undefined ? { artifactId } : {}) } };
}

async function readLibraryRaw(store: WorldStore): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(toExtendedLength(join(store.dir, fromPortable(CLONED_VOICES_PATH))), "utf8");
  } catch {
    return null;
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
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
  const { stat } = await import("node:fs/promises");
  const absolute = join(store.dir, fromPortable(voice.clip));
  try {
    await stat(toExtendedLength(absolute));
    return absolute;
  } catch {
    return null;
  }
}
