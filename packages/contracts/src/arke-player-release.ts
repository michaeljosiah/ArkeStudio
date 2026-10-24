import { z } from "zod";
import { SlugSchema } from "./ids.js";
import { PartScheduleSchema, WorldPartSchema, type PartSchedule } from "./world-package.js";
import type { ListeningChapter } from "./audiobook-listening.js";

/**
 * Releasing a production a chapter at a time (design turn 236, SPEC-058 R-43 – R-48): what each Arke
 * Player release held, so the next can follow it. An edition is a whole world; a part carries only
 * the chapters read whole since the last release and names the edition it follows, by the
 * fingerprint Arke Player tells editions apart by (R-30, R-46).
 */

/** What one release held: its own edition label and fingerprint, its chapters, and on a part the edition it follows. */
export const ArkePlayerReleaseSchema = z
  .object({
    edition: z.string().min(1).max(64),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    chapters: z.array(z.object({ id: SlugSchema, order: z.number().int().min(1), title: z.string() }).strict()).max(1000),
    part: WorldPartSchema.optional(),
  })
  .strict();
export type ArkePlayerRelease = z.infer<typeof ArkePlayerReleaseSchema>;

/** Release in the export (R-43): absent for the whole world; a part's chapters by id, and the author's schedule. */
export const ArkePlayerPartRequestSchema = z.object({ chapters: z.array(SlugSchema).min(1).max(1000), schedule: PartScheduleSchema.optional() }).strict();
export type ArkePlayerPartRequest = z.infer<typeof ArkePlayerPartRequestSchema>;

export interface ArkePlayerReleaseState {
  /** The edition parts follow now: the newest whole world. */
  edition: { label: string; fingerprint: string; exportedAt: string };
  /** The newest release, as Since names it: `since 22 Oct 2026 · Chapter 23`. */
  last: { kind: "edition" | "part"; exportedAt: string; number?: number; chapter: { order: number; title: string } | null };
  /** Every chapter the edition and its parts released. */
  released: ReadonlySet<string>;
  /** The last chapter released, by order: a part's chapters come after it. */
  lastOrder: number;
  /** The number the next part takes. */
  nextNumber: number;
  /** The newest part's schedule, which the next keeps unless the author changes it. */
  schedule?: PartSchedule;
}

/**
 * Where a production's releases stand (R-43): the newest edition, the parts after it that follow it,
 * what they released, and what comes next. Null when the production has no edition yet, so the
 * whole world is the only release it can make.
 */
export function arkePlayerReleaseState(packages: ReadonlyArray<{ productionId: string; exportedAt: string; release?: ArkePlayerRelease | undefined }>, productionId: string): ArkePlayerReleaseState | null {
  const releases = packages
    .filter((entry): entry is typeof entry & { release: ArkePlayerRelease } => entry.productionId === productionId && entry.release !== undefined)
    .sort((a, b) => (a.exportedAt < b.exportedAt ? -1 : a.exportedAt > b.exportedAt ? 1 : 0));
  const editionAt = releases.findLastIndex((entry) => entry.release.part === undefined);
  if (editionAt === -1) return null;
  const edition = releases[editionAt]!;
  const parts = releases.slice(editionAt + 1).filter((entry) => entry.release.part?.fingerprint === edition.release.fingerprint).sort((a, b) => a.release.part!.number - b.release.part!.number);
  const all = [edition, ...parts];
  const newest = all[all.length - 1]!;
  const chapters = all.flatMap((entry) => entry.release.chapters);
  const lastChapter = newest.release.chapters.reduce<{ order: number; title: string } | null>((best, chapter) => (best === null || chapter.order > best.order ? { order: chapter.order, title: chapter.title } : best), null);
  // A part carries the schedule the author left it with; an empty one is a schedule cleared, which
  // the next part keeps rather than going back to an older one (codex on PR 2173).
  const schedule = [...parts].reverse().find((entry) => entry.release.part?.schedule !== undefined)?.release.part?.schedule;
  return {
    edition: { label: edition.release.edition, fingerprint: edition.release.fingerprint, exportedAt: edition.exportedAt },
    last: { kind: newest === edition ? "edition" : "part", exportedAt: newest.exportedAt, ...(newest.release.part !== undefined ? { number: newest.release.part.number } : {}), chapter: lastChapter },
    released: new Set(chapters.map((chapter) => chapter.id)),
    lastOrder: chapters.reduce((most, chapter) => Math.max(most, chapter.order), 0),
    nextNumber: (parts.at(-1)?.release.part?.number ?? 0) + 1,
    ...(schedule !== undefined ? { schedule } : {}),
  };
}

/**
 * The listening plan with every other chapter still in the manuscript, as not read: the plan leaves
 * out a chapter outlined or with no prose, and a part that ran on past one would leave it behind
 * for good (codex on PR 2173), since the next part starts after the last chapter released.
 */
export function withUnplannedChapters(plan: readonly ListeningChapter[], manuscript: ReadonlyArray<{ id: string; order: number; title: string; retired?: boolean }>): ListeningChapter[] {
  const planned = new Set(plan.map((chapter) => chapter.chapterId));
  const unplanned: ListeningChapter[] = manuscript
    .filter((chapter) => chapter.retired !== true && !planned.has(chapter.id))
    .map((chapter) => ({ chapterId: chapter.id, order: chapter.order, title: chapter.title, state: "not read", seconds: 0, blocks: [], gaps: [], pictures: [], opening: null }));
  return [...plan, ...unplanned].sort((a, b) => a.order - b.order);
}

/** How far a chapter is read, for one that cannot go in a part yet: `read 6 of 31 blocks` (236d). */
export function chapterBlocksRead(chapter: Pick<ListeningChapter, "blocks" | "gaps">): { read: number; of: number } {
  const missing = chapter.gaps.reduce((sum, gap) => sum + gap.to - gap.from + 1, 0);
  return { read: chapter.blocks.length, of: chapter.blocks.length + missing };
}

/**
 * The chapters a part may hold (R-44): every chapter after the last release, in manuscript order, up
 * to the first not read whole — a part never skips one, so none is released before the one before.
 * The rest are listed, the first of them with how far it is read.
 */
export function arkePlayerPartChapters<T extends Pick<ListeningChapter, "chapterId" | "order" | "state">>(chapters: readonly T[], state: Pick<ArkePlayerReleaseState, "released" | "lastOrder">): { ready: T[]; waiting: T[] } {
  const after = chapters.filter((chapter) => !state.released.has(chapter.chapterId) && chapter.order > state.lastOrder).sort((a, b) => a.order - b.order);
  const stop = after.findIndex((chapter) => chapter.state !== "read");
  return stop === -1 ? { ready: after, waiting: [] } : { ready: after.slice(0, stop), waiting: after.slice(stop) };
}
