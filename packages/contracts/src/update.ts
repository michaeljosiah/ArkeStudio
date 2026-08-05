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
  })
  .strict();
export type UpdateState = z.infer<typeof UpdateStateSchema>;

export const IDLE_UPDATE_STATE: UpdateState = {
  status: "idle",
  targetVersion: null,
  progressPercent: null,
  flow: null,
  detail: null,
};
