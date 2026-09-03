import { z } from "zod";

/** One labelled press whose content and decision arrive together (SPEC-040 R-2, R-7). */
export const SingleActOperationSchema = z.enum([
  "canon-create",
  "canon-amend",
  "canon-settle",
  "story-overview-edit",
  "season-edit",
  "episode-edit",
  "sheet-duplicate",
  "sheet-status",
  "sheet-rename",
  "guest-promotion",
  "art-direction-edit",
]);
export type SingleActOperation = z.infer<typeof SingleActOperationSchema>;

/** The inverse suited to the accepted act, carried back rather than reconstructed by the client. */
export const SingleActUndoSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("restore-version"), path: z.string().min(1), version: z.number().int().min(1) }).strict(),
  z.object({ kind: z.literal("restore-derived-art-direction"), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("retire"), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("rename-sheet"), path: z.string().min(1), name: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("set-sheet-status"), path: z.string().min(1), status: z.enum(["sketch", "locked"]) }).strict(),
]);
export type SingleActUndo = z.infer<typeof SingleActUndoSchema>;
