import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  boardLetter,
  boardPackKey,
  packBoards,
  packShotsFor,
  type PackShot,
  type Take,
} from "../src/index.js";

/**
 * SPEC-035's packer, against its own §4 matrix (T-1 – T-18).
 *
 * The prototype this was ported from keyed its overrides by ordinal and read cast from a stored
 * list; both are deliberate divergences here, and both have a test that would catch a
 * regression back to the prototype's shape.
 */

const shot = (over: Partial<PackShot> & { id: string; number: number }): PackShot => ({
  durationSec: 4,
  timeOfDay: "night",
  lighting: null,
  cast: ["maren-kest"],
  solo: false,
  ...over,
});

/** Every shot framed, unless a test says otherwise. */
const framed = () => true;
const unframed = () => false;
const NONE: ReadonlySet<string> = new Set();

/** Boards as `letter:members` — what a reader can check at a glance. */
const shape = (pack: ReturnType<typeof packBoards>): string => {
  assert.ok(pack.ok, "expected a successful pack");
  return pack.boards.map((b) => `${b.letter}:${b.memberShotIds.join(",")}`).join(" | ");
};

const boardsOf = (pack: ReturnType<typeof packBoards>) => {
  assert.ok(pack.ok, "expected a successful pack");
  return pack.boards;
};

const noteTexts = (pack: ReturnType<typeof packBoards>): string[] =>
  boardsOf(pack).flatMap((b) => b.notes.map((n) => n.text));

describe("the scene's own values are modal, not stored (T-1)", () => {
  it("reads four night shots and one dusk as a night scene with one override", () => {
    // Four night + one dusk. Only the dusk shot may break; comparing against a stored default
    // of "dusk" would have broken between every pair.
    const shots = [
      shot({ id: "sh_1", number: 1, timeOfDay: "night" }),
      shot({ id: "sh_2", number: 2, timeOfDay: "night" }),
      shot({ id: "sh_3", number: 3, timeOfDay: "dusk" }),
      shot({ id: "sh_4", number: 4, timeOfDay: "night" }),
      shot({ id: "sh_5", number: 5, timeOfDay: "night" }),
    ];
    const pack = packBoards(shots, 60, NONE, NONE, framed);
    /*
     * The walk breaks entering the dusk shot and again leaving it; the lone dusk board then
     * folds back under R-7, carrying the seam it suppressed. Two boards, one warning — and,
     * the point of this test, ONE seam rather than the four a stored default would have made.
     */
    assert.equal(shape(pack), "A:sh_1,sh_2,sh_3 | B:sh_4,sh_5");
    assert.match(noteTexts(pack)[0]!, /spans a time-of-day change · shot 3 dusk in a night board/);
    assert.equal(boardsOf(pack)[1]!.reason, "time of day changes");
  });

  it("never breaks on an unset value, because absence inherits", () => {
    const shots = [
      shot({ id: "sh_1", number: 1, timeOfDay: "night" }),
      shot({ id: "sh_2", number: 2, timeOfDay: null }),
      shot({ id: "sh_3", number: 3, timeOfDay: "night" }),
    ];
    assert.equal(shape(packBoards(shots, 60, NONE, NONE, framed)), "A:sh_1,sh_2,sh_3");
  });
});

describe("the clip limit is never overridable (T-2)", () => {
  it("breaks at the cap, and a merge at that boundary changes nothing", () => {
    const shots = [
      shot({ id: "sh_1", number: 1, durationSec: 6 }),
      shot({ id: "sh_2", number: 2, durationSec: 6 }),
      shot({ id: "sh_3", number: 3, durationSec: 6 }),
    ];
    const bare = packBoards(shots, 10, NONE, NONE, framed);
    assert.equal(shape(bare), "A:sh_1 | B:sh_2 | C:sh_3");
    const merged = packBoards(shots, 10, NONE, new Set(["sh_2", "sh_3"]), framed);
    assert.equal(shape(merged), shape(bare), "a merge cannot buy a request the provider refuses");
    assert.equal(boardsOf(merged)[1]!.reason, "clip limit");
  });
});

