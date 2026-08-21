import { useCallback, useState } from "react";

/**
 * Whether the production rail is folded, as a decision the person made (design turn 101).
 *
 * It was route-driven before: the Cut folded the rail because the Cut wanted the width, and
 * nowhere else could. That made the width the app's to decide, and left somebody who wanted the
 * marks-only rail on every screen — or the labels on the Cut — with no way to say so.
 *
 * `null` is the third state and the reason this is not a boolean: it means nobody has said, so a
 * screen may still fold itself. The moment a person presses the control, their answer holds
 * across every route.
 *
 * Held in a module variable rather than in the browser's own store, so it lasts the session and
 * no longer. The client's credential guard (SPEC-008 R-6) bans web storage outright — by name, so
 * even writing the name here trips it — and the ban is worth more than this preference is: a rail
 * that forgets its width between launches is a smaller problem than a tripwire with a hole in it.
 * Outliving the window means a real preference on the coordinator, beside the theme.
 */
let choice: boolean | null = null;

export function useRailCollapsed(): [boolean | null, (next: boolean) => void] {
  // One rail is mounted at a time — the production layout owns it — so a module variable read
  // into local state is the whole of the sharing this needs.
  const [value, setValue] = useState<boolean | null>(choice);
  const set = useCallback((next: boolean) => {
    choice = next;
    setValue(next);
  }, []);
  return [value, set];
}
