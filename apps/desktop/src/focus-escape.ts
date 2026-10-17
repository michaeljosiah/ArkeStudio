/**
 * Run in the page when Escape is pressed while it holds full screen (the chapter's Focus): leaves
 * the full screen, which the page hears and leaves Focus on, unless a menu, list or dialog is
 * showing. That Escape is the overlay's, as the page's own rule says; taking it here would close
 * the `@` or `/` menu and Focus with one key (codex on PR 1835). Only a visible one counts, so a
 * list kept in the page out of sight cannot hold the full screen for good.
 */
export const LEAVE_PAGE_FULL_SCREEN = `(() => {
  const overlay = [...document.querySelectorAll("dialog[open], [role='menu'], [role='listbox']")].some((element) => element.getClientRects().length > 0);
  if (!overlay && document.fullscreenElement) document.exitFullscreen().catch(() => {});
})()`;