describe("a suppressed break is carried (T-3)", () => {
  it("warns on the surviving board when a merge spans a time-of-day change", () => {
    const shots = [
      shot({ id: "sh_1", number: 1, timeOfDay: "dusk" }),
      shot({ id: "sh_2", number: 2, timeOfDay: "dusk" }),
      shot({ id: "sh_3", number: 3, timeOfDay: "night" }),
      shot({ id: "sh_4", number: 4, timeOfDay: "night" }),
    ];
    const pack = packBoards(shots, 60, NONE, new Set(["sh_3"]), framed);
    assert.equal(shape(pack), "A:sh_1,sh_2,sh_3,sh_4", "the merge holds one board across the seam");
    const warnings = boardsOf(pack)[0]!.notes.filter((n) => n.kind === "warning");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.text, /spans a time-of-day change · shot 3 night/);
  });

  it("warns when a merge spans a cast change, naming who arrives", () => {
    const shots = [
      shot({ id: "sh_1", number: 1, cast: ["maren-kest"] }),
      shot({ id: "sh_2", number: 2, cast: ["sereth"] }),
    ];
    const pack = packBoards(shots, 60, NONE, new Set(["sh_2"]), framed);
    assert.equal(shape(pack), "A:sh_1,sh_2");
    assert.match(noteTexts(pack)[0]!, /spans a cast change · shot 2 brings sereth/);
  });
});

describe("the single-shot collapse (T-4, T-12, T-17)", () => {
  it("folds a board of one into the neighbour with room, carrying its reason", () => {
    const shots = [
      shot({ id: "sh_1", number: 1, timeOfDay: "night" }),
      shot({ id: "sh_2", number: 2, timeOfDay: "night" }),
      shot({ id: "sh_3", number: 3, timeOfDay: "dusk" }),
    ];
    const pack = packBoards(shots, 60, NONE, NONE, framed);
    assert.equal(shape(pack), "A:sh_1,sh_2,sh_3", "a board of one is per-shot generation in disguise");
    assert.match(noteTexts(pack)[0]!, /spans a time-of-day change · shot 3 dusk/);
  });

  it("leaves a hand-split board of one standing (T-4)", () => {
    const shots = [
      shot({ id: "sh_1", number: 1 }),
      shot({ id: "sh_2", number: 2 }),
      shot({ id: "sh_3", number: 3 }),
    ];
    const pack = packBoards(shots, 60, new Set(["sh_3"]), NONE, framed);
    assert.equal(shape(pack), "A:sh_1,sh_2 | B:sh_3");
    assert.equal(boardsOf(pack)[1]!.reason, "by hand", "the author said seam; the packer does not un-say it");
  });

  it("never folds forward across a hand seam (T-12)", () => {
    /*
     * sh_3 is a singleton with no room behind it — board A is full at the cap — and a
     * hand-split board ahead that has room. Folding forward would erase the author's boundary
     * as surely as folding their board, so it is refused and the singleton stands.
     */
    const shots = [
      shot({ id: "sh_1", number: 1, durationSec: 5 }),
      shot({ id: "sh_2", number: 2, durationSec: 5 }),
      shot({ id: "sh_3", number: 3, durationSec: 1, timeOfDay: "dusk" }),
      shot({ id: "sh_4", number: 4, durationSec: 1 }),
    ];
    const withSplit = packBoards(shots, 10, new Set(["sh_4"]), NONE, framed);
    assert.equal(shape(withSplit), "A:sh_1,sh_2 | B:sh_3 | C:sh_4", "the hand seam survives");

    /*
     * And the split is what stopped it: the identical scene without one folds sh_3 forward,
     * which is the behaviour the guard exists to withhold from an authored boundary.
     */
    const withoutSplit = packBoards(shots, 10, NONE, NONE, framed);
    assert.equal(shape(withoutSplit), "A:sh_1,sh_2 | B:sh_3,sh_4");
  });

  it("carries the FORWARD board's reason, not the singleton's, when folding forward (T-17)", () => {
    /*
     * sh_1 is a singleton with no room behind it. sh_2 begins a `cast changes` board. Folding
     * forward makes the boundary between them vanish — so THAT is the warning, and the
     * singleton's own start reason survives as the combined board's start.
     */
    const shots = [
      shot({ id: "sh_1", number: 1, durationSec: 2, cast: ["maren-kest"] }),
      shot({ id: "sh_2", number: 2, durationSec: 2, cast: ["sereth"] }),
      shot({ id: "sh_3", number: 3, durationSec: 2, cast: ["sereth"] }),
    ];
    const pack = packBoards(shots, 6, NONE, NONE, framed);
    assert.equal(shape(pack), "A:sh_1,sh_2,sh_3");
    const warnings = noteTexts(pack);
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0]!,
      /spans a cast change · shot 2 brings sereth/,
      "the seam that vanished is the one between the singleton and the board it joined",
    );
  });
});

