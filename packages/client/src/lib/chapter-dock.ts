/**
 * Whether Arke's dock was left open in each view of a chapter (design turn 194, rule 13): the
 * Manuscript opens with it, Audiobook and Timing put away, and whatever the author does with it is
 * kept on this device for that view. A view name and open or closed in the browser's storage is the
 * whole of it — never written to the world — which is why the client policy allows this one file its
 * `localStorage` while every credential-shaped word stays forbidden. Storage that is missing,
 * blocked or throws reads as never set, so the view's own default stands.
 */
const KEY = "arke.chapter-dock.";

export type ChapterView = "manuscript" | "audiobook" | "timing";

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
  return { manuscript: held("manuscript") ?? true, audiobook: held("audiobook") ?? false, timing: held("timing") ?? false };
}

export function rememberDock(view: ChapterView, open: boolean): void {
  try {
    window.localStorage?.setItem(KEY + view, open ? "open" : "closed");
  } catch {
    // Not kept: the next visit opens the view as its default has it.
  }
}
