import assert from "node:assert/strict";
import { it } from "node:test";
import { AudiobookBookSchema, audiobookDirectionHash, audiobookNoteFor, audiobookTakeDirectionHash, performanceNote, type CadencePlan, type ManifestModel } from "../src/index.js";

// One narrator performs the cast, and a narrator for the book (SPEC-047 R-44..R-46).
const plan: CadencePlan = { schemaVersion: 1, sourceTextHash: `sha256:${"a".repeat(64)}`, delivery: "measured", speed: 1, cues: [] };

it("a take's direction names the note under performed, and is the same name as before without one (R-45)", () => {
  assert.equal(audiobookTakeDirectionHash(null), undefined, "no plan, no note: no direction");
  assert.equal(audiobookTakeDirectionHash(plan), audiobookDirectionHash(plan), "every take made before notes stays current");
  const noted = audiobookTakeDirectionHash(plan, "low, clipped");
  assert.notEqual(noted, audiobookDirectionHash(plan));
  assert.notEqual(noted, audiobookTakeDirectionHash(plan, "flat, far off"), "a note changed is another take");
  assert.notEqual(audiobookTakeDirectionHash(null, "low, clipped"), undefined, "a note alone directs the line");
});

it("a line's note is its speaker's under performed only, and narration takes none (R-44)", () => {
  const book = { reading: "performed" as const, notes: { "maren-kest": "low, clipped", "Tam Rusk": "quick" } };
  assert.equal(audiobookNoteFor(book, { speaker: "Maren Kest", sheet: "maren-kest" }), "low, clipped");
  assert.equal(audiobookNoteFor(book, { speaker: "Tam Rusk" }), "quick", "a name no sheet carries");
  assert.equal(audiobookNoteFor(book, {}), undefined, "narration");
  assert.equal(audiobookNoteFor({ ...book, reading: "narrator" }, { speaker: "Maren Kest", sheet: "maren-kest" }), undefined);
  assert.equal(audiobookNoteFor({ ...book, reading: "cast" }, { speaker: "Maren Kest", sheet: "maren-kest" }), undefined);
});

it("a note is played through the row's phrase path, or cannot be (R-45)", () => {
  const cadence = (phrase?: "best-effort-tag" | "best-effort-instruction", tagSyntax?: "paren") =>
    ({ cadence: { deliveries: ["measured"], speed: null, pause: "unsupported", emphasis: "unsupported", breath: "unsupported", outputTimestamps: "none", deliveryMappings: { measured: { settings: {} } }, ...(phrase ? { phrase } : {}), ...(tagSyntax ? { tagSyntax } : {}) } }) as Pick<ManifestModel, "cadence">;
  assert.deepEqual(performanceNote("low", cadence("best-effort-tag")), { mode: "tag", tag: "[low]" });
  assert.deepEqual(performanceNote("low", cadence("best-effort-tag", "paren"), "en"), { mode: "tag", tag: "(low)" });
  assert.equal(performanceNote("low", cadence("best-effort-tag", "paren")).mode, "unsupported", "a paren tag waits for a line stated English");
  assert.deepEqual(performanceNote("low", cadence("best-effort-instruction")), { mode: "instruction" });
  assert.deepEqual(performanceNote("low", cadence()), { mode: "unsupported", reason: "no phrase" });
});

it("the book record carries performed, notes of at most 60 characters, and its own narrator (R-44, R-46)", () => {
  const ok = AudiobookBookSchema.safeParse({ schemaVersion: 1, reading: "performed", notes: { "maren-kest": "low, clipped" }, narrator: { provider: "kokoro", model: "kokoro-82m", voiceId: "af_heart", label: "Heart" } });
  assert.ok(ok.success);
  assert.ok(!AudiobookBookSchema.safeParse({ schemaVersion: 1, reading: "performed", notes: { "maren-kest": "x".repeat(61) } }).success);
});
