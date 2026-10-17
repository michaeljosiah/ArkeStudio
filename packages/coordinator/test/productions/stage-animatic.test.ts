import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { orderedShots, stageBoardStagings, stageShot, type ClientMessage, type DomainEvent, type SceneRecord } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { prepareBenchSubject, subjectReferenceRouting } from "../../src/bench/subject.js";
import { stageArtifactProblem } from "../../src/productions/stage-playblast.js";
import { STAGE_ANIMATIC_SCHEMA_VERSION } from "../../src/productions/scene-record.js";
import { encodePng, solidImage } from "../../src/references/png.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { tempDir } from "../tmp.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const CLOCK = "2026-10-17T12:00:00.000Z";
const PRODUCTION = "saltlight";
const SCENE_FILE = "04-the-verse-rises";
const SCENE = "sc_04";
// Shots 12 (4 s) and 13 (6 s): a ten-second board.
const MEMBERS = ["sh_12", "sh_13"];

async function file(name: string, bytes: Uint8Array): Promise<string> {
  const dir = await tempDir("stage-animatic-");
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}
const animatic = () => file("animatic.mp4", new Uint8Array([
  0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76,
  0, 0, 0, 9, 0x6d, 0x64, 0x61, 0x74, 0,
]));
const opening = () => file("opening-frame.png", encodePng(solidImage(1280, 720, [20, 40, 60, 255])));

async function harness() {
  const { root } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.listWorlds();
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    mediaProbe: { durationSec: async () => 10, info: async () => ({ durationSec: 10, hasAudio: false, width: 1280, height: 720, frameRate: 30 }) },
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    observeEvent: (event) => events.push(event),
  });
  const send = (msg: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> }).handleClientMessage(msg);
  const bundle = () => provider.openStore()!.getBundle();
  const scene = (): SceneRecord => bundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!.scenes.find((candidate) => candidate.id === SCENE)!;
  const stageShotNamed = async (shotId: string, lift = 0) => {
    const current = orderedShots(scene()).find((candidate) => candidate.id === shotId)!;
    const fresh = stageShot(current, { cast: ["maren-kest"], sets: ["The Vigil"], durationSec: current.durationSec ?? 4 });
    await send({
      kind: "scene-command", worldId: WORLD_ID, productionId: PRODUCTION, sceneFile: SCENE_FILE, sceneId: SCENE, baseVersion: scene().version,
      command: { kind: "edit-stage", shotId, staging: { cast: fresh.cast, sets: fresh.sets, keys: fresh.keys.map((key) => ({ ...key, p: [key.p[0], key.p[1] + lift, key.p[2]] as [number, number, number] })) } },
    });
  };
  const refusals = () => events.filter((event): event is Extract<DomainEvent, { type: "scene.write-refused" }> => event.type === "scene.write-refused");
  const message = async (): Promise<Extract<ClientMessage, { kind: "stage-animatic" }>> => ({
    kind: "stage-animatic", worldId: WORLD_ID, productionId: PRODUCTION, sceneFile: SCENE_FILE, sceneId: SCENE,
    baseVersion: scene().version, members: MEMBERS, stagings: stageBoardStagings(scene(), MEMBERS)!, durationSec: 10, aspect: "16:9", look: "lit",
    sourcePath: await animatic(), openingFrameSourcePath: await opening(),
  });
  return { provider, events, send, bundle, scene, stageShotNamed, refusals, message };
}

