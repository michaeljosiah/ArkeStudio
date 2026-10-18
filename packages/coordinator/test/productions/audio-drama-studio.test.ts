import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, ulid, type EpisodeScriptBlock, type Job } from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { createProduction } from "../../src/productions/ops.js";
import { saveEpisodeScript, setDramaRole } from "../../src/productions/audio-drama.js";
import { hearDramaLines, type DramaHearDeps } from "../../src/productions/audio-drama-hear.js";
import { editAudioStudio, openAudioStudio } from "../../src/productions/audio-studio.js";
import { importAudioStudioMedia } from "../../src/productions/audio-studio-import.js";
import { DRAMA_MIX_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { fileGeneratedArtifact } from "../../src/artifacts/filing.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { wav } from "../audio/helpers.js";
import { DramaEditionService } from "../../src/publications/drama.js";
import { tempDir } from "../tmp.js";

/** An audio drama's episode in Audio Studio (SPEC-057 R-67, R-68): one arrangement, on the chapter's studio. */
const CLOCK = "2026-10-18T12:00:00.000Z";
const BREEZE = { provider: "breezeblue", model: "breeze-tts-2", voiceId: "breeze-a", label: "Breeze A" };
const second = (n: number) => wav(Array.from({ length: Math.round(48_000 * n) }, (_, i) => (i % 40) * 100));

async function episode(blocks: (sound: string) => EpisodeScriptBlock[]) {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => CLOCK });
  closeOnCleanup(() => store.close());
  const id = await createProduction(store, { title: "Low Water", medium: "story", productionKind: "audio-drama" });
  await setDramaRole(store, id, "maren-kest", { voice: BREEZE });
  await setDramaRole(store, id, "bray", { voice: BREEZE });
  // A placed sound, filed as a production artifact.
  await mkdir(join(store.dir, ".staging/sound"), { recursive: true });
  await writeFile(join(store.dir, ".staging/sound/bell.wav"), second(0.5));
  const bell = await fileGeneratedArtifact(store, { sourcePath: join(store.dir, ".staging/sound/bell.wav"), production: id, generation: {
    source: "sound", productionId: id, name: "Bell", cue: "sound", heard: "The bell.", prompt: "The bell.", provider: "elevenlabs",
    model: "eleven_text_to_sound_v2", outputFormat: "mp3_44100_128", estimatedMicroUsd: 0, costMicroUsd: null } as never });
  const script = blocks(bell.id);
  await saveEpisodeScript(store, id, { episode: 1, title: "", blocks: script, baseHash: null });
  const sent: EnqueueInput[] = [];
  const deps: DramaHearDeps = {
    worldId: store.worldId, narrator: BREEZE, models: SHIPPED_MANIFEST.models,
    enqueue: async (input) => {
      sent.push(input);
      await mkdir(join(store.dir, input.landing!.dir), { recursive: true });
      await writeFile(join(store.dir, input.landing!.dir, input.landing!.name!), second(1));
      return newId("jb");
    },
    waitForJob: async (jobId) => ({ id: jobId, status: "succeeded", landedFiles: [`${sent.at(-1)!.landing!.dir}/${sent.at(-1)!.landing!.name}`] }) as unknown as Job,
  };
  const spoken = script.filter((block) => block.kind === "dialogue" || block.kind === "narration").map((block) => block.id);
  const quoted = await hearDramaLines(store, id, { episode: 1, blocks: spoken }, deps);
  await hearDramaLines(store, id, { episode: 1, blocks: spoken, quoteToken: quoted.disposition === "quoted" ? quoted.quote.token : "" }, deps);
  return { store, id, script };
}

