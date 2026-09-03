import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { orderedShots, stageShot, type ClientMessage, type DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { encodePng, solidImage } from "../../src/references/png.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { tempDir } from "../tmp.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const CLOCK = "2026-08-31T12:00:00.000Z";
const PRODUCTION = "saltlight";
const SCENE_FILE = "04-the-verse-rises";
const SCENE = "sc_04";
const SHOT = "sh_12";

async function playblastFile(bytes = new Uint8Array([
  0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76,
  0, 0, 0, 9, 0x6d, 0x64, 0x61, 0x74, 0,
])): Promise<string> {
  const dir = await tempDir("stage-playblast-");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "playblast.mp4");
  await writeFile(path, bytes);
  return path;
}

async function openingFrameFile(bytes = encodePng(solidImage(16, 9, [20, 40, 60, 255]))): Promise<string> {
  const dir = await tempDir("stage-opening-frame-");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "opening-frame.png");
  await writeFile(path, bytes);
  return path;
}

async function harness() {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.listWorlds();
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    observeEvent: (event) => events.push(event),
  });
  const send = (msg: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> }).handleClientMessage(msg);
  const bundle = () => provider.openStore()!.getBundle();
  const shot = () => {
    const production = bundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    const scene = production.scenes.find((candidate) => candidate.id === SCENE)!;
    return { scene, shot: orderedShots(scene).find((candidate) => candidate.id === SHOT)! };
  };
  /** Stage the shot the way the client does: one versioned edit carrying a fresh v1. */
  const stage = async () => {
    const { scene, shot: current } = shot();
    await send({
      kind: "scene-command",
      worldId: WORLD_ID,
      productionId: PRODUCTION,
      sceneFile: SCENE_FILE,
      sceneId: SCENE,
      baseVersion: scene.version,
      command: {
        kind: "edit-shot",
        shotId: SHOT,
        change: { staging: stageShot(current, { cast: ["maren-kest"], sets: ["The Vigil"], durationSec: 4 }) },
      },
    });
  };
  const refusals = () =>
    events.filter((event): event is Extract<DomainEvent, { type: "scene.write-refused" }> => event.type === "scene.write-refused");
  return { provider, worldDir, events, send, bundle, shot, stage, refusals };
}

describe("filing a playblast from the Stage", () => {
  it("files the bytes as a video artifact on the shot and pins it on the staging, versioned", async () => {
    const { provider, worldDir, send, bundle, shot, stage, refusals, events } = await harness();
    try {
      await stage();
      const staged = shot();
      assert.equal(staged.shot.staging?.version, 1);
      const sceneVersion = staged.scene.version;

      await send({
        kind: "stage-playblast",
        worldId: WORLD_ID,
        productionId: PRODUCTION,
        sceneFile: SCENE_FILE,
        sceneId: SCENE,
        baseVersion: sceneVersion,
        shotId: SHOT,
        durationSec: 4,
        aspect: "16:9",
        stagingVersion: 1,
        sourcePath: await playblastFile(),
        openingFrameSourcePath: await openingFrameFile(),
      });

      assert.deepEqual(refusals(), []);
      const attached = events.filter((event) => event.type === "artifact.attached");
      assert.equal(attached.length, 2, "both files are announced like any other artifact");
      const after = shot();
      const pinned = after.shot.staging?.playblast;
      assert.ok(pinned, "the staging names its playblast");
      assert.equal(pinned.version, 1);
      assert.equal(after.scene.version, sceneVersion + 1, "the pin is a versioned scene write");
      const artifact = bundle().artifacts.find((candidate) => candidate.id === pinned.artifactId);
      assert.ok(artifact, "the pinned id resolves on the shelf");
      assert.equal(artifact.kind, "video");
      assert.match(artifact.file, /\.mp4$/);
      assert.equal(artifact.production, PRODUCTION, "owned by the production, not the world");
      assert.ok(artifact.links.includes(SHOT), "linked to the shot it was rendered for");
      assert.ok((await readFile(join(worldDir, "artifacts", artifact.file))).byteLength > 0);
      const openingFrame = bundle().artifacts.find((candidate) => candidate.id === pinned.openingFrameArtifactId);
      assert.ok(openingFrame, "the pinned opening frame resolves on the shelf");
      assert.equal(openingFrame.kind, "image");
      assert.equal(openingFrame.production, PRODUCTION);
      assert.ok(openingFrame.links.includes(SHOT));
      assert.ok((await readFile(join(worldDir, "artifacts", openingFrame.file))).byteLength > 0);
    } finally {
      await provider.close();
    }
  });

  it("refuses before copying when the shot is not staged, and when the staging moved under the render", async () => {
    const { provider, send, bundle, shot, stage, refusals } = await harness();
    try {
      const shelfBefore = bundle().artifacts.length;
      await send({
        kind: "stage-playblast",
        worldId: WORLD_ID,
        productionId: PRODUCTION,
        sceneFile: SCENE_FILE,
        sceneId: SCENE,
        baseVersion: shot().scene.version,
        shotId: SHOT,
        durationSec: 4,
        aspect: "16:9",
        stagingVersion: 1,
        sourcePath: await playblastFile(),
        openingFrameSourcePath: await openingFrameFile(),
      });
      assert.match(refusals().at(-1)?.reason ?? "", /stage the shot before/);
      assert.equal(bundle().artifacts.length, shelfBefore, "nothing landed on the shelf");

      await stage();
      await send({
        kind: "stage-playblast",
        worldId: WORLD_ID,
        productionId: PRODUCTION,
        sceneFile: SCENE_FILE,
        sceneId: SCENE,
        baseVersion: shot().scene.version,
        shotId: SHOT,
        durationSec: 4,
        aspect: "16:9",
        stagingVersion: 7,
        sourcePath: await playblastFile(),
        openingFrameSourcePath: await openingFrameFile(),
      });
      assert.match(refusals().at(-1)?.reason ?? "", /moved to v1 .* export it again/);
      assert.equal(bundle().artifacts.length, shelfBefore);
      assert.equal(shot().shot.staging?.playblast, undefined);

      // An encoder that stopped without output: nothing to pin, and nothing pinned.
      const empty = await playblastFile(new Uint8Array());
      await send({
        kind: "stage-playblast",
        worldId: WORLD_ID,
        productionId: PRODUCTION,
        sceneFile: SCENE_FILE,
        sceneId: SCENE,
        baseVersion: shot().scene.version,
        shotId: SHOT,
        durationSec: 4,
        aspect: "16:9",
        stagingVersion: 1,
        sourcePath: empty,
        openingFrameSourcePath: await openingFrameFile(),
      });
      assert.match(refusals().at(-1)?.reason ?? "", /came back empty/);
      assert.equal(bundle().artifacts.length, shelfBefore);
      assert.equal(shot().shot.staging?.playblast, undefined);

      await send({
        kind: "stage-playblast",
        worldId: WORLD_ID,
        productionId: PRODUCTION,
        sceneFile: SCENE_FILE,
        sceneId: SCENE,
        baseVersion: shot().scene.version,
        shotId: SHOT,
        durationSec: 4,
        aspect: "16:9",
        stagingVersion: 1,
        sourcePath: await playblastFile(),
        openingFrameSourcePath: await openingFrameFile(new Uint8Array([1, 2, 3])),
      });
      assert.match(refusals().at(-1)?.reason ?? "", /opening frame is not a valid PNG/);
      assert.equal(bundle().artifacts.length, shelfBefore);
      assert.equal(shot().shot.staging?.playblast, undefined);
    } finally {
      await provider.close();
    }
  });
});
