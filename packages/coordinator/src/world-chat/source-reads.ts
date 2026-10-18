import type { WorldChatCheckReceipt } from "@arke-studio/contracts";

/**
 * The chapters of one story these receipts read whole (SPEC-057 R-5). A full `get_chapter` read's
 * target is `<story>:<chapter>`; a section read (beats, plan, ending) carries a third part and is
 * not a reading of the chapter, and a paged read counts only on its final, complete page.
 *
 * `current`, when given, is each chapter's fence now: a read of a chapter edited since does not
 * count, because what was read is no longer what the story says (codex on PR 1866).
 */
export function chaptersReadWhole(
  receipts: readonly WorldChatCheckReceipt[], storyId: string, current?: (chapterId: string) => string,
): Set<string> {
  const read = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.tool !== "target-read" || (receipt.status !== "complete" && receipt.status !== "empty") || receipt.complete === false) continue;
    const target = receipt.target;
    if (target?.requirement !== "chapters" || !target.id.startsWith(`${storyId}:`)) continue;
    const parts = target.id.split(":");
    if (parts.length !== 2) continue;
    if (current && receipt.observedRevisionOrDigest !== current(parts[1]!)) continue;
    read.add(parts[1]!);
  }
  return read;
}
