import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";
import { markdownExtensions } from "../src/components/editor/extensions.js";
import { reviewMarksKey, reviewMarksPlugin } from "../src/components/editor/writing-aids.js";
import { placeReviewNotes, quoteText, type ReviewFinding } from "../src/lib/review-notes.js";

const finding = (id: string, quote: string, offset: number, decision: ReviewFinding["decision"] = "open"): ReviewFinding => ({
  id, taskId: "script", offset, category: "continuity", certainty: "possible-confusion", quote, imageBlocks: [],
  observation: `About ${quote}`, impact: "Readers stall.", correction: "Say who rang it.", decision,
});

describe("placing a review's notes (SPEC-056 R-29)", () => {
  const body = "The bell rang. Maren listened.\n\nThe bell rang again, closer.";

  it("by the stored offset when the quote is still there, numbered in reading order, with its paragraph", () => {
    const second = body.indexOf("The bell rang", 5);
    const { placed, lost } = placeReviewNotes(body, [finding("b", "The bell rang", second), finding("a", "Maren listened.", body.indexOf("Maren"))]);
    assert.deepEqual(placed.map((note) => [note.finding.id, note.n, note.nth, note.paragraph]), [["a", 1, 0, 1], ["b", 2, 1, 2]], "the second appearance of a repeated quote is its second");
    assert.deepEqual(lost, []);
  });

  it("by the exact quote when the chapter moved, and not at all when the quote is gone", () => {
    const { placed, lost } = placeReviewNotes(`A new opening.\n\n${body}`, [finding("a", "Maren listened.", 15), finding("c", "The tide was out.", 3)]);
    assert.equal(placed[0]?.at, `A new opening.\n\n${body}`.indexOf("Maren listened."), "found by its words");
    assert.deepEqual(lost.map((each) => each.id), ["c"], "never anchored to other words");
  });

  it("leaves out notes already decided", () => {
    assert.deepEqual(placeReviewNotes(body, [finding("a", "Maren listened.", 15, "dismissed"), finding("b", "Maren listened.", 15, "intentional")]).placed, []);
  });

  it("matches a quote as the editor shows it, the Markdown's marks dropped", () => {
    assert.equal(quoteText("The *bell*\n rang."), "The bell rang.");
  });
});

describe("marking the quotes in the prose (R-29)", () => {
  it("marks the appearance the note names, the open one in warning", () => {
    const editor = new Editor({ element: null, extensions: markdownExtensions(), content: "The bell rang. The bell rang again.\n", contentType: "markdown" });
    let state = EditorState.create({ doc: editor.state.doc, plugins: [reviewMarksPlugin()] });
    editor.destroy();
    state = state.apply(state.tr.setMeta(reviewMarksKey, { marks: [{ n: 1, text: "The bell rang", nth: 1 }], current: 1 }));
    const plugin = reviewMarksKey.get(state)!;
    const [mark] = (plugin.props.decorations!.call(plugin, state) as DecorationSet).find();
    assert.ok(mark !== undefined);
    assert.equal(mark.from, state.doc.textContent.indexOf("The bell rang", 2) + 1, "the second appearance");
    assert.match((mark as unknown as { type: { attrs: Record<string, string> } }).type.attrs.class ?? "", /fy-review-quote--here/);
  });
});
