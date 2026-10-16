import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Decoration, DecorationSet } from "@tiptap/pm/view";
import { markdownExtensions } from "../src/components/editor/extensions.js";
import { caretBlockKey, caretBlockPlugin, currentMatch, findKey, findMatches, findPlugin } from "../src/components/editor/writing-aids.js";

/** The writing room's aids over a plain state, as the linked names' tests do (Tiptap builds plugins only on a page). */
function open(source: string) {
  const editor = new Editor({ element: null, extensions: markdownExtensions(), content: source, contentType: "markdown" });
  const doc = editor.state.doc;
  editor.destroy();
  return EditorState.create({ doc, plugins: [caretBlockPlugin(), findPlugin()] });
}

const classes = (state: EditorState, key: typeof caretBlockKey | typeof findKey) => {
  const plugin = key.get(state)!;
  const set = (plugin.props.decorations?.call(plugin, state) ?? null) as DecorationSet | null;
  return (set === null ? [] : set.find()).map((deco: Decoration) => ({
    text: state.doc.textBetween(deco.from, deco.to, " "),
    cls: (deco as unknown as { type: { attrs: Record<string, string> } }).type.attrs.class,
  }));
};

describe("the caret's paragraph (SPEC-056 R-12)", () => {
  it("marks the top-level block the caret is in, and moves with it", () => {
    let state = open("The ledger.\n\nMaren reads it twice.\n\nThen the bells.\n");
    const second = state.doc.child(0).nodeSize + 2;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, second)));
    assert.deepEqual(classes(state, caretBlockKey), [{ text: "Maren reads it twice.", cls: "fy-rme__here" }]);
    const third = second + state.doc.child(1).nodeSize;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, third)));
    assert.deepEqual(classes(state, caretBlockKey).map((d) => d.text), ["Then the bells."]);
  });
});

describe("the caret's paragraph inside a list (codex on PR 1801)", () => {
  it("marks the item's own paragraph, not the whole list", () => {
    let state = open("- First item.\n- Second item.\n");
    let at = -1;
    state.doc.descendants((node, pos) => {
      if (at === -1 && node.isText && node.text === "Second item.") at = pos;
      return at === -1;
    });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at + 1)));
    assert.deepEqual(classes(state, caretBlockKey).map((d) => d.text), ["Second item."]);
  });
});

describe("Find (R-7)", () => {
  it("finds a phrase across bold, as the reader sees it", () => {
    const state = open("The **silver bell** rang twice.\n");
    const matches = findMatches(state.doc, "silver bell rang");
    assert.deepEqual(matches.map((m) => state.doc.textBetween(m.from, m.to)), ["silver bell rang"]);
  });

  it("finds every occurrence in any case, across paragraphs", () => {
    const state = open("The bell rang. Bells.\n\nNo bell tonight.\n");
    assert.deepEqual(findMatches(state.doc, "BELL").map((m) => state.doc.textBetween(m.from, m.to)), ["bell", "Bell", "bell"]);
    assert.deepEqual(findMatches(state.doc, "  "), [], "a blank query finds nothing");
  });

  it("draws the matches with the current one marked, and follows edits", () => {
    let state = open("The bell rang.\n\nNo bell tonight.\n");
    state = state.apply(state.tr.setMeta(findKey, { query: "bell", index: 1 }));
    assert.deepEqual(classes(state, findKey).map((d) => d.cls), ["fy-find", "fy-find fy-find--here"]);
    state = state.apply(state.tr.insertText("bell ", 1));
    assert.equal(findKey.getState(state)!.matches.length, 3, "a typed match is found");
    state = state.apply(state.tr.setMeta(findKey, null));
    assert.deepEqual(classes(state, findKey), [], "closed, nothing is drawn");
  });

  it("wraps the current match either way", () => {
    assert.equal(currentMatch({ query: "x", index: 3 }, 3), 0);
    assert.equal(currentMatch({ query: "x", index: -1 }, 3), 2);
    assert.equal(currentMatch({ query: "x", index: 0 }, 0), -1);
  });
});
