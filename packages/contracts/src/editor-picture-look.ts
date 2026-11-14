import { z } from "zod";

/*
 * A cut's picture look (SPEC-038 R-45..R-50): a film grade, film grain, or both, over the whole
 * composited picture.
 *
 * A film's finish was made outside the Studio: its export went through a script that graded it and
 * laid grain over it, and the file that came back was one the Cut could not make again. The look
 * is that finish on the record. It belongs to the timeline, as the mix does, and not to a clip: a
 * grade on one shot and not the next, or grain that stops at a cut, is not a look.
 *
 * The export applies it once the picture is whole and before subtitles are burned in, so the words
 * stay clean. The Viewer draws an approximation of it; the chain below is the look itself.
 *
 * The names say `Timeline` because `PictureLook` is taken: it is what an audiobook's illustration
 * was drawn in (`audiobook-look.ts`), and both are exported from the one index.
 */

/** One grade and two strengths of grain; absent means none, and a look with neither is no look. */
export interface TimelinePictureLook { grade?: "film"; grain?: "light" | "medium" }
// Named, not inferred: the timeline record is embedded in requests and events, and the engine's
// declaration build writes an inferred member out in full wherever it is embedded, past the
// 1,000,000 characters it will write for one type (TS7056). `TextLookPatchSchema` met the same.
export const TimelinePictureLookSchema: z.ZodType<TimelinePictureLook> = z.object({ grade: z.literal("film").optional(), grain: z.enum(["light", "medium"]).optional() }).strict()
  .refine(value => value.grade !== undefined || value.grain !== undefined, "choose a grade or a grain");

// The whole look, never a patch: two rows of chips decide it, and `null` is how the last part goes.
export const TimelinePictureLookCommandSchema = z.object({ kind: z.literal("set-picture-look"), look: TimelinePictureLookSchema.nullable() }).strict();
export type TimelinePictureLookCommand = z.infer<typeof TimelinePictureLookCommandSchema>;
export const isTimelinePictureLookCommand = (value: { kind: string }): value is TimelinePictureLookCommand => value.kind === "set-picture-look";

/**
 * The look as the record holds it: only the parts that are set, so a part sent as `undefined`
 * compares equal to one never sent, in Undo and in the no-change test, and nothing at all when
 * neither is.
 */
export function timelinePictureLookWritten(look: TimelinePictureLook | null | undefined): TimelinePictureLook | undefined {
  if (!look || (look.grade === undefined && look.grain === undefined)) return undefined;
  return { ...(look.grade !== undefined ? { grade: look.grade } : {}), ...(look.grain !== undefined ? { grain: look.grain } : {}) };
}

/*
 * The film grade: a little colour out, the brightest highlights eased down and warmed, the shadows
 * a touch cool, and the over-sharp edge softened. Every curve starts at 0/0, so black stays black.
 *
 * `format=yuv444p` before `gblur` is load-bearing. `curves` works in RGB and `gblur` takes planar
 * frames only, so with nothing between them FFmpeg settles the pair on planar RGB and converts the
 * picture to it ahead of the curves. Its conversion of a 4:2:0 frame to planar RGB leaves black
 * the columns past the last multiple of 16, where there are eight or fewer of them (FFmpeg
 * n8.1.2): the last eight of a frame 1080 wide. Sent back to YUV first, the curves run in packed
 * RGB and the blur never asks for that conversion.
 */
const FILM_GRADE = "eq=saturation=0.86,"
  + "curves=r='0/0 0.25/0.228 0.5/0.5 0.75/0.765 1/0.97':g='0/0 0.25/0.235 0.5/0.5 0.75/0.755 1/0.955':b='0/0 0.25/0.247 0.5/0.5 0.75/0.74 1/0.925',"
  + "format=yuv444p,gblur=sigma=0.55";

/** The noise's strength, which FFmpeg spreads evenly either side of the plate's mid-grey. */
const GRAIN_STRENGTH: Record<NonNullable<TimelinePictureLook["grain"]>, number> = { light: 32, medium: 48 };

/**
 * The look as FFmpeg filter chains, from the picture labelled `inLabel` to one labelled `outLabel`
 * in 4:2:0 (SPEC-038 R-45..R-50). `width`, `height` and `frameRate` are the delivery's own.
 *
 * The grain is a plate made inside the graph: mid-grey at half size, noise that changes every
 * frame, softened and scaled up so it is coarse, then laid over the brightness alone.
 *
 * - The picture goes into `blend` first and the plate second. Overlay chooses between darkening
 *   and lightening by the brightness of its first input, which is what keeps the grain in the
 *   mid-tones and leaves black and white alone.
 * - Colour is the picture's own: in `normal` mode opacity 1 is the first input, and 0 would be the
 *   grey plate's.
 * - The picture and the plate meet in 4:4:4 YUV, where the first plane is brightness. A graded
 *   picture is there already; an ungraded one is brought to it.
 * - The plate is set to exactly mid-grey before the noise, so its level is stated here and not
 *   left to what the colour source makes of `gray`.
 * - The seed is fixed, so the same film exports the same grain twice.
 * - `shortest=1` ends the plate, which has no end of its own, with the picture.
 */
export function timelinePictureLookFilters(look: TimelinePictureLook, width: number, height: number, frameRate: number, inLabel: string, outLabel: string): string[] {
  const grade = look.grade === "film" ? FILM_GRADE : null;
  if (look.grain === undefined) return [`[${inLabel}]${grade ?? "null"},format=yuv420p[${outLabel}]`];
  const picture = `${outLabel}Picture`, plate = `${outLabel}Grain`, half = (value: number) => Math.max(2, Math.round(value / 4) * 2);
  return [
    `[${inLabel}]${grade ?? "format=yuv444p"}[${picture}]`,
    `color=c=gray:s=${half(width)}x${half(height)}:r=${frameRate},format=gray,lutyuv=y=128,noise=alls=${GRAIN_STRENGTH[look.grain]}:allf=t+u:all_seed=7,gblur=sigma=0.6,scale=${width}:${height}:flags=bicubic,format=yuv444p[${plate}]`,
    `[${picture}][${plate}]blend=c0_mode=overlay:c0_opacity=0.5:c1_mode=normal:c1_opacity=1:c2_mode=normal:c2_opacity=1:shortest=1,format=yuv420p[${outLabel}]`,
  ];
}
