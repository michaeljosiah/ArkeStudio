import assert from "node:assert/strict";
import { it } from "node:test";
import { AGENT_MEDIA_TOOL_CATALOG } from "../../src/world-chat/media-tool-catalog.js";

/**
 * What the measurement tools tell Arke about their own limits (design turn 286). Tested on 0.5.127:
 * asked whether ten shots were ready, Arke judged the cuts from the contact sheet's middle frames,
 * and called three slow, dark shots stills because the export review gave them no motion figures.
 */
const describe = (name: string) => AGENT_MEDIA_TOOL_CATALOG.find((tool) => tool.name === name)!.description;

it("the contact sheet says a middle frame shows no cut", () => {
  assert.match(describe("cut_contact_sheet"), /A middle frame shows no cut: to judge whether a cut matches, sample_video either side of it/);
});

it("the export review says a shot with no motion figures is not proof of a still", () => {
  assert.match(describe("review_export"), /not proof of a still: look before saying a shot does not move/);
});

/*
 * What the speech tools say of how they read and what a read costs. On film sound they refused
 * almost every window, each refusal took one of the turn's four speech calls, and nothing told
 * Arke how many it had: it reviewed a scene deaf.
 */
it("the speech tools name the three ways a stretch is read, and that a refused or voiceless read uses no speech read", () => {
  const transcribe = describe("transcribe_audio"), review = describe("review_audio_content");
  for (const read of ["timed", "text-only", "silent"]) { assert.match(transcribe, new RegExp(`\\b${read}\\b`)); assert.match(review, new RegExp(`\\b${read}\\b`)); }
  assert.match(transcribe, /Sound outside the stretches is not read/); assert.match(transcribe, /No stretches means no voice was found/);
  assert.match(transcribe, /Four speech reads a run: a refused read, or one that finds no voice, uses none/);
  assert.match(review, /A refused read, or one that finds no voice, uses no speech read/);
  assert.match(transcribe, /Every media result and refusal says what remains of the run's speech, media, listening and image budgets/);
});

it("video sampling says it samples what the image budget has left, and refuses without a media call when it has none", () => {
  assert.match(describe("sample_video"), /with fewer images left than asked for it samples as many as are left across the interval and says so, and with none left it refuses without using a media call/);
});
