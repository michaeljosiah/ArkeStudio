import { fileArtifact } from "../../src/artifacts/filing.js";
import { FalClient, SHIPPED_MANIFEST } from "@arke-studio/providers";
import { prepareBenchSubject } from "../../src/bench/subject.js";
import { planBenchDispatch } from "../../src/bench/service.js";
import { readContainedVideoReferences, readContainedImageReferences } from "../../src/world/reference-files.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, orderedShots, stageShot, type BenchSession, type ClientMessage, type DomainEvent } from "@arke-studio/contracts";
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

async function openingFrameFile(bytes = encodePng(solidImage(1280, 720, [20, 40, 60, 255]))): Promise<string> {
  const dir = await tempDir("stage-opening-frame-");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "opening-frame.png");
  await writeFile(path, bytes);
  return path;
}

async function harness(duration=4) {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.listWorlds();
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    mediaProbe: { durationSec: async () => duration, info: async () => ({durationSec:duration,hasAudio:false,width:1280,height:720,frameRate:30}) },
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
  /** Keep a legacy private block so filing its new pin proves the schema fence follows the bytes. */
  const stage = async () => {
    const initial=shot();
    if(initial.shot.durationSec !== duration) await send({kind:"scene-command",worldId:WORLD_ID,productionId:PRODUCTION,sceneFile:SCENE_FILE,sceneId:SCENE,baseVersion:initial.scene.version,command:{kind:"edit-shot",shotId:SHOT,change:{durationSec:duration}}});
    const { scene, shot: current } = shot();
    const fresh = stageShot(current, { cast: ["maren-kest"], sets: ["The Vigil"], durationSec: duration });
    await send({
      kind: "scene-command",
      worldId: WORLD_ID,
      productionId: PRODUCTION,
      sceneFile: SCENE_FILE,
      sceneId: SCENE,
      baseVersion: scene.version,
      command: {
        kind: "edit-stage",
        shotId: SHOT,
        staging: {
          cast: fresh.cast,
          sets: fresh.sets,
          keys: fresh.keys,
          rig: fresh.rig,
          seed: fresh.seed,
          rigIntensity: fresh.rigIntensity,
        },
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
      assert.deepEqual(pinned.blocking, { owner: "shot" });
      assert.equal(pinned.rig, "dolly");
      assert.equal(pinned.seed, staged.shot.staging?.seed);
      assert.equal(pinned.rigIntensity, 1);
      assert.equal(bundle().meta.schemaVersion, 10, "the deterministic rig is fenced even on private blocking");
      assert.equal(after.scene.version, sceneVersion + 1, "the pin is a versioned scene write");
      const artifact = bundle().artifacts.find((candidate) => candidate.id === pinned.artifactId);
      assert.ok(artifact, "the pinned id resolves on the shelf");
      assert.equal(artifact.kind, "video");
      assert.equal(artifact.mediaInfo?.durationSec, 4);
      assert.equal(artifact.mediaInfo?.frameRate, 30);
      assert.match(pinned.sourceFingerprint ?? "", /^[a-f0-9]{64}$/);
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

      await send({
        kind: "scene-command",
        worldId: WORLD_ID,
        productionId: PRODUCTION,
        sceneFile: SCENE_FILE,
        sceneId: SCENE,
        baseVersion: after.scene.version,
        command: { kind: "edit-stage", shotId: SHOT, staging: { cast: [], sets: [], keys: [{ t: 0, p: [0, 2, 4], l: [0, 1, 0] }, { t: 4, p: [0, 2, 4], l: [0, 1, 0] }] } },
      });
      const revised = shot().shot.staging!;
      assert.equal(revised.version, 2, "the coordinator advances camera identity");
      assert.equal(revised.playblast?.version, 1, "the prior pin survives only as stale output");
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

it("delivers a fresh filed Stage clip through bench admission into the provider payload and refuses it after edits", async()=>{
  const {provider,worldDir,send,bundle,shot,stage,refusals}=await harness(6);
  try {
    await stage();const staged=shot();
    const sourcePath=await playblastFile();
    await send({kind:"stage-playblast",worldId:WORLD_ID,productionId:PRODUCTION,sceneFile:SCENE_FILE,sceneId:SCENE,baseVersion:staged.scene.version,shotId:SHOT,durationSec:6,aspect:"16:9",stagingVersion:1,sourcePath,openingFrameSourcePath:await openingFrameFile()});
    assert.deepEqual(refusals(),[]);
    const manifest={...SHIPPED_MANIFEST,models:SHIPPED_MANIFEST.models.filter(m=>m.id==="minimax-h3")};
    const prepared=await prepareBenchSubject(bundle(),{productionId:PRODUCTION,sceneId:SCENE,subject:{kind:"shot",shotId:SHOT},mode:"video",settings:null,manifest,sources:{read:async()=>({refused:"No additional sheet images in this transport fixture."}),durationSec:async()=>6}});
    assert.ok(prepared.ok);if(!prepared.ok)return;
    const session={schemaVersion:1,id:newId("sess"),...prepared.prefill,tokenRegistry:prepared.prefill.references,subjectTokens:prepared.prefill.references.map(r=>r.token),nextToken:{image:2,video:2,audio:1},nextTake:1,takes:[],createdAt:CLOCK,updatedAt:CLOCK} as BenchSession;
    assert.ok(session.tokenRegistry.some(r=>r.kind==="video"&&session.composer.activeTokens.includes(r.token)));
    const plan=planBenchDispatch(session,bundle(),manifest,{worldId:WORLD_ID,requestId:"stage-transport",at:CLOCK});
    assert.ok(plan.ok,plan.ok?"":plan.reason);if(!plan.ok)return;
    const input=plan.inputs[0]!;
    const {videoReferences:videoPaths,references:imagePaths,...params}=input.params;
    const videoReferences=await readContainedVideoReferences(worldDir,videoPaths as string[]);
    const imageReferences=await readContainedImageReferences(worldDir,imagePaths as string[]);
    let sent:Record<string,unknown>={};
    await new FalClient(async(_url,init)=>{sent=JSON.parse(String(init?.body));return new Response(JSON.stringify({request_id:"stage-test"}),{status:200});}).submit("test-key",{model:input.model,capability:"video",params,imageReferences,videoReferences});
    assert.deepEqual(sent["reference_video_urls"],[`data:video/mp4;base64,${(await readFile(sourcePath)).toString("base64")}`]);
    assert.equal(sent["duration"],6);
    const changed=structuredClone(bundle());const scene=changed.productions.find(p=>p.meta.id===PRODUCTION)!.scenes.find(s=>s.id===SCENE)!;
    const current=orderedShots(scene).find(s=>s.id===SHOT)!;current.staging!.keys[0]!.l[0]+=1;
    const stale=planBenchDispatch(session,changed,manifest,{worldId:WORLD_ID,requestId:"stale-stage",at:CLOCK});
    assert.equal(stale.ok,false);if(!stale.ok)assert.match(stale.reason,/stale/i);
    const reopened=await prepareBenchSubject(changed,{productionId:PRODUCTION,sceneId:SCENE,subject:{kind:"shot",shotId:SHOT},mode:"video",settings:null,manifest,sources:{read:async()=>({refused:"No references."}),durationSec:async()=>6}});
    assert.ok(reopened.ok);if(reopened.ok)assert.equal(reopened.prefill.references.some(r=>r.label?.startsWith("Staging")),false);
  } finally {await provider.close();}
});

it("fences expanded encoded metadata even when ordinary filing writes it without a Stage scene",async()=>{
  const {provider,bundle}=await harness();
  try {
    assert.ok(bundle().meta.schemaVersion<10);
    const outcome=await fileArtifact(provider.openStore()!,{sourcePath:await playblastFile(),mediaProbe:{durationSec:async()=>4,info:async()=>({durationSec:4,hasAudio:false,width:1280,height:720,frameRate:30})}});
    assert.equal(outcome.outcome,"filed");
    assert.equal(bundle().meta.schemaVersion,10);
  } finally {await provider.close();}
});
