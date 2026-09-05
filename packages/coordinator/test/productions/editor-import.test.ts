import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  applyTimelineCommands, audioGainDbAt, buildFfmpegArgs, buildRenderPlan, detachAudioCommands, effectiveAudioRole,
  mediaPlacementCommands, seedEmptyPictureTimeline, storyTimelineFingerprint, type ProductionBundle,
} from "@arke-studio/contracts";
import { createHash } from "node:crypto";
import { acceptTake, setTrim } from "../../src/takes/review.js";
import { importEditorMedia } from "../../src/productions/editor-import.js";
import { applyTimelineCommand } from "../../src/productions/timeline.js";
import { createProduction } from "../../src/productions/ops.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import type { MediaProbe } from "../../src/media/probe.js";

const probe: MediaProbe = { async durationSec() { return 3; }, async info() { return { durationSec: 3, hasAudio: true }; } };
function saved(production: ProductionBundle) {
  assert.equal(production.timeline?.status, "ready");
  if (production.timeline?.status !== "ready") throw new Error("Missing timeline");
  return production.timeline.timeline;
}

it("imports a zero-scene film, detaches a trimmed video's sound, edits it independently, and reopens with durable undo", async t => {
  const dir = await makeTempWorld();
  let store = await WorldStore.open(dir); t.after(() => store.close());
  const id = await createProduction(store, { title: "Personal footage", medium: "video", frameRate: 24 });
  const production = () => store.getBundle().productions.find(p => p.meta.id === id)!;
  const first = join(dir, "first.mp4"), second = join(dir, "second.mp4");
  await writeFile(first, "first video"); await writeFile(second, "second video");
  assert.deepEqual(production().scenes, []);
  assert.deepEqual(await importEditorMedia(store, [first, second], {
    productionId: id, baseRevision: null, sourceFingerprint: storyTimelineFingerprint(production()), destination: "append",
  }, { mediaProbe: probe, abandoned: () => false }), []);
  let timeline = saved(production());
  const picture = timeline.tracks.find(track => track.id === "tr_picture")!;
  assert.deepEqual(picture.clips.map(clip => [clip.startFrame, clip.durationFrames]), [[0, 72], [72, 72]]);
  assert.equal(timeline.library.length, 2);
  await unlink(first);
  const artifact = store.getBundle().artifacts.find(a => picture.clips[0]!.source.kind === "artifact" && a.id === picture.clips[0]!.source.artifactId)!;
  assert.equal(await readFile(join(dir, "artifacts", artifact.file), "utf8"), "first video");
  const write = async (commands: Parameters<typeof applyTimelineCommands>[1]) => applyTimelineCommand(store, id, {
    kind: "commands", commands, baseRevision: saved(production()).revision, sourceFingerprint: storyTimelineFingerprint(production()),
  });
  await write([{ kind: "trim", clipId: picture.clips[0]!.id, edge: "start", deltaFrames: 12 }]);
  await write([{ kind: "detach-audio", clipId: picture.clips[0]!.id, newClipId: "cl_detached" }]);
  timeline = saved(production());
  const detached = timeline.tracks.flatMap(track => track.clips).find(clip => clip.id === "cl_detached")!;
  assert.deepEqual([detached.startFrame, detached.sourceInFrames, detached.durationFrames, detached.role], [12, 12, 60, "unspecified"]);
  assert.equal(timeline.tracks[0]!.clips[0]!.audio, "mute");
  assert.equal(detached.linkedClipId, undefined);
  const plan = () => buildRenderPlan({ production: production(), timeline: production().timeline!, artifacts: store.getBundle().artifacts, scope: { kind: "production" }, preset: "review-cut" });
  let rendered = plan(); assert.ok(rendered.ok);
  assert.equal(rendered.plan.audio.length, 2, "detached audio plus the second video's sound, with no doubled first video");
  assert.equal(rendered.plan.audio.find(audio => audio.clipId === "cl_detached")!.sourceInSec, .5);
  const beforeUndo = saved(production());
  await applyTimelineCommand(store, id, { kind: "undo", baseRevision: beforeUndo.revision });
  assert.equal(saved(production()).tracks.flatMap(track => track.clips).some(clip => clip.id === "cl_detached"), false);
  assert.equal(saved(production()).tracks[0]!.clips[0]!.audio, "keep");
  await applyTimelineCommand(store, id, { kind: "redo", baseRevision: saved(production()).revision });
  await write([{ kind: "split", clipId: "cl_detached", atFrame: 36, newClipId: "cl_sound-right" }]);
  await write([{ kind: "move-to-frame", clipId: "cl_sound-right", startFrame: 100 }, { kind: "trim", clipId: "cl_sound-right", edge: "end", deltaFrames: -12 }]);
  rendered = plan(); assert.ok(rendered.ok);
  const right = rendered.plan.audio.find(audio => audio.clipId === "cl_sound-right")!;
  assert.equal(right.sourceInSec, 1.5); assert.equal(right.startSec, 100 / 24); assert.equal(right.endSec, 124 / 24);
  assert.equal(saved(production()).tracks[0]!.clips[0]!.startFrame, 12, "sound edits leave picture fixed");
  const beforeClose = saved(production());
  await store.close(); store = await WorldStore.open(dir);
  assert.deepEqual(saved(production()), beforeClose);
  await applyTimelineCommand(store, id, { kind: "undo", baseRevision: saved(production()).revision });
  assert.equal(saved(production()).tracks.flatMap(track => track.clips).find(clip => clip.id === "cl_sound-right")!.startFrame, 36);
});

