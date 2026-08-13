import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyMarkerImport,
  markersFromImport,
  newId,
  orderedMarkers,
  parseLrc,
  SpineMarkerImportSchema,
  type SpineMarker,
} from "../src/index.js";

/**
 * Marker import (#253). Strictness is the point: a lyric marker is what a shot gets anchored to,
 * so a timestamp read generously moves a shot to the wrong bar and nobody can tell.
 */
describe("importing a marker map somebody else made (#253)", () => {
  const mint = () => newId("mk");

  describe("LRC", () => {
    it("reads the three timestamp shapes, padding the fraction on the right", () => {
      const parsed = parseLrc(["[00:30]first", "[00:34.5]second", "[00:39.100]third"].join("\n"));
      assert.ok(parsed.ok);
      assert.deepEqual(parsed.value, [
        { text: "first", atSec: 30 },
        // ".5" is five tenths, not five hundredths — padEnd, not padStart. The difference is a
        // marker at 34.5s versus one at 34.05s.
        { text: "second", atSec: 34.5 },
        { text: "third", atSec: 39.1 },
      ]);
    });

    it("makes one marker per timestamp when a line carries several", () => {
      // What a repeated chorus line looks like in every LRC file in the wild.
      const parsed = parseLrc("[00:30.00][01:10.00][02:15.50]forgive me");
      assert.ok(parsed.ok);
      assert.deepEqual(
        parsed.value.map((row) => row.atSec),
        [30, 70, 135.5],
      );
      assert.ok(parsed.value.every((row) => row.text === "forgive me"));
    });

    it("applies an offset once to every timestamp, and refuses one that lands before the song", () => {
      const later = parseLrc(["[offset:+500]", "[00:30.00]first"].join("\n"));
      assert.ok(later.ok);
      assert.equal(later.value[0]?.atSec, 30.5);

      // The offset applies to timestamps read before it too, so it is resolved in its own pass.
      const earlier = parseLrc(["[00:30.00]first", "[offset:-1000]"].join("\n"));
      assert.ok(earlier.ok);
      assert.equal(earlier.value[0]?.atSec, 29);

      const negative = parseLrc(["[offset:-40000]", "[00:30.00]first"].join("\n"));
      assert.ok(!negative.ok);
      assert.match(negative.refusal.message, /before the song starts/);
      assert.equal(negative.refusal.line, 2);
    });

    it("ignores blank lines and exactly the four standard metadata tags", () => {
      const parsed = parseLrc(["[ti:Forgive Me]", "[ar:Timi J]", "", "[al:Lagos Nights]", "[by:someone]", "[00:30]x"].join("\n"));
      assert.ok(parsed.ok);
      assert.equal(parsed.value.length, 1);

      // Not a known tag, not a timestamp: refused rather than skipped, because a tag nobody
      // recognises may be a timestamp somebody mistyped.
      const unknown = parseLrc(["[re:something]", "[00:30]x"].join("\n"));
      assert.ok(!unknown.ok);
      assert.equal(unknown.refusal.line, 1);
    });

    it("refuses the whole file on one bad line, and says which line it was", () => {
      const bad = parseLrc(["[00:30.00]first", "[00:34.80]second", "[1:0d.20]third"].join("\n"));
      assert.ok(!bad.ok);
      assert.equal(bad.refusal.line, 3, "one-based, because that is what an editor shows");
      assert.match(bad.refusal.message, /not a timestamped lyric line/);
    });

    it("refuses a timestamp with no words, and words with the stamp after them", () => {
      const empty = parseLrc("[00:30.00]   ");
      assert.ok(!empty.ok);
      assert.match(empty.refusal.message, /timestamp and no words/);

      const trailing = parseLrc("first[00:30.00]");
      assert.ok(!trailing.ok, "a stamp after the words is not a timestamped line");
      assert.equal(trailing.refusal.line, 1);
    });

    it("refuses a minute-second value that is not one", () => {
      // 61 seconds is a file written by hand and wrong; reading it as 1:01 would move the lyric.
      const bad = parseLrc("[00:61.00]first");
      assert.ok(!bad.ok);
    });

    it("refuses a malformed stamp that follows a good one, instead of eating it as lyric text", () => {
      // Codex round 1 P1: `[00:30]` was accepted and `[00:61]first` became the words, so a
      // malformed row was buried inside a marker and the repeat the file asked for vanished.
      const bad = parseLrc("[00:30][00:61]first");
      assert.ok(!bad.ok);
      assert.equal(bad.refusal.line, 1);
      assert.match(bad.refusal.message, /not a timestamp this parser accepts/);

      // A good repeat still works — this is about malformed follow-ons, not about repeats.
      const good = parseLrc("[00:30][01:10]first");
      assert.ok(good.ok);
      assert.equal(good.value.length, 2);
    });

    it("requires a complete metadata tag, so a mistyped or trailing one is not swallowed", () => {
      // Codex round 1 P2: matching the prefix alone ignored an unclosed `[ar:Artist`, and worse,
      // treated `[ar:Artist][00:30]words` as metadata — discarding a real lyric marker.
      const unclosed = parseLrc("[ar:Artist");
      assert.ok(!unclosed.ok, "an unclosed tag is a mistyped line, not metadata");

      const trailing = parseLrc("[ar:Artist][00:30]words");
      assert.ok(!trailing.ok, "a tag with a timestamp after it is refused rather than dropping the lyric");

      const spurious = parseLrc("[ti:Forgive Me] and then some");
      assert.ok(!spurious.ok);

      // The four real tags, complete, are still ignored.
      const fine = parseLrc(["[ti:Forgive Me]", "[00:30]x"].join("\n"));
      assert.ok(fine.ok);
      assert.equal(fine.value.length, 1);
    });

    it("refuses a timestamp that appears after the words, not only before them", () => {
      // Codex round 2 P1: round 1 checked whether the body *started* with a bracket, which
      // caught `[00:30][00:61]first` and missed this — one marker whose words were
      // "first[00:40]second", the second stamp silently discarded. The loop already knew.
      const stray = parseLrc("[00:30]first[00:40]second");
      assert.ok(!stray.ok);
      assert.equal(stray.refusal.line, 1);
      assert.match(stray.refusal.message, /timestamp inside the words/);
    });

    it("refuses a lyric past the end of the song, while the line number still exists", () => {
      // Codex round 2 P1: the duration bound lived only in the JSON-shaped helper, which can say
      // `lyrics[7]` and not "line 12" — so LRC had no upper bound at all.
      const past = parseLrc(["[00:30]first", "[10:00]last line"].join("\n"), 222.14);
      assert.ok(!past.ok);
      assert.equal(past.refusal.line, 2, "the line the user is looking at");
      assert.match(past.refusal.message, /past the track's 222\.140s/);

      // Without a known duration nothing is bounded — the caller has not measured the track yet.
      const unbounded = parseLrc("[10:00]last line");
      assert.ok(unbounded.ok);
    });

    it("keeps duplicate timestamps in source order", () => {
      const parsed = parseLrc(["[00:30.00]first", "[00:30.00]second"].join("\n"));
      assert.ok(parsed.ok);
      assert.deepEqual(parsed.value.map((r) => r.text), ["first", "second"]);
    });
  });

  describe("JSON", () => {
    it("mints markers for both kinds and returns them in time order", () => {
      const imported = SpineMarkerImportSchema.parse({
        sections: [{ label: "Chorus", atSec: 60 }, { label: "Intro", atSec: 0 }],
        lyrics: [{ text: "forgive me", atSec: 30.25 }],
      });
      const result = markersFromImport(imported, 222.14, mint);
      assert.ok(result.ok);
      assert.deepEqual(
        result.value.map((m) => (m.kind === "section" ? m.label : m.text)),
        ["Intro", "forgive me", "Chorus"],
      );
      assert.ok(result.value.every((m) => m.id.startsWith("mk_")), "fresh ids, not the file's");
    });

    it("mints no ids at all when any row is refused", () => {
      // Codex round 2 P2: ids were minted as the rows were walked, so a refused import had
      // already advanced a stateful allocator — an id burned for a marker that never existed,
      // from a function whose contract is that a refusal changes nothing.
      let minted = 0;
      const counting = () => { minted += 1; return newId("mk"); };
      const imported = SpineMarkerImportSchema.parse({
        sections: [{ label: "Intro", atSec: 0 }],
        lyrics: [{ text: "fine", atSec: 30 }, { text: "past the end", atSec: 400 }],
      });
      const result = markersFromImport(imported, 222.14, counting);
      assert.ok(!result.ok);
      assert.equal(minted, 0, "not one id spent on an import that was refused");
    });

    it("refuses a marker past the end of the song, naming the row", () => {
      // Not a late lyric — a file that belongs to a different recording. Accepting it would put
      // a label somewhere no shot can ever be anchored.
      const imported = SpineMarkerImportSchema.parse({
        sections: [],
        lyrics: [{ text: "forgive me", atSec: 30 }, { text: "past the end", atSec: 400 }],
      });
      const result = markersFromImport(imported, 222.14, mint);
      assert.ok(!result.ok);
      assert.equal(result.refusal.path, "lyrics[1]");
      assert.match(result.refusal.message, /past the track's 222\.140s/);
    });
  });

  describe("what an accepted import replaces", () => {
    const section = (label: string, atSec: number): SpineMarker => ({
      kind: "section", id: newId("mk"), label, atSec, source: "manual",
    });
    const lyric = (text: string, atSec: number): SpineMarker => ({
      kind: "lyric", id: newId("mk"), text, atSec, source: "manual",
    });
    const existing = [section("Intro", 0), lyric("old line", 30), section("Chorus", 60)];

    it("an LRC import replaces lyrics and leaves sections alone", () => {
      // A lyric sheet says nothing about song structure. Importing one must not cost the
      // sections somebody placed by hand.
      const next = applyMarkerImport(existing, [lyric("new line", 31)], "lyrics-only");
      assert.deepEqual(
        next.map((m) => (m.kind === "section" ? m.label : m.text)),
        ["Intro", "new line", "Chorus"],
      );
    });

    it("a JSON import replaces both kinds", () => {
      const next = applyMarkerImport(existing, [section("Verse 1", 12)], "sections-and-lyrics");
      assert.deepEqual(next.map((m) => (m.kind === "section" ? m.label : m.text)), ["Verse 1"]);
    });

    it("orders by time and keeps insertion order on a tie", () => {
      const tied = orderedMarkers([lyric("second", 30), section("Intro", 0), lyric("third", 30)]);
      assert.deepEqual(tied.map((m) => (m.kind === "section" ? m.label : m.text)), ["Intro", "second", "third"]);
    });
  });
});
