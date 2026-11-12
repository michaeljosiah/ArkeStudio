import assert from "node:assert/strict";
import { it } from "node:test";
import { VoxaClient, WHISPER_PROMPT_MAX_BYTES } from "@arke-studio/voice";
import { whisperNamePrompt } from "../../src/voice/word-times.js";
import { VoiceService } from "../../src/voice/service.js";

it("hints only names present in this request, in lexicon order, without partial names (#1670)", () => {
  const lexicon = new Set(["maren", "tunde", "ronke", "ikoyi"]);
  assert.equal(whisperNamePrompt(lexicon, "Ronke asked Tunde about Ikoyi. Tunde answered."), "tunde, ronke, ikoyi");
  assert.equal(whisperNamePrompt(lexicon, "The rain fell."), undefined);
  const names = Array.from({ length: 40 }, (_, i) => "名" + String.fromCharCode(97 + i % 26, 97 + Math.floor(i / 26)));
  const prompt = whisperNamePrompt(new Set(names), names.join(" "))!;
  assert.ok(Buffer.byteLength(prompt, "utf8") <= WHISPER_PROMPT_MAX_BYTES);
  assert.ok(prompt.length < names.join(", ").length);
  assert.ok(prompt.split(", ").every(name => names.includes(name)));
  assert.ok(prompt.startsWith(names[0]!));
});

it("VoiceService carries a caller's hint and cancellation to Voxa without retaining it (#1670)", async () => {
  const hints: Array<string | null> = [];
  const client = new VoxaClient(async (_url, init) => {
    hints.push(new Headers(init?.headers).get("X-Voxa-Prompt"));
    return Response.json({ text: "Tunde arrived." });
  }, "http://127.0.0.1:5901");
  const service = new VoiceService({ sidecar: client, localPresets: [], cloudSources: [], getKey: async () => null, emit: () => {} });
  const control = new AbortController();
  await service.transcribe(new Uint8Array(), "audio/webm", control.signal, "tunde");
  await service.transcribe(new Uint8Array(), "audio/webm");
  control.abort();
  await assert.rejects(service.transcribe(new Uint8Array(), "audio/webm", control.signal, "ronke"));
  assert.deepEqual(hints, [Buffer.from("tunde").toString("base64"), null]);
});
