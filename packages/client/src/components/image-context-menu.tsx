import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { copyImage, copyableImageSource } from "../lib/clipboard-image.js";

/**
 * Right-click any picture in the studio and copy it.
 *
 * One listener at the root rather than a control on each frame. Pictures are drawn in something
 * like twenty places here, and a per-screen menu would have been twenty chances to forget the
 * next one — the affordance people expect is the one that is on *every* image, including the
 * ones added after this was written.
 *
 * A screen that already answers a right-click keeps it: the canvas menus and the timeline call
 * `preventDefault` on their own handlers, and this stands down whenever that has happened.
 */
const MENU_WIDTH = 168;
const MENU_HEIGHT = 40;
const EDGE = 8;

const TOAST_CLASSES = {
  toast: "fy-toast",
  title: "fy-toast__title",
  description: "fy-toast__description",
  closeButton: "fy-toast__close",
};

interface OpenMenu {
  src: string;
  left: number;
  top: number;
}

export function ImageContextMenu() {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const item = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  /** Where the keyboard was before the menu took it, so closing puts it back. */
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      // A screen with its own menu for this spot has already claimed the click.
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      // The save control sits over the corner of a picture, so a right-click that lands on it is
      // still a right-click on the picture as far as anyone is concerned.
      const image =
        target?.closest("img") ?? target?.closest(".fy-imghost")?.querySelector("img") ?? null;
      const src = image === null ? null : copyableImageSource(image);
      if (src === null) return;
      event.preventDefault();
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setMenu({
        src,
        left: Math.min(Math.max(EDGE, event.clientX), window.innerWidth - MENU_WIDTH - EDGE),
        top: Math.min(Math.max(EDGE, event.clientY), window.innerHeight - MENU_HEIGHT - EDGE),
      });
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  useEffect(() => {
    if (menu === null) return;
    item.current?.focus();
    const close = (restoreFocus = false) => {
      if (restoreFocus) opener.current?.focus();
      setMenu(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && panel.current?.contains(event.target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape hands the keyboard back where it came from; anything that moved focus already
      // (Tab) has said where it wants to be, so it keeps it.
      if (event.key === "Escape") close(true);
      else if (event.key === "Tab") close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    // Capture, because the menu is placed against the viewport and any scrolling pane at all
    // moves the picture out from under it.
    const dismiss = () => close();
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [menu]);

  if (menu === null) return null;
  return (
    <div
      ref={panel}
      className="fy-imgmenu"
      role="menu"
      aria-label="Image actions"
      style={{ left: menu.left, top: menu.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        ref={item}
        type="button"
        role="menuitem"
        onClick={() => {
          setMenu(null);
          void copyImage(menu.src).then((outcome) => {
            if (outcome.ok) {
              toast.success("Image copied", { classNames: TOAST_CLASSES });
              return;
            }
            toast.error("That image was not copied", {
              description: outcome.reason,
              classNames: TOAST_CLASSES,
            });
          });
        }}
      >
        Copy image
      </button>
    </div>
  );
}
