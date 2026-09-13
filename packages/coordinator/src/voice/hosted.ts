import { isHostedVoiceReader, type ClonedVoice } from "@arke-studio/contracts";
import type { DispatchVoiceReference } from "../queue/dispatcher.js";
import type { WorldStore } from "../world/store.js";
import { clipHashOf, recordVoiceReader } from "./library.js";

/**
 * The hosted readers of the world's cloned voices, at the two points where a recording actually
 * leaves this machine (SPEC-046 §1.7, §2.3, §2.4).
 *
 * A vendor is a destination like a remote ComfyUI engine is: the same confirmation frame, asked
 * once per voice per vendor and then remembered on the library entry, with the vendor's own
 * terms as read on 2026-09-13 and no more (R-16, R-17). Below that, the one difference between
 * the two readers: Mistral takes the bytes with every call and keeps nothing; Breeze keeps them
 * as a voice slot on the account, which the library remembers with the clip's hash so a
 * re-recorded clip is cloned again rather than read from a stale slot (R-13).
 */

export interface HostedReaderDestination {
  label: string;
  /** The confirmation token a command carries back; per vendor, not per request. */
  token: string;
  /** What the vendor does with the clip, in the vendor's own terms (R-17). */
  notice: string;
}

const DESTINATIONS: Record<string, HostedReaderDestination> = {
  mistral: {
    label: "Mistral",
    token: "vendor:mistral",
    notice:
      "The recording is sent with each read and not kept by Arke on the service. On a paid workspace it is not used for training and is kept 30 days for abuse monitoring; on the free Experiment tier it is used for training unless opted out in Mistral's admin console.",
  },
  breezeblue: {
    label: "BreezeBlue",
    token: "vendor:breezeblue",
    notice:
      "The recording is saved as a voice on the account, transcribed and trimmed to 30 seconds by the service, and removed when the voice is removed here.",
  },
};

export function hostedReaderDestination(provider: string): HostedReaderDestination | null {
  return DESTINATIONS[provider] ?? null;
}

/** Whether the person already answered for this voice and this vendor (R-16). */
export function hostedUploadConfirmed(voice: ClonedVoice, provider: string): boolean {
  return typeof voice.remote?.[provider]?.confirmedAt === "string";
}

/** Vendor-side voice state, wired by the host with the provider clients that hold the calls. */
export interface HostedVoiceSlots {
  save(provider: string, key: string, input: { name: string; clip: Uint8Array; contentType: "audio/wav" | "audio/mpeg"; language?: string }): Promise<{ voiceId: string }>;
  remove(provider: string, key: string, voiceId: string): Promise<void>;
}

export interface PrepareHostedClipDeps {
  getKey(provider: string): Promise<string | null>;
  slots?: HostedVoiceSlots;
  now(): string;
}

/**
 * The clip is about to leave for a hosted reader: check that the person allowed it, and give
 * the reader what it reads from — the bytes, or the slot that holds them.
 *
 * Called from the dispatcher's clip read. The answer to "send this recording?" is recorded where
 * it is given, at enqueue (`requireVoiceUploadConfirmation`), so a job that reaches this point
 * without it is refused rather than assumed — the same posture the dispatcher takes with an
 * unconfirmed remote engine. A Breeze slot is created on the first read, or again when the clip's
 * hash no longer matches the one the slot was made from; the old slot is removed on a best-effort
 * basis, because a slot the person cannot see counting against their plan is the outcome R-15
 * exists to prevent.
 */
export async function prepareHostedClip(
  store: WorldStore,
  provider: string,
  model: string,
  voice: ClonedVoice,
  clip: DispatchVoiceReference,
  deps: PrepareHostedClipDeps,
): Promise<DispatchVoiceReference> {
  if (!isHostedVoiceReader(provider, model)) return clip;
  if (!hostedUploadConfirmed(voice, provider)) {
    throw new Error(`the recording has not been confirmed for ${hostedReaderDestination(provider)?.label ?? provider} — read again and confirm`);
  }
  if (provider !== "breezeblue") return clip;
  const hash = clipHashOf(clip);
  const held = voice.remote?.[provider];
  if (held?.voiceId !== undefined && held.clipHash === hash) return { ...clip, remoteVoiceId: held.voiceId };
  const key = await deps.getKey(provider);
  if (key === null) throw new Error("BreezeBlue has no key in Settings — add one on Providers, then read again.");
  if (deps.slots === undefined) throw new Error("BreezeBlue voice slots are not configured in this build.");
  // No language hint: the library does not know the recording's, and Breeze detects it from the
  // audio anyway ("detected audio language takes precedence"). A read names its own (R-23).
  const saved = await deps.slots.save(provider, key, { name: voice.name, clip: clip.data, contentType: clip.contentType });
  await recordVoiceReader(store, voice.id, provider, { voiceId: saved.voiceId, clipHash: hash, savedAt: deps.now() });
  if (held?.voiceId !== undefined && held.voiceId !== saved.voiceId) {
    await deps.slots.remove(provider, key, held.voiceId).catch(() => undefined);
  }
  return { ...clip, remoteVoiceId: saved.voiceId };
}
