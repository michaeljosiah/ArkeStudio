import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function validBrowserKey(key: unknown): key is string { return typeof key === "string" && /^[a-f0-9]{64}$/.test(key); }

/** Cookies are shared across ports. Seal their bearer proof with a key held in the browser's
 * origin-scoped IndexedDB, so a sibling service cannot replay a cookie it receives. */
export function sealBrowserProof(proof: string, key: string, origin: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAAD(Buffer.from(origin));
  const encrypted = Buffer.concat([cipher.update(proof, "utf8"), cipher.final()]);
  return "v1." + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}
export function openBrowserProof(value: string | undefined, key: unknown, origin: string): string | undefined {
  if (!validBrowserKey(key) || !value?.startsWith("v1.") || value.length > 512) return;
  try {
    const bytes = Buffer.from(value.slice(3), "base64url");
    const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(origin));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
  } catch { return; }
}
