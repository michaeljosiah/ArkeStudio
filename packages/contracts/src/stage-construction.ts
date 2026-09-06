import { z } from "zod";
import { ShotStageEditSchema, StagingFigureSchema, StagingSetSchema } from "./scene.js";

export const StageConstructionDraftSchema = z
  .object({
    staging: ShotStageEditSchema.refine(
      (stage) => stage.keys.length >= 2 && stage.keys.length <= 120,
      "Use 2 to 120 camera keys.",
    ),
    sampleTimes: z.array(z.number().finite().nonnegative()).max(3).optional(),
    cast: z.array(StagingFigureSchema).max(30),
    sets: z.array(StagingSetSchema).max(120),
    assumptions: z.array(z.string().max(1000)).max(20),
    assessment: z.string().max(4000),
    inspected: z.array(z.string().max(100)).max(24),
  })
  .strict();
export type StageConstructionDraft = z.infer<typeof StageConstructionDraftSchema>;
export const StageInspectionFrameSchema = z
  .object({
    at: z.number().finite().nonnegative(),
    view: z.enum(["camera", "overview"]),
    observations: z.array(z.string().max(500)).max(40).optional(),
    png: z
      .string()
      .min(16)
      .max(1_000_000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export type StageInspectionFrame = z.infer<typeof StageInspectionFrameSchema>;
