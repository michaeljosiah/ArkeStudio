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
