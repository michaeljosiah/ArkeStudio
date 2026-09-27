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
      handle.current?.destroy();
      handle.current = null;
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