describe("an episode in Audio Studio (SPEC-057 R-67, R-68)", () => {
  it("opens as one arrangement: lines in sequence, a cut-in under the line it breaks, a sound the next line waits for", async () => {
    const a: EpisodeScriptBlock = { id: ulid(), kind: "dialogue", speaker: "maren-kest", words: "Ilo's lantern is up here. He said it was", cut: true };
    const b: EpisodeScriptBlock = { id: ulid(), kind: "dialogue", speaker: "bray", words: "Two. Climb.", overlapsPrevious: true };
    const c: EpisodeScriptBlock = { id: ulid(), kind: "dialogue", speaker: "maren-kest", words: "Climb." };
    const { store, id } = await episode((bell) => [
      { id: ulid(), kind: "heading", place: "The bell tower" }, a, b, { id: ulid(), kind: "sound", heard: "The bell.", soundArtifact: bell }, c,
    ]);
    const opened = await openAudioStudio(store, id, "episode-001");
    assert.deepEqual(opened.passages.map((passage) => passage.key), [a.id, b.id, c.id], "every spoken line is a passage, by block id");
    const clip = (key: string) => opened.state.clips.find((candidate) => candidate.id === key)!;
    assert.deepEqual(clip(`line:${b.id}`).placement, { kind: "sequence", offset: -19_200 }, "Bray cuts in 0.4 s before Maren ends");
    assert.equal(clip(`line:${c.id}`).placement.kind, "sequence");
    assert.equal((clip(`line:${c.id}`).placement as { offset: number }).offset, 24_000, "the next line waits for the sound");
    const sound = opened.state.clips.find((candidate) => candidate.id.startsWith("sound:"))!;
    assert.deepEqual(sound.placement, { kind: "passage", anchor: { passageId: opened.state.passages[1]!.id, edge: "end", offset: 0 } });
    const resolved = opened.resolved;
    assert.equal(resolved.issues.length, 0, JSON.stringify(resolved.issues));
    assert.deepEqual(opened.state.tracks.map((track) => track.name), ["Maren Kest", "bray", "Sound"]);
  });

  it("keeps the episode's edits in its own record, never a chapter's", async () => {
    const line: EpisodeScriptBlock = { id: ulid(), kind: "dialogue", speaker: "maren-kest", words: "Climb." };
    const { store, id } = await episode(() => [{ id: ulid(), kind: "heading", place: "The quay" }, line]);
    const opened = await openAudioStudio(store, id, "episode-001");
    const record = await editAudioStudio(store, id, "episode-001", opened.base, { kind: "commands", label: "Add a lane", commands: [{ kind: "add-track", track: { id: "extra", name: "Extra", gainDb: 0, muted: false } }] } as never);
    assert.equal(record, null, "an episode keeps no audiobook record");
    await access(join(store.dir, "productions", id, "drama-mix", "episode-001.json"));
    const reopened = await openAudioStudio(store, id, "episode-001");
    assert.ok(reopened.saved && reopened.state.tracks.some((track) => track.id === "extra"));
    await assert.rejects(access(join(store.dir, "productions", id, ".audiobook")), "no chapter record is made");
  });
});

describe("an audio drama's edition (SPEC-057 R-71..R-76)", () => {
  it("publishes the ready episodes as copies — audio, transcript, credits, script — unchanged by later edits", async () => {
    const line: EpisodeScriptBlock = { id: ulid(), kind: "dialogue", speaker: "maren-kest", words: "Climb.", direction: "breathless" };
    const { store, id } = await episode(() => [{ id: ulid(), kind: "heading", place: "The quay" }, line]);
    const editions = new DramaEditionService(await tempDir("drama-editions"));
    const edition = await editions.publish(store, id, { name: "Pilot", delivery: "podcast", episodes: [1] });
    assert.deepEqual(edition.files.map((file) => file.name).sort(), ["credits.txt", "episode-001-script.txt", "episode-001.wav", "transcript.txt"]);
    assert.ok(edition.episodes[0]!.seconds >= 1);
    const transcript = await editions.serve(edition.id, "transcript.txt");
    assert.equal(await readFile(transcript!.path, "utf8"), "Episode 1\n\nMAREN KEST: Climb.\n", "words, never directions");
    const before = await readFile((await editions.serve(edition.id, "episode-001.wav"))!.path);
    // Edited afterwards: the published edition is as it was.
    const entry = store.getBundle().productions.find((p) => p.meta.id === id)!.episodeScripts![0]!;
    await saveEpisodeScript(store, id, { episode: 1, title: "Changed", blocks: [...entry.script.blocks, { id: ulid(), kind: "dialogue", speaker: "bray", words: "New." }], baseHash: entry.hash });
    assert.deepEqual(await readFile((await editions.serve(edition.id, "episode-001.wav"))!.path), before);
    assert.equal((await editions.list(store.worldId, id)).length, 1);
    await assert.rejects(editions.publish(store, id, { name: "Again", delivery: "archive", episodes: [1] }), /not ready: 1 line not performed/, "the new line has no take");
  });
});

describe("codex round 1 on PR 1879", () => {
  it("fences the first episode mix, imports to an episode, and never reads another episode's mix", async () => {
    const line: EpisodeScriptBlock = { id: ulid(), kind: "dialogue", speaker: "maren-kest", words: "Climb." };
    const { store, id } = await episode(() => [{ id: ulid(), kind: "heading", place: "The quay" }, line]);
    const opened = await openAudioStudio(store, id, "episode-001");
    await writeFile(join(store.dir, ".staging/sound/gull.wav"), second(0.5));
    const failures = await importAudioStudioMedia(store, [join(store.dir, ".staging/sound/gull.wav")],
      { productionId: id, chapterFile: "episode-001", base: opened.base, destination: { trackId: null, at: 0 } }, { abandoned: () => false });
    assert.deepEqual(failures, []);
    assert.ok((await openAudioStudio(store, id, "episode-001")).state.clips.some((clip) => clip.role === "sfx"), "the import is on the episode's timeline");
    assert.ok((await readWorldMeta(store.dir)).schemaVersion >= DRAMA_MIX_SCHEMA_VERSION, "a build without drama-mix refuses the world");
    const path = join(store.dir, "productions", id, "drama-mix", "episode-001.json");
    const record = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...record, episode: 2 }));
    await assert.rejects(openAudioStudio(store, id, "episode-001"), /unreadable/);
  });
});
