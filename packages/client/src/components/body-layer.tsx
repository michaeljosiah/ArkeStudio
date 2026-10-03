import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

const subscribe = () => () => {};

/**
 * A full-window layer drawn on the document's body, wherever in the tree it is opened from.
 *
 * `position: fixed` is fixed to the window only while no ancestor has a transform, and every
 * page head and column here enters with `fy-fade-up`, whose transform animation Chrome keeps as
 * the containing block after it settles. Opened from the audiobook door's title row, the player
 * was laid out as an 847×39 box over that row — transparent, so nothing showed and the head
 * vanished under it — and the Export sheet was clipped to the top of the page.
 *
 * On the server there is no body: the layer renders in place, which is what the SSR tests read.
 * React events still bubble through the tree that opened the layer, as they did before.
 */
export function BodyLayer({ children }: { children: ReactNode }) {
  const client = useSyncExternalStore(subscribe, () => true, () => false);
  return client ? createPortal(children, document.body) : <>{children}</>;
}
