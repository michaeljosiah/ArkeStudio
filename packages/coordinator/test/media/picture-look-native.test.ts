import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFfmpegArgs, type EffectAlphaInput, type ExportPlan, type TimelinePictureLook } from "@arke-studio/contracts";
import { createNodeMediaProcessRunner } from "../../src/media/node-media-host.js";

/**
 * The export's look, run (SPEC-038 R-45..R-50).
 *
 * The contracts tests hold the chain's text. This hands it to FFmpeg through `buildFfmpegArgs`, at
 * the frame a portrait film is delivered at, because what went wrong while the chain was being
 * found could only be seen in pixels: a shadow tint that lifted black, grain laid on one colour,
 * and a strip of black down the right edge of a frame 1080 wide, which is not a multiple of 16.
 * Flat frames are enough to see each of them. Both ways a film's picture is made are run, since
 * the look joins them where they meet: 4:2:0 from a plain cut, planar RGB from the compositor.
 *
 * The frames are read as the 4:2:0 the encoder is handed, plane by plane. Read back through RGB,
 * FFmpeg's own conversion moves a level or two and the figures here would be about that.
 */

const ffmpeg = process.env["ARKE_FFMPEG"] ?? "ffmpeg";
const media = createNodeMediaProcessRunner({ ffmpeg, ffprobe: process.env["ARKE_FFPROBE"] ?? "ffprobe" });
const signal = () => new AbortController().signal;
const version = await media.run("ffmpeg", ["-version"], { signal: signal(), timeoutMs: 10000, maxStdoutBytes: 65536, maxStderrBytes: 16384 });
const available = version.code === 0;

const WIDTH = 1080, HEIGHT = 1920, RATE = 24, FRAMES = 2, PIXELS = WIDTH * HEIGHT, FRAME_BYTES = PIXELS * 3 / 2;
/** Black and neutral in video levels: brightness runs from 16, and 128 is no colour. */
const BLACK_LEVEL = 16, NEUTRAL = 128;

async function run(args: string[]): Promise<Uint8Array> {
  const result = await media.run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", ...args], {
    signal: signal(), timeoutMs: 120000, maxStdoutBytes: FRAMES * FRAME_BYTES + 4096, maxStderrBytes: 16384,
  });
  assert.equal(result.code, 0, result.stderr); return result.stdout;
}

const film = (items: ExportPlan["items"], pictureLook?: TimelinePictureLook): ExportPlan =>
  ({ preset: "vertical-master", frameRate: RATE, items, overlays: [], audio: [], totalSec: FRAMES / RATE, ...(pictureLook ? { pictureLook } : {}) });
const BLACK: ExportPlan["items"] = [{ type: "black", durationSec: FRAMES / RATE }];
const GREY: ExportPlan["items"] = [{ type: "clip", path: "grey.mkv", durationSec: FRAMES / RATE, label: "grey" }];
/** The same grey as a still the compositor places, so the look meets the picture in planar RGB. */
const composited = (pictureLook: TimelinePictureLook): ExportPlan => ({ ...film([], pictureLook),
  effectRender: { rendererVersion: "software-rgba-v2", width: WIDTH, height: HEIGHT, frameRate: RATE, startFrame: 0, endFrame: FRAMES, effectLayers: [], issues: [], pictureLayers: [
    { clipId: "grey", trackId: "picture", order: 0, kind: "media", label: "grey", path: "grey.png", still: true, startFrame: 0, endFrame: FRAMES,
      sourceInSec: 0, sourceSize: { width: WIDTH, height: HEIGHT }, fit: "contain", matte: "source-alpha" }] } });

/** The film's frames as raw 4:2:0 on the pipe. `-crf` stays in the arguments and means nothing to raw video. */
async function exported(plan: ExportPlan, dir: string, alpha?: readonly EffectAlphaInput[]): Promise<Uint8Array> {
  const args = alpha === undefined ? buildFfmpegArgs(plan, dir, "pipe:1", "unused.ttf") : buildFfmpegArgs(plan, dir, "pipe:1", "unused.ttf", alpha);
  args.splice(args.length - 1, 0, ...(args.includes("-pix_fmt") ? [] : ["-pix_fmt", "yuv420p"]), "-c:v", "rawvideo", "-f", "rawvideo");
  const bytes = await run(args);
  assert.equal(bytes.length, FRAMES * FRAME_BYTES);
  return bytes;
}

const brightness = (bytes: Uint8Array, frame: number) => bytes.subarray(frame * FRAME_BYTES, frame * FRAME_BYTES + PIXELS);
const colour = (bytes: Uint8Array, frame: number) => bytes.subarray(frame * FRAME_BYTES + PIXELS, (frame + 1) * FRAME_BYTES);
/** One frame's brightness: each column averaged down the frame, the frame's mean, and how far it spreads about it. */
function levels(bytes: Uint8Array, frame: number): { columns: number[]; mean: number; spread: number } {
  const plane = brightness(bytes, frame), columns = Array.from({ length: WIDTH }, () => 0);
  let sum = 0, squares = 0;
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const value = plane[y * WIDTH + x]!;
    columns[x]! += value; sum += value; squares += value * value;
  }
  const mean = sum / PIXELS;
  return { columns: columns.map(total => total / HEIGHT), mean, spread: Math.sqrt(Math.max(0, squares / PIXELS - mean * mean)) };
}
/** How far the worst of the last sixteen columns sits from the frame: eight of them were black when the edge was lost. */
const edge = (frame: { columns: number[]; mean: number }) => Math.max(...frame.columns.slice(-16).map(column => Math.abs(column - frame.mean)));

