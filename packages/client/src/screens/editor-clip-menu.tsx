import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { detachAudioCommands, type ArtifactSidecar, type ProductionBundle, type ProductionTimeline, type TimelineClip, type TimelineClipCommand, type TimelineClipId } from "@arke-studio/contracts";

/** Shared by the main Picture lane and video overlays; a menu never owns an edit. */
export function ClipMenu({ at, label, onClose, children }: {
  at: { x: number; y: number }; label: string; onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - box.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(at.y, window.innerHeight - box.height - 8))}px`;
  });
  useEffect(() => {
    const opener = document.activeElement;
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dismiss = () => close.current();
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) dismiss(); };
    const scroll = (event: Event) => { if (!ref.current?.contains(event.target as Node)) dismiss(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation(); event.preventDefault(); dismiss();
        if (opener instanceof HTMLElement) opener.focus();
      }
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", scroll, true);
    };
  }, []);
  return <div ref={ref} className="fy-clipmenu" role="menu" aria-label={label}
    style={{ width: 232, maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100vh - 16px)", overflowY: "auto" }}
    onPointerDown={event => event.stopPropagation()}
    onKeyDown={event => {
      if (event.key === "Tab") { close.current(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      const index = items.findIndex(item => item === document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>{children}</div>;
}

export function ExtractAudioMenuItem({ production, timeline, artifacts = [], clip, disabled, onCommands, mintClipId, onClose }: {
  production?: ProductionBundle; timeline: ProductionTimeline; artifacts?: readonly ArtifactSidecar[]; clip: TimelineClip;
  disabled: boolean; onCommands: (commands: TimelineClipCommand[], label?: string) => void; mintClipId: () => TimelineClipId; onClose: () => void;
}) {
  let reason: string | null = production ? null : "Video source unavailable";
  if (production) try { detachAudioCommands(production, timeline, artifacts, clip.id, "cl_detach-preview", true); }
  catch (error) { reason = error instanceof Error ? error.message : String(error); }
  return <>
    <button type="button" role="menuitem" className="fy-clipmenu__item" disabled={disabled || reason !== null}
      onClick={() => {
        if (disabled || reason !== null) return;
        onCommands([{ kind: "detach-audio", clipId: clip.id, newClipId: mintClipId(), newTrack: true }], "Extract audio to new track");
        onClose();
      }}>Extract audio to new track</button>
    {reason && <span className="fy-clipmenu__note">{reason}</span>}
  </>;
}
