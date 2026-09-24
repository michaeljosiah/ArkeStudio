/**
 * Version order, the way SemVer says it (design turn 136; codex on PR 1087). Dotted numbers
 * compare numerically; a pre-release sorts below the release it precedes, and its identifiers
 * compare by number where numeric, numeric below alphanumeric, a shorter matching set below a
 * longer one — so `beta.10` outranks `beta.2`. Shared by the client, which orders release cards
 * and decides what is unread, and the coordinator, which never lets a read marker move back.
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

/** The later of two versions, either of which may be unset. */
export function laterVersion(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return compareVersions(b, a) > 0 ? b : a;
}
