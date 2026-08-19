import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "../tmp.js";
import { WorldStore } from "../../src/world/store.js";
import { cloneVoice, clipFor, wavSeconds } from "../../src/voice/library.js";
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
    await writeFile(toExtendedLength(source), Buffer.from([0x52, 0x49, 0x46, 0x46, 8, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, ...Array.from({ length: 64 }, () => 7)]));
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

  it("mints against the library on disk, not the caller's list (review finding)", async () => {
    await withWorld("arke-clone-stale-", async ({ store, dir, source }) => {
      const first = await cloneVoice(store, [], {
        sourcePath: source, name: "Harbour glass", description: "Low and dry.", consent: true,
      });
      assert.ok(first.ok);
      const before = await readFile(toExtendedLength(join(dir, "voices", "harbour-glass.wav")));

      // A caller holding a bundle snapshot from BEFORE the first clone. The id must still not
      // collide — otherwise the clip path collides and the first voice's recording is overwritten.
      const second = await cloneVoice(store, [], {
        sourcePath: source, name: "Harbour glass", description: "Rougher, slower.", consent: true,
      });
      assert.ok(second.ok);
      assert.notEqual(second.voice.id, first.voice.id, "a stale caller list must not mint a duplicate");
      const after = await readFile(toExtendedLength(join(dir, "voices", "harbour-glass.wav")));
      assert.deepEqual(after, before, "the first voice's clip is untouched");
    });
  });

  it("keeps an entry it cannot parse instead of deleting it on the next clone (review finding)", async () => {
    await withWorld("arke-clone-preserve-", async ({ store, dir, source }) => {
      await mkdir(toExtendedLength(join(dir, "voices")), { recursive: true });
      await writeFile(
        toExtendedLength(join(dir, "voices", "voices.json")),
        JSON.stringify({ voices: [{ id: "ok", name: "OK", clip: "voices/ok.wav" }, { nonsense: true }] }),
        "utf8",
      );
      const made = await cloneVoice(store, [], {
        sourcePath: source, name: "Harbour glass", description: "Low and dry.", consent: true,
      });
      assert.ok(made.ok);
      const written = JSON.parse(
        await readFile(toExtendedLength(join(dir, "voices", "voices.json")), "utf8"),
      ) as { voices: Array<Record<string, unknown>> };
      assert.equal(written.voices.length, 3, "the unreadable entry survives the append");
      assert.ok(written.voices.some((v) => v["nonsense"] === true));
    });
  });

  it("refuses bytes that are not the audio the name claims (review finding)", async () => {
    await withWorld("arke-clone-liar-", async ({ store, dir }) => {
      const liar = join(dir, "not-really.wav");
      await writeFile(toExtendedLength(liar), "this is a text file wearing a wav extension");
      const made = await cloneVoice(store, [], {
        sourcePath: liar, name: "Harbour glass", description: "Low and dry.", consent: true,
      });
      assert.ok(!made.ok);
      assert.match(made.reason, /contents are not wav audio/);
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

/**
 * How long a clip runs, from its own header (SPEC-022 T-10). Staging refuses a clip that is too
 * short to clone from, and this is the only reading it gets to make that call on.
 */
describe("reading a WAV's length", () => {
  /** A real header: `fmt ` with a byte rate, then a `data` chunk of the requested length. */
  function wav({ byteRate, dataBytes, extraChunk = false }: { byteRate: number; dataBytes: number; extraChunk?: boolean }): Uint8Array {
    const parts: number[] = [];
    const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
    const u32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
    parts.push(...ascii("RIFF"), ...u32(0), ...ascii("WAVE"));
    // A LIST chunk of odd length, to prove the walk honours the pad byte that follows one.
    if (extraChunk) parts.push(...ascii("LIST"), ...u32(3), 1, 2, 3, 0);
    parts.push(...ascii("fmt "), ...u32(16), 1, 0, 1, 0, ...u32(44100), ...u32(byteRate), 2, 0, 16, 0);
    parts.push(...ascii("data"), ...u32(dataBytes));
    return Uint8Array.from(parts);
  }

  it("divides the data chunk by the byte rate", () => {
    assert.equal(wavSeconds(wav({ byteRate: 88200, dataBytes: 882000 })), 10);
  });

  it("finds fmt and data behind a chunk of odd length", () => {
    // An odd-sized chunk is followed by a pad byte that is not counted in its size. Missing it
    // walks into the middle of the next chunk header and reads a length out of audio.
    assert.equal(wavSeconds(wav({ byteRate: 88200, dataBytes: 441000, extraChunk: true })), 5);
  });

  it("says nothing rather than guessing", () => {
    // Not a WAV at all, and a WAV whose chunks never arrive: both are unknown, not zero. A zero
    // would read as "too short" and refuse a clip that was never measured.
    assert.equal(wavSeconds(Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0])), null);
    assert.equal(wavSeconds(Uint8Array.from([...[0x52, 0x49, 0x46, 0x46], 8, 0, 0, 0, ...[0x57, 0x41, 0x56, 0x45], ...Array.from({ length: 64 }, () => 7)])), null);
  });
});
