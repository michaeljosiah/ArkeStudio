import { useRef } from "react";
import { Loading } from "./loading.js";
import { useStore, type WorldOpenProgress } from "../lib/store.js";

/**
 * What a world's open is doing, in place of the bare loader line (issue 1844).
 *
 * A large world took up to two minutes behind one unchanging "opening the world", which is also
 * exactly what a hang looks like. The coordinator now says which part of the open it is in and,
 * while it reads, how many files it has read; this turns that into the loader's label.
 */

/** This world's progress, and only this one's: a late word from an earlier open is not news. */
export function useWorldOpenProgress(worldId: string | undefined): WorldOpenProgress | null {
  const progress = useStore().worldOpenProgress;
  return progress !== null && progress.worldId === worldId ? progress : null;
}

const count = (n: number) => n.toLocaleString("en-US");

export function worldOpeningLabel(progress: WorldOpenProgress | null): string {
  switch (progress?.phase) {
    case "reading": {
      const { done, total } = progress;
      if (done === undefined) return "reading the world";
      // The total is how many files the last open read. A world that has grown since outruns it,
      // and a count past its own total is a wrong number, so it is shown alone.
      return total !== undefined && done <= total
        ? `reading the world · ${count(done)} of ${count(total)}`
        : `reading the world · ${count(done)} files`;
    }
    case "checking":
      return "checking the world";
    case "conversations":
      return "checking conversations";
    case "finishing":
      return "finishing";
    default:
      return "opening the world";
  }
}

export function WorldOpening({ worldId }: { worldId: string | undefined }) {
  const progress = useWorldOpenProgress(worldId);
  // The progress is forgotten just before the world arrives (codex on PR 1887); an open that has
  // said its phases is finishing then, not starting again at "opening the world" (issue 1888).
  const seen = useRef<string | undefined>(undefined);
  if (progress) seen.current = worldId;
  return <Loading label={progress === null && seen.current === worldId && worldId !== undefined ? "finishing" : worldOpeningLabel(progress)} />;
}
