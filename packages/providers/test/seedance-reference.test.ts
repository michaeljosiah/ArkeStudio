import assert from "node:assert/strict";
import { it } from "node:test";
import { createHash } from "node:crypto";
import { referencePrompt, referenceInputProblem, multimediaCapacity, admitReference } from "@arke-studio/contracts";
import { FAL_MODELS } from "../src/fal-catalogue.generated.js";
import { FalClient } from "../src/clients/fal.js";

const data = Uint8Array.from([1, 2, 3]);
const hash = createHash("sha256").update(data).digest("hex");
it("Seedance 2.5 refuses short audio at attachment and dispatch review", () => {
  const model = FAL_MODELS.find(row => row.id === "seedance-2.5")!;
  assert.equal(admitReference({ kind: "audio", durationSec: 1 }, [], model).ok, false);
  assert.match(referenceInputProblem(model, { references: ["frame.png"], referenceMedia: [
    { kind: "audio", file: "sound.wav", hash, durationSec: 1 },
  ] }) ?? "", /per-file minimum/);
  assert.equal(model.limits.maxReferenceVideoBytes, 48 * 1024 * 1024);
});
it("fal rows without an audio transport field do not offer standalone audio", () => {
  assert.equal(multimediaCapacity([], FAL_MODELS.find(row => row.id === "minimax-h3")!).audioCeilingSec, 0);
  assert.equal(multimediaCapacity([], FAL_MODELS.find(row => row.id === "seedance-2.0")!).audioCeilingSec, 15);
});
for (const id of ["seedance-2.0", "seedance-2.0-fast", "seedance-2.5"]) {
  it(`${id} sends motion and audio to the reference endpoint with native prompt tokens`, async () => {
    const model = FAL_MODELS.find(row => row.id === id)!;
    let endpoint = "", payload: Record<string, unknown> = {};
    const client = new FalClient(async (url, init) => {
      endpoint = url; payload = JSON.parse(String(init?.body));
      return Response.json({ request_id: "reference" });
    });
    assert.equal(referenceInputProblem(model, {}), null, "text-only generation needs no references");
    const media = [{ kind: "video", file: "stage.mp4", hash, durationSec: 4 }, { kind: "audio", file: "sound.wav", hash, durationSec: 2 }];
    const prompt = referencePrompt("Use @video1 with @Audio1 and @Image1.", model);
    assert.equal(prompt, "Use @Video1 with @Audio1 and @Image1.");
    assert.equal(referenceInputProblem(model, { videoReferences: ["stage.mp4"], referenceMedia: media }), null);
    await client.submit("test", { model: id, capability: "video",
      params: { prompt, durationSec: 5, videoReferences: ["stage.mp4"], referenceMedia: media },
      videoReferences: [{ contentType: "video/mp4", data, durationSec: 4 }],
      mediaAudioReferences: [{ name: "sound.wav", contentType: "audio/wav", data, durationSec: 2 }] });
    assert.match(endpoint, /reference-to-video$/);
    assert.deepEqual(payload.video_urls, ["data:video/mp4;base64,AQID"]);
    assert.deepEqual(payload.audio_urls, ["data:audio/wav;base64,AQID"]);
    assert.equal(payload.prompt, prompt);
    assert.equal(payload.referenceMedia, undefined);
    assert.equal(payload.videoReferences, undefined);
    assert.ok(referenceInputProblem(model, { referenceMedia: media.filter(ref => ref.kind === "audio") }));
  });
}
it("Seedance refuses over-budget video before submitting", async () => {
  let requests = 0;
  const client = new FalClient(async () => { requests++; return Response.json({ request_id: "bad" }); });
  for (const durationSec of [1, 16]) {
    await assert.rejects(client.submit("test", { model: "seedance-2.0", capability: "video",
      params: { prompt: "@Video1", durationSec: 5 }, videoReferences: [{ contentType: "video/mp4", data, durationSec }] }), /limits/);
  }
  assert.equal(requests, 0);
});
it("fal queue completion with no media is a generation failure with the provider's reason", async () => {
  const client = new FalClient(async url => url.endsWith("/status")
    ? Response.json({ status: "COMPLETED" })
    : Response.json({ detail: [{ type: "no_media_generated", msg: "References to missing attachments." }] }, { status: 422 }));
  assert.deepEqual(await client.poll("test", "fal-ai/nano-banana-2::request"),
    { state: "failed", error: "fal: References to missing attachments. (HTTP 422)" });
});
