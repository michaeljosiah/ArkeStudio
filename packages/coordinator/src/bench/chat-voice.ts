import { voiceSourceFor, type ClonedVoice } from "@arke-studio/contracts";
import type { EnqueueInput } from "../queue/dispatcher.js";
import type { WorldStore } from "../world/store.js";
import { clipFor } from "../voice/library.js";
import { hostedReaderDestination, hostedUploadToken } from "../voice/hosted.js";

/** A card names the recording, bytes and destination before approval can consent to upload. */
export async function inspectBenchVoiceInputs(store: WorldStore, inputs: readonly EnqueueInput[]) {
  const pins: Array<{ index: number; voiceId: string; provider: string; clip: string; destination: string | null }> = [];
  const references: Array<{ id: string; role: string }> = [];
  const privacy: string[] = [];
  const consents: Array<{ index: number; provider: string; voice: ClonedVoice; token?: string }> = [];
  for (const [index, input] of inputs.entries()) {
    if (!input.voiceReference) continue;
    const voiceId = input.params.voiceId;
    const source = typeof voiceId === "string" ? voiceSourceFor(store.getBundle().clonedVoices, input.provider, input.model, voiceId) : null;
    if (source?.kind !== "cloned") throw new Error("The selected cloned voice is unavailable.");
    const clip = await clipFor(store, source.voice);
    if (!clip) throw new Error(`The recording for ${source.voice.name} is missing or invalid. Record it again before generating speech.`);
    const vendor = hostedReaderDestination(input.provider);
    const remote = input.engine?.source === "user-url" && input.engine.locality !== "local";
    const token = vendor ? hostedUploadToken(input.provider, source.voice.id) : remote ? input.engine!.instanceId : undefined;
    pins.push({ index, voiceId: source.voice.id, provider: input.provider, clip: clip.name, destination: token ?? null });
    references.push({ id: source.voice.id, role: `Cloned voice recording: ${source.voice.name}` });
    privacy.push(vendor ? `${source.voice.name}: upload this recording to ${vendor.label}. ${vendor.notice}`
      : remote ? `${source.voice.name}: upload this recording to the selected remote ComfyUI engine (${input.engine!.instanceId}). Approving this card confirms this destination.`
        : `${source.voice.name}: this recording is read by the local voice runtime.`);
    consents.push({ index, provider: input.provider, voice: source.voice, ...(token ? { token } : {}) });
  }
  return { pins, references, privacy: [...new Set(privacy)], consents };
}
