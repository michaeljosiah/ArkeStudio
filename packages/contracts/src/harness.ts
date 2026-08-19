import { z } from "zod";

/**
 * Which engine runs the authoring work, and what the screen is allowed to offer (SPEC-005 R-1).
 *
 * One harness ships in the installer and one is brought by the user, and the difference is the
 * whole reason this shape exists. OpenCode is present by construction — it is inside the
 * download, so "is it there?" is not a question worth asking. Claude Code is the user's own
 * installation, which may be absent, too old, or gone since yesterday's update.
 *
 * So availability is DISCOVERED and sent to the screen, rather than assumed. A harness the
 * machine does not have must not be selectable, and the reason has to travel with the answer:
 * "not installed" and "installed but too old" want different things from the reader, and a
 * screen given only a boolean would have to invent the difference or hide it.
 */

export const HarnessEngineSchema = z.enum(["opencode", "claude"]);
export type HarnessEngine = z.infer<typeof HarnessEngineSchema>;

export const HarnessAvailabilitySchema = z
  .object({
    id: HarnessEngineSchema,
    /** How the harness is named on screen — "OpenCode", "Claude Code". */
    label: z.string().min(1),
    /** Found on this machine and clearing the version floor. The gate for selecting it. */
    installed: z.boolean(),
    version: z.string().nullable(),
    /**
     * Why it cannot be chosen, written to be read rather than logged. Null when it can be.
     *
     * Carried rather than derived because only the detector knows which case this is. A screen
     * holding `installed: false` alone could say nothing more useful than "unavailable", when
     * the true answer is often "you have 2.1.180, you need 2.1.227" — something the reader can
     * act on in a minute.
     */
    blocked: z.string().nullable(),
    /**
     * Ships inside the installer, so it is always available and never the thing being gated.
     * Kept as data rather than an id comparison so the screen does not have to know which
     * harness is the bundled one.
     */
    bundled: z.boolean(),
  })
  .strict();
export type HarnessAvailability = z.infer<typeof HarnessAvailabilitySchema>;

/** What the screen renders: every harness the app knows, and which one is currently chosen. */
export const HarnessStatusSchema = z
  .object({
    engine: HarnessEngineSchema,
    harnesses: z.array(HarnessAvailabilitySchema),
  })
  .strict();
export type HarnessStatus = z.infer<typeof HarnessStatusSchema>;

/**
 * The bundled harness, stated once. It cannot be missing, so nothing detects it — a detector
 * that reported OpenCode absent would be describing a broken installation, not a choice.
 */
export const OPENCODE_AVAILABILITY: HarnessAvailability = {
  id: "opencode",
  label: "OpenCode",
  installed: true,
  version: null,
  blocked: null,
  bundled: true,
};
