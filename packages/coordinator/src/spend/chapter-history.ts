import { readFile, stat } from "node:fs/promises";
import { ChapterAudiobookSchema, productionShape, type WorldBundle } from "@arke-studio/contracts";
import { audiobookPath, legacyAudiobookPath } from "../productions/audiobook.js";
import { containedWorldFilePath } from "../world/contained-file.js";

export interface ChapterSpendHistory {
  productionId: string;
  chapterId: string;
  audio: string[];
  adopted: string[];
  pictures: string[];
  unreadable: boolean;
}
const cached = new Map<string, { stamp: string; value: ChapterSpendHistory }>();

/** Read only the retained-media identities. A file stamp avoids reparsing unchanged chapters
 * on every ledger event; unreadable records are retried, never repaired by analytics. */
export async function readChapterSpendHistory(world: WorldBundle, dir: string): Promise<ChapterSpendHistory[]> {
  const result: ChapterSpendHistory[] = [], used = new Set<string>();
  for (const production of world.productions) {
    if (!productionShape(production.meta).hasChapters) continue;
    for (const chapter of production.chapters) {
      if (!chapter.audiobook) continue;
      const key = `${dir}/${production.meta.id}/${chapter.id}`;
      used.add(key);
      const value: ChapterSpendHistory = { productionId: production.meta.id, chapterId: chapter.id, audio: [], adopted: [], pictures: [], unreadable: false };
      try {
        let path: string;
        try { path = await containedWorldFilePath(dir, audiobookPath(production.meta.id, chapter.file)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || chapter.file === "book") throw error;
          path = await containedWorldFilePath(dir, legacyAudiobookPath(production.meta.id, chapter.file));
        }
        const info = await stat(path, { bigint: true });
        const stamp = `${path}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
        const previous = cached.get(key);
        if (previous?.stamp === stamp) { result.push(previous.value); continue; }
        const record = ChapterAudiobookSchema.parse(JSON.parse(await readFile(path, "utf8")));
        for (const take of Object.values(record.takes)) {
          if (take.adopted) value.adopted.push(take.artifactId);
          else if (take.source !== "recorded") value.audio.push(take.artifactId);
        }
        for (const picture of Object.values(record.pictures ?? {})) {
          if (picture.source === "generated") value.pictures.push(picture.file);
          if (picture.tall) value.pictures.push(picture.tall.file);
        }
        cached.set(key, { stamp, value });
      } catch { value.unreadable = true; cached.delete(key); }
      result.push(value);
    }
  }
  for (const key of cached.keys()) if (!used.has(key)) cached.delete(key);
  return result;
}
