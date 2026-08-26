import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { benchMentionsIn, unresolvedBenchMentions } from "@arke-studio/contracts";
import {
  droppedMentions,
  filterMentions,
  insertMention,
  mentionOptions,
  mentionQueryAt,
  mentionQueryEnd,
  type MentionOption,
} from "../src/lib/bench-mention.js";

/**
 * The @ completion in a bench brief (issue 476).
 *
 * The screen's part of this is a menu; the part worth holding still is the arithmetic under it —
 * where a citation starts, what a query matches, and what the words look like afterwards. All of
 * it is exercised here without a browser, because a caret is exactly the kind of thing that is
 * easy to get subtly wrong and hard to see going wrong in a screenshot.
 */

const OPTIONS: MentionOption[] = [
  { token: "Image 1", kind: "image", name: "harbour-night.png", meta: "png · made here", imagePath: "artifacts/harbour-night.png" },
  { token: "Image 2", kind: "image", name: "Aurora · identity", meta: "identity · head-front.png", imagePath: "references/aurora/head-front.png" },
  { token: "Video 1", kind: "video", name: "Take 3", meta: "veo-3 · kept" },
  { token: "Audio 1", kind: "audio", name: "tide-bell.wav", meta: "wav · 0:04" },
];

const tokensOf = (rows: readonly MentionOption[]): string[] => rows.map((row) => row.token);

describe("where a citation starts (issue 476)", () => {
  it("opens on a bare @ at the caret", () => {
    assert.deepEqual(mentionQueryAt("cite @", 6), { start: 5, query: "" });
  });

  it("opens at the very start of the words", () => {
    assert.deepEqual(mentionQueryAt("@im", 3), { start: 0, query: "im" });
  });

  it("carries the space inside a token, so the name it completes can be spelled", () => {
    assert.deepEqual(mentionQueryAt("cite @Image 1", 13), { start: 5, query: "Image 1" });
  });

  it("is not an address: an @ inside a word cites nothing", () => {
    assert.equal(mentionQueryAt("write to me@image.example", 25), null);
  });

  it("closes once the author has written on past it", () => {
    assert.equal(mentionQueryAt("@Image 1 lit from behind and", 28), null);
  });

  it("closes across a line break", () => {
    assert.equal(mentionQueryAt("@\nharbour", 9), null);
  });

  it("reads the caret, not the end of the words", () => {
    // The caret sits after "@im"; the rest of the sentence is already written.
    assert.deepEqual(mentionQueryAt("@im lit from behind", 3), { start: 0, query: "im" });
  });

  it("is nothing at all when the caret sits before the @", () => {
    assert.equal(mentionQueryAt("@Image 1", 0), null);
  });
});

describe("what a query matches (issue 476)", () => {
  it("offers everything attached when nothing has been typed yet", () => {
    assert.deepEqual(tokensOf(filterMentions(OPTIONS, "")), ["Image 1", "Image 2", "Video 1", "Audio 1"]);
  });

  it("narrows by the token's own prefix", () => {
    assert.deepEqual(tokensOf(filterMentions(OPTIONS, "im")), ["Image 1", "Image 2"]);
    assert.deepEqual(tokensOf(filterMentions(OPTIONS, "image")), ["Image 1", "Image 2"]);
  });

  it("narrows by media kind", () => {
    assert.deepEqual(tokensOf(filterMentions(OPTIONS, "audio")), ["Audio 1"]);
  });

  it("finds a source by its filename and by its character's name", () => {
    assert.deepEqual(tokensOf(filterMentions(OPTIONS, "harbour")), ["Image 1"]);
    assert.deepEqual(tokensOf(filterMentions(OPTIONS, "aurora")), ["Image 2"]);
  });

  it("finds the exact name a completed query spells", () => {
    assert.deepEqual(tokensOf(filterMentions(OPTIONS, "Video 1")), ["Video 1"]);
  });

  it("puts the token ahead of a name that merely starts with the same letters", () => {
    // "Aurora" starts with an "a" too; "Audio 1" is the name being completed, so it leads.
    assert.equal(filterMentions(OPTIONS, "a")[0]?.token, "Audio 1");
    assert.equal(filterMentions(OPTIONS, "vid")[0]?.token, "Video 1");
  });

  it("matches nothing rather than everything when the query names nothing attached", () => {
    assert.deepEqual(filterMentions(OPTIONS, "zzz"), []);
  });
});

