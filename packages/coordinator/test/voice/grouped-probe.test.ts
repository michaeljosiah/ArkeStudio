import assert from "node:assert/strict";
import { it } from "node:test";
import { quoteGroupedSpeech, type Job, type SpeechTurn } from "@arke-studio/contracts";
import { geminiSpeechModel } from "@arke-studio/providers";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import { failureStatus, probeGroupedRead, probeWindow, type GroupedProbeDeps, type ProbeBlock } from "../../src/voice/grouped-probe.js";

// Design turn 185, amended: the same blocks read as one request three ways, for a person to choose by ear.
function wav(seconds: number): Uint8Array {
  const data = seconds * 48_000;
  const bytes = Buffer.alloc(44 + data);
  bytes.write("RIFF"); bytes.writeUInt32LE(36 + data, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(data, 40);
  return new Uint8Array(bytes);
}

const NOTES = "Nigerian English, unhurried and close.";
const reader = { provider: "google", model: "gemini-3.8-flash-tts", voiceId: "designed:dv_01J8F3K2QW9VZX4N7M0RTYB6HC:1", label: "Ife's voice" };
const blocks: ProbeBlock[] = [
  { key: "p1.0", who: "narration", text: "Tunde was telling the goat story again.", turns: { shared: NOTES, parts: [{ text: "Tunde was telling the goat story again." }] } },
  { key: "p2.0", who: "Tunde", text: "“Ade, I am telling you.”", turns: { shared: NOTES, parts: [{ text: "“Ade, I am telling you.”", style: "Tunde: loud, delighted." }] } },
  { key: "p3.0", who: "narration", text: "Nobody believed him.", turns: { shared: NOTES, parts: [{ text: "Nobody believed him." }] } },
  { key: "p4.0", who: "narration", text: "Ade stood up.", turns: { shared: NOTES, parts: [{ text: "Ade stood up." }] } },
];
const job = (over: Partial<Job>): Job => ({ id: "jb_1", status: "succeeded", landedFiles: [".staging/probes/x.wav"], error: null, ...over }) as unknown as Job;

function deps(over: Partial<GroupedProbeDeps> = {}): GroupedProbeDeps & { sent: EnqueueInput[] } {
  const sent: EnqueueInput[] = [];
  return {
    sent,
    worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
    productionId: "na-love-or-juju",
    reader,
    model: geminiSpeechModel("flash"),
    blocks,
    at: "2026-10-03T08:00:00.000Z",
    enqueue: async (input) => { sent.push(input); return `jb_${sent.length}`; },
    waitForJob: async (jobId) => job({ id: jobId, landedFiles: [`.staging/probes/${jobId}.wav`] }),
    readLanded: async () => wav(9),
    transcribe: async () => " Tunde was telling the goat story again. Ade, I am telling you. Nobody believed him. Ade stood up. ",
    actualCost: async () => 1_234,
    ...over,
  };
}

it("reads the same blocks as three requests: full style, notes once with deltas, and same-direction runs merged", async () => {
  const probe = deps();
  const result = await probeGroupedRead(probe);
  assert.equal(probe.sent.length, 3, "one request a variant");
  const turns = probe.sent.map((input) => input.params["turns"] as SpeechTurn[]);
  assert.deepEqual(turns[0]!.map((turn) => turn.instructions), [NOTES, `${NOTES} Tunde: loud, delighted.`, NOTES, NOTES], "A: every turn its whole style");
  assert.deepEqual(turns[1]!.map((turn) => turn.instructions), [NOTES, "Tunde: loud, delighted.", undefined, undefined], "B: the notes once");
  assert.deepEqual(turns[2]!.map((turn) => turn.text), [blocks[0]!.text, blocks[1]!.text, "Nobody believed him.\nAde stood up."], "C: a run under one direction is one turn");
  for (const [index, input] of probe.sent.entries()) {
    assert.equal(input.params["text"], turns[index]!.map((turn) => turn.text).join(" "));
    assert.equal(input.params["voiceId"], reader.voiceId);
    assert.equal(input.params["hear"], true, "kept out of a run's search for paid parts");
    assert.equal(input.estimatedMicroUsd, quoteGroupedSpeech(geminiSpeechModel("flash"), turns[index]!, { at: "2026-10-03T08:00:00.000Z" }).expectedMicroUsd);
    assert.equal(input.landing?.dir, ".staging/probes/20261003080000");
  }
  assert.deepEqual(probe.sent.map((input) => input.landing?.name), ["A-full.wav", "B-deltas.wav", "C-merged.wav"]);
  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(result.blocks.map((block) => block.who), ["narration", "Tunde", "narration", "narration"]);
  for (const variant of result.variants) {
    assert.equal(variant.httpStatus, 200);
    assert.equal(variant.seconds, 9);
    assert.match(variant.transcript!, /^Tunde was .* Ade stood up\.$/);
    assert.equal(variant.costMicroUsd, 1_234);
  }
});

it("stops at a failure with its status, says a missing transcriber, and refuses a reader that is not Gemini before sending", async () => {
  const failing = deps({ waitForJob: async (jobId) => job({ id: jobId, status: "failed", landedFiles: [], error: "Google's daily request limit was reached for this key (HTTP 429 daily quota)" }) });
  const failed = await probeGroupedRead(failing);
  assert.equal(failing.sent.length, 1, "a refusal for the day is not met twice more");
  assert.equal(failed.outcome, "failed");
  assert.deepEqual(failed.variants.map((variant) => variant.outcome), ["failed", "not sent", "not sent"]);
  assert.equal(failed.variants[0]!.httpStatus, 429);
  const unheard = await probeGroupedRead(deps({ transcribe: null }));
  assert.equal(unheard.outcome === "refused" ? "" : unheard.variants[0]!.transcriptUnavailable, "no local transcriber");
  const kokoro = deps({ model: null });
  assert.equal((await probeGroupedRead(kokoro)).outcome, "refused");
  assert.equal(kokoro.sent.length, 0);
  assert.equal(failureStatus("no status here"), undefined);
});

it("picks the first run after the title holding a line and narration, or the run from the block named", () => {
  const plan = [{ key: "title" }, { key: "p0.0" }, { key: "p1.0" }, { key: "p2.0" }, { key: "p3.0", speaker: "Tunde" }, { key: "p4.0" }];
  assert.deepEqual(probeWindow(plan, 3), ["p1.0", "p2.0", "p3.0"]);
  assert.deepEqual(probeWindow(plan, 2, "p4.0"), ["p4.0"]);
  assert.deepEqual(probeWindow(plan, 3, "nope"), []);
});
