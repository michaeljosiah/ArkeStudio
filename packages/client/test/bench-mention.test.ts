import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { benchMentionsIn, unresolvedBenchMentions } from "@arke-studio/contracts";
import {
  filterMentions,
  insertMention,
  mentionOptions,
  mentionQueryAt,
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
    assert.equal(next.text, "A face lit by @Image 1 , cold");
    assert.equal(next.caret, 23);
    assert.equal(next.text.slice(0, next.caret), "A face lit by @Image 1 ");
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
});
