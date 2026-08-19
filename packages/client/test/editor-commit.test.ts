import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "@tiptap/core";
import { commitMarkdown, type ReconcileBaselines } from "../src/components/editor/commit.js";
import { markdownExtensions } from "../src/components/editor/extensions.js";
import { dropStrandedEmptyBlocks, normalizeSoftBreaks } from "../src/components/editor/normalize.js";
import { documentMarkdown, serializeMarkdown } from "../src/components/editor/round-trip.js";

/**
 * What reaches the file, driven through a real editor rather than a stand-in for one.
 *
 * Tiptap runs headless here — no DOM is needed to parse a document, hold it, and serialise it —
 * which means these exercise the same instance the screen mounts, including the transactions it
 * dispatches on its own behalf.
 */

const HAND_WRITTEN = `The tides
=========

The tide is the world's clock and its _accountant_.

* salt in the rigging
* verse under the hull
`;

function open(source: string): { editor: Editor; baselines: ReconcileBaselines } {
  const editor = new Editor({
    element: null,
    extensions: markdownExtensions(),
    content: source,
    contentType: "markdown",
  });
  normalizeSoftBreaks(editor);
  return {
    editor,
    baselines: {
      originalSource: { current: source },
      baseCanonical: { current: documentMarkdown(editor) },
      lastCommitted: { current: source },
    },
  };
}

const commit = (editor: Editor, baselines: ReconcileBaselines) =>
  commitMarkdown(editor, baselines, serializeMarkdown);

