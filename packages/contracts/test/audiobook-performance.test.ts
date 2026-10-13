import assert from "node:assert/strict";
import { test } from "node:test";
import { compileAudiobookPerformance, AudiobookBookSchema, ClientMessageSchema, performanceNote, recogniseDirection, groupReads, groupedText, packTurns, type ManifestModel } from "../src/index.js";

const model: ManifestModel = { id: "eleven_v4", provider: "elevenlabs", capability: "voice-tts", displayName: "Eleven v4",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: { maxPromptChars: 10000, audioFormat: "wav" }, pricing: { kind: "perCharacter", microUsdPerCharacter: 80 },
  cadence: { deliveries: ["measured"], speed: null, pause: "best-effort-audio-tag", breath: "best-effort-audio-tag", emphasis: "best-effort-capitalization", outputTimestamps: "none", phrase: "best-effort-tag", tagChars: 160, groupable: true, deliveryMappings: { measured: { settings: {} } } } };

test("performed dialogue preserves a single narrator and restores narration within a paragraph", () => {
  const note = "male narrator imitating a British woman, slight pitch lift, retain male timbre";
  const rows = [{ text: "“Copy,”", speaker: "Mag" }, { text: "she said." }, { text: "“Copy.”", speaker: "Mag" }];
  const book = AudiobookBookSchema.parse({ schemaVersion: 1, reading: "performed", notes: { Mag: note } });
  const result = compileAudiobookPerformance({ key: "p0.0", paragraph: 0, text: rows.map(r => r.text).join(" "), rows }, book, null, model)!;
  assert.match(result.text, /retain male timbre\] “Copy,” \[natural narration, original voice and accent\] she said\./);
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
  assert.ok(ClientMessageSchema.safeParse({ kind: "set-sheet-narration", worldId: "01J8F3K2QW9VZX4N7M0RTYB6H1", path: "characters/mag.md", narration: "x".repeat(300) }).success);
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

test("an oversized character turn splits source words and restores its identity in each request", () => {
  const text = "Hold position. ".repeat(1000).trim();
  const result = compileAudiobookPerformance({ key: "p0.0", paragraph: 0, text, speaker: "Jace" },
    { reading: "performed", notes: { Jace: "quiet, controlled" } }, null,
    { ...model, limits: { ...model.limits, maxPromptChars: 1200 } })!;
  assert.ok(result.parts.length > 1);
  assert.ok(result.parts.every(part => part.length <= 1200 && part.startsWith("[same narrator throughout] [quiet, controlled]")));
  assert.equal(result.parts.map(part => part.replace(/\[[^\]]*\]\s*/g, "")).join(" "), text);
});

test("grouping accounts for every compiled tag and paragraph separator", () => {
  const blocks = Array.from({ length: 6 }, (_, n) => ({ key: String(n), reader: "calen", parts: [{ text: `[curious] ${"x".repeat(3000)}` }], maxCharacters: 10000 }));
  const groups = groupReads(blocks);
  assert.deepEqual(groups.map(g => g.keys.length), [3, 3]);
  assert.ok(groups.every(g => groupedText(g.turns).length <= 10000));
  assert.match(groupedText(groups[0]!.turns), /\n\n/);
});

 test("a mid-row whisper retains its marker, resets delivery and keeps character identity", () => {
  const text = "Hold. Stay quiet. Move.";
  const whispered: ManifestModel = { ...model, cadence: { ...model.cadence!, deliveries: ["measured", "whispered"], deliveryMappings: { measured: { settings: {} }, whispered: { settings: {}, tag: "whispers" } } } };
  const result = compileAudiobookPerformance({ key: "p0.0", paragraph: 0, text, speaker: "Jace" },
    { reading: "performed", notes: { Jace: "low, controlled" } }, { schemaVersion: 1, sourceTextHash: `sha256:${"0".repeat(64)}`, speed: 1, delivery: "measured",
      cues: [{ kind: "delivery", span: { from: 6, to: 17, text: "Stay quiet." }, delivery: "whispered" }, { kind: "pause", at: 17, length: "short" }] }, whispered)!;
  assert.match(result.text, /\[whispers\] Stay quiet\./);
  assert.match(result.text, /\[normal speaking voice\] Move\./);
  assert.equal(result.text.split("[low, controlled]").length - 1, 3);
  assert.equal(result.text.split("[short pause]").length - 1, 1);
  assert.equal(result.text.replace(/\[[^\]]*\]\s*/g, ""), text);
  assert.deepEqual(result.held, []);
});


