import { useEffect, useRef } from "react";
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
  } = props;
  const editor = useRef<HTMLDivElement | null>(null);
  const off = disabledReason !== undefined;
  const locked = off || busy;
  const canSend = !locked && value.trim().length > 0;

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
    <div className={cx("fy-cx", off && "fy-cx--off")}>
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
            // Paste as plain text: a copied web page must not bring its markup with it.
            e.preventDefault();
            const text = e.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
            document.execCommand("insertText", false, text);
          }}
        />
        {value.length === 0 && <div className="fy-cx__placeholder">{placeholder}</div>}
      </div>

      <div className="fy-cx__bar">
        <div className="fy-cx__left">
          {agentLabel !== undefined && <span className="fy-cx__agent">{agentLabel}</span>}
          {busy && <span className="fy-cx__busy">{busyLabel}</span>}
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
