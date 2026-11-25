import { z } from "zod";
import { IsoDateTimeSchema, Sha256Schema, ShotIdSchema, TakeIdSchema } from "./ids.js";
import type { Take } from "./take.js";

/**
 * What is measured of a take when it comes back (design turns 287 and 288c): the checks a person
 * would otherwise make by watching it, run the same way every time. Gold on Gold's first Wan pass
 * was watched shot by shot and still went out with a cut inside a take, two voices nobody wrote
 * near the ends of takes, camera that drifted and never breathed, and lines laid off the take's
 * voice; each of those is a number, and a number is a check (turn 286 rule 2).
 *
 * Only measured items are here. The looked ones of turn 287's list (the face against the sheet,
 * hands, the joins, the production's own lines) are Arke's, with the continuity skill and the
 * frames, until a later slice makes them checks too.
 */
export const TAKE_CHECKS = ["lip-sync", "words", "unwritten-voice", "cuts-inside", "camera", "light"] as const;
export const TakeCheckIdSchema = z.enum(TAKE_CHECKS);
export type TakeCheckId = z.infer<typeof TakeCheckIdSchema>;

/** The list's labels, as the take's panel shows them. */
export const TAKE_CHECK_NAMES: Readonly<Record<TakeCheckId, string>> = {
  "lip-sync": "Lip sync",
  words: "Words",
  "unwritten-voice": "Voice nobody wrote",
  "cuts-inside": "Cuts inside",
  camera: "Camera",
  light: "Light",
};

/** The items a take is not used with (turn 287's hard items); camera and light are advice. */
export const HARD_TAKE_CHECKS: ReadonlySet<TakeCheckId> = new Set(["lip-sync", "words", "unwritten-voice", "cuts-inside"]);

export const TakeCheckSchema = z
  .object({
    id: TakeCheckIdSchema,
    result: z.enum(["pass", "fix"]),
    /** The figure or the few words the list shows beside the label: "0 ms", "at 7.6 s", "handheld · 7 px". */
    says: z.string().min(1).max(80),
    /** Where the take could end to leave out what failed: a voice nobody wrote after the line. */
    endAtSec: z.number().finite().positive().optional(),
  })
  .strict();
export type TakeCheck = z.infer<typeof TakeCheckSchema>;

/** Why an item was not measured: the take has nothing for it to measure, or the host cannot. */
export const TakeCheckSkipSchema = z
  .object({
    id: TakeCheckIdSchema,
    reason: z.enum(["no-sound", "no-line", "no-voice-sent", "no-neighbour", "unavailable"]),
  })
  .strict();
export type TakeCheckSkip = z.infer<typeof TakeCheckSkipSchema>;

/**
 * One take's checks, a line of `productions/<id>/take-checks.jsonl`. Beside the take, never in it:
 * a take is the immutable record of what was asked and what came back, and a measurement made
 * afterwards is neither (as `media-info.json` is, #253). The newest line for a take is its checks,
 * and only while `sourceHash` is the take's media.
 */
export const TakeChecksRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("after-take"),
    ts: IsoDateTimeSchema,
    takeId: TakeIdSchema,
    shotId: ShotIdSchema,
    /** The take's `mediaHash` when it was checked, in the take's own form. */
    sourceHash: Sha256Schema,
    items: z.array(TakeCheckSchema).max(TAKE_CHECKS.length),
    skipped: z.array(TakeCheckSkipSchema).max(TAKE_CHECKS.length),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = [...value.items.map(item => item.id), ...value.skipped.map(item => item.id)];
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "A check is measured or skipped once." });
  });
export type TakeChecksRecord = z.infer<typeof TakeChecksRecordSchema>;

/** A take's checks, when they were made of the media it has now. */
export function currentTakeChecks(checks: Readonly<Record<string, TakeChecksRecord>> | undefined, take: Pick<Take, "id" | "mediaHash">): TakeChecksRecord | null {
  const record = checks?.[take.id];
  return record !== undefined && take.mediaHash !== undefined && record.sourceHash === take.mediaHash ? record : null;
}

/** The count beside the take: how many measured items passed, of how many were measured. */
export function takeChecksCount(record: TakeChecksRecord): { passed: number; of: number; hardToFix: number } {
  const passed = record.items.filter(item => item.result === "pass").length;
  const hardToFix = record.items.filter(item => item.result === "fix" && HARD_TAKE_CHECKS.has(item.id)).length;
  return { passed, of: record.items.length, hardToFix };
}

/** Whether a take is one the checks measure: a clip of one shot with media of its own. */
export function takeIsCheckable(take: Pick<Take, "kind" | "media" | "mediaHash" | "coversShots" | "segment" | "panel">): boolean {
  return take.kind === "clip" && typeof take.media === "string" && take.mediaHash !== undefined
    && take.coversShots.length === 1 && take.segment === undefined && take.panel === undefined;
}
