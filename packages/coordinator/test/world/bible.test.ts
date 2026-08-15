import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyBibleEdits, splitBible, type BibleEdit } from "@arke-studio/contracts";
import {
  applyTurnBibleEdits,
  BibleStaleError,
  readBible,
  restoreBible,
  saveBible,
} from "../../src/world/bible.js";
import { BibleEditError } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { until } from "../wait.js";
import { makeTempWorld } from "./helpers.js";

const CLOCK = () => "2026-08-15T12:00:00.000Z";

const OPENING = [
  "This world is about being owed something by the sea.",
  "",
  "## The tides",
  "",
  "The tide is the world's clock and its accountant.",
  "",
  "## The bells",
  "",
  "Nobody has decided who rings them.",
].join("\n");

/** SPEC-022. The bible is ungated, so these tests are the accept gate's replacement. */
describe("the world bible (SPEC-022)", () => {
  describe("splitting and applying, without a world", () => {
    it("keeps prose written above the first heading", () => {
      // Unlike a sheet, which refuses one. A bible is a blank page somebody types into, and the
      // app has no business telling them to open with a heading.
      const outline = splitBible(OPENING);
      assert.equal(outline.preamble, "This world is about being owed something by the sea.");
      assert.deepEqual(
        outline.sections.map((s) => s.heading),
        ["The tides", "The bells"],
      );
    });

    it("round-trips a document that was never touched", () => {
      const { text } = applyBibleEdits(OPENING, []);
      assert.equal(splitBible(text).sections.length, 2);
      assert.match(text, /## The tides/);
    });

    it("replaces one section and leaves the rest exactly as it was", () => {
      const { text, headings } = applyBibleEdits(OPENING, [
        { op: "set-section", heading: "The tides", text: "Rewritten." },
      ]);
      const outline = splitBible(text);
      assert.deepEqual(headings, ["The tides"]);
      assert.equal(outline.sections[0]!.body, "Rewritten.");
      // The whole point of section-scoped edits: everything the model was not thinking about is
      // byte-identical, rather than paraphrased on the way through.
      assert.equal(outline.sections[1]!.body, "Nobody has decided who rings them.");
      assert.equal(outline.preamble, "This world is about being owed something by the sea.");
    });

    it("adds a section when set-section names a heading that is not there", () => {
      const { text } = applyBibleEdits(OPENING, [
        { op: "set-section", heading: "The Ebb Council", text: "They meet in winter." },
      ]);
      const outline = splitBible(text);
      assert.deepEqual(
        outline.sections.map((s) => s.heading),
        ["The tides", "The bells", "The Ebb Council"],
      );
    });

    it("matches a heading ignoring case and surrounding space", () => {
      const { text } = applyBibleEdits(OPENING, [
        { op: "append-to-section", heading: "  the TIDES ", text: "Maren counts in them." },
      ]);
      assert.match(splitBible(text).sections[0]!.body, /clock and its accountant\.\n\nMaren counts in them\./);
      assert.equal(splitBible(text).sections.length, 2, "matched rather than adding a second one");
    });

    it("refuses to guess when append-to-section names a heading that is gone", () => {
      // Never resolved to "near enough": a heading that moved means the model is editing a
      // document it no longer has, and a guess writes somebody's notes where they did not ask.
      assert.throws(
        () => applyBibleEdits(OPENING, [{ op: "append-to-section", heading: "The tide", text: "x" }]),
        BibleEditError,
      );
    });

    it("refuses to remove a section that is not there", () => {
      assert.throws(
        () => applyBibleEdits(OPENING, [{ op: "remove-section", heading: "The wharf" }]),
        BibleEditError,
      );
    });

    it("applies nothing at all when a later edit in the batch fails", () => {
      // All-or-nothing, like the turn carrying it: a reply saying "I've noted both" must not land
      // beside a bible that took only the first.
      const edits: BibleEdit[] = [
        { op: "set-section", heading: "The tides", text: "First edit landed." },
        { op: "remove-section", heading: "Not a real heading" },
      ];
      assert.throws(() => applyBibleEdits(OPENING, edits), BibleEditError);
      // The pure function throws before returning, so the caller still holds the original text —
      // which is what the runner commits from.
      assert.equal(splitBible(OPENING).sections[0]!.body, "The tide is the world's clock and its accountant.");
    });

    it("replaces the whole document when asked to", () => {
      const { text, headings } = applyBibleEdits(OPENING, [
        { op: "replace-document", text: "## Only this\n\nStarting again." },
      ]);
      assert.deepEqual(headings, ["the whole bible"]);
      assert.equal(splitBible(text).sections.length, 1);
    });
  });

  describe("on disk", () => {
    it("reads a world that has no bible as empty rather than broken", async () => {
      // Every world made before this feature is in this state, and none of them is damaged.
      const dir = await makeTempWorld();
      const bible = await readBible(dir);
      assert.equal(bible.present, false);
      assert.equal(bible.text, "");
      const store = await WorldStore.open(dir, { clock: CLOCK });
      try {
        assert.equal(store.getBundle().bible.present, false);
        assert.equal(store.getBundle().problems.length, 0, "an absent bible is not a problem");
      } finally {
        await store.close();
      }
    });

    it("reads a hand-written bible that has no frontmatter at all", async () => {
      const dir = await makeTempWorld();
      await writeFile(join(dir, "bible.md"), "Just prose. No YAML anywhere.\n", "utf8");
      const bible = await readBible(dir);
      assert.equal(bible.present, true);
      assert.match(bible.text, /Just prose/);
      assert.equal(bible.version, 1);
    });

    it("cuts a version and a history snapshot on every save", async () => {
      // This is the whole safety model: no approval step, but nothing is ever only in one place.
      const dir = await makeTempWorld();
      const store = await WorldStore.open(dir, { clock: CLOCK });
      try {
        const first = await saveBible(store, OPENING, { source: "editor" });
        assert.equal(first.toVersion, 1);

        const second = await saveBible(store, `${OPENING}\n\nA second thought.`, { source: "editor" });
        assert.equal(second.fromVersion, 1);
        assert.equal(second.toVersion, 2);

        const snapshot = await readFile(join(dir, ".history", "bible", "v1.md"), "utf8");
        assert.match(snapshot, /clock and its accountant/);
        assert.doesNotMatch(snapshot, /A second thought/, "v1 is what v1 said");

        const changes = await readFile(join(dir, "changes.jsonl"), "utf8");
        assert.match(changes, /"entity":"bible"/);
      } finally {
        await store.close();
      }
    });

    it("restores an earlier version as a new one, losing nothing in between", async () => {
      const dir = await makeTempWorld();
      const store = await WorldStore.open(dir, { clock: CLOCK });
      try {
        await saveBible(store, "## One\n\nFirst.", { source: "editor" });
        await saveBible(store, "## One\n\nSecond.", { source: "editor" });
        await saveBible(store, "## One\n\nThird.", { source: "editor" });

        await restoreBible(store, 1, "editor");
        const now = await readBible(dir);
        assert.match(now.text, /First\./);
        assert.equal(now.version, 4, "restore moves forward; it never rewrites history");
        // The versions it skipped past are still there to go back to.
        assert.match(await readFile(join(dir, ".history", "bible", "v3.md"), "utf8"), /Third\./);
      } finally {
        await store.close();
      }
    });

    it("refuses a save written against a version that has since moved", async () => {
      const dir = await makeTempWorld();
      const store = await WorldStore.open(dir, { clock: CLOCK });
      try {
        await saveBible(store, "## One\n\nFirst.", { source: "editor" });
        await saveBible(store, "## One\n\nSecond.", { source: "editor" });
        // An editor that loaded v1 and has been typing ever since. Refusing is the only honest
        // outcome — the app cannot know which of the two versions was meant.
        await assert.rejects(
          () => saveBible(store, "## One\n\nFrom a stale editor.", { source: "editor", baseVersion: 1 }),
          BibleStaleError,
        );
        assert.match((await readBible(dir)).text, /Second\./);
      } finally {
        await store.close();
      }
    });
  });

  describe("edits from a turn", () => {
    it("applies them, versions them, and reports what it touched", async () => {
      const dir = await makeTempWorld();
      const store = await WorldStore.open(dir, { clock: CLOCK });
      try {
        await saveBible(store, OPENING, { source: "editor" });
        const record = await applyTurnBibleEdits(
          store,
          [{ op: "append-to-section", heading: "The bells", text: "Maren thinks it is the tide." }],
          { source: "world-chat", baseVersion: 1 },
        );
        assert.ok(record);
        assert.deepEqual(record.headings, ["The bells"]);
        assert.equal(record.fromVersion, 1);
        assert.equal(record.toVersion, 2);
        assert.match((await readBible(dir)).text, /Maren thinks it is the tide/);
      } finally {
        await store.close();
      }
    });

    it("does nothing, and says so, for a turn with no edits", async () => {
      const dir = await makeTempWorld();
      const store = await WorldStore.open(dir, { clock: CLOCK });
      try {
        assert.equal(await applyTurnBibleEdits(store, [], { source: "world-chat", baseVersion: 1 }), null);
      } finally {
        await store.close();
      }
    });

    it("refuses when the author edited the bible while the model was answering", async () => {
      const dir = await makeTempWorld();
      const store = await WorldStore.open(dir, { clock: CLOCK });
      try {
        await saveBible(store, OPENING, { source: "editor" });
        await saveBible(store, `${OPENING}\n\n## Added by hand\n\nWhile it was thinking.`, {
          source: "editor",
        });
        // The turn read v1; the file is v2. Merging would silently drop what they just typed.
        await assert.rejects(
          () =>
            applyTurnBibleEdits(store, [{ op: "set-section", heading: "The tides", text: "x" }], {
              source: "world-chat",
              baseVersion: 1,
            }),
          BibleStaleError,
        );
        assert.match((await readBible(dir)).text, /While it was thinking/);
      } finally {
        await store.close();
      }
    });

    it("leaves the file untouched when one edit in the batch cannot be applied", async () => {
      const dir = await makeTempWorld();
      const store = await WorldStore.open(dir, { clock: CLOCK });
      try {
        await saveBible(store, OPENING, { source: "editor" });
        await assert.rejects(
          () =>
            applyTurnBibleEdits(
              store,
              [
                { op: "set-section", heading: "The tides", text: "Landed." },
                { op: "remove-section", heading: "Nowhere" },
              ],
              { source: "world-chat", baseVersion: 1 },
            ),
          BibleEditError,
        );
        const after = await readBible(dir);
        assert.equal(after.version, 1, "no version was cut");
        assert.doesNotMatch(after.text, /Landed\./, "the first edit did not land on its own");
      } finally {
        await store.close();
      }
    });
  });

  describe("hand-edits while the world is open", () => {
    it("tells its owner it adopted, so the screen is not left holding older text", async () => {
      // Found by running it: the store took the new bytes and nothing downstream knew, so the
      // editor went on showing text the author had replaced minutes earlier, with no way to
      // tell why. Adopting silently means silent to the *user*, not silent to the coordinator.
      const dir = await makeTempWorld();
      let adopted = 0;
      const store = await WorldStore.open(dir, { clock: CLOCK, events: { onAdopted: () => adopted++ } });
      try {
        await saveBible(store, OPENING, { source: "editor" });
        await new Promise((resolve) => setTimeout(resolve, 900));

        await writeFile(join(dir, "bible.md"), "---\nversion: 1\n---\n\n## The tides\n\nMoved.\n", "utf8");
        await until(() => adopted > 0, "the adopted event to fire");
        assert.match(store.getBundle().bible.text, /Moved\./);
      } finally {
        await store.close();
      }
    });

    it("adopts a hand-edit made while the world is open", async () => {
      // `bible.md` is the one authored file the product invites into a text editor, and taking
      // its new bytes is the only thing the watcher still does. R-28's reconciliation stays out
      // of its way for the same reason.
      const dir = await makeTempWorld();
      const store = await WorldStore.open(dir, { clock: CLOCK });
      try {
        await saveBible(store, OPENING, { source: "editor" });
        // The watcher stays suppressed for a beat after the app's own write, so that events for
        // our own renames do not read as somebody else's. A hand-edit made inside that window is
        // genuinely invisible — which is fine in life, where nobody types that fast, and has to
        // be waited out here rather than asserted around.
        await new Promise((resolve) => setTimeout(resolve, 900));

        await writeFile(
          join(dir, "bible.md"),
          "---\nversion: 1\n---\n\n## The tides\n\nTyped straight into VS Code.\n",
          "utf8",
        );
        await until(
          () => /VS Code/.test(store.getBundle().bible.text),
          "the hand-edited bible to be adopted",
        );
      } finally {
        await store.close();
      }
    });
  });
});
