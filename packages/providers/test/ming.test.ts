import assert from "node:assert/strict";
import { it } from "node:test";
import { MingClient, type MingSynthesis } from "../src/clients/ming.js";
import type { SubmitRequest } from "../src/types.js";

function wav(): Uint8Array { const bytes = Buffer.alloc(48); bytes.write("RIFF"); bytes.write("WAVE", 8); return bytes; }
const request = (): SubmitRequest => ({model: "ming-3-0.5b", capability: "voice-tts", params: {text: "Come home.", language: "en"},
  voiceReference: {name: "hash.wav", contentType: "audio/wav", data: wav(), transcript: "The words in this recording."}});

it("sends exact voice bytes, reference words and separate direction to the local host", async () => {
  let seen: Parameters<MingSynthesis["synthesize"]>[0] | undefined;
  const signal = new AbortController().signal;
  const client = new MingClient({status: async () => ({ready: true}), synthesize: async (input, abort) => {seen = input; assert.equal(abort, signal); return wav();}});
  const input = request(); input.params.instructions = "Quiet, restrained anger."; input.signal = signal;
  const result = await client.submit("", input);
  assert.equal(seen?.text, "Come home.");
  assert.equal(seen?.instructions, "Quiet, restrained anger.");
  assert.equal(seen?.reference, input.voiceReference);
  assert.equal(seen?.reference.transcript, "The words in this recording.");
  assert.equal(result.artifacts?.[0]?.contentType, "audio/wav");
});

it("refuses missing voices, missing reference words and oversized requests before inference", async () => {
  let calls = 0;
  const client = new MingClient({status: async () => ({ready: true}), synthesize: async () => {calls++; return wav();}});
  const missing = request(); delete missing.voiceReference;
  await assert.rejects(client.submit("", missing), /saved voice recording/);
  const transcript = request(); delete transcript.voiceReference!.transcript;
  await assert.rejects(client.submit("", transcript), /words spoken/);
  const long = request(); long.params.text = "x".repeat(1201);
  await assert.rejects(client.submit("", long), /shorter parts/);
  const unsupported = request(); unsupported.model = "unqualified";
  await assert.rejects(client.submit("", unsupported), /unsupported/);
  const language = request(); language.params.language = "yo";
  await assert.rejects(client.submit("", language), /language is unsupported/);
  assert.equal(calls, 0);
});

it("reports missing models without a credential and rejects invalid output", async () => {
  const absent = new MingClient({status: async () => ({ready: false, reason: "Install Ming."}), synthesize: async () => wav()});
  assert.ok((await absent.validateKey()).every(probe => !probe.available && probe.reason === "Install Ming."));
  await assert.rejects(absent.submit("", request()), /Install Ming/);
  const broken = new MingClient({status: async () => ({ready: true}), synthesize: async () => new Uint8Array(44)});
  await assert.rejects(broken.submit("", request()), /invalid WAV/);
});