describe("overrides key by shot id, never by position (T-5, T-6)", () => {
  it("keeps a split attached to its shot after a reorder (T-5)", () => {
    const a = shot({ id: "sh_1", number: 1 });
    const b = shot({ id: "sh_2", number: 2 });
    const c = shot({ id: "sh_3", number: 3 });
    const splits = new Set(["sh_3"]);
    assert.equal(shape(packBoards([a, b, c], 60, splits, NONE, framed)), "A:sh_1,sh_2 | B:sh_3");
    // Reordered: the seam follows sh_3, which an ordinal-keyed override could not do.
    assert.equal(shape(packBoards([c, a, b], 60, splits, NONE, framed)), "A:sh_3,sh_1,sh_2");
  });

  it("drops an override naming a shot that is gone, rather than failing (T-6)", () => {
    const shots = [shot({ id: "sh_1", number: 1 }), shot({ id: "sh_2", number: 2 })];
    const pack = packBoards(shots, 60, new Set(["sh_deleted"]), new Set(["sh_also-gone"]), framed);
    assert.equal(shape(pack), "A:sh_1,sh_2");
  });
});

describe("durations add exactly, not in binary floating point", () => {
  it("keeps a board whose decimal durations fill the cap precisely", () => {
    /*
     * 0.3 + 7.9 + 1.8 is 10.000000000000002 in float, which is over a 10-second cap by a
     * number nobody typed. Packed in seconds, this scene split in two — and the singleton
     * could not fold back, because the collapse re-checks the same overflowing sum.
     */
    assert.ok(0.3 + 7.9 + 1.8 > 10, "the float hazard this test exists for");
    const shots = [
      shot({ id: "sh_1", number: 1, durationSec: 0.3 }),
      shot({ id: "sh_2", number: 2, durationSec: 7.9 }),
      shot({ id: "sh_3", number: 3, durationSec: 1.8 }),
    ];
    const pack = packBoards(shots, 10, NONE, NONE, framed);
    assert.equal(shape(pack), "A:sh_1,sh_2,sh_3", "an exact fit is one board");
    assert.equal(boardsOf(pack)[0]!.durationSec, 10, "and it reports the duration a person would write");
  });

  it("still breaks where the durations genuinely exceed the cap", () => {
    const shots = [
      shot({ id: "sh_1", number: 1, durationSec: 0.3 }),
      shot({ id: "sh_2", number: 2, durationSec: 7.9 }),
      shot({ id: "sh_3", number: 3, durationSec: 1.9 }),
    ];
    assert.equal(shape(packBoards(shots, 10, NONE, NONE, framed)), "A:sh_1,sh_2 | B:sh_3");
  });

  it("refuses a shot over the cap by a real margin, not a float artefact", () => {
    const exact = packBoards([shot({ id: "sh_1", number: 1, durationSec: 10 })], 10, NONE, NONE, framed);
    assert.ok(exact.ok, "a shot exactly at the cap fits");
    const over = packBoards([shot({ id: "sh_1", number: 1, durationSec: 10.1 })], 10, NONE, NONE, framed);
    assert.equal(over.ok, false);
  });
});

