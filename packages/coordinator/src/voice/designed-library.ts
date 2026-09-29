import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CLONED_VOICES_PATH, DesignedVoiceSchema, parseDesignedVoices, ulid, type WorldDesignedVoice } from "@arke-studio/contracts";
import type { VoiceDesignResult } from "@arke-studio/providers";
import type { WorldStore } from "../world/store.js";
import { toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import { verifyArtifact } from "../queue/verify.js";

/** One owned transaction publishes the audition and identity; replaying Save is idempotent. */
export async function saveDesignedVoice(store: WorldStore, result: VoiceDesignResult, input: {
  requestId: string; creationJobId?: string;
}): Promise<WorldDesignedVoice> {
  if (!result.voice || !result.sample || result.problem) throw new Error(result.problem ?? "Google returned no usable voice and audition.");
  if (Date.parse(result.voice.expiresAt) <= Date.now()) throw new Error("That Google voice has expired.");
  const invalid = verifyArtifact(result.sample);
  if (invalid) throw new Error("The voice audition is not complete audio.");
  const metadata = result.voice;
  const sample = result.sample;
  return store.gateOp(async () => {
    const raw = await readFile(toExtendedLength(join(store.dir, CLONED_VOICES_PATH)), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const document = raw === null ? { voices: [] } : JSON.parse(raw);
    if (!document || !Array.isArray(document.voices)) throw new Error("The voice library needs repair before saving.");
    const existing = parseDesignedVoices(document).find(voice => voice.remoteId === metadata.remoteId);
    if (existing) return existing;
    const id = `dv_${ulid()}`;
    const voice = DesignedVoiceSchema.parse({ ...metadata, id, kind: "designed", provider: "google", revision: 1,
      sample: `voices/${id}.wav`, created: store.now(), origin: input.creationJobId ? "generated" : "imported",
      ...(input.creationJobId ? { creationJobId: input.creationJobId } : {}),
    });
    await store.commitUnserialised({ kind: "voice-design-save", source: "form", requestId: input.requestId,
      raiseSchemaVersion: 42,
      files: [
        { path: voice.sample, action: "create", baseHash: null, encoding: "base64", content: Buffer.from(sample.data).toString("base64") },
        { path: CLONED_VOICES_PATH, action: raw === null ? "create" : "replace", baseHash: raw === null ? null : sha256(raw),
          content: JSON.stringify({ ...document, voices: [...document.voices, voice] }, null, 2) + "\n" },
      ],
    });
    return voice;
  });
}