it("preserves filed media on a stale import and reports partial filing without changing prior clips", async t => {
  const dir = await makeTempWorld(), store = await WorldStore.open(dir); t.after(() => store.close());
  const id = await createProduction(store, { title: "Import fences", medium: "video" });
  const p = () => store.getBundle().productions.find(p => p.meta.id === id)!;
  const source = join(dir, "clip.mp4"); await writeFile(source, "video");
  const editor = { productionId: id, baseRevision: null, sourceFingerprint: storyTimelineFingerprint(p()), destination: "append" as const };
  let changed = false;
  const competing: MediaProbe = { ...probe, async info() {
    if (!changed) {
      changed = true;
      await applyTimelineCommand(store, id, { kind: "commands", commands: [{ kind: "add-track", trackId: "tr_kept", trackKind: "audio", name: "Keep me" }],
        baseRevision: null, sourceFingerprint: editor.sourceFingerprint });
    }
    return { durationSec: 3, hasAudio: true };
  } };
  await assert.rejects(importEditorMedia(store, [source], editor, { mediaProbe: competing, abandoned: () => false }), /Files were saved.*timeline was unchanged/);
  assert.ok(saved(p()).tracks.some(track => track.id === "tr_kept"));
  assert.equal(saved(p()).library.length, 0);
  const filed = store.getBundle().artifacts.find(a => a.file.includes("clip.mp4"))!;
  assert.ok(filed);
  const failures = await importEditorMedia(store, [source, join(dir, "missing.mp4")], {
    ...editor, baseRevision: saved(p()).revision,
  }, { mediaProbe: probe, abandoned: () => false });
  assert.equal(failures.length, 1); assert.match(failures[0]!.reason, /missing/);
  assert.equal(saved(p()).library[0]!.kind, "artifact");
  assert.equal(store.getBundle().artifacts.filter(a => a.id === filed.id).length, 1, "reimport deduplicates");
  const revision = saved(p()).revision;
  await importEditorMedia(store, [], { ...editor, baseRevision: revision }, { mediaProbe: probe, abandoned: () => false });
  assert.equal(saved(p()).revision, revision, "cancel/no selection writes nothing");
});


