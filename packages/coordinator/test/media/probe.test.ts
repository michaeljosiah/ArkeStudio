import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ffprobeArgs, parseFfprobeJson } from "../../src/media/probe.js";

/**
 * Parsing ffprobe (#253). Every field is checked rather than cast, because ffprobe reports
 * `duration` and `sample_rate` as strings, omits duration entirely for some containers, and a
 * cast turns each of those into a NaN that reads downstream as a real measurement.
 */
describe("reading what a media file actually is (#253)", () => {
  const answer = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      streams: [
        { codec_type: "video", channels: null, sample_rate: null },
        { codec_type: "audio", channels: 2, sample_rate: "48000" },
      ],
      format: { duration: "222.140000" },
      ...over,
    });

  it("reads a duration and audio shape out of ffprobe's JSON", () => {
    assert.deepEqual(parseFfprobeJson(answer()), {
      durationSec: 222.14,
      hasAudio: true,
      audioChannels: 2,
      audioSampleRateHz: 48000,
    });
  });

  it("says a silent file is silent rather than assuming a track", () => {
    const silent = parseFfprobeJson(JSON.stringify({ streams: [{ codec_type: "video" }], format: { duration: "8.0" } }));
    assert.deepEqual(silent, { durationSec: 8, hasAudio: false });
  });

  it("answers null for everything it cannot honestly measure", () => {
    assert.equal(parseFfprobeJson(""), null, "no output at all");
    assert.equal(parseFfprobeJson("ffprobe version 7.1"), null, "prose, not JSON");
    assert.equal(parseFfprobeJson(answer({ format: {} })), null, "a container with no duration");
    assert.equal(parseFfprobeJson(answer({ format: { duration: "N/A" } })), null, "ffprobe's own unknown");
    assert.equal(parseFfprobeJson(answer({ format: { duration: "0" } })), null, "a zero-length file is unmeasured");
    assert.equal(parseFfprobeJson(answer({ format: { duration: "-3" } })), null);
    assert.equal(parseFfprobeJson("null"), null);
  });

  it("drops implausible channel and rate values rather than reporting them", () => {
    // A partly-written download reports exactly this shape, and a zero sample rate downstream is
    // a filter graph that fails at export rather than a measurement that refused itself here.
    const odd = parseFfprobeJson(
      JSON.stringify({ streams: [{ codec_type: "audio", channels: 0, sample_rate: "0" }], format: { duration: "5" } }),
    );
    assert.deepEqual(odd, { durationSec: 5, hasAudio: true });
  });

  it("asks ffprobe for JSON and named entries, never for prose", () => {
    const args = ffprobeArgs("C:/w/artifacts/forgive-me.mp3");
    assert.deepEqual(args.slice(0, 2), ["-v", "error"]);
    assert.ok(args.includes("json"), "localized human output changes between versions and locales");
    assert.equal(args.at(-1), "C:/w/artifacts/forgive-me.mp3", "the path is the last argument, never interpolated");
  });
});
