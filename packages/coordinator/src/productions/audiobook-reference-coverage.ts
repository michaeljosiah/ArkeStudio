import { chapterCharacterCoverage, chapterLocationCoverage, normalizeSpeechText, type ChapterReferenceCoverage, type PictureWho } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { planAudiobook, type AudiobookPlan } from "./audiobook.js";
import { anyNarrator } from "./audiobook-listening.js";
import { chapterPersonCandidates, LOOK_BOUNDS } from "./audiobook-look.js";
import { clip } from "./audiobook-direction.js";

/** A projection of the evidence already held, never another writing or image request. */
export function chapterReferenceCoverage(store: WorldStore, productionId: string | undefined, plan: AudiobookPlan, pictures: readonly { block: string; who: readonly PictureWho[] }[] = []): ChapterReferenceCoverage {
  const bundle = store.getBundle();
  const record = plan.record === "unreadable" ? null : plan.record;
  const look = record?.look;
  const blocks = plan.blocks.map(row => ({ key: row.block.key, text: normalizeSpeechText(row.block.text) }));
  const places = chapterLocationCoverage({ body: plan.body, sheets: bundle.sheets, kits: bundle.referenceKits, place: look?.place, blocks, pictures });
  const people = chapterPersonCandidates(store, plan, productionId);
  const whole = blocks.reduce((sum, block) => sum + block.text.length + block.key.length + 8, 0);
  const omitted = whole <= LOOK_BOUNDS.chapter ? 0 : blocks.reduce((sum, block) => sum + block.text.length - (clip(block.text, LOOK_BOUNDS.block) ?? "").length, 0);
  return {
    chapterId: plan.chapter.id, file: plan.chapter.file, title: plan.chapter.title, order: plan.chapter.order,
    preparation: plan.record === "unreadable" || plan.cast === "unreadable" ? "unreadable" : look === undefined ? "missing" : look.chapterHash !== plan.chapter.hash ? "stale" : "current",
    rows: [...chapterCharacterCoverage({ body: plan.body, sheets: bundle.sheets, kits: bundle.referenceKits, look, blocks, pictures }), ...places.rows.map(row => ({ ...row, kind: "place" as const }))],
    bounds: { people: { limit: LOOK_BOUNDS.people, omitted: Math.max(0, people.length - LOOK_BOUNDS.people) }, places: { limit: places.limit, omitted: places.omitted }, text: { limit: LOOK_BOUNDS.chapter, omitted } },
  };
}

/** Sequential reads keep large books bounded in memory; an unreadable chapter remains a row. */
export async function bookReferenceCoverage(store: WorldStore, productionId: string, pictures: ReadonlyMap<string, readonly { block: string; who: readonly PictureWho[] }[]> = new Map()): Promise<ChapterReferenceCoverage[]> {
  const chapters = [...(store.getBundle().productions.find(production => production.meta.id === productionId)?.chapters ?? [])].filter(chapter => !chapter.retired).sort((a, b) => a.order - b.order);
  const narrator = await anyNarrator(store, productionId);
  const rows: ChapterReferenceCoverage[] = [];
  for (const chapter of chapters) {
    try {
      const plan = await planAudiobook(store, productionId, chapter.id, { narrator });
      rows.push(chapterReferenceCoverage(store, productionId, plan, pictures.get(chapter.file)));
    } catch {
      rows.push({ chapterId: chapter.id, file: chapter.file, title: chapter.title, order: chapter.order, preparation: "unavailable", rows: [],
        bounds: { people: { limit: LOOK_BOUNDS.people, omitted: 0 }, places: { limit: 8, omitted: 0 }, text: { limit: LOOK_BOUNDS.chapter, omitted: 0 } } });
    }
  }
  return rows;
}
