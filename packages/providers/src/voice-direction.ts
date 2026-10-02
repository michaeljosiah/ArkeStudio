import type { Delivery, Sound } from "@arke-studio/contracts";

/**
 * Each reader's own words for direction, as its cadence row declares them (design turn 181,
 * SPEC-049 R-21/R-22). The contract's compiler (`mapCadence`) is the only thing that writes them
 * into a request; these tables are the rows' data, kept here beside the clients that read a
 * job written before the compiler sent compiled text (one that still names a `delivery`).
 * Read from each vendor's documentation on 2026-10-01/02; every phrase is unprobed, and the
 * listen tunes them, nothing else (SPEC-046 R-22).
 */

/**
 * Breeze takes direction three ways — a tag in the text, a sentence beside it, and a guidance
 * scale (SPEC-046 R-20, R-22). A tag where Breeze documents one for the delivery, a sentence
 * always, since a tag goes only into a line stated English (R-23). The guidance value is the
 * vendor's own example.
 */
export const BREEZE_DELIVERY: Record<Delivery, { settings: { guidance_scale: number }; tag?: string; instruction?: string }> = {
  measured: { settings: { guidance_scale: 4 }, instruction: "Read it evenly, at a steady pace." },
  whispered: { settings: { guidance_scale: 4 }, tag: "whispers", instruction: "Whisper it — hushed and close, barely voiced." },
  breaking: { settings: { guidance_scale: 4 }, tag: "sobs", instruction: "The voice is breaking; the words come through tears." },
  cold: { settings: { guidance_scale: 4 }, instruction: "Say it coldly — flat, distant, without warmth." },
  warm: { settings: { guidance_scale: 4 }, instruction: "Say it warmly and gently, close and kind." },
  urgent: { settings: { guidance_scale: 4 }, instruction: "Say it urgently, fast and pressing, as if there is no time." },
};

/**
 * Fish Audio's S2.1 takes direction as a `[bracket]` phrase in the text — natural language, not
 * a fixed set (SPEC-046 §2.9). No settings travel: `temperature` and `top_p` are sampling
 * knobs, not a delivery.
 */
export const FISH_DELIVERY: Record<Delivery, { settings: Record<string, number>; tag: string }> = {
  measured: { settings: {}, tag: "calm and even, at a steady pace" },
  whispered: { settings: {}, tag: "whispering" },
  breaking: { settings: {}, tag: "voice breaking, through tears" },
  cold: { settings: {}, tag: "cold and flat, without warmth" },
  warm: { settings: {}, tag: "warm and gentle" },
  urgent: { settings: {}, tag: "urgent, fast and pressing" },
};

/**
 * Gemini 3.8's vocalizations, from Google's list (speech-generation page, updated 2026-10-01):
 * the text is a verbatim transcript and only these, in angle brackets, are performed rather than
 * spoken.
 */
export const GEMINI_SOUNDS: Record<Sound, string> = {
  laughs: "laugh", chuckles: "chuckle", sighs: "sigh", gasps: "gasp", sobs: "sob",
  "clears throat": "throat-clearing", coughs: "cough", groans: "groan", yawns: "yawn",
};

/** Eleven v3's audio tags (free-form; these are the documented spellings). */
export const ELEVEN_V3_SOUNDS: Record<Sound, string> = {
  laughs: "laughs", chuckles: "chuckles", sighs: "sighs", gasps: "gasps", sobs: "sobs",
  "clears throat": "clears throat", coughs: "coughs", groans: "groans", yawns: "yawns",
};

/** Breeze TTS 2's English audio tags, in parentheses. */
export const BREEZE_SOUNDS: Record<Sound, string> = {
  laughs: "laugh", chuckles: "chuckle", sighs: "sigh", gasps: "gasp", sobs: "sob",
  "clears throat": "clear throat", coughs: "cough", groans: "groan", yawns: "yawn",
};

/** Fish S2.1's effect tags (free-form; the documented ones are present participles). */
export const FISH_SOUNDS: Record<Sound, string> = {
  laughs: "laughing", chuckles: "chuckling", sighs: "sighing", gasps: "gasping", sobs: "sobbing",
  "clears throat": "clear throat", coughs: "coughing", groans: "groaning", yawns: "yawning",
};
