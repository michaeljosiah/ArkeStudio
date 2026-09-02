import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SubtitleCueSchema,
  cueAtFrame,
  cueOverlaps,
  cueStaleness,
  framesToMs,
  msToFrames,
  parseSubtitles,
  serializeSubtitles,
  textDigest,
  type SubtitleCue,
} from "../src/subtitles.js";

/**
 * Editable timed text (SPEC-038 R-21..R-28; issue #683): cues are whole frames, a file that
 * goes in and comes out at one rate lands on the same frames, rows that cannot be imported are
 * named, and a cited script block that changed marks its cue stale rather than rewriting it.
 */

const SRT = `1
00:00:01,000 --> 00:00:02,500
Hello, harbour.

2
00:00:02,600 --> 00:00:04,040
The bells,
far under.

3
00:00:05,000 --> 00:00:04,000
Backwards.

4
nonsense --> 00:00:06,000
No timing.

5
00:00:07,000 --> 00:00:08,000

`;

const VTT = `WEBVTT

NOTE a comment block
that spans lines

intro
00:01.000 --> 00:02.500 line:90%
<v Maren>Hello, harbour.</v>

00:00:02.600 --> 00:00:04.040
The bells, &amp; more
`;

describe("subtitle cues on the frame grid", () => {
  it("imports SRT rows to whole frames and names the rows it cannot", () => {
    const parsed = parseSubtitles(SRT, "srt", 25);
    assert.deepEqual(parsed.cues, [
      { text: "Hello, harbour.", startFrame: 25, endFrame: 63 },
      { text: "The bells,\nfar under.", startFrame: 65, endFrame: 101 },
    ]);
    assert.deepEqual(parsed.problems, [
      { line: 11, message: "00:00:05,000 --> 00:00:04,000 ends before it starts" },
      { line: 15, message: "nonsense --> 00:00:06,000 is not a subtitle timing" },
      { line: 19, message: "00:00:07,000 --> 00:00:08,000 carries no words" },
    ]);
  });

  it("imports WebVTT, skipping notes and stripping voice tags", () => {
    const parsed = parseSubtitles(VTT, "vtt", 24);
    assert.deepEqual(parsed.cues, [
      { text: "Hello, harbour.", startFrame: 24, endFrame: 60 },
      { text: "The bells, & more", startFrame: 62, endFrame: 97 },
    ]);
    assert.deepEqual(parsed.problems, []);
    assert.deepEqual(parseSubtitles("1\n00:00:01,000 --> 00:00:02,000\nx\n", "vtt", 24).problems, [{ line: 1, message: "a WebVTT file begins with WEBVTT" }]);
  });

  it("round-trips at one frame rate without a frame of drift, in both formats", () => {
    for (const frameRate of [24, 25, 30] as const) {
      const frames = [0, 1, 7, 100, 2399, 86399, 86400];
      for (const frame of frames) {
        assert.equal(msToFrames(framesToMs(frame, frameRate), frameRate), frame, `${frame} at ${frameRate}`);
      }
      const cues: SubtitleCue[] = [
        { id: "cu_a", text: "one", startFrame: 1, endFrame: 7 },
        { id: "cu_b", text: "two\nlines", startFrame: 100, endFrame: 2399 },
      ];
      for (const format of ["srt", "vtt"] as const) {
        const text = serializeSubtitles(cues, format, frameRate);
        const back = parseSubtitles(text, format, frameRate);
        assert.deepEqual(back.problems, []);
        assert.deepEqual(back.cues, cues.map(({ text: words, startFrame, endFrame }) => ({ text: words, startFrame, endFrame })));
      }
    }
    assert.equal(serializeSubtitles([], "vtt", 24), "WEBVTT\n\n");
    assert.match(serializeSubtitles([{ text: "a < b", startFrame: 0, endFrame: 24 }], "vtt", 24), /a &lt; b/);
  });

  it("refuses overlap on one track, finds the cue at a frame, and validates the shape", () => {
    const cues: SubtitleCue[] = [
      { id: "cu_a", text: "one", startFrame: 0, endFrame: 10 },
      { id: "cu_b", text: "two", startFrame: 8, endFrame: 20 },
    ];
    assert.deepEqual(cueOverlaps(cues), ["cues cu_a and cu_b overlap"]);
    assert.deepEqual(cueOverlaps([cues[0]!, { ...cues[1]!, startFrame: 10 }]), []);
    assert.equal(cueAtFrame(cues, 9)?.id, "cu_a");
    assert.equal(cueAtFrame(cues, 25), null);
    assert.equal(SubtitleCueSchema.safeParse({ id: "cu_x", text: "x", startFrame: 5, endFrame: 5 }).success, false);
    assert.equal(SubtitleCueSchema.safeParse({ id: "cu_x", text: "x", startFrame: 5, endFrame: 6, speaker: "maren-kest" }).success, true);
  });

  it("marks a cue stale when its cited block changed, and never rewrites it", () => {
    const cue: SubtitleCue = {
      id: "cu_a",
      text: "The bells, far under.",
      startFrame: 0,
      endFrame: 24,
      citation: { kind: "script", sceneId: "sc_04", blockId: "blk_bells", textDigest: textDigest("The bells, far under.") },
    };
    const scenes = [
      { id: "sc_04", script: { blocks: [{ id: "blk_bells", kind: "dialogue" as const, text: "The bells, far under." }] } },
    ] as unknown as Parameters<typeof cueStaleness>[1]["scenes"];
    assert.deepEqual(cueStaleness(cue, { scenes }), { stale: false });
    const edited = [{ id: "sc_04", script: { blocks: [{ id: "blk_bells", kind: "dialogue" as const, text: "The bells, far above." }] } }] as unknown as typeof scenes;
    assert.deepEqual(cueStaleness(cue, { scenes: edited }), { stale: true, reason: "script block blk_bells changed since this cue was written" });
    assert.equal(cue.text, "The bells, far under.", "the words are the cue's own");
    assert.deepEqual(cueStaleness(cue, { scenes: [] }), { stale: true, reason: "script block blk_bells is no longer in sc_04" });
    assert.deepEqual(cueStaleness({ ...cue, citation: undefined }, { scenes: [] }), { stale: false });
  });
});
