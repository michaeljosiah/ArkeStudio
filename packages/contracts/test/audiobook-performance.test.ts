import assert from "node:assert/strict";
import { test } from "node:test";
import { compileAudiobookPerformance, AudiobookBookSchema, ClientMessageSchema, performanceNote, recogniseDirection, groupReads, groupedText, type ManifestModel } from "../src/index.js";

const model: ManifestModel = { id: "eleven_v4", provider: "elevenlabs", capability: "voice-tts", displayName: "Eleven v4",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: { maxPromptChars: 10000, audioFormat: "wav" }, pricing: { kind: "perCharacter", microUsdPerCharacter: 80 },
  cadence: { deliveries: ["measured"], speed: null, pause: "best-effort-audio-tag", breath: "best-effort-audio-tag", emphasis: "best-effort-capitalization", outputTimestamps: "none", phrase: "best-effort-tag", tagChars: 160, groupable: true, deliveryMappings: { measured: { settings: {} } } } };

test("performed dialogue preserves a single narrator and restores narration within a paragraph", () => {
  const note = "male narrator imitating a British woman, slight pitch lift, retain male timbre";
  const rows = [{ text: "“Copy,”", speaker: "Mag" }, { text: "she said." }, { text: "“Copy.”", speaker: "Mag" }];
  const book = AudiobookBookSchema.parse({ schemaVersion: 1, reading: "performed", notes: { Mag: note } });
  const result = compileAudiobookPerformance({ key: "p0.0", paragraph: 0, text: rows.map(r => r.text).join(" "), rows }, book, null, model)!;
  assert.match(result.text, /retain male timbre\] “Copy,” \[same narrator, natural narration, original voice and accent\] she said\./);
  assert.equal(result.text.split(note).length - 1, 2);
  assert.equal(result.text.replace(/\[[^\]]*\]\s*/g, ""), rows.map(r => r.text).join(" "));
  assert.equal(result.noteHeld, false);
  assert.equal(compileAudiobookPerformance({ key: "p0.0", paragraph: 0, text: "Hello." }, { ...book, reading: "narrator" }, null, model), null);
});

test("character briefs retain all clauses without oversized tags or silent truncation", () => {
  const note = `${"calm ".repeat(23).trim()}; ${"steady ".repeat(20).trim()}`;
  const result = performanceNote(note, model);
  assert.equal(result.mode, "tag");
  if (result.mode !== "tag") return;
  assert.equal(result.tag.replace(/\[|\]/g, ""), note);
  assert.ok([...result.tag.matchAll(/\[([^\]]+)\]/g)].every(m => m[1]!.length <= 160));
  assert.equal(performanceNote("x".repeat(161), model).mode, "unsupported");
  assert.ok(!AudiobookBookSchema.safeParse({ schemaVersion: 1, notes: { Mag: "x".repeat(301) } }).success);
  assert.ok(ClientMessageSchema.safeParse({ kind: "set-audiobook-note", worldId: "01J8F3K2QW9VZX4N7M0RTYB6H1", productionId: "book-one", speaker: "Mag", note: "x".repeat(300) }).success);
});

test("character turns must match source words rather than guessing attribution", () => {
  assert.throws(() => compileAudiobookPerformance({ key: "p0.0", paragraph: 0, text: "Different words.", rows: [{ text: "Old words." }] }, { reading: "performed" }, null, model), /cast it again/);
});

test("turn-local compilation keeps pauses and emphasis on the source words", () => {
  const text = "Wait. Move now.";
  const result = compileAudiobookPerformance({ key: "p0.0", paragraph: 0, text,
    rows: [{ text: "Wait.", speaker: "Jace" }, { text: "Move now." }] },
  { reading: "performed", notes: { Jace: "quiet, controlled" } }, {
    schemaVersion: 1, sourceTextHash: `sha256:${"0".repeat(64)}`, speed: 1,
    cues: [{ kind: "pause", at: 5, length: "long" },
      { kind: "emphasis", span: { from: 6, to: 10, text: "Move" }, level: "strong" }],
  }, model)!;
  assert.match(result.text, /Wait\.\s*\[long pause\].*original voice and accent\] MOVE now\./);
  assert.equal(result.text.split("[long pause]").length, 2);
  assert.deepEqual(result.held, []);
});

test("emotions become structured span direction, not spoken bracket text", () => {
  const parsed = recogniseDirection("[curious] Who is there? [snorts] No one.");
  assert.equal(parsed.text, "Who is there? No one.");
  assert.ok(parsed.cues.some(c => c.kind === "delivery" && c.phrase === "curious"));
  assert.ok(parsed.cues.some(c => c.kind === "sound" && c.sound === "snorts"));
});

test("grouping accounts for every compiled tag and paragraph separator", () => {
  const blocks = Array.from({ length: 6 }, (_, n) => ({ key: String(n), reader: "calen", parts: [{ text: `[curious] ${"x".repeat(3000)}` }], maxCharacters: 10000 }));
  const groups = groupReads(blocks);
  assert.deepEqual(groups.map(g => g.keys.length), [3, 3]);
  assert.ok(groups.every(g => groupedText(g.turns).length <= 10000));
  assert.match(groupedText(groups[0]!.turns), /\n\n/);
});
