/** Authored immutable versions only. Prepared actions and session receipts are not story content. */
export function isStoryReleaseHistoryFile(relative: string, productions: ReadonlySet<string>): boolean {
  const parts = relative.split("/");
  if (parts.some(p => !p || p === "." || p === ".." || p.includes("\\"))) return false;
  const version = /^v[1-9][0-9]*\.(md|json)$/;
  if (!version.test(parts.at(-1)!)) return false;
  if (parts.length === 2) return ["bible", "art-direction"].includes(parts[0]!);
  if (parts.length === 3) return ["canon", "characters", "factions", "locations", "references", "voices"].includes(parts[0]!);
  if (parts[0] !== "productions" || !productions.has(parts[1]!)) return false;
  return (parts.length === 4 && ["story", "production", "treatment"].includes(parts[2]!)) ||
    (parts.length === 5 && ["chapters", "scenes", "episodes", "shots"].includes(parts[2]!));
}
