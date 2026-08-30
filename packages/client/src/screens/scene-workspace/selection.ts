import { createContext, useContext } from "react";

/**
 * What the workspace is looking at (SPEC-029 R-25).
 *
 * One selection, shared by both views: a shot picked in Storyboard is the node focused in Flow,
 * and a node picked in Flow is the row Storyboard scrolls to. It lives above the tabs rather
 * than inside either view, which is the whole of why switching views keeps it — a per-view
 * selection is unmounted with its view, and T-18 exists because that is what happened.
 *
 * The subject is what Arke's dock reads too: the scene when nothing narrower is chosen, and
 * otherwise the shot, the edge or the board. Selection alone provides that context; there is no
 * separate "ask Arke to look at this" action.
 */
export type WorkspaceSubject =
  | { kind: "scene" }
  | { kind: "shot"; shotId: string }
  | { kind: "edge"; fromShotId: string | null; toShotId: string | null };

export interface WorkspaceSelection {
  subject: WorkspaceSubject;
  select: (subject: WorkspaceSubject) => void;
}

const SelectionContext = createContext<WorkspaceSelection>({
  subject: { kind: "scene" },
  select: () => {},
});

export const SelectionProvider = SelectionContext.Provider;

export function useWorkspaceSelection(): WorkspaceSelection {
  return useContext(SelectionContext);
}

/** The shot a subject is about, or null — the one place both views agree what "current" means. */
export function selectedShotId(subject: WorkspaceSubject): string | null {
  if (subject.kind === "shot") return subject.shotId;
  // An edge is named by its endpoints, and the shot it belongs to is where it starts: selecting
  // the seam after shot 3 keeps shot 3 the row in view, rather than jumping to the next one.
  if (subject.kind === "edge") return subject.fromShotId ?? subject.toShotId;
  return null;
}
