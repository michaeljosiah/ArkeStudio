// Small editable fields shared across screens: text edited in place, a scene title, seconds (issue 2816).
import { useState, useRef, useEffect } from "react";
import { cx, Textarea } from "./ui.js";
import { Mentions } from "./mentions.js";

// ---------------------------------------------------------------------------
// Inline editors — display renders mentions as chips; a click opens plain text
// ---------------------------------------------------------------------------

export function EditableText({
  value,
  placeholder,
  className,
  rows = 4,
  maxLength,
  onCommit,
}: {
  value: string;
  placeholder: string;
  className?: string;
  rows?: number;
  /** The most the field's save will accept; typing stops there rather than the save being refused. */
  maxLength?: number;
  onCommit: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <div
        role="textbox"
        tabIndex={0}
        title="Type @ to reference"
        className={cx("fy-sbscript", value.trim() === "" && "fy-sbscript--blank", className)}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setEditing(true);
        }}
      >
        {value.trim() === "" ? placeholder : <Mentions text={value} />}
      </div>
    );
  }
  return (
    <Textarea
      autoFocus
      defaultValue={value}
      rows={rows}
      {...(maxLength !== undefined ? { maxLength } : {})}
      style={{ font: "400 12.5px/1.7 var(--font-sans)" }}
      onBlur={(e) => {
        setEditing(false);
        const next = e.target.value.trim();
        if (next !== value) onCommit(next);
      }}
    />
  );
}

/**
 * The name in the header (SPEC-036 R-2, amended 2026-09-02): typed where it reads, like the
 * synopsis under it.
 *
 * A scene is born `Untitled` (R-37) and named here or by Arke, and either way it is the same
 * `edit-scene` write. Enter commits, Escape puts the old name back, and an empty box commits
 * nothing: a scene cannot be nameless, so a blank is read as "leave it", not as a clear.
 */
export function SceneTitle({
  title,
  locked = false,
  label = "Scene title",
  startEditing = false,
  onCommit,
}: {
  title: string;
  locked?: boolean;
  label?: string;
  /** Open already editing, the words selected, so typing replaces them (a new chapter's `Untitled`). */
  startEditing?: boolean;
  onCommit: (title: string) => void;
}) {
  const [editing, setEditing] = useState(startEditing && !locked);
  // Enter and Escape both unmount the input, and the blur that unmounting fires must not commit
  // a second time — or commit at all after an Escape. One flag, set by whichever key settled it.
  const settled = useRef(false);
  // The name the box opened on. A rename landing from elsewhere while it is open — another
  // window, Arke — re-renders `title` under an input still holding the old words, and a blur
  // would then write the old name over the new one against the new version (codex, PR 708).
  // The box closes on the newer name instead, and nothing it held is written.
  const openedOn = useRef(title);
  useEffect(() => {
    if (editing && title !== openedOn.current) {
      settled.current = true;
      setEditing(false);
    }
  }, [editing, title]);
  const open = () => {
    settled.current = false;
    openedOn.current = title;
    setEditing(true);
  };
  // A title that becomes new after the first render (its chapter's body arrived) opens then, and
  // through `open`, so a second opening is not left settled by the first (codex on PR 1799).
  useEffect(() => {
    if (startEditing && !locked) open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startEditing, locked]);
  if (!editing) {
    return (
      <span
        role="textbox"
        tabIndex={locked ? -1 : 0}
        aria-readonly={locked ? true : undefined}
        title={locked ? undefined : "Rename"}
        className={cx("fy-sw__title-text", locked && "fy-sw__title-text--locked")}
        onClick={() => {
          if (!locked) open();
        }}
        onKeyDown={(e) => {
          if (locked || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          open();
        }}
      >
        {title}
      </span>
    );
  }
  const commit = (input: HTMLInputElement) => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    const next = input.value.trim();
    if (next !== "" && next !== openedOn.current && title === openedOn.current) onCommit(next);
  };
  return (
    <input
      autoFocus
      className="fy-sw__title-input"
      aria-label={label}
      defaultValue={title}
      maxLength={200}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => commit(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(e.currentTarget);
        } else if (e.key === "Escape") {
          e.preventDefault();
          settled.current = true;
          setEditing(false);
        }
      }}
    />
  );
}

/** A seconds field that writes on Enter or when it is left, never on each key. */
export function SecondsField({ label, value, min, max, disabled, onCommit, testId, revision }: { label: string; value: number; min: number; max: number; disabled?: boolean; onCommit: (seconds: number) => void; testId?: string; revision?: number }) {
  const [text, setText] = useState(value.toFixed(2));
  const field = useRef<HTMLInputElement | null>(null);
  // Typed into and not yet committed: what an answer to another write must not overwrite.
  const editing = useRef(false);
  // Put back to the record's value whenever an answer lands (codex on PR 1500): a refused write
  // leaves the value as it was, and the field must not keep showing what was refused.
  // An answer to another write leaves a field being typed in alone (codex on PR 1506): only one not
  // in hand is put back, which a committed field is once it has been left.
  useEffect(() => {
    if (editing.current && field.current !== null && typeof document !== "undefined" && document.activeElement === field.current) return;
    setText(value.toFixed(2));
  }, [value, revision]);
  // Read from the field itself at the commit: what is in it is what was meant, whatever the last
  // change event carried.
  const commit = (typed: string) => {
    editing.current = false;
    const parsed = Number(typed.replace("−", "-"));
    if (!Number.isFinite(parsed)) {
      setText(value.toFixed(2));
      return;
    }
    const next = round2(clamp(parsed, min, max));
    setText(next.toFixed(2));
    if (next !== round2(value)) onCommit(next);
  };
  return (
    <input
      ref={field}
      className="fy-tm__field fy-mono"
      type="number"
      step={0.01}
      min={min}
      max={max}
      aria-label={label}
      data-testid={testId}
      value={text}
      disabled={disabled}
      onChange={(event) => {
        editing.current = true;
        setText(event.target.value);
      }}
      onBlur={(event) => commit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit(event.currentTarget.value);
      }}
    />
  );
}

export const round2 = (value: number) => Math.round(value * 100) / 100;
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