describe("the model cap decides membership (T-7)", () => {
  it("repacks when the cap changes", () => {
    const shots = [
      shot({ id: "sh_1", number: 1, durationSec: 8 }),
      shot({ id: "sh_2", number: 2, durationSec: 8 }),
      shot({ id: "sh_3", number: 3, durationSec: 8 }),
    ];
    assert.equal(shape(packBoards(shots, 30, NONE, NONE, framed)), "A:sh_1,sh_2,sh_3");
    assert.equal(shape(packBoards(shots, 20, NONE, NONE, framed)), "A:sh_1,sh_2 | B:sh_3");
    assert.equal(shape(packBoards(shots, 10, NONE, NONE, framed)), "A:sh_1 | B:sh_2 | C:sh_3");
  });
});

describe("the memo key covers the inputs and nothing else (T-8)", () => {
  it("is stable for identical inputs and moves for every input that changes the pack", () => {
    const shots = [shot({ id: "sh_1", number: 1 }), shot({ id: "sh_2", number: 2 })];
    const key = boardPackKey(shots, 30, NONE, NONE, "11");
    assert.equal(boardPackKey(shots, 30, NONE, NONE, "11"), key);
    assert.notEqual(boardPackKey(shots, 20, NONE, NONE, "11"), key, "cap");
    assert.notEqual(boardPackKey(shots, 30, new Set(["sh_2"]), NONE, "11"), key, "splits");
    assert.notEqual(boardPackKey(shots, 30, NONE, new Set(["sh_2"]), "11"), key, "merges");
    assert.notEqual(boardPackKey(shots, 30, NONE, NONE, "10"), key, "frame coverage");
    assert.notEqual(boardPackKey(shots, 30, NONE, NONE, "11", 4), key, "panel cap");
    assert.notEqual(
      boardPackKey([shots[1]!, shots[0]!], 30, NONE, NONE, "11"),
      key,
      "shot order",
    );
    // Set iteration order must not leak into the key.
    assert.equal(
      boardPackKey(shots, 30, new Set(["sh_2", "sh_1"]), NONE, "11"),
      boardPackKey(shots, 30, new Set(["sh_1", "sh_2"]), NONE, "11"),
    );
  });

  it("cannot be confused by separators inside free-text values", () => {
    /*
     * `timeOfDay` and `lighting` come from art direction and are unrestricted. A key that
     * joined them with a separator would encode these two scenes identically — and they pack
     * differently, so a memo would hand one scene the other's boards.
     */
    const a = [shot({ id: "sh_1", number: 1, timeOfDay: "night:blue hour", lighting: "lantern" })];
    const b = [shot({ id: "sh_1", number: 1, timeOfDay: "night", lighting: "blue hour:lantern" })];
    assert.notEqual(boardPackKey(a, 30, NONE, NONE, "1"), boardPackKey(b, 30, NONE, NONE, "1"));

    // The same trap one level out: a cast entry containing the cast separator.
    const c = [shot({ id: "sh_1", number: 1, cast: ["a+b"] })];
    const d = [shot({ id: "sh_1", number: 1, cast: ["a", "b"] })];
    assert.notEqual(boardPackKey(c, 30, NONE, NONE, "1"), boardPackKey(d, 30, NONE, NONE, "1"));
  });

  it("moves when a shot is renumbered, because the number reaches the output", () => {
    // Every warning, accent and refusal names `shot.number`. A key blind to it would return a
    // cached pack whose text names the number the shot used to have.
    const before = [shot({ id: "sh_1", number: 1 })];
    const after = [shot({ id: "sh_1", number: 7 })];
    assert.notEqual(boardPackKey(before, 30, NONE, NONE, "1"), boardPackKey(after, 30, NONE, NONE, "1"));
  });
});

