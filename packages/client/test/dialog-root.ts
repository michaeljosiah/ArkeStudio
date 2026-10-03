/**
 * Where a test looks for a dialog. Every sheet and dialog is drawn on the document's body
 * (`BodyLayer`, and `PageSheet` before it), never in the container the screen was mounted into:
 * a fixed layer opened inside a transformed ancestor is a clipped box over that ancestor, not a
 * window-wide layer. So `container.querySelector(".fy-editordialog")` finds nothing, and a test
 * that wants the dialog queries here. A test's own roots are unmounted and removed in its
 * teardown, so the body holds this test's layers and no other's.
 */
export function dialogRoot(container?: { ownerDocument: Document } | null): HTMLElement {
  return (container?.ownerDocument ?? document).body;
}
