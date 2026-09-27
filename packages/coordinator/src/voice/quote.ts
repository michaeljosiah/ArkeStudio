import { createHash } from "node:crypto";
import type { SpeechQuote } from "@arke-studio/contracts";

/** Bind a displayed authorisation to the prepared request and its dated rates (SPEC-049 R-8).
 * Recomputed at dispatch, rather than retained as permission to charge after an edit. */
export function speechConsentToken(context: string, quotes: readonly SpeechQuote[]): string {
  return createHash("sha256").update(JSON.stringify([context, quotes.map(({ quotedAt: _at, ...quote }) => quote)])).digest("hex");
}