describe("an empty cast is an unknown, not a change (T-9)", () => {
  it("never produces a cast break from a shot that names nobody", () => {
    const shots = [
      shot({ id: "sh_1", number: 1, cast: ["maren-kest"] }),
      shot({ id: "sh_2", number: 2, cast: [] }),
      shot({ id: "sh_3", number: 3, cast: ["sereth"] }),
    ];
    assert.equal(shape(packBoards(shots, 60, NONE, NONE, framed)), "A:sh_1,sh_2,sh_3");
  });

  it("does break where two named casts do not overlap", () => {
    const shots = [
      shot({ id: "sh_1", number: 1, cast: ["maren-kest"] }),
      shot({ id: "sh_2", number: 2, cast: ["maren-kest", "sereth"] }),
      shot({ id: "sh_3", number: 3, cast: ["ilo"] }),
    ];
    const pack = packBoards(shots, 60, NONE, NONE, framed);
    assert.equal(shape(pack), "A:sh_1,sh_2,sh_3", "the singleton folds back");
    assert.match(noteTexts(pack)[0]!, /spans a cast change · shot 3 brings ilo/);
  });
});

describe("letters are derived and unbounded (T-10, T-15)", () => {
  it("renumbers on every pack", () => {
    const shots = [
      shot({ id: "sh_1", number: 1, durationSec: 8 }),
      shot({ id: "sh_2", number: 2, durationSec: 8 }),
    ];
    assert.deepEqual(
      boardsOf(packBoards(shots, 10, NONE, NONE, framed)).map((b) => b.letter),
      ["A", "B"],
    );
  });

  it("continues past Z as AA, AB (T-15)", () => {
    assert.equal(boardLetter(0), "A");
    assert.equal(boardLetter(25), "Z");
    assert.equal(boardLetter(26), "AA");
    assert.equal(boardLetter(27), "AB");
    assert.equal(boardLetter(51), "AZ");
    assert.equal(boardLetter(52), "BA");
    // A 10s cap over 30 one-second shots each breaking by hand reaches the far side of Z.
    const shots = Array.from({ length: 30 }, (_, i) =>
      shot({ id: `sh_${i + 1}`, number: i + 1, durationSec: 1 }),
    );
    const splits = new Set(shots.slice(1).map((s) => s.id));
    const letters = boardsOf(packBoards(shots, 10, splits, NONE, framed)).map((b) => b.letter);
    assert.equal(letters.length, 30);
    assert.deepEqual(letters.slice(24, 28), ["Y", "Z", "AA", "AB"]);
  });
});

describe("a shot no cap can hold refuses the pack (T-11)", () => {
  it("names the shot and returns no boards beside the refusal", () => {
    const shots = [
      shot({ id: "sh_1", number: 1, durationSec: 4 }),
      shot({ id: "sh_2", number: 2, durationSec: 40 }),
    ];
    const pack = packBoards(shots, 30, NONE, NONE, framed);
    assert.equal(pack.ok, false);
    assert.ok(!pack.ok);
    assert.deepEqual(pack.oversizeShot, {
      shotId: "sh_2",
      number: 2,
      durationSec: 40,
      capSec: 30,
    });
    assert.ok(!("boards" in pack), "a refusal offers nothing to dispatch");
  });
});

