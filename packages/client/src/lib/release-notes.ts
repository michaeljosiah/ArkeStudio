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
  /** A URL the page can load, or null when the card names no picture the build carries. */
  picture: string | null;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Null when the card cannot be read: a missing title or date, or no paragraph at all. The
 * picture is the file the front matter names, resolved by the caller to whatever the build
 * carries it as — never the first image that happens to sit in the folder.
 */
export function parseReleaseCard(
  tag: string,
  raw: string,
  resolvePicture: (file: string) => string | null,
): ReleaseCard | null {
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
  // A date that only looks like one — `2026-02-31` — would be normalised to a day the author
  // never wrote and grouped under it; the components have to round-trip (codex, PR 1087).
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  const paragraphs = match[2]!
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.replace(/\s*\r?\n\s*/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0);
  if (paragraphs.length === 0) return null;
  const named = fields["picture"];
  const picture = named ? resolvePicture(named) : null;
  return { version: tag.replace(/^v/, ""), tag, title, date, paragraphs, picture };
}

/**
 * Dotted numbers compare numerically; a pre-release sorts below the release it precedes, and
 * its identifiers compare the way SemVer says — numeric ones by number, numeric below
 * alphanumeric, and a shorter set below a longer one that matches it — so `beta.10` outranks
 * `beta.2` (codex, PR 1087).
 */
export function compareVersions(a: string, b: string): number {
  const split = (version: string) => {
    const [core = "", ...rest] = version.replace(/^v/, "").split("-");
    const pre = rest.length > 0 ? rest.join("-") : null;
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
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
  const ours = left.pre.split(".");
  const theirs = right.pre.split(".");
  for (let i = 0; i < Math.min(ours.length, theirs.length); i += 1) {
    const x = ours[i]!;
    const y = theirs[i]!;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const difference = Number(x) - Number(y);
      if (difference !== 0) return difference;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return ours.length - theirs.length;
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

/**
 * What has not been read, counting an update the updater has found as one more while it is
 * newer than the last version read — so reading it, before or after installing, clears it
 * (codex, PR 1087).
 */
export function unreadCount(cards: readonly ReleaseCard[], seenVersion: string | null, waitingVersion: string | null): number {
  const waiting =
    waitingVersion !== null && (seenVersion === null || compareVersions(waitingVersion, seenVersion) > 0) ? 1 : 0;
  return unreadReleases(cards, seenVersion).length + waiting;
}

/** The version reading What's new marks as seen: the newest card, or the waiting update when it is newer. */
export function newestVersion(cards: readonly ReleaseCard[], waitingVersion: string | null): string | null {
  const newest = orderReleases(cards)[0]?.version ?? null;
  if (waitingVersion === null) return newest;
  return newest === null || compareVersions(waitingVersion, newest) > 0 ? waitingVersion : newest;
}

export const RELEASE_PAGE = "https://github.com/michaeljosiah/ArkeStudio/releases/tag/";
