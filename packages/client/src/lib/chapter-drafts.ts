import { subscribeChapterSaveResults } from "./store.js";

/** Editor-owned drafts outlive its screen so navigation cannot publish an older saved manuscript. */
export type ParkedDraft = { value: string; baseHash: string; landedBody: string | null; conflict?: boolean; cancel?: () => void };
export const parkedDrafts = new Map<string, ParkedDraft>();
export const parkedKey = (worldId: string, prodId: string, file: string): string => `${worldId}/${prodId}/${file}`;

/** The editor already flushed on leaving. Wait for its acknowledgements, never duplicate its writes. */
export async function waitForChapterSaves(worldId: string, productionId: string, chapters: readonly { file: string; title: string }[], signal: AbortSignal): Promise<void> {
  const unresolved = () => chapters.flatMap(chapter => { const draft = parkedDrafts.get(parkedKey(worldId, productionId, chapter.file)); return draft ? [{ chapter, draft }] : []; });
  if (!unresolved().length) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => { clearTimeout(timer); off(); signal.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
    const check = () => {
      const remaining = unresolved();
      if (!remaining.length) { finish(); return; }
      const failed = remaining.find(row => row.draft.conflict || !row.draft.cancel);
      if (failed) finish(new Error(`Open “${failed.chapter.title}” and resolve its unsaved draft before publishing.`));
    };
    const abort = () => finish(new DOMException("Cancelled", "AbortError"));
    // Editor listeners can replace a waiting save with its successor in the same dispatch.
    const off = subscribeChapterSaveResults(() => queueMicrotask(check));
    const timer = setTimeout(() => finish(new Error("Chapter saving has not finished. Open the chapter and check its save status before publishing.")), 15_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else check();
  });
}
