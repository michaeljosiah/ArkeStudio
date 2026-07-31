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
