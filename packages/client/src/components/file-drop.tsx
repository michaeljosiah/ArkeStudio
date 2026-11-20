import { useEffect, useRef, useState, type DragEvent } from "react";
import { Upload } from "./icons.js";

/** A drag carrying files from outside the window, not something dragged within the page. */
function carriesFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * A surface that takes a file dropped from outside the app (issue 3146).
 *
 * Null turns it off, and then the surface is not a target at all: offering a drop where the
 * Upload beside it is disabled would be a second way in that the first one has refused.
 *
 * Counted enter by enter, the composer's way: dragging over a child fires leave on the parent
 * before the child's enter is undone, so a plain flag flickers off while the file is still over
 * the card. A drop or a drag ended anywhere else in the window says nothing here, so those clear
 * it too.
 */
export function useFileDrop(onFiles: ((files: File[]) => void) | null) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    if (!over) return;
    const clear = () => {
      depth.current = 0;
      setOver(false);
    };
    window.addEventListener("drop", clear);
    window.addEventListener("dragend", clear);
    return () => {
      window.removeEventListener("drop", clear);
      window.removeEventListener("dragend", clear);
    };
  }, [over]);
  if (onFiles === null) return { over: false, handlers: {} };
  return {
    over,
    handlers: {
      onDragEnter: (event: DragEvent<HTMLElement>) => {
        if (!carriesFiles(event)) return;
        depth.current += 1;
        setOver(true);
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!carriesFiles(event)) return;
        // Without this the drop never fires: the window takes the file instead.
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!carriesFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        depth.current = 0;
        setOver(false);
        const files = Array.from(event.dataTransfer.files ?? []);
        if (files.length > 0) onFiles(files);
      },
    },
  };
}

/** What a drop here will do, drawn over the surface while a file is over it. */
export function DropTarget() {
  return (
    <div className="fy-dropzone fy-dropzone--over" role="status" data-testid="file-dropzone">
      <Upload size={16} />
      <span>Drop to upload</span>
    </div>
  );
}