describe("committing a document", () => {
  it("reports no change when nothing was typed", () => {
    const { editor, baselines } = open(HAND_WRITTEN);
    const result = commit(editor, baselines);
    assert.equal(result.changed, false, "an untouched document is not a save");
    assert.equal(result.markdown, HAND_WRITTEN, "and the bytes it would write are the ones it read");
    editor.destroy();
  });

  it("ignores the empty paragraph the editor keeps below the last block", () => {
    /*
     * The regression this exists for. A document ending in a list gets a trailing paragraph
     * appended by the editor itself, a moment after it loads, so there is somewhere to click below
     * the list. That arrives as an ordinary update, indistinguishable from typing — and it used to
     * save: version 1 became version 2 before the author had touched the keyboard, and the real
     * edit that followed was then refused for being written against a version that had moved.
     */
    const { editor, baselines } = open(HAND_WRITTEN);
    const end = editor.state.doc.content.size;
    editor.view.dispatch(
      editor.state.tr.insert(end, editor.state.schema.nodes.paragraph!.create()),
    );

    assert.match(editor.getMarkdown(), /\n$/, "the paragraph really is on the document");
    assert.equal(commit(editor, baselines).changed, false, "and it is not content");
    editor.destroy();
  });

  it("hands up the author's own formatting once something is typed", () => {
    const { editor, baselines } = open(HAND_WRITTEN);
    const paragraph = editor.state.doc.child(1);
    assert.ok(paragraph.textContent.includes("accountant"));

    editor.view.dispatch(
      editor.state.tr.insertText(" It keeps two ledgers.", editor.state.doc.child(0).nodeSize + paragraph.nodeSize - 1),
    );

    const result = commit(editor, baselines);
    assert.equal(result.changed, true);
    assert.match(result.markdown, /It keeps two ledgers\./, "the edit is in the bytes");
    assert.match(result.markdown, /^\* salt in the rigging$/m, "so are the author's bullets");
    assert.match(result.markdown, /^=========$/m, "and their heading");
    editor.destroy();
  });

  it("reflows a hand-wrapped paragraph so the browser cannot turn its wrap into a break", () => {
    /*
     * The regression this exists for. A paragraph the author wrapped at eighty columns arrives as a
     * newline inside a text node. Nothing renders it, so the first keystroke in that paragraph made
     * the browser hand it back as an explicit hard break, and the file gained two trailing spaces —
     * turning one flowing paragraph into two lines, in the file and in what the Studio reads.
     */
    const wrapped = "The tide is the world's clock and its accountant,\nand it does not forget.\n";
    const { editor, baselines } = open(wrapped);

    assert.ok(
      !editor.state.doc.textContent.includes("\n"),
      "no newline survives inside a paragraph, so there is nothing left to reinterpret",
    );
    assert.equal(commit(editor, baselines).changed, false, "and reflowing is not itself an edit");

    editor.view.dispatch(editor.state.tr.insertText(" It keeps two.", editor.state.doc.child(0).nodeSize - 1));
    const result = commit(editor, baselines);
    assert.match(result.markdown, /accountant,\nand it does not forget\. It keeps two\./, "the author's wrap is still where they put it");
    assert.ok(!/ {2}\n/.test(result.markdown), "and no hard break was invented");
    editor.destroy();
  });

  it("leaves the newlines inside a code block alone", () => {
    /*
     * The regression this exists for. A fenced block's whole body is one text node full of
     * newlines, and the soft-break reflow rewrote every one of them — putting a program on a single
     * line. The commit's proof did not catch it, because the headless serialiser reflows the same
     * way and so agreed with the corruption. Verified against the two failure surfaces separately:
     * the document as loaded, and the bytes a commit would write.
     */
    const source = "## Notes\n\n```js\nconst a = 1\nconst b = 2\nreturn a + b\n```\n\nAnd prose after.\n";
    const { editor, baselines } = open(source);

    assert.match(
      documentMarkdown(editor),
      /```js\nconst a = 1\nconst b = 2\nreturn a \+ b\n```/,
      "three lines of code are still three lines",
    );
    assert.equal(serializeMarkdown(source), documentMarkdown(editor), "and the proof agrees");

    editor.view.dispatch(editor.state.tr.insertText(" Truly.", editor.state.doc.content.size - 1));
    const result = commit(editor, baselines);
    assert.equal(result.changed, true);
    assert.match(result.markdown, /const a = 1\nconst b = 2\nreturn a \+ b/, "and a save keeps them");
  });

  it("writes nothing while the document cannot be read back", () => {
    /*
     * Ask for a quote and leave it empty. Markdown writes an empty blockquote as a bare `>`, and a
     * bare `>` reads back as nothing at all — so those bytes would lose the block on the next load,
     * and the mismatch would make every later commit give up on the author's formatting too. The
     * block is half-made, not broken: hold, and let the next keystroke ask again.
     */
    const { editor, baselines } = open(HAND_WRITTEN);
    const end = editor.state.doc.content.size;
    editor.view.dispatch(editor.state.tr.insert(end, editor.state.schema.nodes.paragraph!.create()));
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.toggleBlockquote();
    assert.match(documentMarkdown(editor), />$/, "the document really does end in an empty quote");

    const result = commit(editor, baselines);
    assert.equal(result.changed, false, "nothing is written");
    assert.equal(baselines.originalSource.current, HAND_WRITTEN, "and no baseline moved");

    editor.view.dispatch(
      editor.state.tr.insertText("The harbour keeps its own ledger.", editor.state.selection.from),
    );
    const next = commit(editor, baselines);
    assert.equal(next.changed, true, "the moment it can be written down, it is");
    assert.match(next.markdown, /^> The harbour keeps its own ledger\.$/m);
    assert.match(next.markdown, /^\* salt in the rigging$/m, "with the author's formatting intact");
    editor.destroy();
  });

  it("drops a quote the author left behind, so one stray keystroke cannot stop a bible saving", () => {
    const { editor, baselines } = open(HAND_WRITTEN);
    const end = editor.state.doc.content.size;
    editor.view.dispatch(editor.state.tr.insert(end, editor.state.schema.nodes.paragraph!.create()));
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.toggleBlockquote();

    dropStrandedEmptyBlocks(editor);
    assert.match(documentMarkdown(editor), />$/, "the one the caret is in stays — it is being written");

    // The author gives up on the quote and types back in the prose instead.
    const inParagraph = editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize - 1;
    editor.commands.setTextSelection(inParagraph);
    editor.view.dispatch(editor.state.tr.insertText(" It keeps two ledgers.", inParagraph));
    dropStrandedEmptyBlocks(editor);

    const result = commit(editor, baselines);
    assert.equal(result.changed, true, "the document can be written down again");
    assert.ok(!/>/.test(result.markdown), "the abandoned quote is gone");
    assert.match(result.markdown, /It keeps two ledgers\./, "and what was typed is there");
    assert.match(result.markdown, /^\* salt in the rigging$/m, "with the author's formatting intact");
    editor.destroy();
  });

  it("drops the block under the caret too, once the caret is leaving", () => {
    /*
     * The regression this exists for. `dropStrandedEmptyBlocks` runs on every update, but a flush
     * fires from blur and unmount — where no update follows and there is no next keystroke to ask
     * again. A caret parked in an empty quote made the document un-writable, the commit held, and
     * everything typed before the quote was never written.
     */
    const { editor, baselines } = open(HAND_WRITTEN);
    const paragraphEnd = editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize - 1;
    editor.view.dispatch(editor.state.tr.insertText(" It keeps two ledgers.", paragraphEnd));

    const end = editor.state.doc.content.size;
    editor.view.dispatch(editor.state.tr.insert(end, editor.state.schema.nodes.paragraph!.create()));
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.toggleBlockquote();

    dropStrandedEmptyBlocks(editor);
    assert.equal(commit(editor, baselines).changed, false, "while typing, the caret's quote holds");

    dropStrandedEmptyBlocks(editor, { keepAtSelection: false });
    const flushed = commit(editor, baselines);
    assert.equal(flushed.changed, true, "on the way out, it does not");
    assert.match(flushed.markdown, /It keeps two ledgers\./, "so the sentence is not lost");
    assert.ok(!/>/.test(flushed.markdown), "and the empty quote is not written");
    editor.destroy();
  });

  it("falls back to canonical output when the author's formatting cannot be proved", () => {
    const { editor, baselines } = open(HAND_WRITTEN);
    editor.view.dispatch(
      editor.state.tr.insertText(" It keeps two ledgers.", editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize - 1),
    );

    // Stands in for a fuzzy match that landed somewhere it was not meant to: the bytes parse, they
    // just say something else. Nothing can tell those apart from the outside, so it must not try.
    const misread = commitMarkdown(editor, baselines, (markdown) =>
      /^\* salt/m.test(markdown) ? "something else entirely" : serializeMarkdown(markdown),
    );
    assert.equal(misread.changed, true);
    assert.match(misread.markdown, /^- salt in the rigging$/m, "canonical bullets — the fallback ran");
    assert.match(misread.markdown, /It keeps two ledgers\./, "and the edit is still there");
    editor.destroy();
  });

  it("leaves the baselines alone when there is no editor left to serialise", () => {
    const { editor, baselines } = open(HAND_WRITTEN);
    editor.destroy();
    const result = commitMarkdown(null, baselines, serializeMarkdown);
    assert.equal(result.changed, false);
    assert.equal(result.markdown, HAND_WRITTEN);
    assert.equal(baselines.originalSource.current, HAND_WRITTEN);
  });

  it("advances its baselines so a second edit patches onto the first", () => {
    const { editor, baselines } = open(HAND_WRITTEN);
    editor.view.dispatch(editor.state.tr.insertText(" One.", editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize - 1));
    const first = commit(editor, baselines);
    editor.view.dispatch(editor.state.tr.insertText(" Two.", editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize - 1));
    const second = commit(editor, baselines);

    assert.match(first.markdown, /One\./);
    assert.match(second.markdown, /One\. Two\./, "the second edit built on the first");
    assert.match(second.markdown, /^\* salt in the rigging$/m, "and the formatting held across both");
    editor.destroy();
  });
});
