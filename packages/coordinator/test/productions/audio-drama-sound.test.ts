import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, type Job } from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { createProduction } from "../../src/productions/ops.js";
import { generateDramaSound, type DramaSoundDeps, type DramaSoundInput } from "../../src/productions/audio-drama-sound.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/** A sound for an audio drama's cue (SPEC-057 R-39..R-42): priced, made against its token, kept as artifacts. */
const CLOCK = "2026-10-18T12:00:00.000Z";
async function drama() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => CLOCK });
  closeOnCleanup(() => store.close());
  const id = await createProduction(store, { title: "Low Water", medium: "story", productionKind: "audio-drama" });
  const sent: EnqueueInput[] = [];
  const deps: DramaSoundDeps = {
    worldId: store.worldId, models: SHIPPED_MANIFEST.models,
    enqueue: async (input) => {
      sent.push(input);
      await mkdir(join(store.dir, input.landing!.dir), { recursive: true });
      await writeFile(join(store.dir, input.landing!.dir, input.landing!.name!), Buffer.from(`mp3:${sent.length}`));
      return newId("jb");
    },
    waitForJob: async (jobId) => {
      const input = sent.at(-1)!;
      return { id: jobId, status: "succeeded", landedFiles: [`${input.landing!.dir}/${input.landing!.name!}`] } as unknown as Job;
    },
  };
  return { store, id, sent, deps };
}
const bell: DramaSoundInput = { cue: "sound", heard: "One deep stroke of the harbour bell.", prompt: "One deep stroke of a harbour bell. Close and dry.", durationSec: 4, name: "Harbour bell" };

describe("a sound for an audio drama's cue (SPEC-057 R-39..R-42)", () => {
  it("prices a sound by its length at the catalogue rate and makes nothing until pressed with the token", async () => {
    const { store, id, sent, deps } = await drama();
    const quoted = await generateDramaSound(store, id, { ...bell, quoteOnly: true }, deps);
    assert.equal(quoted.disposition, "quoted");
    if (quoted.disposition !== "quoted") return;
    assert.equal(quoted.quote.estimatedMicroUsd, 8_000, "4 s at $0.12 a minute");
    assert.deepEqual(quoted.quote.requests.map((r) => [r.engine, r.durationSec]), [["ElevenLabs Sound Effects v2", 4]]);
    const stale = await generateDramaSound(store, id, { ...bell, quoteToken: "not-the-token" }, deps);
    assert.equal(stale.disposition, "quoted", "a press against another quote is quoted again, never made");
    assert.equal(sent.length, 0);
    const made = await generateDramaSound(store, id, { ...bell, quoteToken: quoted.quote.token }, deps);
    assert.equal(made.disposition, "made");
    if (made.disposition !== "made") return;
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.capability, "sound-effect");
    assert.deepEqual(sent[0]!.params, { text: bell.prompt, durationSeconds: 4 }, "what is sent is the edited prompt, not the script's words");
    const artifact = store.getBundle().artifacts.find((a) => a.id === made.artifactIds[0])!;
    assert.equal(artifact.production, id, "a production artifact");
    assert.equal(artifact.generation?.source === "sound" && artifact.generation.heard, bell.heard, "the script's words are kept as they were");
  });

  it("makes an ambience as two seamless loops of 30 s and 23 s, the second naming the first (R-42)", async () => {
    const { store, id, sent, deps } = await drama();
    const rain: DramaSoundInput = { cue: "ambience", heard: "Rain on the lamp-room glass.", prompt: "Rain on glass. Close and dry.", durationSec: null, name: "Lamp room rain" };
    const quoted = await generateDramaSound(store, id, { ...rain, quoteOnly: true }, deps);
    assert.ok(quoted.disposition === "quoted");
    if (quoted.disposition !== "quoted") return;
    assert.deepEqual(quoted.quote.requests.map((r) => [r.durationSec, r.loop]), [[30, true], [23, true]]);
    const made = await generateDramaSound(store, id, { ...rain, quoteToken: quoted.quote.token }, deps);
    assert.ok(made.disposition === "made" && made.artifactIds.length === 2);
    if (made.disposition !== "made") return;
    assert.deepEqual(sent.map((input) => input.params), [{ text: rain.prompt, durationSeconds: 30, loop: true }, { text: rain.prompt, durationSeconds: 23, loop: true }]);
    const second = store.getBundle().artifacts.find((a) => a.id === made.artifactIds[1])!;
    assert.equal(second.generation?.source === "sound" && second.generation.pair, made.artifactIds[0]);
  });

  it("composes music with Eleven Music, and refuses a sound over 30 s rather than cutting it", async () => {
    const { store, id, sent, deps } = await drama();
    const cello: DramaSoundInput = { cue: "music", heard: "A cello, solo, enters under.", prompt: "A cello, solo. Instrumental.", durationSec: 45, name: "Cello" };
    const quoted = await generateDramaSound(store, id, { ...cello, quoteOnly: true }, deps);
    assert.ok(quoted.disposition === "quoted" && quoted.quote.estimatedMicroUsd === 112_500, "45 s at $0.15 a minute");
    await generateDramaSound(store, id, { ...cello, quoteToken: quoted.disposition === "quoted" ? quoted.quote.token : "" }, deps);
    assert.deepEqual([sent[0]!.capability, sent[0]!.model, sent[0]!.params], ["music", "music_v1", { prompt: cello.prompt, durationSeconds: 45 }]);
    await assert.rejects(generateDramaSound(store, id, { ...bell, durationSec: 31, quoteOnly: true }, deps), /0\.5 to 30 seconds/);
  });
});
