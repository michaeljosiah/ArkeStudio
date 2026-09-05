import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import type { AudioRightsEvent } from "@arke-studio/contracts";
import { appendAudioRights, readAudioRights, effectiveAudioRights } from "../../src/audio/rights.js";
import { cachedAudioTranscript } from "../../src/audio/transcript-comparison.js";
import { audioHash } from "../../src/audio/qc.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { wav } from "./helpers.js";

it("rights append and withdrawal preserve history; damaged logs fail closed", async t => {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir); t.after(() => store.close());
  const hash = `sha256:${"a".repeat(64)}`;
  const ack: AudioRightsEvent = { schemaVersion: 1, action: "acknowledge", audioHash: hash, id: "ack", basis: "self",
    scopes: ["cloud-reference-upload"], statementVersion: 1, at: "2026-09-05T12:00:00Z" };
  assert.deepEqual(await readAudioRights(store), []);
  await appendAudioRights(store, ack); await appendAudioRights(store, ack);
  assert.equal((await readAudioRights(store)).length, 1);
  await appendAudioRights(store, { schemaVersion: 1, action: "withdraw", audioHash: hash, acknowledgementId: "ack", at: "2026-09-05T12:01:00Z" });
  const events = await readAudioRights(store);
  assert.equal(events.length, 2);
  assert.equal(effectiveAudioRights(events, hash, "cloud-reference-upload").length, 0);
  const path = join(dir, "audio/rights.jsonl"), intact = await readFile(path, "utf8");
  await writeFile(path, `${intact}{"action":"withdraw"`);
  await assert.rejects(readAudioRights(store), /rights-unavailable/);
  await assert.rejects(appendAudioRights(store, { ...ack, id: "another" }), /rights-unavailable/);
});
it("local transcript cache needs no rights and is reused only for matching text and engine", async t => {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir); t.after(() => store.close());
  const bytes = wav([1000, -1000]); let calls = 0;
  const input = { bytes, expectedHash: audioHash(bytes), authoredText: "Hello there", transcriber: {
    id: "local-test", version: "1", async transcribe() { calls++; return "Hello there"; } } };
  const first = await cachedAudioTranscript(store, input);
  assert.deepEqual(await cachedAudioTranscript(store, input), first);
  assert.equal(calls, 1);
  await cachedAudioTranscript(store, { ...input, authoredText: "New wording" });
  assert.equal(calls, 2);
  const absent = await cachedAudioTranscript(store, { ...input, transcriber: null });
  assert.equal(absent.status, "unavailable");
  assert.deepEqual(await readAudioRights(store), []);
});
