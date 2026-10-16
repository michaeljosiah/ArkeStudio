import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "@tiptap/core";
import { markdownExtensions } from "../src/components/editor/extensions.js";
import { EditorState } from "@tiptap/pm/state";
import type { Decoration } from "@tiptap/pm/view";
import { linkedNamesKey, linkedNamesPlugin, nameMatcher, type LinkedName, type NameMatcher } from "../src/components/editor/linked-names.js";
import { filterMentions, matchMentionTrigger, MENTION_QUERY_MAX_LENGTH, type Mention } from "../src/components/editor/mentions.js";

const CAST: LinkedName[] = [
  { id: "maren-kest", kind: "character", names: ["Maren Kest", "Maren"], colour: 2 },
  { id: "rook", kind: "character", names: ["Rook"], colour: null },
  { id: "the-undersong", kind: "place", names: ["the Undersong"], colour: null },
  { id: "saltmarket", kind: "place", names: ["saltmarket"], colour: null },
];

const texts = (matcher: NameMatcher, text: string) => matcher.find(text).map((hit) => text.slice(hit.from, hit.to));

describe("recognising names (SPEC-056 R-15)", () => {
  const matcher = nameMatcher(CAST)!;

  it("takes the longest name first", () => {
    assert.deepEqual(texts(matcher, "Maren Kest woke. Maren slept."), ["Maren Kest", "Maren"]);
    assert.deepEqual(matcher.find("Maren Kest woke.")[0]!.ids, ["maren-kest"]);
  });

  it("matches whole words only", () => {
    assert.deepEqual(texts(matcher, "Marenka and Rookery, and Maren's coat"), ["Maren"], "a possessive is still the name");
  });

  it("reads a capitalised name case-sensitively and any other name in any case", () => {
    assert.deepEqual(texts(matcher, "a rook on the roof, then Rook"), ["Rook"], "the bird is not the man");
    assert.deepEqual(texts(matcher, "Saltmarket at dawn; the saltmarket at dusk"), ["Saltmarket", "saltmarket"]);
  });

  it("finds `The Vigil` as the prose writes it mid-sentence, and not `the vigil`", () => {
    const vigil = nameMatcher([{ id: "the-vigil", kind: "place", names: ["The Vigil"], colour: null }])!;
    assert.deepEqual(texts(vigil, "The Vigil stood. Maren climbed the Vigil, a long vigil."), ["The Vigil", "the Vigil"]);
  });

  it("lists every sheet that shares the text", () => {
    const shared = nameMatcher([...CAST, { id: "maren-the-elder", kind: "character", names: ["Maren"], colour: 3 }])!;
    assert.deepEqual(shared.find("Maren said")[0]!.ids.sort(), ["maren-kest", "maren-the-elder"]);
  });

  it("names every sheet when an exact and a folded name find the same text (codex on PR 1800)", () => {
    const both = nameMatcher([{ id: "ade", kind: "character", names: ["Ade"], colour: null }, { id: "ade-river", kind: "place", names: ["ade"], colour: null }])!;
    assert.deepEqual(both.find("Ade waded in.")[0]!.ids.sort(), ["ade", "ade-river"]);
  });

  it("skips one-letter names and has no matcher for none", () => {
    assert.equal(nameMatcher([{ id: "a", kind: "character", names: ["A"], colour: null }]), null);
    assert.equal(nameMatcher([]), null);
  });
});

/*
 * Tiptap builds its plugins only when it mounts on a page, so the plugin runs here over a plain
 * ProseMirror state holding the document the headless editor parsed.
 */
function open(source: string, names: LinkedName[]) {
  let matcher = nameMatcher(names);
  const editor = new Editor({ element: null, extensions: markdownExtensions(), content: source, contentType: "markdown" });
  const parsed = editor.state.doc;
  let state = EditorState.create({ doc: parsed, plugins: [linkedNamesPlugin(() => matcher)] });
  editor.destroy();
  const attrs = (deco: Decoration) => (deco as unknown as { type: { attrs: Record<string, string> } }).type.attrs;
  const marked = () =>
    (linkedNamesKey.getState(state)?.find() ?? []).map((deco) => ({
      text: state.doc.textBetween(deco.from, deco.to),
      names: attrs(deco)["data-names"],
      cls: attrs(deco).class ?? "",
    }));
  const type = (at: number, text: string) => {
    state = state.apply(state.tr.insertText(text, at));
  };
  const rename = (next: LinkedName[]) => {
    matcher = nameMatcher(next);
    state = state.apply(state.tr.setMeta(linkedNamesKey, "refresh"));
  };
  return { parsed, doc: () => state.doc, marked, type, rename };
}