describe("a board's cut animatic (issue 1824)", () => {
  it("files the recording and its opening frame and pins them on the scene's boards", async () => {
    const { provider, events, send, bundle, scene, stageShotNamed, refusals, message } = await harness();
    try {
      await stageShotNamed("sh_12");
      await stageShotNamed("sh_13");
      await send(await message());
      assert.deepEqual(refusals(), []);
      const pin = scene().boards?.animatics?.[0];
      assert.ok(pin);
      assert.deepEqual(pin.members, MEMBERS);
      assert.equal(pin.durationSec, 10);
      assert.equal(pin.look, "lit");
      assert.deepEqual(pin.stagings.map((entry) => entry.shotId), MEMBERS);
      const video = bundle().artifacts.find((artifact) => artifact.id === pin.artifactId);
      assert.equal(video?.kind, "video");
      assert.equal(video?.origin.by === "system" ? video.origin.producedBy : "", "stage-board:sh_12,sh_13");
      assert.equal(bundle().artifacts.find((artifact) => artifact.id === pin.openingFrameArtifactId)?.kind, "image");
      assert.equal(events.filter((event) => event.type === "artifact.attached").length, 2);
      assert.ok(bundle().meta.schemaVersion >= STAGE_ANIMATIC_SCHEMA_VERSION, "the pin raises the world past the fence");
      assert.equal(stageArtifactProblem(bundle(), video!), null);

      // Filing again replaces the board's pin rather than adding a second.
      await send(await message());
      assert.equal(scene().boards?.animatics?.length, 1);

      // A light added to the scene's blocking leaves every shot's staging alone and still makes the
      // animatic a picture of another scene.
      const filed = scene().boards!.animatics![0]!;
      await send({ kind: "scene-command", worldId: WORLD_ID, productionId: PRODUCTION, sceneFile: SCENE_FILE, sceneId: SCENE, baseVersion: scene().version,
        command: { kind: "edit-stage", shotId: "sh_12", blocking: { cast: [], sets: [], lights: [{ name: "lamp", kind: "point", colour: "#ffc27a", strength: 10, x: 0, y: 1.5, z: 0 }] } } });
      assert.deepEqual(refusals(), []);
      assert.match(stageArtifactProblem(bundle(), bundle().artifacts.find((artifact) => artifact.id === filed.artifactId)!) ?? "", /stale/, "a shared blocking edit stales it");
      await send(await message());
      assert.equal(scene().boards?.animatics?.[0]?.blockingVersion, scene().blocking?.version, "a fresh filing records the blocking it was drawn over");

      // A shot edit marks the board's animatic stale, and its files stop riding.
      const pinned = scene().boards!.animatics![0]!;
      await stageShotNamed("sh_13", 0.4);
      const after = bundle().artifacts.find((artifact) => artifact.id === pinned.artifactId)!;
      assert.match(stageArtifactProblem(bundle(), after) ?? "", /stale/);
    } finally {
      await provider.close();
    }
  });

  it("refuses a recording of a board that moved while it rendered, filing nothing", async () => {
    const { provider, send, bundle, scene, stageShotNamed, refusals, message } = await harness();
    try {
      await stageShotNamed("sh_12");
      await stageShotNamed("sh_13");
      const stale = await message();
      await stageShotNamed("sh_13", 0.4);
      const shelf = bundle().artifacts.length;
      await send({ ...stale, baseVersion: scene().version });
      assert.match(refusals().at(-1)?.reason ?? "", /moved while the animatic rendered/);
      assert.equal(bundle().artifacts.length, shelf);
      assert.equal(scene().boards?.animatics, undefined);
      await send({ ...(await message()), durationSec: 9 });
      assert.match(refusals().at(-1)?.reason ?? "", /timing or aspect changed/);
    } finally {
      await provider.close();
    }
  });

  it("rides on the board's Bench session as its reference video, with the cut list and the follow line", async () => {
    const { provider, send, bundle, stageShotNamed, refusals, message } = await harness();
    try {
      await stageShotNamed("sh_12");
      await stageShotNamed("sh_13");
      await send(await message());
      assert.deepEqual(refusals(), []);
      // A ten-second route packs shots 12 and 13 as Board A.
      const manifest = { ...SHIPPED_MANIFEST, models: SHIPPED_MANIFEST.models.filter((model) => model.id === "minimax-h3").map((model) => ({ ...model, limits: { ...model.limits, maxDurationSec: 10 } })) };
      const prepared = await prepareBenchSubject(bundle(), {
        productionId: PRODUCTION, sceneId: SCENE, subject: { kind: "board", memberShotIds: MEMBERS }, follow: "camera",
        settings: null, manifest, sources: { read: async () => ({ refused: "No sheet images in this fixture." }), durationSec: async () => 10 },
      });
      assert.ok(prepared.ok, prepared.ok ? "" : prepared.reason);
      if (!prepared.ok) return;
      const video = prepared.prefill.references.find((reference) => reference.kind === "video");
      assert.equal(video?.token, "Video 1");
      assert.match(video?.label ?? "", /^Board [A-Z]+ · animatic$/);
      const brief = prepared.prefill.composer.brief;
      assert.match(brief, /^0\.0–4\.0 s · /m);
      assert.match(brief, /^4\.0–10\.0 s · /m);
      assert.ok(prepared.prefill.composer.activeTokens.includes("Video 1"), "the animatic rides where video references do");
      assert.match(brief, /^References: .*@Video 1 the blockout\.$/m);
      assert.equal(brief.split("\n").at(-1), "Use @Video 1 only for camera position and movement. The figures in it are placeholders; do not copy their poses or body mechanics.");
      assert.equal(prepared.prefill.composer.params.kind === "video" ? prepared.prefill.composer.params.follow : undefined, "camera");
      // Every member storyboarded: the frame sequence would claim the keyframe lane, but an admitted
      // animatic carries the cuts and the camera, so it leads as a playblast does for a shot.
      const frames = MEMBERS.map((shotId, index) => ({ token: `Image ${9 + index}`, kind: "image" as const, source: { source: "artifact" as const, artifactId: video!.source.source === "artifact" ? video!.source.artifactId : "", hash: "sha256:0000000000000000" as const }, label: `Shot ${shotId} · accepted frame`, detail: "visual keyframe", ride: "when-supported" as const, subjectRole: "board-frame" as const }));
      const routed = subjectReferenceRouting([...prepared.prefill.references, ...frames], prepared.prefill.subject, manifest.models[0]!);
      assert.deepEqual(routed.keyframeTokens, []);
      assert.ok(routed.activeTokens.includes("Video 1"));
    } finally {
      await provider.close();
    }
  });
});
