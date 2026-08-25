import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { mkdir, open, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactSidecarSchema } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { WorldStore } from "../../src/world/store.js";
import { cloneVoice, clipFor, wavSeconds } from "../../src/voice/library.js";
import { fileArtifact } from "../../src/artifacts/filing.js";
import { CrashSignal } from "../../src/world/commit.js";
import { toExtendedLength } from "../../src/world/paths.js";
import { makeTempWorld } from "../world/helpers.js";

const CLOCK = () => "2026-08-18T10:00:00.000Z";

const CLONE_COMMIT_KILL_POINTS = [
  "prepared-written",
  "snapshots-written",
  "staged-written",
  "committing-marked",
  "renamed:0",
  "renamed:1",
  "world-renamed",
  "changes-appended",
] as const;

async function fileExists(path: string): Promise<boolean> {
  const info = await stat(toExtendedLength(path)).catch(() => null);
  return info?.isFile() === true;
}

/** Every durable clone/provenance record must resolve to media at the same instant it is read. */
async function assertRecordedMediaExists(dir: string, at: string): Promise<void> {
  const artifacts = new Map<string, { file: string; hash: string }>();
  for (const sidecarName of (await readdir(join(dir, "artifacts"))).filter((name) =>
    name.endsWith(".json"),
  )) {
    const sidecar = ArtifactSidecarSchema.parse(
      JSON.parse(await readFile(toExtendedLength(join(dir, "artifacts", sidecarName)), "utf8")),
    );
    assert.equal(
      await fileExists(join(dir, "artifacts", sidecar.file)),
      true,
      `${at}: artifact ${sidecar.id} references missing media ${sidecar.file}`,
    );
    artifacts.set(sidecar.id, sidecar);
  }

  const libraryRaw = await readFile(toExtendedLength(join(dir, "voices", "voices.json")), "utf8").catch(
    () => null,
  );
  if (libraryRaw === null) return;
  const values = (JSON.parse(libraryRaw) as { voices?: unknown }).voices;
  assert.ok(Array.isArray(values), `${at}: the voice library remains an array`);
  for (const value of values) {
    const voice = value as { id?: unknown; clip?: unknown; artifactId?: unknown };
    assert.equal(typeof voice.clip, "string", `${at}: voice ${String(voice.id)} has a clip path`);
    assert.equal(
      await fileExists(join(dir, voice.clip as string)),
      true,
      `${at}: voice ${String(voice.id)} references missing clip ${String(voice.clip)}`,
    );
    assert.equal(typeof voice.artifactId, "string", `${at}: voice ${String(voice.id)} has provenance`);
    assert.ok(
      artifacts.has(voice.artifactId as string),
      `${at}: voice ${String(voice.id)} resolves its provenance`,
    );
    const artifact = artifacts.get(voice.artifactId as string)!;
    const media = await readFile(toExtendedLength(join(dir, "artifacts", artifact.file)));
    assert.equal(
      artifact.hash,
      `sha256:${createHash("sha256").update(media).digest("hex").slice(0, 16)}`,
      `${at}: voice ${String(voice.id)} provenance metadata matches its media`,
    );
  }
}

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
    // A complete RIFF/WAVE, long enough to satisfy the clone floor.
    await writeFile(toExtendedLength(source), wav({ byteRate: 20, dataBytes: 64 }));
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

  it("cleans up newly staged media before the record commit starts", async () => {
    await withWorld("arke-clone-transaction-", async ({ store, dir, source }) => {
      const beforeArtifacts = await readdir(join(dir, "artifacts")).catch(() => [] as string[]);
      const made = await cloneVoice(
        store,
        [],
        { sourcePath: source, name: "Harbour glass", description: "Low and dry.", consent: true },
        {
          afterArtifactFiled: () => {
            throw new Error("library write failed");
          },
        },
      );
      assert.equal(made.ok, false);
      const voices = await readdir(join(dir, "voices")).catch(() => [] as string[]);
      assert.deepEqual(voices, []);
      const artifacts = await readdir(join(dir, "artifacts")).catch(() => [] as string[]);
      assert.deepEqual(artifacts.sort(), beforeArtifacts.sort());
      assert.deepEqual(store.getBundle().clonedVoices, []);
      assert.equal(
        store.getBundle().artifacts.some((artifact) => artifact.links.includes("harbour-glass")),
        false,
      );
    });
  });

  for (const point of CLONE_COMMIT_KILL_POINTS) {
    it(`a kill at ${point} never leaves a clone record pointing at missing media`, async () => {
      const dir = await makeTempWorld();
      const source = join(await tempDir(`arke-clone-crash-${point.replace(":", "-")}-`), "recording.wav");
      await writeFile(toExtendedLength(source), wav({ byteRate: 20, dataBytes: 64 }));
      let store: WorldStore | null = await WorldStore.open(dir, { clock: CLOCK });
      try {
        const commit = store.commitUnserialised.bind(store);
        store.commitUnserialised = (input) =>
          commit(input, {
            at: (where) => {
              if (where === point) throw new CrashSignal(`killed at ${where}`);
            },
          });
        const made = await cloneVoice(store, [], {
          sourcePath: source,
          name: "Harbour glass",
          description: "Low and dry.",
          consent: true,
        });
        assert.equal(made.ok, false, `${point}: the interrupted request does not report success`);
        await assertRecordedMediaExists(dir, `interrupted at ${point}`);

        if (point === "renamed:0") {
          assert.equal(
            await fileExists(join(dir, "artifacts", "harbour-glass.wav.json")),
            true,
            "the first rename has made provenance live",
          );
          assert.equal(
            await fileExists(join(dir, "artifacts", "harbour-glass.wav")),
            true,
            "live provenance still has its pre-staged bytes",
          );
          assert.equal(
            await fileExists(join(dir, "voices", "voices.json")),
            false,
            "the catalogue rename has not happened yet",
          );
        }

        await store.close();
        store = null;
        store = await WorldStore.open(dir, { clock: CLOCK });
        await assertRecordedMediaExists(dir, `recovered from ${point}`);

        const beforePointOfNoReturn =
          point === "prepared-written" || point === "snapshots-written" || point === "staged-written";
        assert.equal(
          store.getBundle().clonedVoices.some((voice) => voice.id === "harbour-glass"),
          !beforePointOfNoReturn,
          `${point}: recovery ${beforePointOfNoReturn ? "rolls records back" : "rolls records forward"}`,
        );
      } finally {
        await store?.close().catch(() => {});
      }
    });
  }

  it("keeps media when WorldStore reports failure after the records committed", async () => {
    await withWorld("arke-clone-post-commit-", async ({ store, dir, source }) => {
      const commit = store.commitUnserialised.bind(store);
      store.commitUnserialised = async (input, hooks) => {
        await commit(input, hooks);
        // WorldStore normally has this ambiguity when its post-commit rescan fails.
        throw new Error("post-commit rescan failed");
      };

      const made = await cloneVoice(store, [], {
        sourcePath: source,
        name: "Harbour glass",
        description: "Low and dry.",
        consent: true,
      });

      assert.equal(made.ok, false, "the caller still receives the reported failure");
      await assertRecordedMediaExists(dir, "after a post-commit failure");
      assert.equal(
        store.getBundle().clonedVoices.some((voice) => voice.id === "harbour-glass"),
        true,
        "the records that already committed remain usable",
      );
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

  it("confines hand-edited library paths and refuses linked files", async () => {
    await withWorld("arke-clone-confined-", async ({ store, dir, source }) => {
      const bytes = await readFile(source);
      const voice = {
        id: "unsafe",
        name: "Unsafe",
        description: "low",
        attributes: ["low"],
        consent: true,
        created: CLOCK(),
      };
      for (const clip of [
        source,
        "../recording.wav",
        "voices/clip.wav:secret",
        String.raw`C:\recording.wav`,
      ]) {
        assert.equal(await clipFor(store, { ...voice, clip }), null, clip);
      }

      await mkdir(join(dir, "voices"), { recursive: true });
      const outside = join(await tempDir("arke-clone-outside-"), "outside.wav");
      await writeFile(outside, bytes);
      await symlink(outside, join(dir, "voices", "linked.wav"));
      assert.equal(await clipFor(store, { ...voice, clip: "voices/linked.wav" }), null);
    });
  });

  it("returns content-addressed bytes, never a host path", async () => {
    await withWorld("arke-clone-reference-", async ({ store, source }) => {
      const made = await cloneVoice(store, [], {
        sourcePath: source,
        name: "Harbour glass",
        description: "Low and dry.",
        consent: true,
      });
      assert.ok(made.ok);
      const clip = await clipFor(store, made.voice);
      assert.ok(clip);
      assert.match(clip.name, /^[0-9a-f]{64}\.wav$/);
      assert.equal(clip.contentType, "audio/wav");
      assert.equal(JSON.stringify(clip).includes(store.dir), false);
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

  it("refuses a clone after its store has closed without staging any world bytes", async () => {
    await withWorld("arke-clone-closed-", async ({ store, dir, source }) => {
      const voicesBefore = await readdir(join(dir, "voices")).catch(() => [] as string[]);
      const artifactsBefore = await readdir(join(dir, "artifacts"));
      await store.close();

      const made = await cloneVoice(store, [], {
        sourcePath: source,
        name: "Closed glass",
        description: "Low and dry.",
        consent: true,
      });

      assert.equal(made.ok, false);
      assert.match(made.ok ? "" : made.reason, /closed/);
      assert.deepEqual(await readdir(join(dir, "voices")).catch(() => [] as string[]), voicesBefore);
      assert.deepEqual((await readdir(join(dir, "artifacts"))).sort(), artifactsBefore.sort());
    });
  });

  it("mints against the library on disk, not the caller's list (review finding)", async () => {
    await withWorld("arke-clone-stale-", async ({ store, dir, source }) => {
      const first = await cloneVoice(store, [], {
        sourcePath: source,
        name: "Harbour glass",
        description: "Low and dry.",
        consent: true,
      });
      assert.ok(first.ok);
      const before = await readFile(toExtendedLength(join(dir, "voices", "harbour-glass.wav")));

      // A caller holding a bundle snapshot from BEFORE the first clone. The id must still not
      // collide — otherwise the clip path collides and the first voice's recording is overwritten.
      const second = await cloneVoice(store, [], {
        sourcePath: source,
        name: "Harbour glass",
        description: "Rougher, slower.",
        consent: true,
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
        sourcePath: source,
        name: "Harbour glass",
        description: "Low and dry.",
        consent: true,
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
        sourcePath: liar,
        name: "Harbour glass",
        description: "Low and dry.",
        consent: true,
      });
      assert.ok(!made.ok);
      assert.match(made.reason, /contents are not wav audio/);
    });
  });

  it("refuses an oversized recording before copying it into the world", async () => {
    await withWorld("arke-clone-large-", async ({ store, source }) => {
      const handle = await open(source, "r+");
      try {
        await handle.truncate(50 * 1024 * 1024 + 1);
      } finally {
        await handle.close();
      }
      const made = await cloneVoice(store, [], {
        sourcePath: source,
        name: "Too large",
        description: "Low and dry.",
        consent: true,
      });
      assert.ok(!made.ok);
      assert.match(made.reason, /over 50 MB/);
    });
  });

  it("refuses a directory used as a clip", async () => {
    await withWorld("arke-clone-directory-", async ({ store, dir }) => {
      await mkdir(join(dir, "voices", "directory.wav"), { recursive: true });
      const voice = {
        id: "directory",
        name: "Directory",
        clip: "voices/directory.wav",
        description: "low",
        attributes: ["low"],
        consent: true,
        created: CLOCK(),
      };
      assert.equal(await clipFor(store, voice), null);
    });
  });

  it("refuses a truncated WAV even when its prefix and extension look right", async () => {
    await withWorld("arke-clone-truncated-", async ({ store, source }) => {
      await writeFile(source, Buffer.from("RIFF\u0008\u0000\u0000\u0000WAVE\u0000", "binary"));
      const made = await cloneVoice(store, [], {
        sourcePath: source,
        name: "Truncated",
        description: "Low and dry.",
        consent: true,
      });
      assert.ok(!made.ok);
      assert.match(made.reason, /not wav audio|incomplete/);
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

  it("serialises concurrent same-name clones without crossing their source bytes", async () => {
    await withWorld("arke-clone-race-", async ({ store, dir, source }) => {
      const firstBytes = await readFile(toExtendedLength(source));
      const secondBytes = Buffer.from(firstBytes);
      secondBytes[secondBytes.length - 1] = 0x7f;
      const secondSource = join(await tempDir("arke-clone-race-source-"), "recording.wav");
      await writeFile(toExtendedLength(secondSource), secondBytes);

      const recordings = [
        { sourcePath: source, bytes: firstBytes },
        { sourcePath: secondSource, bytes: secondBytes },
      ];
      const attempts = Array.from({ length: 12 }, (_, index) => {
        const recording = recordings[index % recordings.length]!;
        return {
          recording,
          outcome: cloneVoice(store, [], {
            sourcePath: recording.sourcePath,
            name: "Concurrent glass",
            description: `Concurrent source ${index % recordings.length === 0 ? "one" : "two"}.`,
            consent: true,
          }),
        };
      });
      const outcomes = await Promise.all(attempts.map((attempt) => attempt.outcome));

      assert.ok(
        outcomes.every((outcome) => outcome.ok),
        "every racing clone commits",
      );
      const voices = outcomes.map((outcome) => {
        assert.ok(outcome.ok);
        return outcome.voice;
      });
      assert.equal(new Set(voices.map((voice) => voice.id)).size, voices.length, "every clip id is distinct");

      const artifacts = new Map(store.getBundle().artifacts.map((artifact) => [artifact.id, artifact]));
      for (const [index, voice] of voices.entries()) {
        const sourceBytes = attempts[index]!.recording.bytes;
        const expectedHash = `sha256:${createHash("sha256").update(sourceBytes).digest("hex").slice(0, 16)}`;
        const artifact = artifacts.get(voice.artifactId ?? "");
        assert.ok(artifact, `${voice.id} resolves its artifact metadata`);
        assert.equal(artifact.hash, expectedHash, `${voice.id} metadata hashes its own source`);
        const provenanceBytes = await readFile(toExtendedLength(join(dir, "artifacts", artifact.file)));
        assert.equal(
          `sha256:${createHash("sha256").update(provenanceBytes).digest("hex").slice(0, 16)}`,
          artifact.hash,
          `${voice.id} provenance media matches its metadata`,
        );
        assert.deepEqual(
          await readFile(toExtendedLength(join(dir, voice.clip))),
          sourceBytes,
          `${voice.id} keeps its own source bytes`,
        );
      }
    });
  });

  it("serialises same-name normal filing with clone provenance", async () => {
    await withWorld("arke-clone-filing-race-", async ({ store, dir, source }) => {
      const cloneBytes = await readFile(toExtendedLength(source));
      const normalBytes = Buffer.from(cloneBytes);
      normalBytes[normalBytes.length - 1] = 0x55;
      const normalSource = join(await tempDir("arke-clone-filing-source-"), "harbour-glass.wav");
      await writeFile(toExtendedLength(normalSource), normalBytes);

      let releaseClone!: () => void;
      const cloneHeld = new Promise<void>((resolve) => {
        releaseClone = resolve;
      });
      let cloneStaged!: () => void;
      const staged = new Promise<void>((resolve) => {
        cloneStaged = resolve;
      });
      let filingQueued!: () => void;
      const queued = new Promise<void>((resolve) => {
        filingQueued = resolve;
      });
      const gateOp = store.gateOp.bind(store);
      let gateCalls = 0;
      store.gateOp = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = gateOp(operation);
        gateCalls += 1;
        if (gateCalls === 2) filingQueued();
        return result;
      };

      const cloning = cloneVoice(
        store,
        [],
        { sourcePath: source, name: "Harbour glass", description: "Low and dry.", consent: true },
        {
          afterArtifactFiled: async () => {
            cloneStaged();
            await cloneHeld;
          },
        },
      );
      await staged;
      const filing = fileArtifact(store, { sourcePath: normalSource });
      await queued;
      releaseClone();

      const [made, filed] = await Promise.all([cloning, filing]);
      assert.ok(made.ok);
      assert.equal(filed.outcome, "filed");
      assert.equal(
        filed.artifact.file,
        "harbour-glass-2.wav",
        "the queued filer does not overwrite provenance",
      );

      const artifacts = store
        .getBundle()
        .artifacts.filter(
          (artifact) => artifact.id === made.voice.artifactId || artifact.id === filed.artifact.id,
        );
      assert.equal(artifacts.length, 2);
      for (const artifact of artifacts) {
        const media = await readFile(toExtendedLength(join(dir, "artifacts", artifact.file)));
        assert.equal(
          artifact.hash,
          `sha256:${createHash("sha256").update(media).digest("hex").slice(0, 16)}`,
          `${artifact.file} metadata and media stay paired`,
        );
      }
      assert.deepEqual(
        await readFile(toExtendedLength(join(dir, "artifacts", filed.artifact.file))),
        normalBytes,
      );
    });
  });

  it("serialises clone provenance behind an in-flight normal filing", async () => {
    await withWorld("arke-filing-clone-race-", async ({ store, dir, source }) => {
      const cloneBytes = await readFile(toExtendedLength(source));
      const normalBytes = Buffer.from(cloneBytes);
      normalBytes[normalBytes.length - 1] = 0x33;
      const normalSource = join(await tempDir("arke-filing-clone-source-"), "harbour-glass.wav");
      await writeFile(toExtendedLength(normalSource), normalBytes);

      let releaseFiling!: () => void;
      const filingHeld = new Promise<void>((resolve) => {
        releaseFiling = resolve;
      });
      let filingEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        filingEntered = resolve;
      });
      const gateOp = store.gateOp.bind(store);
      let gateCalls = 0;
      store.gateOp = <T>(operation: () => Promise<T>): Promise<T> => {
        gateCalls += 1;
        if (gateCalls !== 1) return gateOp(operation);
        return gateOp(async () => {
          filingEntered();
          await filingHeld;
          return operation();
        });
      };

      const filing = fileArtifact(store, { sourcePath: normalSource });
      await entered;
      const cloning = cloneVoice(store, [], {
        sourcePath: source,
        name: "Harbour glass",
        description: "Low and dry.",
        consent: true,
      });
      releaseFiling();

      const [filed, made] = await Promise.all([filing, cloning]);
      assert.equal(filed.outcome, "filed");
      assert.ok(made.ok);
      const provenance = store
        .getBundle()
        .artifacts.find((artifact) => artifact.id === made.voice.artifactId);
      assert.ok(provenance);
      assert.equal(provenance.file, "harbour-glass-2.wav");
      for (const artifact of [filed.artifact, provenance]) {
        const media = await readFile(toExtendedLength(join(dir, "artifacts", artifact.file)));
        assert.equal(
          artifact.hash,
          `sha256:${createHash("sha256").update(media).digest("hex").slice(0, 16)}`,
        );
      }
    });
  });

  it("does not reuse provenance metadata whose media no longer matches its hash", async () => {
    await withWorld("arke-clone-mismatched-provenance-", async ({ store, dir, source }) => {
      const filed = await fileArtifact(store, { sourcePath: source });
      assert.equal(filed.outcome, "filed");
      await writeFile(toExtendedLength(join(dir, "artifacts", filed.artifact.file)), "different bytes");

      const made = await cloneVoice(store, [], {
        sourcePath: source,
        name: "Hash guarded",
        description: "Low and dry.",
        consent: true,
      });

      assert.ok(made.ok);
      assert.notEqual(made.voice.artifactId, filed.artifact.id);
      const artifact = store
        .getBundle()
        .artifacts.find((candidate) => candidate.id === made.voice.artifactId);
      assert.ok(artifact);
      const media = await readFile(toExtendedLength(join(dir, "artifacts", artifact.file)));
      assert.equal(artifact.hash, `sha256:${createHash("sha256").update(media).digest("hex").slice(0, 16)}`);
    });
  });
});

/**
 * How long a clip runs, from its own header (SPEC-022 T-10). Staging refuses a clip that is too
 * short to clone from, and this is the only reading it gets to make that call on.
 */
/** A real header: `fmt ` with a byte rate, then a `data` chunk of the requested length. */
function wav({
  byteRate,
  dataBytes,
  extraChunk = false,
}: {
  byteRate: number;
  dataBytes: number;
  extraChunk?: boolean;
}): Uint8Array {
  const parts: number[] = [];
  const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
  const u32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  parts.push(...ascii("RIFF"), ...u32(0), ...ascii("WAVE"));
  // A LIST chunk of odd length, to prove the walk honours the pad byte that follows one.
  if (extraChunk) parts.push(...ascii("LIST"), ...u32(3), 1, 2, 3, 0);
  parts.push(...ascii("fmt "), ...u32(16), 1, 0, 1, 0, ...u32(44100), ...u32(byteRate), 2, 0, 16, 0);
  parts.push(...ascii("data"), ...u32(dataBytes));
  const out = new Uint8Array(parts.length + dataBytes);
  out.set(parts);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}

describe("reading a WAV's length", () => {
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
    // RIFF/WAVE with no chunks behind it: the magic passes, and there is still nothing to measure.
    assert.equal(
      wavSeconds(
        Uint8Array.from([
          0x52,
          0x49,
          0x46,
          0x46,
          8,
          0,
          0,
          0,
          0x57,
          0x41,
          0x56,
          0x45,
          ...Array.from({ length: 64 }, () => 7),
        ]),
      ),
      null,
    );
  });
});