it("detaches the live accepted take and selection trim even when the renderer's timeline revision is current", async t => {
  const dir = await makeTempWorld();
  const firstId = "tk_01J8F0000000000000000000B2", nextId = "tk_01J8F0000000000000000000B3";
  const takesDir = join(dir, "productions", "saltlight", "takes");
  const first = JSON.parse(await readFile(join(takesDir, firstId, "take.json"), "utf8"));
  for (const id of [firstId, nextId]) {
    const folder = join(takesDir, id), bytes = Buffer.from(id);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "take.json"), JSON.stringify({ ...first, id }));
    await writeFile(join(folder, "clip.mp4"), bytes);
    await writeFile(join(folder, "media-info.json"), JSON.stringify({ sourceHash: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      mediaInfo: { durationSec: 6, hasAudio: true }, probedAt: "2026-09-06T00:00:00Z" }));
  }
  const store = await WorldStore.open(dir); t.after(() => store.close());
  const p = () => store.getBundle().productions.find(production => production.meta.id === "saltlight")!;
  await applyTimelineCommand(store, "saltlight", { kind: "commands", baseRevision: null, sourceFingerprint: storyTimelineFingerprint(p()), commands: [
    { kind: "place", trackId: "tr_picture", clip: { id: "cl_live", startFrame: 0, durationFrames: 24, sourceInFrames: 0,
      source: { kind: "shot", shotId: "sh_12", sceneNumber: 1, shotNumber: 2, label: "Live shot" }, audio: "keep" } },
  ] });
  const stale = p(), revision = saved(stale).revision;
  assert.doesNotThrow(() => detachAudioCommands(stale, saved(stale), store.getBundle().artifacts, "cl_live", "cl_preview"));
  await acceptTake(store, p(), { takeId: nextId, shotId: "sh_12", by: "user" });
  await setTrim(store, p(), { shotId: "sh_12", trimInSec: .213 });
  assert.equal(saved(p()).revision, revision, "selection changes have no timeline revision fence");
  await applyTimelineCommand(store, "saltlight", { kind: "commands", baseRevision: revision, sourceFingerprint: storyTimelineFingerprint(stale),
    commands: [{ kind: "detach-audio", clipId: "cl_live", newClipId: "cl_current-sound" }] });
  const timeline = saved(p()), sound = timeline.tracks.flatMap(track => track.clips).find(clip => clip.id === "cl_current-sound")!;
  assert.deepEqual(sound.source, { kind: "take", takeId: nextId, label: "Live shot", offsetSec: .213 });
  assert.equal(timeline.tracks[0]!.clips[0]!.audio, "mute");
  await applyTimelineCommand(store, "saltlight", { kind: "undo", baseRevision: timeline.revision });
  assert.equal(saved(p()).tracks[0]!.clips[0]!.audio, "keep");
  assert.equal(saved(p()).tracks.flatMap(track => track.clips).some(clip => clip.id === sound.id), false);
});

it("remeasures an unmeasured duplicate before appending it", async t => {
  const dir = await makeTempWorld(), store = await WorldStore.open(dir); t.after(() => store.close());
  const id = await createProduction(store, { title: "Remeasure", medium: "video", frameRate: 24 });
  const p = () => store.getBundle().productions.find(production => production.meta.id === id)!;
  const source = join(dir, "unmeasured.mp4"); await writeFile(source, "once unavailable");
  const editor = { productionId: id, baseRevision: null, sourceFingerprint: storyTimelineFingerprint(p()), destination: "library" as const };
  await importEditorMedia(store, [source], editor, { abandoned: () => false });
  const libraryId = saved(p()).library[0]!;
  let probes = 0;
  await importEditorMedia(store, [source], { ...editor, baseRevision: saved(p()).revision, destination: "append" }, {
    abandoned: () => false, mediaProbe: { ...probe, async info() { probes++; return { durationSec: 3, hasAudio: true }; } },
  });
  assert.equal(probes, 1);
  assert.equal(saved(p()).tracks[0]!.clips[0]!.durationFrames, 72);
  assert.deepEqual(saved(p()).library, [libraryId], "reuse the same artifact identity");
});

it("plans imports after legacy cut migration reserves its audio track ids", async t => {
  const dir = await makeTempWorld(), store = await WorldStore.open(dir); t.after(() => store.close());
  const p = () => store.getBundle().productions.find(production => production.meta.id === "saltlight")!;
  const artifact = store.getBundle().artifacts.find(item => item.kind === "audio")!; assert.ok(artifact);
  await store.commit({ kind: "test-cut", source: "test", files: [{ path: "productions/saltlight/cut.json", action: "create", baseHash: null,
    content: JSON.stringify({ audio: [
      { kind: "score", label: "Existing score", entries: [{ artifactId: artifact.id }] },
      { kind: "ambience", label: "Existing ambience", entries: [{ artifactId: artifact.id }] },
    ], overlays: [] }) }] });
  const source = join(dir, "new.wav"); await writeFile(source, "new sound");
  await importEditorMedia(store, [source], { productionId: "saltlight", baseRevision: null, sourceFingerprint: storyTimelineFingerprint(p()), destination: "append" },
    { mediaProbe: probe, abandoned: () => false });
  const timeline = saved(p());
  assert.equal(timeline.migratedCut, true);
  assert.deepEqual(timeline.tracks.filter(track => track.id.startsWith("tr_audio-")).map(track => [track.id, track.name, track.clips.length]),
    [["tr_audio-0", "Existing score", 1], ["tr_audio-1", "Existing ambience", 1], ["tr_audio-2", "Audio 2", 1]]);
});

