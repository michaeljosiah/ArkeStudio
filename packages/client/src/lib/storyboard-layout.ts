/**
 * Which layout the storyboard opens on (design turn 145): the Grid unless this person chose the
 * List last time. Remembered per person, not per scene, and never written to the world — a
 * layout name in the browser's storage is the whole of it, which is why tokens.test.ts allows
 * this one file its `localStorage` while every credential-shaped word stays forbidden.
 */
const KEY = "arke.storyboard.layout";

export type StoryboardLayout = "list" | "grid";

export function rememberedLayout(): StoryboardLayout {
  try {
    return window.localStorage?.getItem(KEY) === "list" ? "list" : "grid";
  } catch {
    // A browser that refuses storage answers the default.
    return "grid";
  }
}

export function rememberLayout(layout: StoryboardLayout): void {
  try {
    window.localStorage?.setItem(KEY, layout);
  } catch {
    // The session keeps the choice; nothing else to do.
  }
}
