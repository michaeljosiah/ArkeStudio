import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { PageSheet } from "./page-sheet.js";
import { useMediaQuery } from "../lib/media-query.js";

/** Chapter-owned Looks retain the real phone chrome; other PageSheet callers are unchanged. */
export function ChapterLookSheet({ children, ...props }: ComponentProps<typeof PageSheet>) {
  return <PageSheet {...props}><ChapterLookInsets />{children}</PageSheet>;
}

function ChapterLookInsets() {
  const marker = useRef<HTMLSpanElement>(null);
  const phone = useMediaQuery("(max-width: 699px)");
  useLayoutEffect(() => {
    if (!phone) return;
    const dialog = marker.current?.closest("dialog");
    const chapter = document.querySelector<HTMLElement>('[data-screen="chapter"]');
    if (!dialog || !chapter) return;
    const appBar = chapter.closest(".fy-production-app")?.querySelector<HTMLElement>(".fy-titlebar");
    const chapterBar = chapter.querySelector<HTMLElement>(".fy-scene-back");
    const head = dialog.querySelector<HTMLElement>(".fy-page-sheet__head");
    const body = dialog.querySelector<HTMLElement>(".fy-page-sheet__body");
    const foot = dialog.querySelector<HTMLElement>(".fy-page-sheet__foot");
    dialog.classList.add("fy-chapter-look-sheet");
    const measure = () => {
      const top = Math.max(0, ...[appBar, chapterBar].map(node => node?.getBoundingClientRect().bottom ?? 0));
      const safe = parseFloat(window.getComputedStyle(dialog).getPropertyValue("--chapter-look-safe-bottom")) || 0;
      const style = body ? window.getComputedStyle(body) : null;
      // Keep at least one actual line plus the body's own padding. If the chrome cannot leave
      // that much usable room, the existing full-viewport layout is the accessible fallback.
      const line = parseFloat(style?.lineHeight ?? "") || (parseFloat(style?.fontSize ?? "") || 16) * 1.5;
      const minimum = (head?.getBoundingClientRect().height ?? 0) + (foot?.getBoundingClientRect().height ?? 0)
        + (parseFloat(style?.paddingTop ?? "") || 0) + (parseFloat(style?.paddingBottom ?? "") || 0) + line;
      const fits = window.innerHeight - top - safe >= minimum;
      dialog.style.setProperty("--chapter-look-top", (fits ? top : 0) + "px");
      dialog.style.setProperty("--chapter-look-bottom", (fits ? safe : 0) + "px");
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    for (const node of [appBar, chapterBar, head, body, foot]) if (node) observer?.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect(); window.removeEventListener("resize", measure);
      dialog.classList.remove("fy-chapter-look-sheet");
      dialog.style.removeProperty("--chapter-look-top"); dialog.style.removeProperty("--chapter-look-bottom");
    };
  }, [phone]);
  return <span hidden aria-hidden="true" ref={marker} />;
}
