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

/**
 * Vendor-side voice state, wired by the host with the provider clients that hold the calls.
 * Every call takes the job's cancellation: a save that is aborted uploads nothing further and
 * bills no slot after the person said stop.
 */
export interface HostedVoiceSlots {
  save(provider: string, key: string, input: { name: string; clip: Uint8Array; contentType: "audio/wav" | "audio/mpeg"; language?: string }, signal?: AbortSignal): Promise<{ voiceId: string }>;
  remove(provider: string, key: string, voiceId: string, signal?: AbortSignal): Promise<void>;
  /** The id of the account's voice saved under exactly this name, or null; a listing that fails throws. */
  find(provider: string, key: string, name: string, signal?: AbortSignal): Promise<string | null>;
  /** Whether the account still holds this voice — gone, or another account's, reads false. */
  has(provider: string, key: string, voiceId: string, signal?: AbortSignal): Promise<boolean>;
}

export interface PrepareHostedClipDeps {
  getKey(provider: string): Promise<string | null>;
  slots?: HostedVoiceSlots;
  /** The job's cancellation, checked before anything is saved or recorded. */
  signal?: AbortSignal;
  now(): string;
}

/**
 * One slot flow at a time per vendor and voice. Two jobs for the same not-yet-saved voice can
 * start together — two missing blocks of one voiced page, on a lane whose concurrency is two —
 * and both would pass the listing before either had saved, making two slots and recording one
 * (codex on PR 1156). The listing-then-save is serialised in this process, and the second
 * flow re-reads the entry the first one wrote.
 */
const slotFlows = new Map<string, Promise<unknown>>();

async function serialised<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = slotFlows.get(key) ?? Promise.resolve();
  const run = previous.then(work, work);
  const settled = run.then(() => undefined, () => undefined);
  slotFlows.set(key, settled);
  try {
    return await run;
  } finally {
    if (slotFlows.get(key) === settled) slotFlows.delete(key);
  }
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
 * title is reused rather than made twice. The old slot is removed when a re-recorded clip
 * replaces it, and until the vendor confirms it gone its id stays on the entry as `stale` and is
 * tried again at the next read — the id is the only handle there is on a copy the person cannot
 * see counting against their plan, which is the outcome R-15 exists to prevent.
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
  const slots = deps.slots;
  if (slots === undefined) throw new Error(`${label} voice slots are not configured in this build.`);
  const hash = clipHashOf(clip);
  const signal = deps.signal;
  return serialised(`${provider}:${voice.id}`, async () => {
    signal?.throwIfAborted();
    // The entry as it is now, not as it was when this read began: a flow that waited its turn
    // reads the slot the flow before it recorded.
    const current = store.getBundle().clonedVoices.find((entry) => entry.id === voice.id) ?? voice;
    const held = current.remote?.[provider];
    const stale = held?.stale ?? [];
    const remaining = await removeStale(slots, provider, key, stale, signal);
    if (held?.voiceId !== undefined && held.clipHash === hash && (await slots.has(provider, key, held.voiceId, signal))) {
      if (remaining.length !== stale.length) await recordVoiceReader(store, voice.id, provider, { stale: remaining });
      return { ...clip, remoteVoiceId: held.voiceId };
    }
    const name = hostedSlotName(current, hash);
    // A listing that fails throws through here and the read fails with the reason: it is not
    // read as "no slot", because a save after an unanswered listing is the duplicate charge the
    // listing exists to prevent. Only a listing that answered "none" is followed by a save.
    const found = await slots.find(provider, key, name, signal);
    signal?.throwIfAborted();
    const voiceId = found ?? (await slots.save(provider, key, { name, clip: clip.data, contentType: clip.contentType }, signal)).voiceId;
    const replaced = held?.voiceId !== undefined && held.voiceId !== voiceId ? [held.voiceId] : [];
    // Recorded before the old slot is removed, with the old id kept as stale until it is: a
    // cancellation or a crash between the two loses no handle.
    await recordVoiceReader(store, voice.id, provider, { voiceId, clipHash: hash, savedAt: deps.now(), stale: [...remaining, ...replaced] });
    const left = await removeStale(slots, provider, key, [...remaining, ...replaced], signal);
    if (left.length !== remaining.length + replaced.length) await recordVoiceReader(store, voice.id, provider, { stale: left });
    return { ...clip, remoteVoiceId: voiceId };
  });
}

/** Remove what can be removed; the ids the vendor did not confirm gone come back to be kept. */
async function removeStale(slots: HostedVoiceSlots, provider: string, key: string, ids: readonly string[], signal: AbortSignal | undefined): Promise<string[]> {
  const kept: string[] = [];
  for (const id of ids) {
    if (signal?.aborted) {
      kept.push(id);
      continue;
    }
    try {
      await slots.remove(provider, key, id, signal);
    } catch {
      kept.push(id);
    }
  }
  return kept;
}