test("the export's look keeps black black, reaches the last column of a frame 1080 wide, and lays the same grain twice", { skip: !available }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "arke-picture-look-"));
  try {
    await run(["-y", "-f", "lavfi", "-i", `color=c=gray:s=${WIDTH}x${HEIGHT}:r=${RATE}`, "-frames:v", "4", "-c:v", "ffv1", join(dir, "grey.mkv")]);
    await run(["-y", "-f", "lavfi", "-i", `color=c=gray:s=${WIDTH}x${HEIGHT}`, "-frames:v", "1", join(dir, "grey.png")]);

    // Black. The grade alone leaves every sample of it where it was: no lift, and no colour.
    const gradedBlack = await exported(film(BLACK, { grade: "film" }), dir);
    for (let frame = 0; frame < FRAMES; frame++) {
      assert.ok(brightness(gradedBlack, frame).every(value => value === BLACK_LEVEL), "graded black is black");
      assert.ok(colour(gradedBlack, frame).every(value => value === NEUTRAL), "and has no colour");
    }
    // Grain over it adds no colour. Light never lifts it. Medium lifts a pixel here and there by
    // one level, the least a frame can hold, where the plate is at its brightest: overlay leaves
    // black alone when black is 0, and in video levels it is 16.
    for (const grain of ["light", "medium"] as const) {
      const black = await exported(film(BLACK, { grade: "film", grain }), dir);
      let lifted = 0, highest = 0;
      for (let frame = 0; frame < FRAMES; frame++) {
        assert.ok(colour(black, frame).every(value => value === NEUTRAL), `${grain} grain adds no colour to black`);
        for (const value of brightness(black, frame)) { if (value > BLACK_LEVEL) lifted++; if (value > highest) highest = value; }
      }
      if (grain === "light") assert.equal(highest <= BLACK_LEVEL, true, `light grain lifted black to ${highest}`);
      else assert.ok(highest <= BLACK_LEVEL + 1 && lifted / (FRAMES * PIXELS) < 0.0005, `medium grain lifted ${lifted} pixels of black, as far as ${highest}`);
    }

    // Mid-grey through a plain cut, where the picture reaches the look in 4:2:0.
    const flat = levels(await exported(film(GREY), dir), 0);
    assert.equal(flat.spread, 0, "the source is flat");
    const graded = await exported(film(GREY, { grade: "film" }), dir), gradedGrey = levels(graded, 0);
    // The grade's blur is where the right edge was lost. A flat frame comes out flat, to its last column.
    assert.equal(gradedGrey.spread, 0, "a flat frame is still flat once graded");
    assert.equal(edge(gradedGrey), 0, "and its last columns are the grey the rest is");
    assert.ok(Math.abs(gradedGrey.mean - flat.mean) <= 3, `mid-grey stays mid-grey: ${flat.mean} to ${gradedGrey.mean}`);

    const both: TimelinePictureLook = { grade: "film", grain: "medium" };
    const first = await exported(film(GREY, both), dir), second = await exported(film(GREY, both), dir);
    assert.equal(Buffer.compare(first, second), 0, "the same film exports the same grain twice");
    const grained = levels(first, 0);
    assert.ok(grained.spread > 2, `the grain moves mid-grey: spread ${grained.spread}`);
    assert.ok(Math.abs(grained.mean - gradedGrey.mean) <= 3, `and leaves its level: ${gradedGrey.mean} to ${grained.mean}`);
    assert.ok(edge(grained) < 1.5, `the grain reaches the last column: ${edge(grained)} from the frame's level`);
    // It changes every frame, and it is laid on brightness alone: the colour planes are the graded film's.
    const one = brightness(first, 0), two = brightness(first, 1);
    let moved = 0;
    for (let index = 0; index < PIXELS; index++) if (one[index] !== two[index]) moved++;
    assert.ok(moved / PIXELS > 0.5, `${moved} of ${PIXELS} pixels differ between two frames`);
    for (let frame = 0; frame < FRAMES; frame++) assert.equal(Buffer.compare(colour(first, frame), colour(graded, frame)), 0, "the grain adds no colour");
    const light = levels(await exported(film(GREY, { grain: "light" }), dir), 0);
    assert.ok(light.spread > 1 && light.spread < grained.spread, `light grain is finer than medium: ${light.spread} and ${grained.spread}`);
    assert.ok(edge(light) < 1.5);

    // The same grey from the compositor, which hands the look planar RGB.
    for (const value of [{ grade: "film" }, { grain: "medium" }, both] as TimelinePictureLook[]) {
      const drawn = levels(await exported(composited(value), dir, []), 0);
      assert.ok(edge(drawn) < 1.5, `${JSON.stringify(value)} reaches the compositor's last column: ${edge(drawn)}`);
      assert.ok(Math.abs(drawn.mean - flat.mean) <= 4, `${JSON.stringify(value)} keeps the compositor's mid-grey: ${drawn.mean}`);
      assert.equal(drawn.spread > 2, value.grain !== undefined);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
