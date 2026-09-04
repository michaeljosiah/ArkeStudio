import { useEffect, useRef, useState, type DragEvent } from "react";
import { ComposerMic } from "./dictation.js";
import { cx } from "./ui.js";

/**
 * The composer: one input for every conversation in the studio.
 *
 * The anatomy follows opencode's prompt-input (a contenteditable surface that grows to a cap and
 * then scrolls, over a fixed control bar) because the shape solves problems a bare <input> does
 * not: multi-line drafting, a visible sense of who is answering, and — next — room for
 * attachments above the text. See design-system/composer.html for the reviewed target.
 *
 * contenteditable rather than <textarea>: @mentions will need to be coloured inline and treated
 * as single objects, which a textarea cannot do. Until mentions land it behaves as plain text,
 * and every write goes through textOf() so nothing but text can ever leave here.
 */

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  /** Who is answering — shown in the bar when the caller knows. */
  agentLabel?: string;
  /** A turn is in flight: the surface is read-only and the button says so. */
  busy?: boolean;
  busyLabel?: string;
  /** Unavailable, with the reason stated beneath rather than a dead box. */
  disabledReason?: string;
  autoFocus?: boolean;
  /** Present → the + button appears and asks the host to open its picker. */
  onAttach?: () => void;
  /**
   * Present → the microphone appears, and what is heard lands here as text.
   *
   * A callback rather than a boolean because the composer does not own the draft: what is spoken
   * is appended to whatever is already typed, and only the caller knows what that is. It is
   * never submitted — see components/dictation.tsx for why that is the whole safety story.
   */
  onDictate?: (text: string) => void;
  /**
   * Present → the whole composer becomes a drop target and pasted files are taken. Resolves
   * with whatever could not be taken, so the refusal can be shown on a chip.
   */
  onAttachFiles?: (files: readonly File[]) => Promise<readonly Trouble[]>;
  /** Present → a paste too long to be a message becomes an attachment instead. */
  onAttachText?: (text: string) => Promise<readonly Trouble[]>;
  /** What has been attached to this conversation, including private evidence not yet filed. */
  attachments?: readonly Attachment[];
  onRemoveAttachment?: (id: string) => void;
  /** Present for private conversation attachments that may be explicitly filed into the world. */
  onPromoteAttachment?: (id: string) => void;
  /** Things the world would not take, from anywhere — shown greyed among the chips. */
  refusals?: readonly Trouble[];
  onDismissRefusal?: (name: string) => void;
}

/** Something that would not go in, and why — a chip states both rather than staying silent. */
export interface Trouble {
  name: string;
  reason: string;
}

/**
 * One attachment, as the composer needs it: no path, because there isn't one to show.
 *
 * `id` is deliberately not `artifactId`. A world artifact and a private conversation attachment
 * are different things — one is filed in the world, the other is unfinished workspace that may
 * never be — and the composer has no business knowing which it is holding. It needs something
 * stable to key a chip by and hand back on removal, and that is all this is.
 */
export interface Attachment {
  id: string;
  file: string;
  kind: "audio" | "image" | "video" | "document" | "board" | "other";
  promoted?: boolean;
}

/** Its kind in one word, so a chip says what it is without needing an icon set per format. */
function kindLabel(kind: Attachment["kind"]): string {
  return kind === "other" ? "file" : kind;
}

/**
 * A paste this big is a document being handed over, not a sentence being typed — opencode's
 * thresholds, and the reason is practical: ten thousand characters in the box hide the
 * conversation and go out as one unreadable turn.
 */
export function isLongPaste(text: string): boolean {
  return text.length > 8_000 || (text.match(/\n/g)?.length ?? 0) > 120;
}

/** Only a drag carrying files concerns us — dragging selected text over the box does not. */
function carriesFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

/** The editor's text, and only its text — no markup ever escapes into state. */
function textOf(node: HTMLElement): string {
  return node.innerText.replace(/ /g, " ");
}