describe("the panel limit is a pack input, not a later subdivision (T-13)", () => {
  it("caps membership, names the reason, and cannot be merged across", () => {
    const shots = Array.from({ length: 5 }, (_, i) =>
      shot({ id: `sh_${i + 1}`, number: i + 1, durationSec: 1 }),
    );
    const pack = packBoards(shots, 60, NONE, new Set(shots.map((s) => s.id)), framed, 2);
    assert.equal(shape(pack), "A:sh_1,sh_2 | B:sh_3,sh_4 | C:sh_5");
    assert.equal(boardsOf(pack)[1]!.reason, "panel limit");
    for (const board of boardsOf(pack)) {
      assert.ok(board.memberShotIds.length <= 2, "no board may exceed one sheet");
    }
  });

  it("keeps the collapse inside the panel cap too", () => {
    const shots = Array.from({ length: 3 }, (_, i) =>
      shot({ id: `sh_${i + 1}`, number: i + 1, durationSec: 1 }),
    );
    // Boards of 2 then 1; folding the singleton back would make 3, over the cap of 2.
    const pack = packBoards(shots, 60, NONE, NONE, framed, 2);
    assert.equal(shape(pack), "A:sh_1,sh_2 | B:sh_3");
  });
});

describe("splits and merges are disjoint at read (T-14)", () => {
  it("reads an id in both sets as a split, dropping the dormant merge", () => {
    const shots = [
      shot({ id: "sh_1", number: 1, timeOfDay: "dusk" }),
      shot({ id: "sh_2", number: 2, timeOfDay: "dusk" }),
      shot({ id: "sh_3", number: 3, timeOfDay: "dusk" }),
    ];
    const pack = packBoards(shots, 60, new Set(["sh_2"]), new Set(["sh_2"]), framed);
    assert.equal(shape(pack), "A:sh_1 | B:sh_2,sh_3");
    assert.equal(boardsOf(pack)[1]!.reason, "by hand");
  });
});

describe("lighting is an accent, never a break (R-6)", () => {
  it("keeps one board and notes the accent in neutral", () => {
    const shots = [
      shot({ id: "sh_1", number: 1, lighting: "blue hour" }),
      shot({ id: "sh_2", number: 2, lighting: "blue hour" }),
      shot({ id: "sh_3", number: 3, lighting: "practical lantern" }),
    ];
    const pack = packBoards(shots, 60, NONE, NONE, framed);
    assert.equal(shape(pack), "A:sh_1,sh_2,sh_3", "breaking on light defeated the feature once");
    const accents = boardsOf(pack)[0]!.notes.filter((n) => n.kind === "accent");
    assert.equal(accents.length, 1);
    assert.match(accents[0]!.text, /lighting accent · shot 3 · practical lantern, inside a blue hour scene/);
  });
});

describe("what the board reports about itself", () => {
  it("counts members without a frame, for the dialog's scope preview", () => {
    const shots = [shot({ id: "sh_1", number: 1 }), shot({ id: "sh_2", number: 2 })];
    assert.equal(boardsOf(packBoards(shots, 60, NONE, NONE, unframed))[0]!.missingFrames, 2);
    assert.equal(
      boardsOf(packBoards(shots, 60, NONE, NONE, (id) => id === "sh_1"))[0]!.missingFrames,
      1,
    );
  });

  it("warns where a solo-rendered shot sits inside a board (R-9)", () => {
    const shots = [
      shot({ id: "sh_1", number: 1 }),
      shot({ id: "sh_2", number: 2, solo: true }),
    ];
    const pack = packBoards(shots, 60, NONE, NONE, framed);
    assert.match(noteTexts(pack)[0]!, /shot 2 rendered separately · may not match this board/);
  });

  it("says nothing about a solo shot that is a board of its own", () => {
    const pack = packBoards([shot({ id: "sh_1", number: 1, solo: true })], 60, NONE, NONE, framed);
    assert.deepEqual(noteTexts(pack), []);
  });

  it("gives the first board no reason, having nothing before it (R-10)", () => {
    const pack = packBoards([shot({ id: "sh_1", number: 1 })], 60, NONE, NONE, framed);
    assert.equal(boardsOf(pack)[0]!.reason, null);
  });

  it("packs an empty scene into no boards at all", () => {
    assert.equal(shape(packBoards([], 30, NONE, NONE, framed)), "");
  });
});

