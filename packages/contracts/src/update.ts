import { z } from "zod";

export const UpdateStateSchema = z
  .object({
    status: z.enum([
      "idle",
      "checking",
      "available",
      "none",
      "downloading",
      "ready",
      "install-on-close",
      "shutting-down",
      "installing",
      "updated",
      "install-failed",
      "error",
      "externally-managed",
    ]),
    targetVersion: z.string().min(1).nullable(),
    progressPercent: z.number().min(0).max(100).nullable(),
    flow: z.enum(["restart", "on-close"]).nullable(),
    detail: z.string().nullable(),
    /**
     * The waiting update's release name and notes, as plain text, from the check that found it
     * (SPEC-016 R-19). The updater fetches them with every check and used to drop them; What's
     * new shows them on the card for the update, so a person can read what they are getting
     * before pressing Download. Defaulted: a state published by an older desktop still parses.
     */
    releaseName: z.string().nullable().default(null),
    releaseNotes: z.string().nullable().default(null),
  })
  .strict();
export type UpdateState = z.infer<typeof UpdateStateSchema>;

export const IDLE_UPDATE_STATE: UpdateState = {
  status: "idle",
  targetVersion: null,
  progressPercent: null,
  flow: null,
  detail: null,
  releaseName: null,
  releaseNotes: null,
};
