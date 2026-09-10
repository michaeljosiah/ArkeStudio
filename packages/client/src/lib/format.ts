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

/**
 * A date alone (`2026-08-23`) is a calendar day and is read as one, locally; anything else is
 * an instant. `new Date("2026-08-23")` is UTC midnight, which is the evening before west of
 * Greenwich — a release card read that way sat under `today` with yesterday's date beside it.
 */
export function parseDay(iso: string): Date {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(iso);
}

export function shortDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = parseDay(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * How long ago, in the fewest characters that carry it — `now`, `4h ago`, `4d ago`, `Sep 7`.
 *
 * The world card's own band (design 1a). It reads the timestamp as an age because that is the
 * question the front door asks — which of these did I touch last — and because the band it
 * shares with the world's counts is 280px wide: a full `Sep 7, 02:22` took the room the counts
 * needed and truncated them at every window width (issue 1007). Past a week an age stops being
 * informative and the date is shorter anyway.
 */
export function relativeDate(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const minutes = Math.floor((now.getTime() - d.getTime()) / 60000);
  /*
   * A stamp in the future is not `now` (codex, 2026-09-09). A world folder is portable, so it
   * can arrive saved by a machine whose clock is ahead — or this one's can be put back — and a
   * negative age satisfies every branch below, which would report a save made tomorrow as this
   * minute's. The date says what the age cannot, and shows the discrepancy rather than hiding it.
   */
  if (minutes < 0) return shortDate(iso);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return shortDate(iso);
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

/**
 * Which day a stamp falls on, said the way a feed groups its rows: today, yesterday, then a
 * count. A date alone is a local day, as `parseDay` reads it.
 */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = parseDay(iso);
  if (Number.isNaN(d.getTime())) return "earlier";
  const start = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return days < 14 ? "last week" : `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return days < 60 ? "last month" : `${Math.floor(days / 30)} months ago`;
  return shortDate(iso);
}
