import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMPTY_MUSIC_RECORD,
  keptMusic,
  musicClock,
  musicKindOf,
  MusicRecordSchema,
  musicTitleFrom,
  musicTotalMs,
  musicTrackEdges,
  musicTrackId,
  PICTURE_SHAPE_BASELINE,
  productionShape,
  ProductionMediumSchema,
  BenchMusicParamsSchema,
  ClientMessageSchema,
  clipMusicTrim,
  musicLoudnessLabel,
  MusicSequenceSchema,
  musicSequenceLine,
  musicStanzas,
  musicTakeLabel,
  musicTakesInstrumental,
  musicTakesLength,
  MusicTrackEditSchema,
} from "../src/index.js";

/**
 * A music production's record (SPEC-060 R-1 – R-4, design turn 238): the medium and its kinds,
 * music.json as written, and what the album page reads from it.
 */

// An artifact id is `ar_` and a ULID; each track's take is its own.
const takeOf = (id: string) => `ar_01J9M${[...id].map((char) => char.charCodeAt(0) % 10).join("").padStart(21, "0")}`;
const track = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, source: { artifactId: takeOf(id) }, ...extra });
const artifact = (id: string, durationSec: number) => ({ id: takeOf(id), kind: "audio" as const, file: `${id}.wav`, mediaInfo: { durationSec, hasAudio: true } });

describe("the music medium (R-1)", () => {
  it("is a medium of its own, with no scenes or chapters, its kind its label", () => {
    assert.ok(ProductionMediumSchema.safeParse("music").success);
    for (const [kind, label] of [["album", "Album"], ["single", "Single"], ["soundtrack", "Soundtrack"]] as const) {
      const shape = productionShape({ format: "video", medium: "music", kind });
      assert.equal(shape.isMusic, true);
      assert.equal(shape.hasScenes, false);
      assert.equal(shape.hasChapters, false);
      assert.equal(shape.displayLabel, label);
    }
    assert.equal(productionShape({ format: "video", medium: "video" }).isMusic, false);
  });

  it("reads an album where a kind is missing or unknown", () => {
    assert.equal(musicKindOf({}), "album");
    assert.equal(musicKindOf({ kind: "mixtape" }), "album");
    assert.equal(musicKindOf({ kind: "soundtrack" }), "soundtrack");
  });
});

describe("music.json (R-4)", () => {
  it("defaults the album's loudness to −14 LUFS and holds tracks in order", () => {
    const record = MusicRecordSchema.parse({ version: 1, tracks: [track("one"), track("two", { lyrics: "[verse]\nwords", sections: [{ label: "Verse", atMs: 0 }], trim: { startMs: 0, endMs: 1000 }, fadeInMs: 200, next: { gapMs: 2000 } })] });
    assert.equal(record.loudness, -14);
    assert.deepEqual(record.tracks.map((entry) => entry.id), ["one", "two"]);
    assert.deepEqual(record.tracks[0]!.takes, []);
    assert.deepEqual(EMPTY_MUSIC_RECORD, { version: 1, loudness: -14, tracks: [] });
  });

  it("refuses a track id twice, a trim that ends before it starts, and a key it does not know", () => {
    assert.equal(MusicRecordSchema.safeParse({ version: 1, tracks: [track("one"), track("one")] }).success, false);
    assert.equal(MusicRecordSchema.safeParse({ version: 1, tracks: [track("one", { trim: { startMs: 5000, endMs: 1000 } })] }).success, false);
    assert.equal(MusicRecordSchema.safeParse({ version: 1, tracks: [], heardIn: [] }).success, false, "Heard in is read, never kept (R-14)");
    assert.equal(MusicRecordSchema.safeParse({ version: 1, tracks: [track("one", { next: { gapMs: 1000, crossfadeMs: 1000 } })] }).success, false);
  });
});

