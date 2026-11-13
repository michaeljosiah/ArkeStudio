import { z } from "zod";
import { SceneAtmosphereSchema, ShotStageEditSchema, StageLightSchema, StagingFigureSchema, StagingSetSchema } from "./scene.js";

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
    /**
     * Where the location plate's camera stood, as the build estimated it from the picture (issue
     * 1818). Keep saves it on the plate; Match camera puts the matched shot's opening key there.
     */
    plateCamera: z
      .object({
        p: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
        l: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
        focalMm: z.number().finite().min(8).max(300),
      })
      .strict()
      .optional(),
    /** The scene's practical lights and atmosphere, as the build read them (issue 1825); Keep writes them with the blocking. */
    lights: z.array(StageLightSchema).max(24).optional(),
    atmosphere: SceneAtmosphereSchema.optional(),
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
