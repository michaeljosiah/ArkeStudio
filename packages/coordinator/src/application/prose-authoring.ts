import { createChapter, openChapter, saveChapter, editChapterPlan, restoreChapter, setChapterRetired } from "../productions/ops.js";
import { readContinuity } from "../productions/continuity.js";
import { readVoices } from "../productions/voices.js";
import { readAudiobook, presentTakes } from "../productions/audiobook.js";
import type { WorldStore } from "../world/store.js";

/**
 * Local prose workspace use cases. Domain operations retain their write gates, history and
 * stale-base checks; the host translates results into its own events and drains pending saves.
 * External authorization and authoritative remote save receipts are a later engine boundary.
 */
export class ProseAuthoringService {
  constructor(private readonly store: WorldStore) {}

  create(productionId: string, input: Parameters<typeof createChapter>[2]) {
    return createChapter(this.store, productionId, input);
  }

  async open(productionId: string, chapterId: string) {
    const chapter = await openChapter(this.store, productionId, chapterId);
    // The bundle holds stamps, not the records needed to open the editing workspace.
    const continuity = await readContinuity(this.store, productionId, chapter.file);
    const voices = await readVoices(this.store, productionId, chapter.file);
    const audiobook = await readAudiobook(this.store, productionId, chapter.file);
    const present = audiobook === null || audiobook === "unreadable" ? null : await presentTakes(this.store, audiobook);
    const missing = present === null || audiobook === null || audiobook === "unreadable" ? []
      : [...new Set(Object.values(audiobook.takes).map(take => take.artifactId))].filter(id => !present.has(id));
    return {
      body: chapter.body, version: chapter.version, hash: chapter.hash, versions: chapter.versions,
      ...(continuity === "unreadable" ? { continuityUnreadable: true as const } : continuity !== null ? { continuity } : {}),
      ...(voices === "unreadable" ? { voicesUnreadable: true as const } : voices !== null ? { voices } : {}),
      ...(audiobook === "unreadable" ? { audiobookUnreadable: true as const } : audiobook !== null ? { audiobook } : {}),
      ...(missing.length > 0 ? { audiobookMissing: missing } : {}),
    };
  }

  save(productionId: string, chapterFile: string, body: string, options: Parameters<typeof saveChapter>[4]) {
    return saveChapter(this.store, productionId, chapterFile, body, options);
  }

  editPlan(productionId: string, chapterFile: string, changes: Parameters<typeof editChapterPlan>[3]) {
    return editChapterPlan(this.store, productionId, chapterFile, changes);
  }

  restore(productionId: string, chapterFile: string, version: number) {
    return restoreChapter(this.store, productionId, chapterFile, version);
  }

  retire(productionId: string, chapterFile: string, retired: boolean) {
    return setChapterRetired(this.store, productionId, chapterFile, retired);
  }
}