export function Composer(props: ComposerProps) {
  const {
    value,
    onChange,
    onSubmit,
    placeholder,
    agentLabel,
    busy = false,
    busyLabel = "Working…",
    disabledReason,
    autoFocus = false,
    onAttach,
    onDictate,
    onAttachFiles,
    onAttachText,
    attachments = [],
    onRemoveAttachment,
    onPromoteAttachment,
    refusals = [],
    onDismissRefusal,
  } = props;
  const editor = useRef<HTMLDivElement | null>(null);
  const off = disabledReason !== undefined;
  const locked = off || busy;
  const canSend = !locked && value.trim().length > 0;

  // Drag state, counted rather than flagged: dragging over a child fires dragleave on the
  // parent, and a plain boolean makes the overlay flicker as the pointer crosses the chips.
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const [taking, setTaking] = useState(0);
  const [trouble, setTrouble] = useState<readonly Trouble[]>([]);
  // Dismissed by name-and-reason rather than by identity, so the × works on refusals the caller
  // owns as well as ones raised here. Without it the button is decoration on half the chips.
  const [waved, setWaved] = useState<readonly string[]>([]);
  const takesFiles = onAttachFiles !== undefined && !locked;

  function endDrag(): void {
    depth.current = 0;
    setDragging(false);
  }

  async function take(run: () => Promise<readonly Trouble[]>, count: number): Promise<void> {
    setTaking((n) => n + count);
    const refused = await run().catch(() => [{ name: "that", reason: "the app could not take it" }]);
    setTaking((n) => Math.max(0, n - count));
    // Keep the last few only: a refusal is news for a moment, not a list to manage.
    if (refused.length > 0) setTrouble((prev) => [...prev, ...refused].slice(-3));
  }

  const troubleKey = (t: Trouble) => `${t.name}\0${t.reason}`;
  const shown = [...refusals, ...trouble].filter((t) => !waved.includes(troubleKey(t)));

  // React does not own the contenteditable's children — writing them on every render would
  // fight the caret. Only correct the DOM when it has actually drifted from state (a send that
  // cleared the box, a draft restored from elsewhere).
  useEffect(() => {
    const node = editor.current;
    if (node && textOf(node) !== value) node.innerText = value;
  }, [value]);

  useEffect(() => {
    if (autoFocus && !locked) editor.current?.focus();
  }, [autoFocus, locked]);

  return (
    <div
      className={cx("fy-cx", off && "fy-cx--off", dragging && "fy-cx--drag")}
      {...(takesFiles
        ? {
            onDragEnter: (e: DragEvent<HTMLDivElement>) => {
              if (!carriesFiles(e)) return;
              depth.current += 1;
              setDragging(true);
            },
            onDragOver: (e: DragEvent<HTMLDivElement>) => {
              if (!carriesFiles(e)) return;
              // Without this the browser opens the file instead, replacing the whole app.
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            },
            onDragLeave: () => {
              depth.current -= 1;
              if (depth.current <= 0) endDrag();
            },
            onDrop: (e: DragEvent<HTMLDivElement>) => {
              if (!carriesFiles(e)) return;
              e.preventDefault();
              endDrag();
              const files = Array.from(e.dataTransfer.files);
              if (files.length > 0 && onAttachFiles) void take(() => onAttachFiles(files), files.length);
            },
          }
        : {})}
    >
      {dragging && (
        <div className="fy-cx__drop">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <path d="M12 16V4m0 0L7 9m5-5l5 5" />
            <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
          <span>Drop to attach</span>
        </div>
      )}
      {(attachments.length > 0 || shown.length > 0) && (
        <div className="fy-cx__strip">
          {shown.map((t, i) => (
            <span key={`${t.name}-${i}`} className="fy-cx__chip fy-cx__chip--bad" title={t.reason}>
              <span className="fy-cx__chipname">{t.name}</span>
              <span className="fy-cx__chipkind">{t.reason}</span>
              <button
                type="button"
                className="fy-cx__chipx"
                aria-label={`Dismiss — ${t.name} was not attached`}
                onClick={() => {
                  setWaved((prev) => [...prev, troubleKey(t)]);
                  onDismissRefusal?.(t.name);
                }}
              >
                ×
              </button>
            </span>
          ))}
          {attachments.map((a) => (
            <span key={a.id} className="fy-cx__chip" title={a.file}>
              <span className="fy-cx__chipname">{a.file}</span>
              <span className="fy-cx__chipkind">{kindLabel(a.kind)}</span>
              {onPromoteAttachment && a.promoted === false && (
                <button
                  type="button"
                  className="fy-cx__chipaction"
                  onClick={() => onPromoteAttachment(a.id)}
                >
                  File in world
                </button>
              )}
              {onRemoveAttachment && (
                <button
                  type="button"
                  className="fy-cx__chipx"
                  aria-label={`Stop referring to ${a.file}`}
                  title="Stop referring to this — it stays filed in the world"
                  onClick={() => onRemoveAttachment(a.id)}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div className="fy-cx__editorwrap">
        <div
          ref={editor}
          className="fy-cx__editor"
          role="textbox"
          aria-multiline="true"
          aria-label={placeholder}
          contentEditable={!locked}
          suppressContentEditableWarning
          spellCheck
          onInput={(e) => onChange(textOf(e.currentTarget))}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a new line. Never while an IME is composing — that
            // key is the user choosing a candidate, not sending. Never on auto-repeat either.
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (e.repeat || !canSend) return;
            onSubmit();
          }}
          onPaste={(e) => {
            // A file on the clipboard is an attachment, not text — a screenshot goes straight
            // to a chip instead of by way of save-it-somewhere-then-attach-it.
            const files = Array.from(e.clipboardData.files);
            if (files.length > 0 && onAttachFiles && !locked) {
              e.preventDefault();
              void take(() => onAttachFiles(files), files.length);
              return;
            }
            // Paste as plain text: a copied web page must not bring its markup with it.
            e.preventDefault();
            const text = e.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
            if (onAttachText && !locked && isLongPaste(text)) {
              void take(() => onAttachText(text), 1);
              return;
            }
            document.execCommand("insertText", false, text);
          }}
        />
        {value.length === 0 && <div className="fy-cx__placeholder">{placeholder}</div>}
      </div>

      <div className="fy-cx__bar">
        <div className="fy-cx__left">
          {onAttach && (
            <button
              type="button"
              className="fy-cx__attach"
              disabled={locked}
              aria-label="Attach images, documents and audio"
              title="Attach images, documents and audio"
              onClick={onAttach}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          )}
          {/* Mounted only when asked for, which is what keeps this component free of the store:
              the capture state machine lives inside the child, not here. */}
          {onDictate && <ComposerMic onText={onDictate} disabled={locked} />}
          {agentLabel !== undefined && <span className="fy-cx__agent">{agentLabel}</span>}
          {busy && <span className="fy-cx__busy">{busyLabel}</span>}
          {taking > 0 && (
            <span className="fy-cx__busy">
              attaching {taking === 1 ? "a file" : `${taking} files`}…
            </span>
          )}
        </div>
        <button
          type="button"
          className="fy-cx__send"
          disabled={!canSend}
          aria-label="Send"
          title={canSend ? "Send  ↵" : undefined}
          onClick={onSubmit}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>

      {off && <div className="fy-cx__reason">{disabledReason}</div>}
    </div>
  );
}
