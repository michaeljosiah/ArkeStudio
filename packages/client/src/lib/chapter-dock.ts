/**
 * Whether Arke's dock was left open in each view of a chapter (design turn 194, rule 13): the
 * Manuscript opens with it, Audiobook and Timing put away, and whatever the author does with it is
 * kept on this device for that view. A view name and open or closed in the browser's storage is the
 * whole of it — never written to the world — which is why the client policy allows this one file its
 * `localStorage` while every credential-shaped word stays forbidden. Storage that is missing,
 * blocked or throws reads as never set, so the view's own default stands.
 */
const KEY = "arke.chapter-dock.";

/** The chapter's views; Chapter is the production home (design turn 227, SPEC-056 R-1). */
export type ChapterView = "chapter" | "manuscript" | "audiobook" | "timing";

/** The dock as each view opens it here: remembered, else open in the Manuscript and put away elsewhere. */
export function rememberedDocks(): Record<ChapterView, boolean> {
  const held = (view: ChapterView): boolean | null => {
    try {
      const value = window.localStorage?.getItem(KEY + view);
      return value === "open" ? true : value === "closed" ? false : null;
    } catch {
      return null;
    }
  };
  return { chapter: held("chapter") ?? false, manuscript: held("manuscript") ?? true, audiobook: held("audiobook") ?? false, timing: held("timing") ?? false };
}

export function rememberDock(view: ChapterView, open: boolean): void {
  try {
    window.localStorage?.setItem(KEY + view, open ? "open" : "closed");
  } catch {
    // Not kept: the next visit opens the view as its default has it.
  }
}

/*
 * Whether a book's names are linked in its chapters (SPEC-056 D-5): on unless turned off from ⋯,
 * kept on this device per book as a list of the books turned off. Display only, like the dock.
 */
const NAMES_OFF_KEY = "arke.chapter.linked-names-off";

function booksWithNamesOff(): Set<string> {
  try {
    const raw = JSON.parse(window.localStorage?.getItem(NAMES_OFF_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

export function namesRemembered(book: string): boolean {
  return !booksWithNamesOff().has(book);
}

export function rememberNames(book: string, on: boolean): void {
  const off = booksWithNamesOff();
  if (on) off.delete(book);
  else off.add(book);
  try {
    window.localStorage?.setItem(NAMES_OFF_KEY, JSON.stringify([...off]));
  } catch {
    // Not kept: the next visit links the names, as the default has it.
  }
}