describe("what the words look like afterwards (issue 476)", () => {
  it("replaces the query, keeps both sides, and leaves the caret ready to write", () => {
    const query = mentionQueryAt("A face lit by @im, cold", 17);
    assert.notEqual(query, null);
    const next = insertMention("A face lit by @im, cold", query!, "Image 1");
    // No space before the comma. The earlier version wrote "@Image 1 , cold" — a completion the
    // author asked for to name a picture, punctuating their sentence for them (raised on review).
    assert.equal(next.text, "A face lit by @Image 1, cold");
    assert.equal(next.caret, 22);
    assert.equal(next.text.slice(0, next.caret), "A face lit by @Image 1");
  });

  it("puts no space in front of punctuation that closes", () => {
    for (const [after, expected] of [
      [", cold", "@Image 1, cold"],
      [".", "@Image 1."],
      [")", "@Image 1)"],
      [": low light", "@Image 1: low light"],
      ["; then", "@Image 1; then"],
    ] as const) {
      const text = `@im${after}`;
      assert.equal(insertMention(text, mentionQueryAt(text, 3)!, "Image 1").text, expected, after);
    }
  });

  it("still leaves one where the next word needs it", () => {
    assert.equal(insertMention("@im", mentionQueryAt("@im", 3)!, "Image 1").text, "@Image 1 ");
    const text = "@imcold";
    assert.equal(insertMention(text, mentionQueryAt(text, 3)!, "Image 1").text, "@Image 1 ");
  });

  it("inserts exactly one mention, at the query, from a bare @", () => {
    const query = mentionQueryAt("cite @", 6);
    const next = insertMention("cite @", query!, "Image 1");
    assert.equal(next.text, "cite @Image 1 ");
    assert.equal(benchMentionsIn(next.text).length, 1);
  });

  it("does not double the space the words already have", () => {
    const query = mentionQueryAt("@im and then", 3);
    const next = insertMention("@im and then", query!, "Image 1");
    assert.equal(next.text, "@Image 1 and then");
    assert.equal(next.caret, 8);
  });

  it("replaces the whole name when the caret is put back inside one (review, issue 476)", () => {
    // "@Im|age 1" — everything after the caret belongs to the same citation. Replacing only as
    // far as the caret left the tail behind and wrote "@Image 1 age 1".
    const text = "lit by @Image 1, cold";
    const query = mentionQueryAt(text, 10);
    assert.deepEqual(query, { start: 7, query: "Im" });
    assert.equal(mentionQueryEnd(text, query!), 15);
    const next = insertMention(text, query!, "Image 2");
    assert.equal(next.text, "lit by @Image 2, cold");
    assert.equal(benchMentionsIn(next.text).length, 1);
  });

  it("finishes a half-typed filename, and takes nothing past the word", () => {
    const text = "@harbour-night.png and then";
    const query = mentionQueryAt(text, 4);
    assert.deepEqual(query, { start: 0, query: "har" });
    assert.equal(mentionQueryEnd(text, query!), 18);
    assert.equal(insertMention(text, query!, "Image 1").text, "@Image 1 and then");
  });

  it("stops at the citation, not at the prose after it", () => {
    const text = "@im lit from behind";
    assert.equal(mentionQueryEnd(text, mentionQueryAt(text, 3)!), 3);
    const next = insertMention(text, mentionQueryAt(text, 3)!, "Image 1");
    assert.equal(next.text, "@Image 1 lit from behind");
  });

  it("survives a second completion in the same sentence", () => {
    const first = insertMention("cite @", mentionQueryAt("cite @", 6)!, "Image 1");
    const typed = `${first.text}and @`;
    const second = insertMention(typed, mentionQueryAt(typed, typed.length)!, "Audio 1");
    assert.equal(second.text, "cite @Image 1 and @Audio 1 ");
    assert.deepEqual(
      benchMentionsIn(second.text).map((m) => m.token),
      ["Image 1", "Audio 1"],
    );
  });
});

describe("what the menu may offer (issue 476)", () => {
  const sources = [
    { existingToken: "Image 1", name: "harbour-night.png", meta: "png", imagePath: "artifacts/harbour-night.png" },
    { existingToken: "Image 7", name: "gone.png", meta: "png" },
  ];

  it("offers the attached tokens, in lane order, dressed from the picker's own rows", () => {
    const rows = mentionOptions(["Image 1"], sources);
    assert.deepEqual(rows, [
      {
        token: "Image 1",
        kind: "image",
        name: "harbour-night.png",
        meta: "png",
        imagePath: "artifacts/harbour-night.png",
      },
    ]);
  });

  it("offers nothing for a token that is not attached, however well the source is known", () => {
    assert.deepEqual(mentionOptions([], sources), []);
  });

  it("still names a token whose source row has gone, under the kind the token spells", () => {
    const rows = mentionOptions(["Video 2"], sources);
    assert.deepEqual(rows, [{ token: "Video 2", kind: "video", name: "Video 2", meta: "" }]);
  });

  it("offers one row per name, however many lanes the picture rides (review, issue 476)", () => {
    // A shot's reference lane and its keyframe lane are checked separately when attaching, so
    // one picture can sit in both — and two identical rows share one React key.
    const rows = mentionOptions(["Image 1", "Image 1"], sources);
    assert.deepEqual(
      rows.map((r) => r.token),
      ["Image 1"],
    );
  });
});

