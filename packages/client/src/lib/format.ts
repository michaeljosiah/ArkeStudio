/** Formatting helpers. Money arrives as integer micro-dollars and is formatted here only. */

export function usd(microUsd: number | null | undefined): string {
  if (microUsd === null || microUsd === undefined) return "—";
  const dollars = microUsd / 1_000_000;
  return dollars < 0.01 && dollars > 0 ? `<$0.01` : `$${dollars.toFixed(2)}`;
}

export function usdPrecise(microUsd: number | null | undefined): string {
  if (microUsd === null || microUsd === undefined) return "—";
  return `$${(microUsd / 1_000_000).toFixed(4)}`;
}

export function shortDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function shortDateTime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function seconds(n: number | undefined): string {
  return n === undefined ? "—" : `${n}s`;
}

/**
 * A runtime measured off a timeline rather than authored (issue 453).
 *
 * Every other length on the Cut is a duration somebody wrote down, so it arrives whole and
 * `seconds` never had to round. A placed film's length is wherever a person let go of the
 * pointer: "14.776s" reads as a measurement rather than a label, so whole seconds it is.
 *
 * Except near zero, which is the case worth the extra branch. A clip may be as short as
 * `MIN_CLIP_SEC`, and rounding a 0.1s film to "0s" would make something real and exportable look
 * exactly like the empty production the export refuses. Below a second it keeps a decimal, and it
 * never returns zero for a film that has anything on it at all.
 */
export function runtimeSeconds(n: number): string {
  if (n <= 0) return "0s";
  if (n >= 1) return `${Math.round(n)}s`;
  return `${Math.max(0.1, Math.round(n * 10) / 10)}s`;
}

/** "sh_12" → "Shot 12", "sc_04" → "Scene 4" — ids stay mono in detail views. */
export function humanNumber(id: string, label: string): string {
  const m = /_0*(\d+)$/.exec(id);
  return m ? `${label} ${m[1]}` : id;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/**
 * What the shelf calls a generated artifact's maker (issue 475).
 *
 * One word for the bench, another for a character's own references, because a shelf that called
 * both "made here" would answer "which of these came from a character?" with silence. Spelled
 * once, so the card and the picker tile can never disagree about the same file.
 */
export function generatedOriginLabel(artifact: { origin: { by: string; producedBy?: string } }): string {
  return artifact.origin.producedBy === "character-reference" ? "character reference" : "made here";
}
