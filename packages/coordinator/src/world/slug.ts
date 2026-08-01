import { ulid } from "@arke-studio/contracts";
import { SLUG_CAP } from "./paths.js";

/**
 * Slugification (SPEC-002 §2.4, R-7..R-9). User-authored names become filenames on Windows:
 * lowercase, transliterate where a mapping exists, collapse everything else to hyphens, cap
 * the length, escape reserved device names, and never let two names collide case-insensitively
 * — NTFS is case-insensitive and a case-sensitive check would let one sheet destroy another.
 */

/** CON, PRN, AUX, NUL, COM0–COM9, LPT0–LPT9 — reserved with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/** Common Latin diacritics fold via NFKD; a few letters have no decomposition and map by hand. */
const HAND_MAP: Record<string, string> = {
  æ: "ae",
  ø: "o",
  đ: "d",
  ð: "d",
  þ: "th",
  ß: "ss",
  ł: "l",
  œ: "oe",
};

export function slugify(name: string): string {
  let s = name.normalize("NFKD").toLowerCase();
  s = s.replace(/[\u0300-\u036f]/g, ""); // strip combining marks left by NFKD
  s = s.replace(/[æøđðþßłœ]/g, (ch) => HAND_MAP[ch] ?? "");
  s = s.replace(/[^a-z0-9]+/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  if (s.length > SLUG_CAP) s = s.slice(0, SLUG_CAP).replace(/-+$/g, "");
  if (RESERVED.test(s)) s = `${s}-x`; // escaped, not refused — the display name lives in frontmatter
  return s;
}

/** Fallback for names that slugify to nothing (emoji-only, unmapped scripts). */
export function fallbackSlug(kind: string): string {
  return `${kind}-${ulid().slice(-8).toLowerCase()}`;
}

/**
 * Produce a unique slug within a collection, compared case-insensitively (R-7, D4).
 * Collisions take a numeric suffix; the suffix respects the length cap.
 */
export function uniqueSlug(name: string, kind: string, taken: Iterable<string>): string {
  const base = slugify(name) || fallbackSlug(kind);
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const head = base.slice(0, Math.max(1, SLUG_CAP - suffix.length)).replace(/-+$/g, "");
    const candidate = `${head}${suffix}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}
