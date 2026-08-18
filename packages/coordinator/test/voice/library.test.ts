import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "../tmp.js";
import { WorldStore } from "../../src/world/store.js";
import { cloneVoice, clipFor } from "../../src/voice/library.js";
import { toExtendedLength } from "../../src/world/paths.js";
import { makeTempWorld } from "../world/helpers.js";

const CLOCK = () => "2026-08-18T10:00:00.000Z";

/**
 * The cloned-voice write path (SPEC-022 T-4). Three things land — the clip, the artifact, the
 * library entry — and the order they land in matters more than any of them individually.
 */
describe("cloning a voice into a world", () => {
  /**
   * The store closes in `finally`, never after the assertions. A failed assertion that skips
   * `close()` leaves the world open and hangs the whole runner — silently, with no failing test
   * to point at. Learned writing these.
   */
  async function withWorld(
    prefix: string,
    body: (ctx: { store: WorldStore; dir: string; source: string }) => Promise<void>,
  ): Promise<void> {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    const source = join(await tempDir(prefix), "recording.wav");
    // A RIFF header and a little payload: enough that filing measures something real.
    await writeFile(toExtendedLength(source), Buffer.from([0x52, 0x49, 0x46, 0x46, ...Array.from({ length: 64 }, () => 7)]));
    try {
      await body({ store, dir, source });
    } finally {
      await store.close();
    }
  }

  it("writes the clip, files the artifact, and records the voice", async () => {
    await withWorld("arke-clone-ok-", async ({ store, dir, source }) => {
      const made = await cloneVoice(store, [], {
        sourcePath: source,
        name: "Harbour glass",
        description: "Low, dry, unhurried. Coastal.",
        consent: true,
        sheetId: "maren-kest",
      });
      assert.ok(made.ok);
      assert.equal(made.voice.id, "harbour-glass");
      assert.equal(made.voice.clip, "voices/harbour-glass.wav");

      // 1 — the clip is where the voice says it is, and it is the bytes that were chosen.
      const written = await readFile(toExtendedLength(join(dir, "voices", "harbour-glass.wav")));
      assert.deepEqual(written, await readFile(toExtendedLength(source)));

      // 2 — provenance was filed, and it is NOT what the voice speaks from.
      assert.ok(made.voice.artifactId, "the recording files as an artifact");

      // 3 — the library is what the picker reads.
      const bundle = store.getBundle();
      assert.deepEqual(
        bundle.clonedVoices.map((v) => v.id),
        ["harbour-glass"],
      );
      assert.deepEqual(bundle.clonedVoices[0]?.attributes, ["low", "dry", "unhurried", "coastal"]);
    });
  });

  it("survives its artifact being deleted, which is why the bytes exist twice", async () => {
    await withWorld("arke-clone-orphan-", async ({ store, dir, source }) => {
      const made = await cloneVoice(store, [], {
        sourcePath: source,
        name: "Harbour glass",
        description: "Low and dry.",
        consent: true,
      });
      assert.ok(made.ok);
      // Somebody tidies the artifacts shelf. The voice must still speak.
      await rm(toExtendedLength(join(dir, "artifacts")), { recursive: true, force: true });
      const voice = store.getBundle().clonedVoices[0];
      assert.ok(voice, "the voice outlives its provenance");
      assert.ok(await clipFor(store, voice), "and still has bytes to speak with");
    });
  });

  it("reports a missing clip rather than dispatching into a take that cannot finish", async () => {
    await withWorld("arke-clone-noclip-", async ({ store, dir, source }) => {
      const made = await cloneVoice(store, [], {
        sourcePath: source,
        name: "Harbour glass",
        description: "Low and dry.",
        consent: true,
      });
      assert.ok(made.ok);
      await rm(toExtendedLength(join(dir, "voices", "harbour-glass.wav")), { force: true });
      assert.equal(await clipFor(store, made.voice), null, "null is an answer the caller must handle");
    });
  });

  it("refuses the description and the consent before writing anything", async () => {
    await withWorld("arke-clone-refuse-", async ({ store, dir, source }) => {
      const noDescription = await cloneVoice(store, [], {
        sourcePath: source,
        name: "Harbour glass",
        description: "   ",
        consent: true,
      });
      assert.ok(!noDescription.ok);
      assert.match(noDescription.reason, /what the picker matches on/);

      const noConsent = await cloneVoice(store, [], {
        sourcePath: source,
        name: "Harbour glass",
        description: "Low and dry.",
        consent: false,
      });
      assert.ok(!noConsent.ok);

      // A refused clone leaves no clip behind — the refusal happens before any byte is written.
      const voices = await readdir(toExtendedLength(join(dir, "voices"))).catch(() => [] as string[]);
      assert.deepEqual(voices, []);
    });
  });

  it("refuses a file that is not audio", async () => {
    await withWorld("arke-clone-notaudio-", async ({ store, dir }) => {
      const notAudio = join(dir, "notes.txt");
      await writeFile(toExtendedLength(notAudio), "not a recording");
      const made = await cloneVoice(store, [], {
        sourcePath: notAudio,
        name: "Harbour glass",
        description: "Low and dry.",
        consent: true,
      });
      assert.ok(!made.ok);
      assert.match(made.reason, /is not audio/);
    });
  });

  it("a second voice of the same name gets its own id and its own clip", async () => {
    await withWorld("arke-clone-collide-", async ({ store, source }) => {
      const first = await cloneVoice(store, [], {
        sourcePath: source,
        name: "Harbour glass",
        description: "Low and dry.",
        consent: true,
      });
      assert.ok(first.ok);
      const second = await cloneVoice(store, [first.voice], {
        sourcePath: source,
        name: "Harbour glass",
        description: "Rougher, slower.",
        consent: true,
      });
      assert.ok(second.ok);
      assert.equal(second.voice.id, "harbour-glass-2");
      assert.equal(second.voice.clip, "voices/harbour-glass-2.wav");

      assert.deepEqual(
        store
          .getBundle()
          .clonedVoices.map((v) => v.id)
          .sort(),
        ["harbour-glass", "harbour-glass-2"],
        "appending never clobbers what was already there",
      );
    });
  });
});