describe("assembling the packer's input (T-18)", () => {
  const clip = (over: Partial<Take> & { id: string; coversShots: string[] }): Take =>
    ({ kind: "clip", ...over }) as Take;

  it("follows the framing chain, then the scene's own inheritance", () => {
    const [a, b] = packShotsFor({
      scene: { defaults: { timeOfDay: "dusk", lighting: "blue hour" }, inherits: { timeOfDay: "dawn" } },
      shots: [
        { id: "sh_1", number: 1, title: "a", description: "", framing: { timeOfDay: "night" } },
        { id: "sh_2", number: 2, title: "b", description: "" },
      ],
      selections: {},
      takes: [],
      castOf: () => [],
      defaultDurationSec: 4,
    });
    assert.equal(a!.timeOfDay, "night", "the shot's own framing wins");
    assert.equal(b!.timeOfDay, "dusk", "then the scene's defaults");
    assert.equal(b!.lighting, "blue hour");
  });

  it("falls through to inherits only when neither framing nor defaults answer", () => {
    const [only] = packShotsFor({
      scene: { defaults: undefined, inherits: { timeOfDay: "dawn" } },
      shots: [{ id: "sh_1", number: 1, title: "a", description: "" }],
      selections: {},
      takes: [],
      castOf: () => [],
      defaultDurationSec: 4,
    });
    assert.equal(only!.timeOfDay, "dawn");
    assert.equal(only!.lighting, null, "lighting has no inherits to fall through to");
  });

  it("takes the default duration where a shot states none", () => {
    const [a, b] = packShotsFor({
      scene: {},
      shots: [
        { id: "sh_1", number: 1, title: "a", description: "", durationSec: 9 },
        { id: "sh_2", number: 2, title: "b", description: "" },
      ],
      selections: {},
      takes: [],
      castOf: () => [],
      defaultDurationSec: 4,
    });
    assert.equal(a!.durationSec, 9);
    assert.equal(b!.durationSec, 4);
  });

  it("marks solo only for a CLIP covering exactly that shot (T-18)", () => {
    const shots = [
      { id: "sh_1", number: 1, title: "a", description: "" },
      { id: "sh_2", number: 2, title: "b", description: "" },
      { id: "sh_3", number: 3, title: "c", description: "" },
    ];
    const packed = packShotsFor({
      scene: {},
      shots,
      selections: {
        sh_1: { acceptedTakeId: "tk_solo", trimInSec: 0 },
        // A still misfiled into the clip slot by an older build: framed, never "rendered
        // separately" — without the kind check every board holding it would warn about a
        // video render that never happened.
        sh_2: { acceptedTakeId: "tk_still", trimInSec: 0 },
        // A pass take covering several shots is not a solo render of any of them.
        sh_3: { acceptedTakeId: "tk_pass", trimInSec: 0 },
      },
      takes: [
        clip({ id: "tk_solo", coversShots: ["sh_1"] }),
        clip({ id: "tk_still", coversShots: ["sh_2"], kind: "frame" }),
        clip({ id: "tk_pass", coversShots: ["sh_2", "sh_3"] }),
      ],
      castOf: () => [],
      defaultDurationSec: 4,
    });
    assert.deepEqual(
      packed.map((s) => s.solo),
      [true, false, false],
    );
  });

  it("never calls a whole-scene pass segment solo — it is the opposite (T-18)", () => {
    /*
     * Arrival derives one `clip` per shot from a pass, each covering exactly its own shot and
     * naming the pass in `segment`. By coverage alone that is indistinguishable from a solo
     * render, while the meaning is inverted: this footage was made WITH its neighbours, which
     * is the whole point of a board. Reading it as solo would make an accepted pass warn that
     * its own members were rendered separately.
     */
    const packed = packShotsFor({
      scene: {},
      shots: [
        { id: "sh_1", number: 1, title: "a", description: "" },
        { id: "sh_2", number: 2, title: "b", description: "" },
      ],
      selections: {
        sh_1: { acceptedTakeId: "tk_seg1", trimInSec: 0 },
        sh_2: { acceptedTakeId: "tk_seg2", trimInSec: 0 },
      },
      takes: [
        // The parent, covering both — this is what makes the segments non-solo.
        clip({ id: "tk_pass", coversShots: ["sh_1", "sh_2"] }),
        clip({
          id: "tk_seg1",
          coversShots: ["sh_1"],
          segment: { passTakeId: "tk_pass", inSec: 0, outSec: 4 },
        }),
        clip({
          id: "tk_seg2",
          coversShots: ["sh_2"],
          segment: { passTakeId: "tk_pass", inSec: 4, outSec: 8 },
        }),
      ],
      castOf: () => [],
      defaultDurationSec: 4,
    });
    assert.deepEqual(
      packed.map((s) => s.solo),
      [false, false],
    );
    // And so the board says nothing about them.
    const pack = packBoards(packed, 60, NONE, NONE, framed);
    assert.deepEqual(noteTexts(pack), []);
  });

  it("still calls a SINGLE-shot pass segment solo, judged by its parent (T-18)", () => {
    /*
     * A pass can cover one shot — the cap isolated it — and arrival gives it a segment all the
     * same. That footage was rendered without neighbours, so if a later repack groups the shot
     * with some, the board must still say it may not match. The parent's coverage is what
     * separates this from the multi-shot case; the segment's own coverage cannot.
     */
    const packed = packShotsFor({
      scene: {},
      shots: [
        { id: "sh_1", number: 1, title: "a", description: "" },
        { id: "sh_2", number: 2, title: "b", description: "" },
      ],
      selections: { sh_1: { acceptedTakeId: "tk_seg", trimInSec: 0 } },
      takes: [
        clip({ id: "tk_lonepass", coversShots: ["sh_1"] }),
        clip({
          id: "tk_seg",
          coversShots: ["sh_1"],
          segment: { passTakeId: "tk_lonepass", inSec: 0, outSec: 4 },
        }),
      ],
      castOf: () => [],
      defaultDurationSec: 4,
    });
    assert.deepEqual(
      packed.map((s) => s.solo),
      [true, false],
    );
    const pack = packBoards(packed, 60, NONE, NONE, framed);
    assert.match(noteTexts(pack)[0]!, /shot 1 rendered separately/);
  });

  it("treats a segment whose parent is missing as solo, preferring a visible seam", () => {
    const packed = packShotsFor({
      scene: {},
      shots: [{ id: "sh_1", number: 1, title: "a", description: "" }],
      selections: { sh_1: { acceptedTakeId: "tk_orphan", trimInSec: 0 } },
      takes: [
        clip({
          id: "tk_orphan",
          coversShots: ["sh_1"],
          segment: { passTakeId: "tk_gone", inSec: 0, outSec: 4 },
        }),
      ],
      castOf: () => [],
      defaultDurationSec: 4,
    });
    assert.equal(packed[0]!.solo, true, "a seam that might exist is said, not hidden");
  });

  it("takes cast from the caller's resolver, in order", () => {
    const packed = packShotsFor({
      scene: {},
      shots: [{ id: "sh_1", number: 1, title: "a", description: "@maren-kest and @sereth" }],
      selections: {},
      takes: [],
      castOf: (s) => (s.description.includes("maren") ? ["maren-kest", "sereth"] : []),
      defaultDurationSec: 4,
    });
    assert.deepEqual(packed[0]!.cast, ["maren-kest", "sereth"]);
  });
});
