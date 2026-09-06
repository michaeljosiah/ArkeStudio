import type { ChapterContinuity, ChapterSummary } from "@arke-studio/contracts";

/**
 * Where everyone is (design turn 129, SPEC-012 R-43): the door's continuity table, computed from
 * the summaries' placings alone. Chapters down in reading order, the cast across; a cell holds
 * `where` for that character after that chapter — the chapter's own when it placed them, else
 * carried from the derived chapter before it, row by row, naming the chapter that placed it and
 * in warning while that source is stale. A chapter not derived, or over the cap, breaks the
 * chain: nothing is carried across it, and a character placed before it is a dash after it until
 * a chapter places them again, because the chapter nobody read may have moved them.
 */

export interface ContinuityCell {
  where: string;
  /** The order of the chapter that placed them, when this cell is carried rather than placed here. */
  since?: number;
  /** Placed by a chapter that has moved since, or carried from one. */
  warn: boolean;
}

export interface ContinuityRow {
  chapter: ChapterSummary;
  stamp: { kind: "derived" | "none" | "stale" | "unreadable"; version?: number; omitted: number };
  cells: Array<ContinuityCell | null>;
}

export function continuityRows(chapters: readonly ChapterSummary[], cast: readonly string[]): ContinuityRow[] {
  const carry = new Map<string, { where: string; since: number; stale: boolean }>();
  return [...chapters]
    .sort((a, b) => a.order - b.order)
    .map((chapter) => {
      const record = chapter.continuity;
      // No record, or one that cannot be read (codex on turn 129): a chapter nobody has read may
      // have moved anyone, so nothing is carried across it.
      if (record === undefined || "unreadable" in record) {
        carry.clear();
        return { chapter, stamp: { kind: record === undefined ? ("none" as const) : ("unreadable" as const), omitted: 0 }, cells: cast.map(() => null) };
      }
      const stale = chapter.hash !== undefined && chapter.hash !== record.hash;
      const overCap = record.omitted > 0;
      const cells = cast.map((id): ContinuityCell | null => {
        const placed = record.placed.find((entry) => entry.character === id && entry.where !== undefined);
        if (placed !== undefined) return { where: placed.where!, warn: stale };
        const held = overCap ? undefined : carry.get(id);
        return held === undefined ? null : { where: held.where, since: held.since, warn: held.stale };
      });
      if (overCap) carry.clear();
      else {
        for (const id of cast) {
          const placed = record.placed.find((entry) => entry.character === id && entry.where !== undefined);
          if (placed !== undefined) carry.set(id, { where: placed.where!, since: chapter.order, stale });
          // A chapter that has moved may have moved anyone it did not place either (codex on turn
          // 129): every cell carried past it is in warning from here on, whatever its source says.
          else if (stale) {
            const held = carry.get(id);
            if (held !== undefined) held.stale = true;
          }
        }
      }
      return { chapter, stamp: { kind: stale ? ("stale" as const) : ("derived" as const), version: record.version, omitted: record.omitted }, cells };
    });
}

/** The row's stamp, as the design draws it: `derived · v4`, `not derived`, or the warning. */
export function continuityRowStamp(stamp: ContinuityRow["stamp"]): string {
  if (stamp.kind === "none") return "not derived";
  if (stamp.kind === "unreadable") return "record unreadable";
  if (stamp.kind === "stale") return `chapter moved · derived against v${stamp.version}`;
  return stamp.omitted > 0 ? `derived · v${stamp.version} · ${stamp.omitted} over the cap` : `derived · v${stamp.version}`;
}

/** The panel's stamp: what the check proved, and what it dropped or cut. */
export function continuityStamp(record: ChapterContinuity): string {
  const parts = [`derived · v${record.version}`];
  if (record.passes > 1) parts.push(`${record.passes} passes`);
  parts.push(
    record.dropped === 0
      ? "every line is the chapter’s own words"
      : `${record.dropped} line${record.dropped === 1 ? "" : "s"} dropped, not in the chapter`,
  );
  if (record.omitted > 0) parts.push(`${record.omitted} character${record.omitted === 1 ? "" : "s"} over the cap`);
  if (record.cut > 0) parts.push(`${record.cut} line${record.cut === 1 ? "" : "s"} over the cap`);
  return parts.join(" · ");
}

export type ChaptersView = "outline" | "continuity";

/** The door remembers which view it was on for the session; storage may be absent or refuse. */
export function rememberedChaptersView(productionId: string | undefined): ChaptersView {
  try {
    return sessionStorage.getItem(`arke.chapters.view.${productionId ?? ""}`) === "continuity" ? "continuity" : "outline";
  } catch {
    return "outline";
  }
}

export function rememberChaptersView(productionId: string | undefined, view: ChaptersView): void {
  try {
    sessionStorage.setItem(`arke.chapters.view.${productionId ?? ""}`, view);
  } catch {
    // Nothing to remember with; the choice lives for the mount.
  }
}
