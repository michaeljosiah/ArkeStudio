import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { commitMarkdown, type ReconcileBaselines } from "./commit.js";
import { markdownExtensions } from "./extensions.js";
import { dropStrandedEmptyBlocks, normalizeSoftBreaks } from "./normalize.js";
import { documentMarkdown, serializeMarkdown } from "./round-trip.js";
import { SlashMenu } from "./slash-menu.js";
import {
  filterSlashCommands,
  moveSelection,
  readSlashMenuState,
  runSlashCommand,
  SLASH_COMMANDS,
  type SlashCommand,
  type SlashMenuState,
} from "./slash-commands.js";

/**
 * A rich editor over markdown, where the markdown is what is real.
 *
 * The document on screen is a ProseMirror tree, but nothing outside this component ever sees one:
 * `value` is markdown in, `onChange` is markdown out, and the bytes handed back preserve the
 * formatting of the bytes handed in (see `reconcile.ts`). That is what lets this sit under a file
 * two other writers also edit — the Studio mid-conversation, and whatever the author opens the
 * folder with — without any of them having to know it exists.
 */

/**
 * How long after the last keystroke the document is serialised.
 *
 * Shorter than the screen's own autosave (1200ms) so a save always has fresh bytes to write, long
 * enough that ordinary typing pays for reconciliation once per pause rather than once per character.
 */
const SERIALIZE_MS = 400;

interface RichMarkdownEditorProps {
  /** Markdown in. Changing this from outside adopts the new document. */
  value: string;
  /** Markdown out, already carried onto `value`'s formatting. */
  onChange: (markdown: string) => void;
  placeholder?: string;
  ariaLabel: string;
}