describe("a rewrite that lost a citation (issue 476)", () => {
  it("names what went, once, in the order the ask made them", () => {
    assert.deepEqual(
      droppedMentions("@Image 1 beside @Audio 1 and @Image 1", "a picture beside @Audio 1"),
      ["Image 1"],
    );
  });

  it("counts a citation flattened into plain words as gone", () => {
    assert.deepEqual(droppedMentions("lit like @Image 2", "lit like Image 2"), ["Image 2"]);
  });

  it("says nothing of a rewrite that kept them, wherever it moved them to", () => {
    assert.deepEqual(droppedMentions("@Image 1 and @Audio 1", "@Audio 1, then @Image 1, closer"), []);
  });

  it("says nothing of an ask that cited nothing", () => {
    assert.deepEqual(droppedMentions("a rusted tide-clock", "a rusted tide-clock, lit low"), []);
  });
});

describe("a citation nothing answers for (issue 476)", () => {
  it("names what is cited and not attached, once, in the order written", () => {
    assert.deepEqual(
      unresolvedBenchMentions("@Image 3 beside @Image 1, then @Image 3 again", ["Image 1"]),
      ["Image 3"],
    );
  });

  it("leaves the older bare spelling alone — a brief written before mentions is not bound", () => {
    assert.deepEqual(unresolvedBenchMentions("citing Image 3 by name", []), []);
  });

  it("says nothing when every citation is riding", () => {
    assert.deepEqual(unresolvedBenchMentions("@Image 1 and @Audio 1", ["Audio 1", "Image 1"]), []);
  });

  /**
   * Both bounds matter, and both were missing (raised on review). Unbounded, ordinary prose gets
   * refused at dispatch over a reference nobody cited — the worst kind of refusal, because the
   * words the author is asked to fix are words they never meant as a citation.
   */
  it("is not a citation with an at-sign buried inside a word", () => {
    assert.deepEqual(benchMentionsIn("write to me@Image 1.example"), []);
    assert.deepEqual(unresolvedBenchMentions("write to me@Image 1.example", []), []);
  });

  it("is not a citation where the number runs on into a word", () => {
    assert.deepEqual(benchMentionsIn("released @Image 1st of May"), []);
    assert.deepEqual(unresolvedBenchMentions("released @Image 1st of May", []), []);
  });

  it("still reads a citation the editor would have offered — after an opener, or first", () => {
    for (const text of ["@Image 1", "lit by @Image 1", "(@Image 1)", 'said "@Image 1"']) {
      assert.deepEqual(
        benchMentionsIn(text).map((m) => m.token),
        ["Image 1"],
        text,
      );
    }
  });

  it("reads the whole number, and stops at ordinary punctuation", () => {
    assert.deepEqual(
      benchMentionsIn("@Image 10, then @Image 2.").map((m) => m.token),
      ["Image 10", "Image 2"],
    );
  });

  it("stops at a word-suffix the editor treats as part of the query (review, issue 476)", () => {
    // The editor's query word carries "._-", so it offers no completion for these; the gate must
    // not recognise a prefix of one as a citation and refuse the sentence over it.
    for (const text of ["@Image 1_extra", "@Image 1.foo", "@Image 1-more"]) {
      assert.deepEqual(benchMentionsIn(text), [], text);
    }
  });

  it("but a full stop that ends a sentence still ends a citation", () => {
    for (const text of ["cite @Image 1.", "cite @Image 1. Then more", "cite @Image 1-"]) {
      assert.deepEqual(
        benchMentionsIn(text).map((m) => m.token),
        ["Image 1"],
        text,
      );
    }
  });

  it("agrees with the editor about where a citation may start", () => {
    // Whatever the editor refuses to open a menu over, the gate must refuse to read as one.
    for (const text of ["me@Image 1", "a/@Image 1", "lit by @Image 1"]) {
      const at = text.lastIndexOf("@") + 1 + "Image 1".length;
      const opened = mentionQueryAt(text, at) !== null;
      assert.equal(benchMentionsIn(text).length > 0, opened, text);
    }
  });
});