describe("linked names in the editor (R-15, R-16)", () => {
  it("marks names as decorations and writes nothing into the document", () => {
    const { parsed, doc, marked } = open("Maren Kest crossed the saltmarket.\n\nRook waited under the Undersong.\n", CAST);
    assert.deepEqual(marked().map((m) => m.text), ["Maren Kest", "saltmarket", "Rook", "the Undersong"]);
    assert.equal(marked()[0]!.names, "maren-kest");
    assert.match(marked()[0]!.cls, /fy-ln--character fy-voice--2/, "a character in the book's speaker colour");
    assert.match(marked()[1]!.cls, /fy-ln--place fy-voice--none/, "a place is neutral");
    assert.match(marked()[2]!.cls, /fy-voice--none/, "a character with no colour is neutral");
    assert.ok(doc().eq(parsed), "the document is the author's");
  });

  it("reads again the paragraph a keystroke touched, and keeps the rest", () => {
    const { doc, marked, type } = open("Maren waited.\n\nNobody came.\n", CAST);
    const second = doc().child(0).nodeSize;
    type(second + 1 + "Nobody came".length, " for Rook");
    assert.deepEqual(marked().map((m) => m.text), ["Maren", "Rook"]);
    type(1, "x");
    assert.deepEqual(marked().map((m) => m.text), ["Rook"], "xMaren is no longer the name");
  });

  it("reads the whole chapter again when the names change", () => {
    const { marked, rename } = open("Ife sang to Maren.\n", CAST);
    assert.deepEqual(marked().map((m) => m.text), ["Maren"]);
    rename([...CAST, { id: "ife", kind: "character", names: ["Ife"], colour: 1 }]);
    assert.deepEqual(marked().map((m) => m.text), ["Ife", "Maren"]);
  });

  it("leaves code alone, a fence inside a list too", () => {
    const { marked } = open("Maren `Maren` said.\n\n```\nMaren\n```\n\n- Rook\n\n  ```\n  Rook\n  ```\n", CAST);
    assert.deepEqual(marked().map((m) => m.text), ["Maren", "Rook"]);
  });

  it("is not in the set the round-trip proof uses", () => {
    assert.ok(!markdownExtensions().some((extension) => extension.name === "linkedNames"));
  });
});

describe("the @ menu (R-18)", () => {
  it("opens on an @ that starts a word", () => {
    assert.equal(matchMentionTrigger("@"), "");
    assert.equal(matchMentionTrigger("She turned to @Mar"), "Mar");
    assert.equal(matchMentionTrigger("He said “@Ma"), "Ma");
    assert.equal(matchMentionTrigger("to @Maren Ke"), "Maren Ke", "a full name has a space in it");
  });

  it("stays shut for an address, a doubled space or a long run", () => {
    assert.equal(matchMentionTrigger("write to maren@home"), null);
    assert.equal(matchMentionTrigger("@Maren  then"), null);
    assert.equal(matchMentionTrigger("@ Maren"), null);
    assert.equal(matchMentionTrigger(`@${"a".repeat(MENTION_QUERY_MAX_LENGTH + 1)}`), null);
  });

  it("lists this chapter's speakers, then characters, then places, filtered by a word's start", () => {
    const rows: Mention[] = [
      { id: "pier", name: "The Pier", insert: "The Pier", group: "Places" },
      { id: "rook", name: "Rook Vane", insert: "Rook", group: "Characters" },
      { id: "maren", name: "Maren Kest", insert: "Maren", group: "In this chapter" },
    ];
    assert.deepEqual(filterMentions(rows, "").map((row) => row.id), ["maren", "rook", "pier"]);
    assert.deepEqual(filterMentions(rows, "ke").map((row) => row.id), ["maren"], "a surname's start");
    assert.deepEqual(filterMentions(rows, "ier").map((row) => row.id), [], "not the middle of a word");
    const anne: Mention = { id: "anne", name: "Anne-Marie Holt", insert: "Anne-Marie", group: "Characters" };
    assert.deepEqual(filterMentions([anne], "marie").map((row) => row.id), ["anne"], "a hyphenated name's second word");
    assert.deepEqual(filterMentions([anne], "anne-ma").map((row) => row.id), ["anne"], "or the name's start past the hyphen");
  });
});
