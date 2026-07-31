import { z } from "zod";

/**
 * Voxa sidecar skeleton (master spec §7). Voxa is a .NET 10 self-contained executable the
 * desktop shell supervises; it serves local inference only — cloud speech goes through the
 * ordinary provider path so there is exactly one money path. SPEC-011 lands the protocol
 * client; the shapes are settled here.
 */

/** One voice in the local catalogue (Kokoro ships a fixed set; §7.1). */
export const LocalVoiceSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    engine: z.enum(["kokoro", "espeak-ng"]),
    language: z.string().min(1),
    /** Descriptive attributes used by honest attribute-overlap matching (SPEC-011). */
    attributes: z.array(z.string()),
  })
  .strict();
export type LocalVoice = z.infer<typeof LocalVoiceSchema>;

export const SidecarHealthSchema = z
  .object({
    ok: z.boolean(),
    version: z.string().optional(),
    engines: z.array(z.string()).optional(),
  })
  .strict();
export type SidecarHealth = z.infer<typeof SidecarHealthSchema>;

/** The SPEC-011 client surface, declared so callers can be written against it now. */
export interface VoiceSidecarClient {
  health(): Promise<SidecarHealth>;
  listVoices(): Promise<LocalVoice[]>;
  /** Synthesise a line to a WAV buffer. Local inference only; never a network call. */
  synthesize(input: { voiceId: string; text: string }): Promise<Uint8Array>;
}
