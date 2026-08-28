/**
 * Log redaction at the boundary (SPEC-008 R-7): every record passes through here on its way
 * to disk, so a new call site that logs an object containing a key is redacted without that
 * path having been changed. Two nets, both applied:
 *
 *  1. Known secrets — every credential the store has seen this session is replaced wherever
 *     its value appears, in any string, regardless of field name.
 *  2. Suspicious fields — keys that look like credentials (`apiKey`, `authorization`, …) are
 *     masked wholesale, catching secrets the registry has not seen.
 */

// Prompts join the masked set (SPEC-016 R-15): diagnostics carry the log tail, and a bundle
// must be safe to paste publicly — no prompts, ever. Call sites keep prompt text out of free
// message strings for the same reason; the field mask is the mechanical backstop.
const SUSPICIOUS_FIELD = /(key|token|secret|password|credential|authorization|cookie|prompt)/i;
/** Field names that merely *contain* a suspicious word but are not credentials. */
const FIELD_ALLOWLIST = new Set(["idempotencyKey", "idempotency_key", "preReservedCanonIds", "keyHint"]);

export const REDACTED = "[redacted]";

export class SecretRegistry {
  private readonly secrets = new Set<string>();

  /** Register a plaintext secret so its value is scrubbed wherever it appears (R-7). */
  register(secret: string): void {
    // Very short strings would redact half the log by substring accident.
    if (secret.length >= 8) this.secrets.add(secret);
  }

  scrub(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      while (out.includes(secret)) out = out.replace(secret, REDACTED);
    }
    return out;
  }

  has(text: string): boolean {
    for (const secret of this.secrets) if (text.includes(secret)) return true;
    return false;
  }
}

/**
 * Absolute filesystem paths in free text (SPEC-032 R-28 — a NEW rule; SPEC-008 R-6 governs
 * credentials and is silent on paths). Subsystem reasons are built from subprocess output and
 * `Error.message`, which routinely embed the install's own paths — and every one carries the
 * user's Windows account name in it. A bare volume root (`D:`) survives on purpose: it is the
 * one filesystem identification a diagnostics record may carry, because a disk finding has to
 * name the drive.
 *
 * Three shapes, matched conservatively so product strings survive intact:
 *  - a drive letter with a separator and at least one path character (`C:\Users\…`, `C:/x`),
 *  - a UNC or `\\?\` path (`\\server\share\…`),
 *  - a POSIX path rooted at a well-known absolute first segment (`/Users/…`, `/home/…`) —
 *    anchored to those roots so hash-route strings like `/settings/engines` and URL paths do
 *    not read as filesystem locations.
 */
// A path's tail may contain spaces — `Program Files`, a two-word account name, `AI Models` —
// and stopping at the first one would leak exactly the half the rule exists to remove. A space
// is consumed only when the token after it leads onward: to another separator, or to a
// dot-extension at a word boundary (a spaced filename like `My Model.safetensors`). Prose after
// a path survives, because `is missing` leads to neither.
const PATH_TAIL = String.raw`(?:[^\s"'<>|]|[ ](?=[^\s\\/"'<>|]*(?:[\\/]|\.[A-Za-z0-9]{1,12}(?=[\s"'<>|.,;)]|$))))+`;

const ABSOLUTE_PATH = new RegExp(
  [
    String.raw`\b[A-Za-z]:[\\/]` + PATH_TAIL,
    String.raw`\\\\` + PATH_TAIL,
    // A file: URL is unambiguously a filesystem location, however many slashes it carries —
    // and it is what Node ESM errors and stack traces spell paths as.
    String.raw`\bfile:\/+[^\s"'<>|]+`,
    // The lookbehind keeps a URL's `/home/…` segment from reading as a filesystem root: the
    // character before a genuine POSIX path is a space, a bracket or the start of the string,
    // never a hostname's last letter or a scheme's colon.
    String.raw`(?<![\w:/.-])/(?:Users|home|root|var|tmp|etc|opt|usr|private|mnt|media|srv|data|Applications|Library|Volumes|snap|run)/` + PATH_TAIL,
    // Any other absolute POSIX path, recognised by its shape rather than its root. Two shapes:
    // a final segment carrying a dot-extension after at least one directory (`/x/file.bin`), or
    // an extensionless run at least three segments deep (`/nix/store/…/bin/foo` — executable
    // and directory paths in Error.message carry no extension). The product's own routes are
    // two segments (`/settings/engines`) and stay prose, as does `GET /api/foo`; a deeper
    // slash-run in prose is eaten, which leans the safe way for a diagnostics record. A spaced
    // filename under an unlisted root is the one residual this heuristic accepts, because the
    // second line is exactly that — a heuristic under the enumeration that carries the real
    // guarantee (D9).
    String.raw`(?<![\w:/.-])/(?:[^\s"'<>|/]+/)+[^\s"'<>|/.]+(?:\.[^\s"'<>|/.]+)+`,
    String.raw`(?<![\w:/.-])/(?:[^\s"'<>|/]+/){2,}[^\s"'<>|/]+`,
  ].join("|"),
  "g",
);

export const PATH_REDACTED = "[path]";

/** Replace every absolute filesystem path in `text` with the marker (SPEC-032 R-28). */
export function scrubAbsolutePaths(text: string): string {
  return text.replace(ABSOLUTE_PATH, PATH_REDACTED);
}

/**
 * The one redaction boundary diagnostics text crosses (SPEC-032 R-13, R-28, R-29): registered
 * secrets first — the path scrub must never split a secret before the registry sees it — then
 * the path rule. Spelled once and imported by the coordinator and the property test alike, so
 * the test can never pass against a composition the product does not ship.
 *
 * What it cannot catch: world content in free text. The registry knows secrets and the regex
 * knows paths; a subsystem reason that QUOTED a world name would pass both, which is why log
 * call sites keep world content out of message strings in the first place (SPEC-016 R-15's
 * discipline) and the property test plants world names in structured fields, not prose.
 */
export function diagnosticsBoundary(registry: SecretRegistry): { scrub(text: string): string } {
  return { scrub: (text) => scrubAbsolutePaths(registry.scrub(text)) };
}

/** Deep-copy `value` with secrets scrubbed and credential-shaped fields masked. */
export function redactDeep(value: unknown, registry: SecretRegistry): unknown {
  if (typeof value === "string") return registry.scrub(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, registry));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SUSPICIOUS_FIELD.test(k) && !FIELD_ALLOWLIST.has(k) && typeof v === "string" && v.length > 0) {
        out[k] = REDACTED;
      } else {
        out[k] = redactDeep(v, registry);
      }
    }
    return out;
  }
  return value;
}
