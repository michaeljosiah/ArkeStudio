import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from "react";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { cx } from "../ui.js";
import { commitMarkdown, type ReconcileBaselines } from "./commit.js";
import { markdownExtensions } from "./extensions.js";
import { LinkedNames, linkedNamesKey, nameMatcher, type LinkedName, type NameMatcher } from "./linked-names.js";
import { MentionMenu } from "./mention-menu.js";
import { filterMentions, insertMention, readMentionState, type Mention, type MentionMenuState } from "./mentions.js";
import { currentMatch, findKey, WritingAids, type FindState } from "./writing-aids.js";
import { marginsKey, type MarginItem } from "./margins.js";
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
  /** Markdown out, already carried onto `value`'s formatting. Never called while read-only. */
  onChange?: (markdown: string) => void;
  placeholder?: string;
  ariaLabel: string;
  /**
   * Show the document, take no edits (issue 477).
   *
   * The artifact viewer opens a `.md` artifact through this component so a filed document reads
   * the way the bible does — headings, lists, tables, task items — rather than as raw markdown in
   * a grey box. Artifacts are immutable, though: superseding one files new bytes as a new
   * artifact (SPEC-015 R-5), and there is no such filing path from the shelf yet. Until there
   * is, the honest surface is one that cannot be typed into and says so.
   */
  readOnly?: boolean;
  /**
   * The words selected, as plain text, or null when the selection collapses (turn 128), with the
   * top-level block the selection starts in counted from one — the paragraph, for prose. What
   * the chapter workspace makes the dock's subject; nothing is done with it here.
   */
  onSelect?: (text: string | null, paragraph: number | null) => void;
  /**
   * The world's characters and places to underline in the prose (SPEC-056 R-15). Decoration only:
   * the extension is added to the live editor alone, never to the round-trip proof's set. Whether
   * it is given at all is read once, at mount; the names themselves may change at any time.
   */
  linkedNames?: readonly LinkedName[];
  /** A linked name held under the pointer for 300ms, or long-pressed (R-17); null when it is left. */
  onName?: (hit: { ids: string[]; text: string; rect: DOMRect } | null) => void;
  /** What `@` offers (R-18). Absent, `@` is only a character. */
  mentions?: readonly Mention[];
  /**
   * The writing room's aids (SPEC-056 R-7, R-12): the caret's paragraph marked for Focus, and
   * Find. Read once, at mount, as the names are.
   */
  writingAids?: boolean;
  /** Find's query and which match is current; null when Find is closed. */
  find?: FindState | null;
  /** How many matches the query has, and which is current (-1 for none). */
  onFind?: (count: number, current: number) => void;
  /** Where the caret is on screen after it moves or the text changes, for Focus to hold it (R-12). */
  onCaret?: (caret: { top: number; bottom: number }) => void;
  /** Speaker faces and passage pictures beside their paragraphs (R-14); empty when both are off. */
  margins?: readonly MarginItem[];
  /** The live editor, for a selection bar that formats in place (R-22); null once it is gone. */
  onEditor?: (editor: Editor | null) => void;
}

/**
 * Bring a document position to the middle of whatever scrolls the editor: the match itself, not
 * the paragraph around it, which can be taller than the window (codex on PR 1801).
 */
function centreOn(editor: Editor, pos: number): void {
  let at: { top: number; bottom: number };
  try {
    at = editor.view.coordsAtPos(pos);
  } catch {
    return;
  }
  let scroller: HTMLElement | null = editor.view.dom.parentElement;
  while (scroller !== null) {
    const overflow = getComputedStyle(scroller).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && scroller.scrollHeight > scroller.clientHeight) break;
    scroller = scroller.parentElement;
  }
  const box = scroller?.getBoundingClientRect() ?? { top: 0, height: window.innerHeight };
  const delta = (at.top + at.bottom) / 2 - (box.top + box.height / 2);
  if (scroller !== null) scroller.scrollBy?.({ top: delta });
  else window.scrollBy?.({ top: delta });
}

