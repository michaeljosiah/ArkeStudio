/**
 * Release cards (SPEC-016 R-18, design turn 136): `docs/releases/<tag>/notes.md`, front matter
 * naming a title, a date and the picture beside it, then the notes as plain paragraphs. The
 * parsing is here, away from the bundler, so it can be tested on a string.
 */
export interface ReleaseCard {
  /** `0.5.47`, as package.json spells it. */
  version: string;
  /** `v0.5.47`, as the tag and the folder spell it. */
  tag: string;
  title: string;
  /** `YYYY-MM-DD`. */
  date: string;
  paragraphs: string[];
  /** A URL the page can load, or null when the card has no picture. */
  picture: string | null;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Null when the card cannot be read: a missing title or date, or no paragraph at all. */
export function parseReleaseCard(tag: string, raw: string, picture: string | null): ReleaseCard | null {
  const match = FRONT_MATTER.exec(raw);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (field) fields[field[1]!.toLowerCase()] = field[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  const title = fields["title"];
  const date = fields["date"];
  if (!title || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const paragraphs = match[2]!
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.replace(/\s*\r?\n\s*/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0);
  if (paragraphs.length === 0) return null;
  return { version: tag.replace(/^v/, ""), tag, title, date, paragraphs, picture };
}

/** Dotted numbers compare numerically; a pre-release suffix sorts below the release it precedes. */
export function compareVersions(a: string, b: string): number {
  const split = (version: string) => {
    const [core = "", pre] = version.replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre: pre ?? null };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i += 1) {
    const difference = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (difference !== 0) return difference;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre.localeCompare(right.pre);
}

/** Newest first. */
export function orderReleases(cards: readonly ReleaseCard[]): ReleaseCard[] {
  return [...cards].sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * What has not been read (SPEC-014 R-24, R-25). A version never recorded counts only the newest
 * card as unread: a fresh install announces one release, not the history it also carries.
 */
export function unreadReleases(cards: readonly ReleaseCard[], seenVersion: string | null): ReleaseCard[] {
  const ordered = orderReleases(cards);
  if (ordered.length === 0) return [];
  if (seenVersion === null) return [ordered[0]!];
  return ordered.filter((card) => compareVersions(card.version, seenVersion) > 0);
}

export const RELEASE_PAGE = "https://github.com/michaeljosiah/ArkeStudio/releases/tag/";
