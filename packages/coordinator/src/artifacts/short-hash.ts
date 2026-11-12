import { createHash } from "node:crypto";

/**
 * An artifact's content hash as its sidecar records it: `sha256:` and the first 16 hex characters
 * of the digest. Every sidecar on disk carries exactly this form, and every check that a file is
 * still the one filed compares against it, so the form cannot change. It was written out inline
 * at each place an artifact is filed or checked (issue 2824); this is that one expression.
 */
export function artifactShortHash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
}