describe("what the album page reads", () => {
  it("gives a crossfade to both sides as fades, a gap after the track, and nothing after the last", () => {
    const record = MusicRecordSchema.parse({ version: 1, tracks: [track("a", { next: { crossfadeMs: 3000 } }), track("b", { fadeInMs: 5000, next: { gapMs: 2000 } }), track("c", { next: { gapMs: 2000 } })] });
    assert.deepEqual(musicTrackEdges(record, 0), { fadeInMs: 0, fadeOutMs: 3000, gapMs: 0 });
    assert.deepEqual(musicTrackEdges(record, 1), { fadeInMs: 5000, fadeOutMs: 0, gapMs: 2000 });
    assert.deepEqual(musicTrackEdges(record, 2), { fadeInMs: 0, fadeOutMs: 0, gapMs: 0 });
  });

  it("adds up the tracks inside their trims and the gaps, and says nothing while a length is unknown", () => {
    const record = MusicRecordSchema.parse({ version: 1, tracks: [track("a", { trim: { startMs: 1000, endMs: 61_000 }, next: { gapMs: 2000 } }), track("b")] });
    assert.equal(musicTotalMs(record, [artifact("a", 120), artifact("b", 30)]), 92_000);
    assert.equal(musicTotalMs(record, [artifact("a", 120)]), null);
    assert.equal(musicClock(92_000), "1:32");
    assert.equal(musicClock(3_852_000), "1:04:12");
  });

  it("lists kept music from Bench and the audio drama's music, a song by its words", () => {
    const bench = (id: string, lyrics: string) => ({ id, kind: "audio" as const, file: `${id}.mp3`, generation: { source: "bench", brief: "Slow sea shanty, low strings", params: { kind: "music", lyrics } } });
    const kept = keptMusic([
      bench("ar_song", "[verse]\nhaul on the ropes"),
      bench("ar_tune", ""),
      { id: "ar_cue", kind: "audio" as const, file: "cue.wav", generation: { source: "sound", cue: "music", name: "Harbour reel" } },
      { id: "ar_door", kind: "audio" as const, file: "door.wav", generation: { source: "sound", cue: "sound", name: "Door" } },
      { ...bench("ar_gone", "words"), retiredAt: "2026-10-24T10:00:00Z" },
    ] as never);
    assert.deepEqual(kept.map((entry) => [entry.artifact.id, entry.song, entry.title]), [["ar_song", true, "Slow sea shanty"], ["ar_tune", false, "Slow sea shanty"], ["ar_cue", false, "Harbour reel"]]);
  });

  it("names a track from its brief or its file, and keeps its id unique on the album", () => {
    assert.equal(musicTitleFrom(undefined, "artifacts/tide-caller.wav"), "Tide caller");
    assert.equal(musicTitleFrom("The Drowned Verse, slow", "x.wav"), "The Drowned Verse");
    assert.equal(musicTrackId("The Drowned Verse", []), "the-drowned-verse");
    assert.equal(musicTrackId("The Drowned Verse", ["the-drowned-verse"]), "the-drowned-verse-2");
    assert.equal(musicTrackId("¿?", []), "track");
    // Cut to 48, an id never ends on a separator (codex on PR 2189).
    const long = musicTrackId(`${"a".repeat(47)} song`, []);
    assert.equal(long, "a".repeat(47));
    assert.match(long, /^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it("asks for a music cover square, 1024 on a side (R-5)", () => {
    assert.match(PICTURE_SHAPE_BASELINE.replace(/\s+/g, " "), /A music production's cover .*: 1:1, 1024 × 1024/);
  });
});

describe("a track's composer (238i, R-9)", () => {
  it("asks a length and an instrumental only of a route that keeps them", () => {
    assert.ok(BenchMusicParamsSchema.safeParse({ kind: "music", lyrics: "", count: 3, lengthSec: 180, instrumental: true }).success);
    assert.equal(BenchMusicParamsSchema.safeParse({ kind: "music", lyrics: "", count: 1, lengthSec: 2 }).success, false, "at least three seconds");
    assert.equal(BenchMusicParamsSchema.safeParse({ kind: "music", lyrics: "", count: 1, lengthSec: 301 }).success, false, "at most five minutes");
    assert.equal(BenchMusicParamsSchema.safeParse({ kind: "music", lyrics: "", count: 1, instrumental: false }).success, false, "an instrumental is said, never denied");
    const eleven = { capability: "music", limits: { musicLength: "exact" as const, musicInstrumental: true as const } };
    const ceiling = { capability: "music", limits: {} };
    assert.deepEqual([musicTakesLength(eleven), musicTakesInstrumental(eleven)], [true, true]);
    assert.deepEqual([musicTakesLength(ceiling), musicTakesInstrumental(ceiling)], [false, false]);
    assert.equal(musicTakesLength({ capability: "voice-tts", limits: { musicLength: "exact" } }), false);
  });

  it("keeps its takes with the album's session, and names the chosen one Take n of m", () => {
    const sessionId = "sess_01J9M000000000000000000777";
    const takes = [{ sessionId, takeId: "tk_01J9M000000000000000000701" }, { sessionId, takeId: "tk_01J9M000000000000000000702" }];
    const record = MusicRecordSchema.parse({ version: 1, session: sessionId, tracks: [track("one", { takes })] });
    assert.equal(record.session, sessionId);
    assert.equal(musicTakeLabel(record.tracks[0]!, { generation: { source: "bench", takeId: takes[1]!.takeId } } as never), "Take 2 of 2");
    assert.equal(musicTakeLabel(record.tracks[0]!, { generation: { source: "bench", takeId: "tk_01J9M000000000000000000799" } } as never), null, "a take of another track");
    assert.equal(musicTakeLabel(record.tracks[0]!, undefined), null);
  });

  it("clips a trim to a newly chosen take, and drops one nothing is left of (R-10)", () => {
    assert.deepEqual(clipMusicTrim({ startMs: 1000, endMs: 200_000 }, 150_000), { startMs: 1000, endMs: 150_000 });
    assert.equal(clipMusicTrim({ startMs: 0, endMs: 200_000 }, 150_000), undefined, "the whole take");
    assert.equal(clipMusicTrim({ startMs: 160_000, endMs: 200_000 }, 150_000), undefined);
    assert.deepEqual(clipMusicTrim({ startMs: 1000, endMs: 9000 }, null), { startMs: 1000, endMs: 9000 });
    assert.equal(clipMusicTrim(undefined, 150_000), undefined);
  });
});

describe("the track editor and the sequence (238j, 238k, R-11 – R-13)", () => {
  it("sends a whole edit and a whole sequence, one shape for the page and World Chat", () => {
    assert.ok(MusicTrackEditSchema.safeParse({ trim: null, fadeInMs: 0, fadeOutMs: 8000, sections: [{ label: "Verse", atMs: 18_000 }] }).success);
    assert.equal(MusicTrackEditSchema.safeParse({ trim: null, fadeInMs: 61_000, fadeOutMs: 0, sections: [] }).success, false, "a fade of at most a minute");
    assert.equal(MusicTrackEditSchema.safeParse({ trim: null, fadeInMs: 0, fadeOutMs: 0, sections: [{ label: " ", atMs: 0 }] }).success, false, "a section is named");
    assert.ok(MusicSequenceSchema.safeParse({ loudness: -14, joins: [{ trackId: "one", next: { gapMs: 2000 } }, { trackId: "two", next: null }] }).success);
    assert.equal(MusicSequenceSchema.safeParse({ loudness: -5, joins: [] }).success, false);
    assert.equal(MusicSequenceSchema.safeParse({ loudness: -14, joins: [{ trackId: "one", next: { crossfadeMs: 16_000 } }] }).success, false, "a crossfade of at most 15 s");
    const edit = ClientMessageSchema.safeParse({ kind: "music-track-edit", worldId: "01J9M000000000000000000001", productionId: "songs", trackId: "one", trim: { startMs: 0, endMs: 1000 }, fadeInMs: 0, fadeOutMs: 0, sections: [] });
    assert.ok(edit.success, JSON.stringify(edit.error?.issues));
  });

  it("puts each lyric stanza under its section, its tag gone", () => {
    assert.deepEqual(musicStanzas("[verse]\nUnder the harbour\nsalt in the ledger\n\n[chorus]\r\nHold the verse\n\nAfter the chorus"), [
      { label: "Verse", lines: ["Under the harbour", "salt in the ledger"] },
      { label: "Chorus", lines: ["Hold the verse"] },
      { label: null, lines: ["After the chorus"] },
    ]);
    assert.deepEqual(musicStanzas(undefined), []);
  });

  it("says the sequence as the head and the Export sheet do", () => {
    const record = MusicRecordSchema.parse({ version: 1, tracks: [track("a", { next: { gapMs: 2000 } }), track("b", { next: { crossfadeMs: 3000 } }), track("c", { next: { gapMs: 2000 } }), track("d", { next: { gapMs: 4000 } })] });
    assert.equal(musicSequenceLine(record), "2 gaps · 1 crossfade", "a join after the last track joins nothing");
    assert.equal(musicSequenceLine(MusicRecordSchema.parse({ version: 1, tracks: [track("a", { next: { gapMs: 0 } }), track("b")] })), "Back to back");
    assert.equal(musicLoudnessLabel(-14), "−14 LUFS");
    assert.equal(musicLoudnessLabel(-16.5), "−16.5 LUFS");
  });
});