export function RichMarkdownEditor({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: RichMarkdownEditorProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);

  const originalSource = useRef(value);
  const baseCanonical = useRef("");
  const lastCommitted = useRef(value);
  const baselines = useRef<ReconcileBaselines>({
    originalSource,
    baseCanonical,
    lastCommitted,
  }).current;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [menu, setMenu] = useState<SlashMenuState | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>(SLASH_COMMANDS);
  const [selected, setSelected] = useState(0);
  /*
   * ProseMirror keeps the `handleKeyDown` closure it was given on the first render, so everything
   * the keyboard reads has to come from a ref. State drives the drawing; these drive the keys.
   */
  const menuRef = useRef<SlashMenuState | null>(null);
  const commandsRef = useRef<SlashCommand[]>(SLASH_COMMANDS);
  const selectedRef = useRef(0);
  menuRef.current = menu;
  commandsRef.current = commands;
  selectedRef.current = selected;

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /*
   * `onCreate` is where the baselines are seeded, and reconciliation against an unseeded
   * `baseCanonical` would diff the whole document against an empty string. Nothing is expected to
   * dispatch before then, but the ordering is load-bearing enough to be stated rather than assumed.
   */
  const ready = useRef(false);

  const syncMenu = useCallback((instance: Editor) => {
    const next = readSlashMenuState(instance, shellRef.current);
    setMenu(next);
    if (!next) return;
    const filtered = filterSlashCommands(SLASH_COMMANDS, next.query);
    setCommands(filtered);
    // Reset rather than clamp: one more letter means a different set of rows, and running whichever
    // command inherited the old index would insert a block nobody pointed at.
    setSelected(0);
  }, []);

  const commit = useCallback(() => {
    const { markdown, changed } = commitMarkdown(editorRef.current, baselines, serializeMarkdown);
    if (changed) onChangeRef.current(markdown);
  }, [baselines]);

  const flush = useCallback(() => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    /*
     * Without `keepAtSelection: false` this is where a pending edit goes to die. The caret sitting
     * inside an empty quote makes the document un-writable, the commit holds, and on unmount there
     * is no next keystroke to ask again — so whatever was typed before the quote is simply lost.
     * At blur and unmount the caret is not "still writing" anything; it is leaving.
     */
    if (editorRef.current) dropStrandedEmptyBlocks(editorRef.current, { keepAtSelection: false });
    commit();
  }, [commit]);

  /*
   * `useEditor` compares its options on every render and calls `setOptions` when any differ — and it
   * compares `extensions` by the identity of each entry. A fresh array of fresh instances every
   * render therefore meant `view.setProps` and `view.updateState` on every keystroke, which is both
   * wasted work and the documented way to disturb an IME composition mid-character.
   *
   * `content` is pinned to what the editor mounted with for the same reason: it is read once at
   * creation and never again, so letting the live value through would defeat the comparison for no
   * benefit. Later documents arrive by adoption, below.
   */
  const extensions = useMemo(() => markdownExtensions({ placeholder }), [placeholder]);
  const mountContent = useRef(value).current;
  const editorProps = useMemo(
    () => ({
      attributes: { class: "fy-rme__doc", "aria-label": ariaLabel, spellcheck: "true" },
      handleKeyDown: (_view: unknown, event: KeyboardEvent) => {
        const open = menuRef.current;
        if (!open) return false;

        if (event.key === "Escape") {
          event.preventDefault();
          setMenu(null);
          return true;
        }

        const rows = commandsRef.current;
        // With nothing to pick, Enter has to stay a paragraph break rather than be swallowed.
        if (rows.length === 0) return false;

        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const delta = event.key === "ArrowDown" ? 1 : -1;
          setSelected(moveSelection(selectedRef.current, delta, rows.length));
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const command = rows[selectedRef.current] ?? rows[0];
          const live = editorRef.current;
          if (command && live) runSlashCommand(live, open, command);
          return true;
        }
        return false;
      },
    }),
    [ariaLabel],
  );

  const editor = useEditor({
    immediatelyRender: false,
    content: mountContent,
    contentType: "markdown",
    extensions,
    editorProps,
    onCreate: ({ editor: instance }) => {
      editorRef.current = instance;
      normalizeSoftBreaks(instance);
      originalSource.current = value;
      baseCanonical.current = documentMarkdown(instance);
      lastCommitted.current = value;
      ready.current = true;
    },
    onUpdate: ({ editor: instance }) => {
      syncMenu(instance);
      if (!ready.current) return;
      // Before the debounce rather than inside it, so the document the commit sees is already one
      // that can be written down, and the transaction this may dispatch settles first.
      dropStrandedEmptyBlocks(instance);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        commit();
      }, SERIALIZE_MS);
    },
    onSelectionUpdate: ({ editor: instance }) => syncMenu(instance),
  });
  editorRef.current = editor;

  /*
   * A layout effect, not a passive one: React runs layout cleanups before effect cleanups, so this
   * is the last moment the editor is still alive on unmount. Serialising after `useEditor` has
   * destroyed it would lose whatever was typed in the final 400ms.
   */
  useLayoutEffect(() => flush, [flush]);

  /*
   * Adopt a document that moved underneath the editor — the Studio edited the bible mid-turn, or
   * the author opened the folder in a text editor. `lastCommitted` is what tells that apart from
   * the echo of our own save coming back through the store.
   */
  useEffect(() => {
    if (!editor || value === lastCommitted.current) return;

    if (documentMarkdown(editor) === value) {
      // The bytes moved but the document did not — something canonicalised the file. Re-seat the
      // baselines on the new bytes so the next edit patches onto them, and leave the caret alone.
      lastCommitted.current = value;
      originalSource.current = value;
      baseCanonical.current = value;
      return;
    }

    const focused = editor.isFocused;
    const { from, to } = editor.state.selection;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
    normalizeSoftBreaks(editor);
    lastCommitted.current = value;
    originalSource.current = value;
    baseCanonical.current = documentMarkdown(editor);
    if (focused) {
      const end = editor.state.doc.content.size;
      editor
        .chain()
        .setTextSelection({ from: Math.min(from, end), to: Math.min(to, end) })
        .focus()
        .run();
    }
  }, [editor, value]);

  return (
    <div className="fy-rme" ref={shellRef} onBlur={flush}>
      <EditorContent editor={editor} />
      {menu && editor && (
        <SlashMenu
          editor={editor}
          menu={menu}
          commands={commands}
          selected={selected}
          onHover={setSelected}
        />
      )}
    </div>
  );
}
