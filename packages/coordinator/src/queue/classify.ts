/**
 * Failure classification (SPEC-009 §2.6, R-7): retrying the wrong thing is expensive in a way
 * retrying HTTP is not. Ambiguity defaults to terminal (D5) — failing visibly is cheaper than
 * retrying wrongly, and a content-policy rejection retried five times is five charges.
 */

export type FailureClass = "transient" | "terminal" | "provider-fault" | "offline";

const PROVIDER_FAULT = /(HTTP 401|HTTP 403|credential was rejected|unauthoriz|unauthent|quota exhaust|billing|payment required|HTTP 402)/i;
const OFFLINE = /(fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|network is (down|unreachable)|getaddrinfo)/i;
const TRANSIENT = /(HTTP 429|rate.?limit|HTTP 5\d\d|timeout|timed out|ECONNRESET|EPIPE|socket hang up|aborted)/i;

export function classifyError(err: unknown): FailureClass {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (PROVIDER_FAULT.test(message)) return "provider-fault";
  if (OFFLINE.test(message)) return "offline";
  if (TRANSIENT.test(message)) return "transient";
  // Invalid parameters, content policy, unknown model, anything unrecognised: terminal (D5).
  return "terminal";
}

/** A 429 additionally tells the rate limiter to adapt downward (R-10, D9). */
export function isRateLimit(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /(HTTP 429|rate.?limit)/i.test(message);
}

/** Exponential backoff with full jitter, bounded (R-9). `attempt` is 1-based. */
export function backoffMs(attempt: number, baseMs: number, capMs: number, rng: () => number): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.5 + rng() * 0.5));
}