it("roles are per clip, track defaults affect future placements only, and legacy mixes remain meaningful", async t => {
  const dir = await makeTempWorld(), store = await WorldStore.open(dir); t.after(() => store.close());
  const p = store.getBundle().productions[0]!;
  let timeline = seedEmptyPictureTimeline(p);
  const source = { kind: "artifact" as const, artifactId: "ar_01J8G0000000000000000R1", label: "sound.wav" };
  // Use a filed id from the fixture so the schema and renderer see the same identity.
  source.artifactId = store.getBundle().artifacts[0]!.id;
  timeline = applyTimelineCommands(timeline, [
    { kind: "add-track", trackId: "tr_audio", trackKind: "audio", name: "Audio 1" },
    { kind: "place", trackId: "tr_audio", clip: { id: "cl_neutral", startFrame: 0, durationFrames: 24, sourceInFrames: 0, source } },
    { kind: "set-track", trackId: "tr_audio", defaultRole: "music" },
    { kind: "place", trackId: "tr_audio", clip: { id: "cl_music", startFrame: 24, durationFrames: 24, sourceInFrames: 0, source } },
    { kind: "place", trackId: "tr_audio", clip: { id: "cl_override", startFrame: 48, durationFrames: 24, sourceInFrames: 0, source, role: "dialogue" } },
  ]);
  const track = timeline.tracks[1]!;
  assert.deepEqual(track.clips.map(clip => effectiveAudioRole(track, clip)), ["unspecified", "music", "dialogue"]);
  assert.equal(effectiveAudioRole({ kind: "music" }, { source }), "music", "legacy sources preserve their track's mix role");
  const mix = { mix: timeline.mix, speech: [{ startSec: 0, endSec: 2 }] };
  assert.equal(audioGainDbAt(mix, { gainDb: 0, role: "unspecified" }, 1), 0);
  assert.equal(audioGainDbAt(mix, { gainDb: 0, role: "music" }, 1), -9);
  assert.throws(() => mediaPlacementCommands(timeline, [{ ...store.getBundle().artifacts[0]!, kind: "video", mediaInfo: undefined }], "append", () => "cl_unknown"), /measured duration/);
});

it("encodes and decodes imported footage with detached, independently edited audio", { skip: !process.env.ARKE_TEST_FFMPEG }, async t => {
  const run = promisify(execFile), ffmpeg = process.env.ARKE_TEST_FFMPEG!;
  const dir = await makeTempWorld(), store = await WorldStore.open(dir); t.after(() => store.close());
  const first = join(dir, "first.mp4"), second = join(dir, "second.mp4");
  for (const [index, path] of [first, second].entries()) {
    await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${index ? "blue" : "red"}:s=320x180:r=24:d=3`,
      "-f", "lavfi", "-i", `sine=frequency=${index ? 880 : 440}:duration=3`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path], { timeout: 30000 });
  }
  const id = await createProduction(store, { title: "Native export", medium: "video", frameRate: 24 });
  const p = () => store.getBundle().productions.find(production => production.meta.id === id)!;
  await importEditorMedia(store, [first, second], {
    productionId: id, baseRevision: null, sourceFingerprint: storyTimelineFingerprint(p()), destination: "append",
  }, { mediaProbe: probe, abandoned: () => false });
  const write = async (commands: Parameters<typeof applyTimelineCommands>[1]) => applyTimelineCommand(store, id, {
    kind: "commands", commands, baseRevision: saved(p()).revision, sourceFingerprint: storyTimelineFingerprint(p()),
  });
  const picture = saved(p()).tracks[0]!.clips[0]!;
  await write([{ kind: "trim", clipId: picture.id, edge: "start", deltaFrames: 12 }]);
  await write([{ kind: "detach-audio", clipId: picture.id, newClipId: "cl_sound" }]);
  await write([{ kind: "split", clipId: "cl_sound", atFrame: 36, newClipId: "cl_sound-right" }]);
  await write([{ kind: "move-to-frame", clipId: "cl_sound-right", startFrame: 100 }, { kind: "trim", clipId: "cl_sound-right", edge: "end", deltaFrames: -12 }]);
  await unlink(first); await unlink(second);
  const result = buildRenderPlan({ production: p(), timeline: p().timeline!, artifacts: store.getBundle().artifacts, scope: { kind: "production" }, preset: "review-cut" });
  assert.ok(result.ok); assert.equal(result.plan.totalSec, 6);
  const output = join(dir, "edited.mp4");
  await run(ffmpeg, ["-v", "error", ...buildFfmpegArgs(result.plan, dir, output, "unused.ttf")], { timeout: 60000, maxBuffer: 1024 * 1024 });
  assert.ok((await readFile(output)).length > 1000);
  await run(ffmpeg, ["-v", "error", "-i", output, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"], { timeout: 30000 });
});
