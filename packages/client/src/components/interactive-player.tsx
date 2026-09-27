import { useEffect, useRef } from "react";
import { mountInteractivePlayer, type InteractivePlayerHandle, type InteractivePlayerOptions } from "@arke-studio/contracts";

/**
 * The interactive player in the app (design turn 156): the same module the exported package
 * inlines, mounted into one element and left to run. React owns only the element and the
 * lifetime; the player owns everything inside it, so the preview cannot drift from the package.
 *
 * The options are read once, when it mounts — key the component to start a fresh preview — and
 * the author's callbacks are called through a ref, so they always see the screen's current state.
 * The walk evidence is the one thing that changes under a running preview, and it is pushed in.
 */
export function InteractivePlayerView({
  options,
  unwalked,
  className,
  label,
}: {
  options: InteractivePlayerOptions;
  unwalked: readonly string[];
  className?: string;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<InteractivePlayerHandle | null>(null);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    // A modal: focus returns to what opened it, and Tab and Shift+Tab stay inside while it is up —
    // past the player's last control is the covered map, whose presses must not fire behind it.
    const opener = element.ownerDocument.activeElement as HTMLElement | null;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      // Only what can take focus now: the closed Route panel keeps its buttons under `hidden`,
      // and the bar's are display:none at a choice. Counted, one of them was the "last" control,
      // and Tab from the real last one left the player for the map behind it.
      const shown = (el: HTMLElement) =>
        el.closest("[hidden]") === null && (typeof el.checkVisibility !== "function" || el.checkVisibility());
      const focusable = [
        element,
        ...[...element.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter(shown),
      ];
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const at = element.ownerDocument.activeElement;
      if (event.shiftKey && (at === first || !element.contains(at))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (at === last || !element.contains(at))) {
        event.preventDefault();
        first.focus();
      }
    };
    element.addEventListener("keydown", trap);
    const { author, ...rest } = latest.current;
    handle.current = mountInteractivePlayer(element, {
      ...rest,
      ...(author
        ? {
            author: {
              unwalked: author.unwalked,
              onChoice: (choice, walked) => latest.current.author?.onChoice?.(choice, walked),
              onBranchMap: () => latest.current.author?.onBranchMap?.(),
              onClose: () => latest.current.author?.onClose?.(),
            },
          }
        : {}),
    });
    return () => {
      element.removeEventListener("keydown", trap);
      handle.current?.destroy();
      handle.current = null;
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
    };
  }, []);

  const walkKey = unwalked.join(" ");
  useEffect(() => {
    handle.current?.setUnwalked(unwalked);
    // The ids, not the array: a new array with the same ids is no news to the player.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walkKey]);

  return <div ref={host} className={className} role="dialog" aria-modal="true" aria-label={label} />;
}