/** How long the pointer rests on a name before its card opens (R-17). */
const NAME_HOVER_MS = 300;
const NAME_PRESS_MS = 500;

export function RichMarkdownEditor({
  value,
  onChange,
  placeholder,
  ariaLabel,
  readOnly = false,
  onSelect,
  linkedNames,
  onName,
  mentions,
  writingAids,
  find = null,
  onFind,
  onCaret,
  margins,
  onEditor,
}: RichMarkdownEditorProps) {
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
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
  // Read from a ref for the same reason the menu state is: `commit` is closed over by ProseMirror
  // and by the unmount flush, and neither re-reads a prop.
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

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

  // The `@` menu, kept beside the slash menu's state rather than merged into it: the two never
  // open together (one needs a `/` at the block's start, the other an `@` after a space).
  const mentionsRef = useRef(mentions);
  mentionsRef.current = mentions;
  const [mention, setMention] = useState<MentionMenuState | null>(null);
  const [mentionRows, setMentionRows] = useState<Mention[]>([]);
  const [mentionSelected, setMentionSelected] = useState(0);
  const mentionRef = useRef<MentionMenuState | null>(null);
  const mentionRowsRef = useRef<Mention[]>([]);
  const mentionSelectedRef = useRef(0);
  mentionRef.current = mention;
  mentionRowsRef.current = mentionRows;
  mentionSelectedRef.current = mentionSelected;
  // A sheet arriving or renamed while the menu is open changes its rows at once (codex on PR 1800).
  const mentionsText = JSON.stringify(mentions ?? null);
  useEffect(() => {
    const open = mentionRef.current;
    if (open !== null && mentionsRef.current !== undefined) setMentionRows(filterMentions(mentionsRef.current, open.query));
  }, [mentionsText]);
  // Esc closes and leaves the `@` typed (R-18): the trigger it closed stays closed until the caret
  // leaves it, or the next keystroke would open it again.
  const dismissedAt = useRef<number | null>(null);

  // Keyed by content rather than identity: the screen rebuilds its list every render, and a new
  // array of the same names is not a reason to read the whole chapter again.
  const namesKey = useMemo(() => JSON.stringify(linkedNames ?? null), [linkedNames]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const matcher = useMemo(() => (linkedNames === undefined ? null : nameMatcher(linkedNames)), [namesKey]);
  const matcherRef = useRef<NameMatcher | null>(matcher);
  matcherRef.current = matcher;
  const withNames = useRef(linkedNames !== undefined).current;
  const withAids = useRef(writingAids === true).current;
  const onCaretRef = useRef(onCaret);
  onCaretRef.current = onCaret;
  const reportCaret = useCallback((instance: Editor) => {
    if (!onCaretRef.current || instance.isDestroyed) return;
    try {
      const at = instance.view.coordsAtPos(instance.state.selection.head);
      onCaretRef.current({ top: at.top, bottom: at.bottom });
    } catch {
      // A document mid-replacement has no coordinates to give; the next move reports.
    }
  }, []);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /*
   * `onCreate` is where the baselines are seeded, and reconciliation against an unseeded
   * `baseCanonical` would diff the whole document against an empty string. Nothing is expected to
   * dispatch before then, but the ordering is load-bearing enough to be stated rather than assumed.
   */
  const ready = useRef(false);

  const syncMenu = useCallback((instance: Editor) => {
    const offered = mentionsRef.current;
    const at = offered === undefined ? null : readMentionState(instance, shellRef.current);
    if (at === null || dismissedAt.current !== at.from) dismissedAt.current = null;
    const shown = at !== null && dismissedAt.current === null ? at : null;
    setMention(shown);
    if (shown !== null) {
      setMentionRows(filterMentions(offered ?? [], shown.query));
      setMentionSelected(0);
    }
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
    // A read-only document has nothing to write back, and writing one anyway would hand a caller
    // that never offered a sink some bytes to file.
    if (readOnlyRef.current) return;
    const { markdown, changed } = commitMarkdown(editorRef.current, baselines, serializeMarkdown);
    if (changed) onChangeRef.current?.(markdown);
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
  const extensions = useMemo(
    () => [
      ...markdownExtensions({ placeholder }),
      ...(withNames ? [LinkedNames.configure({ getMatcher: () => matcherRef.current })] : []),
      ...(withAids ? [WritingAids] : []),
    ],
    [placeholder, withNames, withAids],
  );
  const mountContent = useRef(value).current;
  const editorProps = useMemo(
    () => ({
      attributes: {
        class: "fy-rme__doc",
        "aria-label": ariaLabel,
        spellcheck: readOnly ? "false" : "true",
        ...(readOnly ? { "aria-readonly": "true" } : {}),
      },
      handleKeyDown: (_view: unknown, event: KeyboardEvent) => {
        const at = mentionRef.current;
        if (at) {
          if (event.key === "Escape") {
            event.preventDefault();
            dismissedAt.current = at.from;
            setMention(null);
            return true;
          }
          const rows = mentionRowsRef.current;
          if (rows.length === 0) return false;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setMentionSelected(moveSelection(mentionSelectedRef.current, event.key === "ArrowDown" ? 1 : -1, rows.length));
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            const row = rows[mentionSelectedRef.current] ?? rows[0];
            if (row && editorRef.current) insertMention(editorRef.current, at, row);
            return true;
          }
          return false;
        }
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
    [ariaLabel, readOnly],
  );

  const editor = useEditor({
    immediatelyRender: false,
    editable: !readOnly,
    content: mountContent,
    contentType: "markdown",
    extensions,
    editorProps,
    onCreate: ({ editor: instance }) => {
      editorRef.current = instance;
      normalizeSoftBreaks(instance);
      /*
       * Seeded from `mountContent`, not `value`, and the difference is load-bearing. The editor is
       * built in an effect, so `content` is read on the render that mounted it while this callback
       * closes over whichever render was current when it ran — and `value` can move between the two
       * if a snapshot lands in that window. Seeding from the live value would describe a document
       * the editor is not holding: `baseCanonical` would belong to one text and `originalSource` to
       * another, and the first commit would fail its proof and canonicalise the whole file.
       *
       * Taking what the editor actually mounted with keeps the three consistent. If `value` has
       * indeed moved on, `lastCommitted` no longer matches it and the adoption effect below picks
       * the newer document up on the next pass.
       */
      originalSource.current = mountContent;
      baseCanonical.current = documentMarkdown(instance);
      lastCommitted.current = mountContent;
      ready.current = true;
    },
    onUpdate: ({ editor: instance }) => {
      syncMenu(instance);
      reportCaret(instance);
      const found = withAids ? findKey.getState(instance.state) : undefined;
      if (found?.find) onFindRef.current?.(found.matches.length, currentMatch(found.find, found.matches.length));
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
    onSelectionUpdate: ({ editor: instance }) => {
      syncMenu(instance);
      reportCaret(instance);
      const { from, to, empty, $from } = instance.state.selection;
      if (empty) {
        onSelectRef.current?.(null, null);
        return;
      }
      // Serialised before it is reported (codex on PR 899): a selection made inside the 400ms
      // debounce would otherwise name words the owner has not been handed yet.
      flush();
      /*
       * The selected words as markdown, not as document positions or rendered text: what is said
       * about them goes into a thread that never sees the editor and is quoted back against the
       * file, so `**bold**` must be selected as `**bold**` or it is never found. The slice is
       * serialised by the same manager that writes the file; plain text is the fallback for an
       * editor mounted without one.
       */
      const slice = instance.state.doc.cut(from, to);
      const markdown = instance.markdown?.serialize(slice.toJSON()).replace(/\n+$/, "");
      onSelectRef.current?.(markdown || instance.state.doc.textBetween(from, to, "\n\n"), $from.index(0) + 1);
    },
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

  /*
   * Find (R-7): the query and the current match go to the plugin, the count comes back, and the
   * current match is scrolled to the middle. The selection is left alone — selecting a match would
   * make it the passage the page asks about.
   */
  const onFindRef = useRef(onFind);
  onFindRef.current = onFind;
  const findKeyText = find === null ? null : `${find.query}\u0000${find.index}`;
  useEffect(() => {
    if (!editor || !withAids || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(findKey, find).setMeta("addToHistory", false));
    const own = findKey.getState(editor.state);
    const count = own?.matches.length ?? 0;
    const here = find === null ? -1 : currentMatch(find, count);
    onFindRef.current?.(count, here);
    const match = here >= 0 ? own?.matches[here] : undefined;
    if (match !== undefined) centreOn(editor, match.from);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, withAids, findKeyText]);

  const onEditorRef = useRef(onEditor);
  onEditorRef.current = onEditor;
  useEffect(() => {
    if (!editor) return;
    onEditorRef.current?.(editor);
    return () => onEditorRef.current?.(null);
  }, [editor]);

  // The margins are the screen's to choose; the editor only places them.
  const marginsText = JSON.stringify(margins ?? []);
  useEffect(() => {
    if (!editor || !withAids || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(marginsKey, JSON.parse(marginsText) as MarginItem[]).setMeta("addToHistory", false));
  }, [editor, withAids, marginsText]);

  // New names (a sheet arrived, one was renamed): the chapter is read again for them.
  useEffect(() => {
    if (!editor || !withNames || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(linkedNamesKey, "refresh").setMeta("addToHistory", false));
  }, [editor, withNames, namesKey]);

  /*
   * The name card's trigger (R-17): a rest of 300ms on a name, or a long press on touch. The card
   * itself is the screen's — this only says which sheets and where — so it can hold the screen's
   * links, voices and Chat without the editor knowing any of them.
   */
  const onNameRef = useRef(onName);
  onNameRef.current = onName;
  const nameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovered = useRef<Element | null>(null);
  const clearNameTimer = () => {
    if (nameTimer.current) clearTimeout(nameTimer.current);
    nameTimer.current = null;
  };
  useEffect(() => clearNameTimer, []);
  const nameAt = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element ? target.closest<HTMLElement>(".fy-ln") : null;
  const report = (element: HTMLElement) => {
    const ids = (element.dataset.names ?? "").split(" ").filter(Boolean);
    if (ids.length > 0) onNameRef.current?.({ ids, text: element.textContent ?? "", rect: element.getBoundingClientRect() });
  };
  const nameEvents = withNames
    ? {
        onMouseOver: (event: ReactMouseEvent) => {
          const element = nameAt(event.target);
          if (element === hovered.current) return;
          hovered.current = element;
          clearNameTimer();
          if (element === null) {
            onNameRef.current?.(null);
            return;
          }
          nameTimer.current = setTimeout(() => report(element), NAME_HOVER_MS);
        },
        onMouseLeave: () => {
          hovered.current = null;
          clearNameTimer();
          onNameRef.current?.(null);
        },
        onTouchStart: (event: ReactTouchEvent) => {
          const element = nameAt(event.target);
          clearNameTimer();
          // A touch anywhere else puts an open card away, as moving the pointer off a name does.
          if (element === null) onNameRef.current?.(null);
          else nameTimer.current = setTimeout(() => report(element), NAME_PRESS_MS);
        },
        onTouchMove: clearNameTimer,
        onTouchEnd: clearNameTimer,
      }
    : {};

  return (
    <div
      className={cx("fy-rme", readOnly && "fy-rme--read")}
      ref={shellRef}
      onBlur={(event) => {
        flush();
        // Leaving the editor closes the `@` menu; choosing one of its rows never blurs it.
        if (!(event.relatedTarget instanceof Node) || !shellRef.current?.contains(event.relatedTarget)) setMention(null);
      }}
      {...nameEvents}
    >
      <EditorContent editor={editor} />
      {mention && editor && (
        <MentionMenu
          menu={mention}
          rows={mentionRows}
          selected={mentionSelected}
          onHover={setMentionSelected}
          onPick={(row) => insertMention(editor, mention, row)}
        />
      )}
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