test("grouped performed requests carry context once and identity only at changes, preserving paragraphs", () => {
  const book = { reading: "performed" as const, notes: { Jace: "lower British register", Mag: "male narrator, slight pitch lift" } };
  const source = [
    { key: "p0.0", paragraph: 0, text: "First paragraph." },
    { key: "p1.0", paragraph: 1, text: "Second paragraph." },
    { key: "p2.0", paragraph: 2, text: "Hold.", speaker: "Jace" },
    { key: "p3.0", paragraph: 3, text: "Stay.", speaker: "Jace" },
    { key: "p4.0", paragraph: 4, text: "She nodded. Copy.", rows: [{ text: "She nodded." }, { text: "Copy.", speaker: "Mag" }] },
    { key: "p5.0", paragraph: 5, text: "Then silence." },
  ];
  const blocks = source.map(block => {
    const compiled = compileAudiobookPerformance(block, book, null, model, { book: "natural American narration", chapter: "restrained tension" })!;
    return { key: block.key, reader: "calen", parts: compiled.parts.map((text, i) => ({ text, performance: compiled.passages[i] })) };
  });
  const actual = groupedText(packTurns(blocks, "deltas"));
  assert.equal(actual, "[same narrator throughout] [natural American narration] [restrained tension] First paragraph.\n\nSecond paragraph.\n\n[lower British register] Hold.\n\nStay.\n\n[natural American narration] She nodded. [male narrator, slight pitch lift] Copy.\n\n[natural American narration] Then silence.");
  const scoped = groupedText(packTurns(blocks.slice(3, 5), "deltas"));
  assert.ok(scoped.startsWith("[same narrator throughout] [natural American narration] [restrained tension] [lower British register] Stay."), "a middle-only request reestablishes the narrator and current character");
  const groups = groupReads(blocks.map(b => ({ ...b, maxCharacters: 220 })));
  assert.ok(groups.length > 1);
  assert.ok(groups.every(g => groupedText(g.turns).length <= 220));
  assert.ok(groups.every(g => groupedText(g.turns).startsWith("[same narrator throughout] [natural American narration] [restrained tension]")));
});


test("temporary delivery resets at a grouped paragraph boundary even for the same speaker", () => {
  const reader = { ...model, cadence: { ...model.cadence!, deliveries: ["measured", "whispered"], deliveryMappings: { measured: { settings: {} }, whispered: { settings: {}, tag: "whispers" } } } };
  const book = { reading: "performed" as const, notes: { Jace: "lower British register" } };
  const first = compileAudiobookPerformance({ key: "a", paragraph: 0, text: "Quiet.", speaker: "Jace" }, book,
    { schemaVersion: 1, sourceTextHash: `sha256:${"0".repeat(64)}`, speed: 1, delivery: "whispered", cues: [] }, reader)!;
  const second = compileAudiobookPerformance({ key: "b", paragraph: 1, text: "Move.", speaker: "Jace" }, book, null, reader)!;
  const text = groupedText(packTurns([first, second].map((p, i) => ({ key: String(i), reader: "calen", parts: p.parts.map((text, j) => ({ text, performance: p.passages[j] })) })), "deltas"));
  assert.equal(text, "[same narrator throughout] [lower British register] [whispers] Quiet.\n\n[normal speaking voice] [lower British register] Move.");
});
