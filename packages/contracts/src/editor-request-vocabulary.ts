import { z } from "zod";

/** Shared request vocabulary stays below generic requests and effect proposal schemas. */
export const EDITOR_REQUEST_BOUNDS = { perTurn: 2, commands: 50, summary: 500, kept: 200 } as const;
export const EditorRequestIdSchema = z.string().regex(/^req_[0-9A-HJKMNP-TV-Z]{26}$/, "an editor request id is req_ followed by a ULID");
export type EditorRequestId = z.infer<typeof EditorRequestIdSchema>;
