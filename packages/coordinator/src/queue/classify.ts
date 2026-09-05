/**
 * Failure classification (SPEC-009 §2.6, R-7): retrying the wrong thing is expensive in a way
 * retrying HTTP is not. Ambiguity defaults to terminal (D5) — failing visibly is cheaper than
 * retrying wrongly, and a content-policy rejection retried five times is five charges.
 */

export type FailureClass = "transient" | "terminal" | "provider-fault" | "offline";

const PROVIDER_FAULT = /(HTTP 401|HTTP 403|credential was rejected|unauthoriz|unauthent|quota exhaust|billing|payment required|HTTP 402)/i;
const OFFLINE = /(fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|network is (down|unreachable)|getaddrinfo)/i;
const TRANSIENT = /(HTTP 429|rate.?limit|HTTP 5\d\d|timeout|timed out|ECONNRESET|EPIPE|socket hang up|aborted)/i;

/**
 * Transport codes, which live on `.cause` and never in the message.
 *
 * Undici throws a bare `TypeError: fetch failed` and hangs the discriminating code off the cause
 * chain. Every transport failure therefore met `OFFLINE`'s literal `fetch failed` and stopped
 * there — `TRANSIENT` never ran for exactly the codes it names. A response-header deadline
 * reached the user as "offline — jobs stay queued and resume with connectivity", and the lane
 * was paused on a premise about the network that was not true.
 *
 * The split is not whether bytes moved but whether waiting is the remedy. A name that does not
 * resolve, a refused port, no route to the host: nothing to wait for on our side, so offline, and
 * the lane holds until connectivity returns. A connection that was made and then broke, or any
 * clock running out, is transient and earns a backoff instead.
 *
 * Deadlines land on the transient side deliberately, the connect deadline included. Once #95
 * configures Arke's own connect/header/body limits, the expiry of a limit Arke itself chose must
 * never be reported as the network being down — that is this same bug, one layer up.
 */
const TRANSPORT_CLASS = new Map<string, FailureClass>([
  ["ENOTFOUND", "offline"],
  ["EAI_AGAIN", "offline"],
  ["ECONNREFUSED", "offline"],
  ["ENETUNREACH", "offline"],
  ["EHOSTUNREACH", "offline"],
  ["ENETDOWN", "offline"],
  ["EHOSTDOWN", "offline"],
  ["ECONNRESET", "transient"],
  ["EPIPE", "transient"],
  ["ETIMEDOUT", "transient"],
  ["UND_ERR_SOCKET", "transient"],
  ["UND_ERR_CONNECT_TIMEOUT", "transient"],
  ["UND_ERR_HEADERS_TIMEOUT", "transient"],
  ["UND_ERR_BODY_TIMEOUT", "transient"],
  ["UND_ERR_ABORTED", "transient"],
]);

/** The class of the outermost transport code in the chain, or null when it names none. */
function transportClass(err: unknown): FailureClass | null {
  // Outermost first: Undici's own reading of what happened (`UND_ERR_SOCKET`) is more specific
  // than the syscall errno underneath it. `seen` is what makes a self-referencing cause end.
  const seen = new Set<unknown>();
  const pending: unknown[] = [err];
  while (pending.length > 0) {
    const node = pending.shift();
    if (typeof node !== "object" || node === null || seen.has(node)) continue;
    seen.add(node);
    const code = (node as { code?: unknown }).code;
    if (typeof code === "string") {
      const klass = TRANSPORT_CLASS.get(code);
      if (klass !== undefined) return klass;
    }
    // A host with both A and AAAA records fails as an AggregateError whose members carry the
    // codes and whose outer error carries none. The local providers hit exactly that whenever
    // their server is not running, so the commonest chain of all is behind this branch.
    const members = (node as { errors?: unknown }).errors;
    if (Array.isArray(members)) pending.push(...members);
    pending.push((node as { cause?: unknown }).cause);
  }
  return null;
}

const CLASSES: ReadonlySet<string> = new Set<FailureClass>(["transient", "terminal", "provider-fault", "offline"]);

/** The class a provider client declared on the error itself, or null where it named none. */
function declaredClass(err: unknown): FailureClass | null {
  if (typeof err !== "object" || err === null) return null;
  const declared = (err as { failureClass?: unknown }).failureClass;
  return typeof declared === "string" && CLASSES.has(declared) ? (declared as FailureClass) : null;
}

export function classifyError(err: unknown): FailureClass {
  // A client that names its own class is believed before anything is read: it witnessed the
  // condition where it arose, and a card without room for a recipe (`ProviderBusyError`) has no
  // status, no transport code and no word in its message that could tell it from a refusal. D5's
  // default made it terminal, and the user was told to try again with nothing to press (#692).
  const declared = declaredClass(err);
  if (declared !== null) return declared;
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  // Next, still ahead of the chain: a witnessed HTTP status outranks any reading of the
  // transport, and a rejected credential retried on backoff is a lane that never says why it is
  // stuck. Nothing reporting one of these carries a transport code to lose.
  if (PROVIDER_FAULT.test(message)) return "provider-fault";
  // A witnessed 4xx is the provider's verdict on the request, not a reading of the transport, and
  // nothing about waiting changes it. Read after the message alone, `fal: result fetch failed
  // (HTTP 422)` met OFFLINE's literal `fetch failed` and a request that could never become valid
  // was re-fetched every poll interval for as long as the app ran (#630). 429 keeps its place on
  // the transient side; every other 4xx is D5's terminal, named by its status.
  const witnessed = /HTTP (4\d\d)/i.exec(message);
  if (witnessed !== null) return witnessed[1] === "429" ? "transient" : "terminal";
  // Then the chain, ahead of the message: `fetch failed` is what the message says for every one
  // of them, so reading it first is reading the one part that cannot tell them apart.
  const transport = transportClass(err);
  if (transport !== null) return transport;
  if (OFFLINE.test(message)) return "offline";
  if (TRANSIENT.test(message)) return "transient";
  // Invalid parameters, content policy, unknown model, anything unrecognised: terminal (D5).
  return "terminal";
}

/** A 429 additionally tells the rate limiter to adapt downward (R-10, D9). */
export function isRateLimit(err: unknown): boolean {
  if (typeof err === "object" && err !== null && (err as { responseStatus?: unknown }).responseStatus === 429) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /(HTTP 429|rate.?limit)/i.test(message);
}

/** Exponential backoff with full jitter, bounded (R-9). `attempt` is 1-based. */
export function backoffMs(attempt: number, baseMs: number, capMs: number, rng: () => number): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.5 + rng() * 0.5));
}
