import { chapterCalled, chapterNumber } from "@arke-studio/contracts";

type Book = ReadonlyArray<{ order: number; title: string; retired?: boolean }> | undefined;

const at = (chapters: Book, order: number) => chapters?.find((each) => each.order === order && each.retired !== true);

/**
 * What the book calls the chapter at a place (SPEC-047 R-2), for a screen that holds only its
 * order: `Chapter N` counted without an unnumbered prologue before it, or a prologue's own title.
 * Named by place, a book that opens on a prologue had every screen calling Iwo Road "Chapter 24"
 * under a heading read "Chapter 23 · Iwo Road" (issue 3240). A chapter the book no longer holds
 * keeps the place it was given.
 */
export function calledAt(chapters: Book, order: number): string {
  const chapter = at(chapters, order);
  return chapter === undefined ? `Chapter ${order}` : chapterCalled(chapters!, chapter);
}

/** The number alone, as `calledAt` counts it: none for a prologue. */
export function numberAt(chapters: Book, order: number): number | null {
  const chapter = at(chapters, order);
  return chapter === undefined ? order : chapterNumber(chapters!, chapter);
}
