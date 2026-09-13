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
  /** What the vendor does with the clip, in the vendor's own terms (R-17). */
  notice: string;
  /** Whether the vendor keeps the clip on the account, addressed by an id the library records. */
  keepsSlot: boolean;
}

const DESTINATIONS: Record<string, HostedReaderDestination> = {
  mistral: {
    label: "Mistral",
    notice:
      "The recording is sent with each read and not kept by Arke on the service. On a paid workspace it is not used for training and is kept 30 days for abuse monitoring; on the free Experiment tier it is used for training unless opted out in Mistral's admin console.",
    keepsSlot: false,
  },
  breezeblue: {
    label: "BreezeBlue",
    // No claim of removal: nothing in the app deletes a cloned voice yet, so nothing removes the
    // slot on the person's behalf (R-15 waits on that command). What is true is said instead.
    notice:
      "The recording is saved as a voice on the account, transcribed and trimmed to 30 seconds by the service. It stays on the account until removed there; re-recording the clip here replaces it.",
    keepsSlot: true,
  },
};

export function hostedReaderDestination(provider: string): HostedReaderDestination | null {
  return DESTINATIONS[provider] ?? null;
}

/** Whether the reader keeps the clip on the account (R-13): a slot to make, check and remove. */
export function hostedReaderKeepsSlot(provider: string): boolean {
  return DESTINATIONS[provider]?.keepsSlot === true;
}

/**
 * The token a command carries back to say "yes, send this one". Per vendor AND per voice: a
 * page with two cloned voices through the same vendor asks twice, and the first answer cannot
 * be replayed for the second (codex on PR 1153).
 */
export function hostedUploadToken(provider: string, voiceId: string): string {
  return `vendor:${provider}:${voiceId}`;
}

/** Whether the person already answered for this voice and this vendor (R-16). */
export function hostedUploadConfirmed(voice: ClonedVoice, provider: string): boolean {
  return typeof voice.remote?.[provider]?.confirmedAt === "string";
}

/**
 * The name a slot is saved under: the voice's name and the clip's hash. The hash is what makes
 * the name a key — the account can be listed for it, so a slot made by a call whose answer
 * never landed (a crash between the vendor creating it and the library recording it) is found
 * and reused rather than made again and charged again (codex on PR 1153).
 */
export function hostedSlotName(voice: Pick<ClonedVoice, "name">, clipHash: string): string {
  return `${voice.name.slice(0, 60)} · ${clipHash.replace(/^sha256:/, "").slice(0, 12)}`;
}

/** Vendor-side voice state, wired by the host with the provider clients that hold the calls. */
export interface HostedVoiceSlots {
  save(provider: string, key: string, input: { name: string; clip: Uint8Array; contentType: "audio/wav" | "audio/mpeg"; language?: string }): Promise<{ voiceId: string }>;
  remove(provider: string, key: string, voiceId: string): Promise<void>;
  /** The id of the account's voice saved under exactly this name, or null. */
  find(provider: string, key: string, name: string): Promise<string | null>;
  /** Whether the account still holds this voice — gone, or another account's, reads false. */
  has(provider: string, key: string, voiceId: string): Promise<boolean>;
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
 * unconfirmed remote engine.
 *
 * A slot is vendor-side state the library only remembers, so the record is checked against the
 * account before it is used, and the account before a slot is made: a recorded slot the account
 * no longer holds (deleted in the vendor's console, or a key rotated to another account) is
 * remade rather than sent to fail on every read; a slot the account holds under the hash-named
 * title is reused rather than made twice. The old slot is removed on a best-effort basis when a
 * re-recorded clip replaces it, because a copy the person cannot see counting against their
 * plan is the outcome R-15 exists to prevent.
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
  if (!hostedReaderKeepsSlot(provider)) return clip;
  const label = hostedReaderDestination(provider)?.label ?? provider;
  const key = await deps.getKey(provider);
  if (key === null) throw new Error(`${label} has no key in Settings — add one on Providers, then read again.`);
  if (deps.slots === undefined) throw new Error(`${label} voice slots are not configured in this build.`);
  const hash = clipHashOf(clip);
  const held = voice.remote?.[provider];
  if (held?.voiceId !== undefined && held.clipHash === hash && (await deps.slots.has(provider, key, held.voiceId))) {
    return { ...clip, remoteVoiceId: held.voiceId };
  }
  const name = hostedSlotName(voice, hash);
  const found = await deps.slots.find(provider, key, name);
  const voiceId = found ?? (await deps.slots.save(provider, key, { name, clip: clip.data, contentType: clip.contentType })).voiceId;
  await recordVoiceReader(store, voice.id, provider, { voiceId, clipHash: hash, savedAt: deps.now() });
  if (held?.voiceId !== undefined && held.voiceId !== voiceId) {
    await deps.slots.remove(provider, key, held.voiceId).catch(() => undefined);
  }
  return { ...clip, remoteVoiceId: voiceId };
}
