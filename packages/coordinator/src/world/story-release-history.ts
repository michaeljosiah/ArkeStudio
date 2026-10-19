/** Authored immutable versions only. Prepared actions and session receipts are not story content. */
export function isStoryReleaseHistoryFile(relative: string, productions: ReadonlySet<string>): boolean {
  const parts = relative.split("/");
  if (parts.some(p => !p || p === "." || p === ".." || p.includes("\\"))) return false;
  const version = /^v[1-9][0-9]*\.(md|json)$/;
  if (!version.test(parts.at(-1)!)) return false;
  if (parts.length === 2) return ["bible", "art-direction"].includes(parts[0]!);
  if (parts.length === 3) return ["canon", "characters", "factions", "locations", "references", "voices"].includes(parts[0]!);
  if (parts[0] !== "productions" || !productions.has(parts[1]!)) return false;
  return (parts.length === 4 && ["story", "prose-style", "routing", "season", "narrative"].includes(parts[2]!)) ||
    (parts.length === 5 && ["chapters", "scenes", "episodes", "scripts"].includes(parts[2]!));
}

/** Old change records use entity identity rather than an exact current filename. */
export function isStoryReleaseLegacyChange(entity: unknown, productions: ReadonlySet<string>): boolean {
  if (typeof entity !== "string" || /[\\:]/.test(entity)) return false;
  const parts = entity.split("/");
  if (parts.some(p => !p || p === "." || p === ".." || p.startsWith("."))) return false;
  if (parts[0] === "productions") return parts.length >= 2 && productions.has(parts[1]!);
  if (parts.length === 1) return ["world", "bible", "art-direction"].includes(entity);
  return ["canon", "characters", "locations", "factions", "references", "voices", "artifacts"].includes(parts[0]!);
}

/** Match the known filename, so Markdown punctuation cannot become part of the lookup key. */
export function referencesStoryArtifact(text: string, filename: string): boolean {
  const reference = `artifacts/${filename}`;
  return text.includes(reference) || text.includes(encodeURI(reference));
}
