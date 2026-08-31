import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  newId,
  orderedShots,
  type AppSettings,
  type BenchSession,
  type BenchTake,
  type ManifestModel,
  type ModelManifest,
  type WorldBundle,
} from "@arke-studio/contracts";
import { fileBenchSubjectTake, type SubjectFilingOutcome } from "../../src/bench/filing.js";
import { recordBenchOutcome } from "../../src/bench/outcome.js";
import { openBenchSession, openSubjectBenchSession, planBenchDispatch } from "../../src/bench/service.js";
import { sessionMediaDir } from "../../src/bench/store.js";
import {
  prepareBenchSubject,
  subjectReferenceRouting,
  subjectSessionReferenceRouting,
} from "../../src/bench/subject.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { projectWorkspace } from "../../src/world-chat/project.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { WorldStore } from "../../src/world/store.js";
import { closeOnCleanup } from "../tmp.js";
import { makeTempWorld } from "../world/helpers.js";

const CLOCK = () => "2026-08-31T12:00:00.000Z";

const IMAGE_MODEL: ManifestModel = {
  id: "test-image",
  provider: "fal",
  capability: "image",
  displayName: "Test Image",
  accepts: { referenceImages: 4, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 20_000, aspects: ["16:9"] },
  pricing: { kind: "perImage", microUsdPerImage: 60_000 },
};

const VIDEO_MODEL: ManifestModel = {
  id: "test-video",
  provider: "fal",
  capability: "video",
  displayName: "Test Video",
  accepts: { referenceImages: 4, startFrame: false, endFrame: false },
  limits: {
    maxPromptChars: 20_000,
    maxDurationSec: 20,
    maxReferenceAudioSec: 20,
    aspects: ["16:9"],
    soundChoice: true,
    durations: { "4": "4", "6": "6", "8": "8", "10": "10", "12": "12", "15": "15", "20": "20" },
  },
  pricing: { kind: "perSecond", microUsdPerSecond: 100_000 },
};

const MANIFEST: ModelManifest = {
  manifestVersion: 1,
  generated: "2026-08-31",
  models: [IMAGE_MODEL, VIDEO_MODEL],
};

async function openWorld(): Promise<{ dir: string; store: WorldStore }> {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store };
}

function withVoiceSample(bundle: WorldBundle): WorldBundle {
  const world = structuredClone(bundle);
  const kit = world.referenceKits.find((candidate) => candidate.sheetId === "maren-kest");
  assert.ok(kit);
  kit.designatedVoiceSample = {
    file: "voice-sample.wav",
    source: "cloning-recording",
    designatedAt: CLOCK(),
  };
  return world;
}

const sourceReader = {
  read: async () => ({ hash: "sha256:deadbeefdeadbeef" }),
  durationSec: async () => 9,
};

function sessionWithTake(input: {
  subject: BenchSession["subject"];
  takeId: BenchTake["id"];
  request: BenchTake["request"];
  media: string;
  cost?: BenchTake["cost"];
}): { session: BenchSession; take: BenchTake } {
  assert.ok(input.subject);
  const sessionId = newId("sess") as BenchSession["id"];
  const take: BenchTake = {
    id: input.takeId,
    n: 1,
    requestId: "subject-dispatch",
    status: "succeeded",
    request: input.request,
    media: { file: input.media, hash: "sha256:cafebabecafebabe" },
    ...(input.cost !== undefined ? { cost: input.cost } : {}),
    disposition: "open",
    createdAt: CLOCK(),
    completedAt: CLOCK(),
  };
  const session = {
    schemaVersion: 1,
    id: sessionId,
    subject: input.subject,
    title: "Production subject",
    composer: {
      mode: input.request.mode,
      provider: input.request.provider,
      model: input.request.model,
      params: input.request.params,
      brief: input.request.brief,
      activeTokens: [],
      keyframeTokens: [],
    },
    tokenRegistry: [],
    subjectTokens: [],
    nextToken: { image: 1, video: 1, audio: 1 },
    nextTake: 2,
    selectedTakeId: take.id,
    takes: [take],
    createdAt: CLOCK(),
    updatedAt: CLOCK(),
  } as BenchSession;
  return { session, take };
}

describe("production subject preparation (SPEC-036 R-23, R-25)", () => {
  it("prefills a shot from current script state and freezes filing provenance at dispatch", async () => {
    const { store } = await openWorld();
    const world = withVoiceSample(store.getBundle());
    const kit = world.referenceKits.find((candidate) => candidate.sheetId === "maren-kest")!;
    kit.looks ??= [];
    kit.looks.push({
      id: "look-storm-coat",
      file: "looks/storm-coat.png",
      kind: "costume",
      prompt: "Maren's storm coat",
      acceptedAt: CLOCK(),
      attachedTo: { kind: "scene", productionId: "saltlight", sceneId: "sc_04" },
    });
    const prepared = await prepareBenchSubject(world, {
      productionId: "saltlight",
      sceneId: "sc_04",
      subject: { kind: "shot", shotId: "sh_12" },
      settings: null,
      manifest: MANIFEST,
      sources: sourceReader,
    });
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    assert.equal(prepared.prefill.subject.kind, "shot");
    assert.match(prepared.prefill.title, /Saltlight.*Scene 4.*Shot 12/);
    assert.equal(prepared.prefill.composer.mode, "image");
    assert.equal(prepared.prefill.composer.params.kind, "image");
    assert.equal(prepared.prefill.composer.params.aspect, "16:9");
    assert.match(prepared.prefill.composer.brief, /Maren at the rail|maren-kest/i);
    const maren = prepared.prefill.references.find((reference) => reference.sheetId === "maren-kest");
    assert.equal(maren?.label, "Maren Kest · v5");
    assert.equal(maren?.sheetVersion, 5);
    assert.equal(
      maren?.source.source === "world-file" ? maren.source.path : null,
      "references/maren-kest/looks/storm-coat.png",
      "the production-scoped attachment resolver chooses the current look",
    );

    const session = {
      schemaVersion: 1,
      id: newId("sess"),
      ...prepared.prefill,
      tokenRegistry: prepared.prefill.references,
      subjectTokens: prepared.prefill.references.map((reference) => reference.token),
      nextToken: { image: 2, video: 1, audio: 1 },
      nextTake: 1,
      takes: [],
      createdAt: CLOCK(),
      updatedAt: CLOCK(),
    } as BenchSession;
    const plan = planBenchDispatch(session, store.getBundle(), MANIFEST, {
      worldId: store.worldId,
      requestId: "shot-dispatch",
      at: CLOCK(),
    });
    assert.ok(plan.ok);
    if (!plan.ok) return;
    const snapshot = plan.reserved[0]!.request;
    assert.equal(snapshot.filing?.kind, "shot");
    assert.equal(snapshot.filing?.kind === "shot" ? snapshot.filing.shotId : null, "sh_12");
    assert.equal(snapshot.productionProvenance?.canonRevision, world.meta.canonRevision);
    assert.equal(snapshot.productionProvenance?.sheets["maren-kest"], 5);
    assert.match(String(plan.inputs[0]!.params.prompt), /Reference assets, by upload order:/);
    assert.match(String(plan.inputs[0]!.params.prompt), /Image 1: Maren Kest/);

    const square = {
      ...IMAGE_MODEL,
      id: "square-image",
      displayName: "Square Image",
      limits: { ...IMAGE_MODEL.limits, aspects: ["1:1"] },
    } satisfies ManifestModel;
    const incompatible = planBenchDispatch(
      { ...session, composer: { ...session.composer, model: square.id } },
      store.getBundle(),
      { ...MANIFEST, models: [square] },
      { worldId: store.worldId, requestId: "square-shot", at: CLOCK() },
    );
    assert.deepEqual(incompatible, { ok: false, reason: "Square Image cannot make the production aspect 16:9." });
  });

  it("prefills the current board as one exact-duration video and keeps unsupported audio visible", async () => {
    const { store } = await openWorld();
    const world = withVoiceSample(store.getBundle());
    const production = world.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const shots = orderedShots(scene);
    let prepared: Awaited<ReturnType<typeof prepareBenchSubject>> | null = null;
    for (let count = 1; count <= shots.length; count += 1) {
      const candidate = await prepareBenchSubject(world, {
        productionId: "saltlight",
        sceneId: "sc_04",
        subject: { kind: "board", memberShotIds: shots.slice(0, count).map((shot) => shot.id) },
        settings: null,
        manifest: MANIFEST,
        sources: sourceReader,
      });
      if (candidate.ok) {
        prepared = candidate;
        break;
      }
    }
    assert.ok(prepared?.ok, "a current first board is accepted by its ordered member identity");
    if (!prepared?.ok || prepared.prefill.subject.kind !== "board") return;
    const subject = prepared.prefill.subject;
    assert.equal(prepared.prefill.composer.mode, "video");
    assert.equal(prepared.prefill.composer.params.kind, "video");
    assert.equal(prepared.prefill.composer.params.durationSec, subject.durationSec);
    assert.equal(subject.durationSec, subject.members.reduce((total, member) => total + member.durationSec, 0));
    assert.match(prepared.prefill.composer.brief, /1\. Maren Kest grips the rail/);
    const voice = prepared.prefill.references.find((reference) => reference.kind === "audio");
    assert.equal(voice?.label, "voice sample · @maren-kest");
    assert.equal(voice?.durationSec, 9);
    assert.equal(
      prepared.prefill.composer.activeTokens.includes(voice!.token),
      false,
      "the tile remains in the registry but fal's image-only transport does not claim it rides",
    );

    const authored = "AUTHORED BOARD PROMPT — hold on Maren, then cross the lamps.";
    const boards = scene.boards ?? { splits: [], merges: [] };
    scene.boards = {
      ...boards,
      prompts: [{ members: subject.members.map((member) => member.shotId), text: authored }],
    };
    const rebuilt = await prepareBenchSubject(world, {
      productionId: "saltlight",
      sceneId: "sc_04",
      subject: { kind: "board", memberShotIds: subject.members.map((member) => member.shotId) },
      settings: null,
      manifest: MANIFEST,
      sources: sourceReader,
    });
    assert.ok(rebuilt.ok);
    if (rebuilt.ok) assert.equal(rebuilt.prefill.composer.brief, authored);
  });

  it("carries a legacy accepted still into the board's visual references", async () => {
    const { store } = await openWorld();
    const world = store.getBundle();
    const production = world.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const shots = orderedShots(scene);
    const template = production.takes.find(
      (candidate) => (candidate.kind === "frame" || candidate.kind === "still") && candidate.media !== undefined,
    );
    assert.ok(template);
    const legacyId = newId("tk");
    production.takes.push({
      ...template!,
      id: legacyId,
      kind: "frame",
      coversShots: [shots[0]!.id],
      media: "legacy-frame.png",
    });
    production.selections[shots[0]!.id] = {
      ...production.selections[shots[0]!.id],
      acceptedTakeId: legacyId,
      trimInSec: 0,
      startFrameArtifactId: null,
      startFrameTakeId: null,
    };
    let prepared: Awaited<ReturnType<typeof prepareBenchSubject>> | null = null;
    for (let count = 1; count <= shots.length; count += 1) {
      const candidate = await prepareBenchSubject(world, {
        productionId: "saltlight",
        sceneId: "sc_04",
        subject: { kind: "board", memberShotIds: shots.slice(0, count).map((shot) => shot.id) },
        settings: null,
        manifest: MANIFEST,
        sources: sourceReader,
      });
      if (candidate.ok) {
        prepared = candidate;
        break;
      }
    }
    assert.ok(prepared?.ok);
    if (!prepared?.ok) return;
    const legacyFrame = prepared.prefill.references.find(
      (reference) =>
        reference.subjectRole === "board-frame" &&
        reference.source.source === "world-file" &&
        reference.source.path.includes(legacyId),
    );
    assert.equal(
      legacyFrame?.source.source === "world-file" ? legacyFrame.source.path : null,
      `productions/saltlight/takes/${legacyId}/legacy-frame.png`,
    );
  });

  it("keeps the id-less Bench subjectless after a production session was most recent", async () => {
    const { dir, store } = await openWorld();
    const prepared = await prepareBenchSubject(store.getBundle(), {
      productionId: "saltlight",
      sceneId: "sc_04",
      subject: { kind: "shot", shotId: "sh_12" },
      settings: null,
      manifest: MANIFEST,
      sources: sourceReader,
    });
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    const subjectId = newId("sess");
    await openSubjectBenchSession(dir, subjectId, CLOCK(), prepared.prefill);
    const ordinary = await openBenchSession(dir, CLOCK);
    assert.ok(ordinary);
    assert.equal(ordinary.session.subject, undefined);
    assert.notEqual(ordinary.session.id, subjectId);
  });

  it("packs board identity with the production's stranded route without selecting it for dispatch", async () => {
    const { store } = await openWorld();
    const world = store.getBundle();
    const production = world.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    production.meta.models = { ...production.meta.models, video: "stranded-long-video" };
    const stranded: ManifestModel = {
      ...VIDEO_MODEL,
      id: "stranded-long-video",
      limits: { ...VIDEO_MODEL.limits, maxDurationSec: 20, durations: { "20": "20" } },
    };
    const prepared = await prepareBenchSubject(world, {
      productionId: "saltlight",
      sceneId: "sc_04",
      subject: { kind: "board", memberShotIds: ["sh_12", "sh_13", "sh_14", "sh_15"] },
      settings: { models: { disabled: [stranded.id] } } as unknown as AppSettings,
      manifest: { ...MANIFEST, models: [IMAGE_MODEL, stranded] },
      sources: sourceReader,
    });

    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    assert.equal(prepared.prefill.subject.kind, "board");
    assert.equal(prepared.prefill.composer.model, "", "a stranded route shapes the board but is not selected");
  });

  it("freezes current board timing and gives a rounded provider tail to the final segment", async () => {
    const { store } = await openWorld();
    const roundedVideo: ManifestModel = {
      ...VIDEO_MODEL,
      id: "rounded-video",
      limits: {
        ...VIDEO_MODEL.limits,
        maxReferenceDurationSec: 20,
        durations: { "20": "20" },
        durationWire: "number",
      },
    };
    const manifest = { ...MANIFEST, models: [IMAGE_MODEL, roundedVideo] };
    const world = store.getBundle();
    const prepared = await prepareBenchSubject(world, {
      productionId: "saltlight",
      sceneId: "sc_04",
      subject: { kind: "board", memberShotIds: ["sh_12", "sh_13", "sh_14", "sh_15"] },
      settings: null,
      manifest,
      sources: sourceReader,
    });
    assert.ok(prepared.ok);
    if (!prepared.ok || prepared.prefill.subject.kind !== "board") return;
    assert.equal(prepared.prefill.subject.durationSec, 19.5);
    const session = {
      schemaVersion: 1,
      id: newId("sess"),
      ...prepared.prefill,
      tokenRegistry: prepared.prefill.references,
      subjectTokens: prepared.prefill.references.map((reference) => reference.token),
      nextToken: { image: 3, audio: 1, video: 1 },
      nextTake: 1,
      takes: [],
      createdAt: CLOCK(),
      updatedAt: CLOCK(),
    } as BenchSession;
    const plan = planBenchDispatch(session, world, manifest, {
      worldId: store.worldId,
      requestId: "rounded-board",
      at: CLOCK(),
    });
    assert.ok(plan.ok);
    if (!plan.ok) return;
    const filing = plan.reserved[0]!.request.filing;
    assert.equal(filing?.kind, "board");
    if (filing?.kind !== "board") return;
    assert.equal(filing.members.at(-1)?.endSec, 20);
    assert.equal((plan.inputs[0]!.params.duration as number), 20);
    const boardParams = session.composer.params;
    assert.equal(boardParams.kind, "video");
    if (boardParams.kind !== "video") return;

    const wrongAspect = planBenchDispatch(
      {
        ...session,
        composer: {
          ...session.composer,
          params: { ...boardParams, aspect: "9:16" },
        },
      },
      world,
      manifest,
      { worldId: store.worldId, requestId: "wrong-aspect", at: CLOCK() },
    );
    assert.deepEqual(wrongAspect, { ok: false, reason: "This board must use the production aspect 16:9." });
    const wrongDuration = planBenchDispatch(
      {
        ...session,
        composer: {
          ...session.composer,
          params: { ...boardParams, durationSec: 20 },
        },
      },
      world,
      manifest,
      { worldId: store.worldId, requestId: "wrong-duration", at: CLOCK() },
    );
    assert.deepEqual(wrongDuration, { ok: false, reason: "This board must keep its 19.5s authored duration." });
    const muted = planBenchDispatch(
      {
        ...session,
        composer: {
          ...session.composer,
          params: { ...boardParams, sound: false },
        },
      },
      world,
      manifest,
      { worldId: store.worldId, requestId: "muted-board", at: CLOCK() },
    );
    assert.deepEqual(muted, { ok: false, reason: "A board subject must keep sound on." });

    const split = structuredClone(world);
    const splitScene = split.productions
      .find((production) => production.meta.id === "saltlight")!
      .scenes.find((candidate) => candidate.id === "sc_04")!;
    splitScene.boards = {
      splits: ["sh_13"],
      merges: [],
    };
    assert.deepEqual(
      planBenchDispatch(session, split, manifest, {
        worldId: store.worldId,
        requestId: "split-board",
        at: CLOCK(),
      }),
      { ok: false, reason: "The board boundaries changed in this scene. Rebuild the session." },
    );

    const changed = structuredClone(world);
    const changedScene = changed.productions
      .find((production) => production.meta.id === "saltlight")!
      .scenes.find((scene) => scene.id === "sc_04")!;
    const changedShot = orderedShots(changedScene).find((shot) => shot.id === "sh_13")!;
    changedShot.durationSec = 7;
    const stale = planBenchDispatch(session, changed, manifest, {
      worldId: store.worldId,
      requestId: "stale-board",
      at: CLOCK(),
    });
    assert.deepEqual(stale, { ok: false, reason: "The board timing changed in this scene. Rebuild the session." });

    const balanced = structuredClone(world);
    const balancedShots = orderedShots(
      balanced.productions
        .find((production) => production.meta.id === "saltlight")!
        .scenes.find((candidate) => candidate.id === "sc_04")!,
    );
    balancedShots[0]!.durationSec = balancedShots[0]!.durationSec! + 0.5;
    balancedShots[1]!.durationSec = balancedShots[1]!.durationSec! - 0.5;
    const currentSubject = structuredClone(session.subject);
    assert.ok(currentSubject?.kind === "board");
    if (currentSubject?.kind !== "board") return;
    currentSubject.members[0]!.durationSec += 0.5;
    currentSubject.members[1]!.durationSec -= 0.5;
    const oldTake = {
      ...plan.reserved[0]!,
      status: "succeeded" as const,
      disposition: "open" as const,
    } as BenchTake;
    const staleRerun = planBenchDispatch(
      { ...session, subject: currentSubject, takes: [oldTake], nextTake: 2 },
      balanced,
      manifest,
      { worldId: store.worldId, requestId: "stale-board-rerun", at: CLOCK(), fromTake: oldTake },
    );
    assert.deepEqual(staleRerun, {
      ok: false,
      reason: "This take belongs to older production timing. Generate a current take instead.",
    });
  });

  it("refuses a board route whose provider default cannot promise its duration", async () => {
    const { store } = await openWorld();
    const model: ManifestModel = {
      ...VIDEO_MODEL,
      id: "default-duration-video",
      displayName: "Default Duration Video",
      limits: {
        maxPromptChars: 20_000,
        maxDurationSec: 20,
        aspects: ["16:9"],
        soundChoice: true,
      },
    };
    const world = store.getBundle();
    const prepared = await prepareBenchSubject(world, {
      productionId: "saltlight",
      sceneId: "sc_04",
      subject: { kind: "board", memberShotIds: ["sh_12", "sh_13", "sh_14", "sh_15"] },
      settings: null,
      manifest: { ...MANIFEST, models: [IMAGE_MODEL, model] },
      sources: sourceReader,
    });
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    const session = {
      schemaVersion: 1,
      id: newId("sess"),
      ...prepared.prefill,
      tokenRegistry: prepared.prefill.references,
      subjectTokens: prepared.prefill.references.map((reference) => reference.token),
      nextToken: { image: 3, audio: 1, video: 1 },
      nextTake: 1,
      takes: [],
      createdAt: CLOCK(),
      updatedAt: CLOCK(),
    } as BenchSession;

    assert.deepEqual(
      planBenchDispatch(session, world, { ...MANIFEST, models: [IMAGE_MODEL, model] }, {
        worldId: store.worldId,
        requestId: "default-duration-board",
        at: CLOCK(),
      }),
      { ok: false, reason: "Default Duration Video does not offer a fixed duration for this board." },
    );
  });

  it("recomputes subject riding lanes for the newly chosen model", async () => {
    const subject = {
      kind: "board" as const,
      productionId: "saltlight",
      productionTitle: "Saltlight",
      sceneId: "sc_04",
      sceneNumber: 4,
      sceneTitle: "The verse rises",
      letter: "A",
      durationSec: 10,
      aspect: "16:9",
      packing: { maxDurationSec: 20 },
      members: [
        { shotId: "sh_12", number: 12, title: "Maren at the rail", durationSec: 4 },
        { shotId: "sh_13", number: 13, title: "The lamps answer", durationSec: 6 },
      ],
    };
    const references = [
      {
        token: "Image 1",
        kind: "image" as const,
        source: { source: "artifact" as const, artifactId: newId("ar"), hash: "sha256:deadbeefdeadbeef" as const },
        subjectRole: "board-frame" as const,
      },
      {
        token: "Image 2",
        kind: "image" as const,
        source: { source: "artifact" as const, artifactId: newId("ar"), hash: "sha256:cafebabecafebabe" as const },
        subjectRole: "board-frame" as const,
      },
      {
        token: "Audio 1",
        kind: "audio" as const,
        source: { source: "world-file" as const, path: "references/maren/voice.wav", hash: "sha256:feedfacefeedface" as const },
        durationSec: 9,
        subjectRole: "audio" as const,
      },
    ];
    const framed = {
      ...VIDEO_MODEL,
      modes: {
        generate: { locked: [] },
        "first-and-last-frame": { route: "test/image-to-video", locked: ["aspect"] },
      },
    } satisfies ManifestModel;

    assert.deepEqual(subjectReferenceRouting(references, subject, framed), {
      activeTokens: [],
      keyframeTokens: ["Image 1", "Image 2"],
    });
    const scopedLook = {
      token: "Image 3",
      kind: "image" as const,
      source: {
        source: "world-file" as const,
        path: "references/maren-kest/looks/storm-coat.png",
        hash: "sha256:0123456789abcdef" as const,
      },
      sheetId: "maren-kest",
      sheetVersion: 5,
      subjectRole: "reference" as const,
    };
    assert.deepEqual(subjectReferenceRouting([scopedLook, ...references], subject, framed), {
      activeTokens: [],
      keyframeTokens: ["Image 1", "Image 2"],
    });
    assert.deepEqual(subjectReferenceRouting(references, subject, VIDEO_MODEL), {
      activeTokens: [],
      keyframeTokens: ["Image 1", "Image 2"],
    });
    const userFrame = {
      token: "Image 4",
      kind: "image" as const,
      source: {
        source: "artifact" as const,
        artifactId: newId("ar"),
        hash: "sha256:abcdefabcdefabcd" as const,
      },
    };
    const session = {
      schemaVersion: 1,
      id: newId("sess"),
      subject,
      title: "Board reference routing",
      composer: {
        mode: "video",
        provider: framed.provider,
        model: framed.id,
        params: { kind: "video", durationSec: 10, aspect: "16:9", sound: true },
        brief: "One pass.",
        activeTokens: ["Image 3"],
        keyframeTokens: ["Image 4"],
      },
      tokenRegistry: [scopedLook, userFrame],
      subjectTokens: ["Image 3"],
      nextToken: { image: 5, audio: 1, video: 1 },
      nextTake: 1,
      takes: [],
      createdAt: CLOCK(),
      updatedAt: CLOCK(),
    } as BenchSession;
    assert.deepEqual(subjectSessionReferenceRouting(session, framed), {
      activeTokens: ["Image 3"],
      keyframeTokens: ["Image 4"],
    });
  });
});

describe("subject Accept filing (SPEC-036 R-24)", () => {
  it("copies a still into production, selects its frame artifact, and retries without duplication", async () => {
    const { dir, store } = await openWorld();
    const takeId = newId("tk") as BenchTake["id"];
    const productionTakeId = newId("tk");
    const artifactId = newId("ar");
    const referencedTakeId = newId("tk") as BenchTake["id"];
    const { session, take } = sessionWithTake({
      subject: {
        kind: "shot",
        productionId: "saltlight",
        productionTitle: "Saltlight",
        sceneId: "sc_04",
        sceneNumber: 4,
        sceneTitle: "The verse rises",
        shotId: "sh_13",
        shotNumber: 13,
        shotTitle: "The lamps answer",
        durationSec: 6,
        aspect: "16:9",
      },
      takeId,
      request: {
        mode: "image",
        brief: "The lamps answer.",
        references: [
          {
            token: "Image 1",
            kind: "image",
            source: { source: "take", takeId: referencedTakeId, hash: "sha256:0123456789abcdef" },
          },
        ],
        keyframes: [],
        provider: "fal",
        model: "test-image",
        params: { kind: "image", count: 1, aspect: "16:9" },
        productionProvenance: { canonRevision: store.getBundle().meta.canonRevision, sheets: {} },
        recipeVersion: 3,
        filing: {
          kind: "shot",
          productionId: "saltlight",
          sceneId: "sc_04",
          shotId: "sh_13",
          productionTakeId,
          frameArtifactId: artifactId,
        },
      },
      media: "take.png",
      cost: { estimatedMicroUsd: 60_000, actualMicroUsd: 58_000, actualSource: "provider-reported" },
    });
    const referencedTake = {
      ...take,
      id: referencedTakeId,
      n: 2,
      requestId: "referenced-bench-take",
      request: { ...take.request, references: [] },
      media: { file: "reference.png", hash: "sha256:0123456789abcdef" },
    } as BenchTake;
    session.takes.push(referencedTake);
    session.nextTake = 3;
    const source = join(dir, sessionMediaDir(session.id, take.id), take.media!.file);
    const referenceSource = join(
      dir,
      sessionMediaDir(session.id, referencedTake.id),
      referencedTake.media!.file,
    );
    await mkdir(join(dir, sessionMediaDir(session.id, take.id)), { recursive: true });
    await mkdir(join(dir, sessionMediaDir(session.id, referencedTake.id)), { recursive: true });
    await writeFile(source, "still bytes");
    await writeFile(referenceSource, "reference bytes");

    const first = await fileBenchSubjectTake(store, session, take);
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === "saltlight")!;
    assert.equal(first.artifactId, artifactId);
    assert.equal(production.selections["sh_13"]?.startFrameArtifactId, artifactId);
    assert.equal(production.selections["sh_13"]?.startFrameTakeId, null);
    const filedTake = production.takes.find((candidate) => candidate.id === productionTakeId)!;
    assert.equal(filedTake.kind, "frame");
    assert.equal(filedTake.provenance.recipeVersion, 3);
    assert.equal(filedTake.references.some((reference) => reference.startsWith(".sessions/")), false);
    assert.equal(await readFile(join(dir, filedTake.references[0]!), "utf8"), "reference bytes");
    assert.equal(store.getBundle().artifacts.find((candidate) => candidate.id === artifactId)?.production, "saltlight");
    assert.equal(await readFile(source, "utf8"), "still bytes", "Accept copies; the Bench source survives");

    const retried = await fileBenchSubjectTake(store, session, take);
    assert.deepEqual(retried.productionTakeIds, first.productionTakeIds);
    const reloaded = store.getBundle().productions.find((candidate) => candidate.meta.id === "saltlight")!;
    assert.equal(reloaded.takes.filter((candidate) => candidate.id === productionTakeId).length, 1);
    assert.equal(reloaded.reviews.filter((decision) => decision.takeId === productionTakeId).length, 1);
  });

  it("keeps one board parent but selects one proportional segment take per member", async () => {
    const { dir, store } = await openWorld();
    const takeId = newId("tk") as BenchTake["id"];
    const parentId = newId("tk");
    const firstId = newId("tk");
    const secondId = newId("tk");
    const { session, take } = sessionWithTake({
      subject: {
        kind: "board",
        productionId: "saltlight",
        productionTitle: "Saltlight",
        sceneId: "sc_04",
        sceneNumber: 4,
        sceneTitle: "The verse rises",
        letter: "A",
        durationSec: 10,
        aspect: "16:9",
        packing: { maxDurationSec: 10 },
        members: [
          { shotId: "sh_12", number: 12, title: "Maren at the rail", durationSec: 4 },
          { shotId: "sh_13", number: 13, title: "The lamps answer", durationSec: 6 },
        ],
      },
      takeId,
      request: {
        mode: "video",
        brief: "One pass across two beats.",
        references: [],
        keyframes: [],
        provider: "fal",
        model: "test-video",
        params: { kind: "video", aspect: "16:9", durationSec: 10, sound: true },
        productionProvenance: { canonRevision: store.getBundle().meta.canonRevision, sheets: {} },
        filing: {
          kind: "board",
          productionId: "saltlight",
          sceneId: "sc_04",
          productionTakeId: parentId,
          members: [
            { shotId: "sh_12", number: 12, startSec: 0, endSec: 4, takeId: firstId },
            { shotId: "sh_13", number: 13, startSec: 4, endSec: 10, takeId: secondId },
          ],
        },
      },
      media: "take.mp4",
      cost: { estimatedMicroUsd: 100_000, actualMicroUsd: null },
    });
    const source = join(dir, sessionMediaDir(session.id, take.id), take.media!.file);
    await mkdir(join(dir, sessionMediaDir(session.id, take.id)), { recursive: true });
    await writeFile(source, "video bytes");

    const currentScene = store
      .getBundle()
      .productions.find((candidate) => candidate.meta.id === "saltlight")!
      .scenes.find((candidate) => candidate.id === "sc_04")!;
    const originalBoards = structuredClone(currentScene.boards);
    currentScene.boards = { splits: ["sh_13"], merges: [] };
    await assert.rejects(
      () => fileBenchSubjectTake(store, session, take),
      /board boundaries changed/,
      "Accept revalidates the bands' current board identity",
    );
    const timingScene = store
      .getBundle()
      .productions.find((candidate) => candidate.meta.id === "saltlight")!
      .scenes.find((candidate) => candidate.id === "sc_04")!;
    timingScene.boards = originalBoards;
    const currentMembers = orderedShots(timingScene).filter((shot) => shot.id === "sh_12" || shot.id === "sh_13");
    currentMembers[0]!.durationSec = 5;
    currentMembers[1]!.durationSec = 5;
    await assert.rejects(
      () => fileBenchSubjectTake(store, session, take),
      /board timing changed/,
      "Accept revalidates each boundary even when the total remains 10s",
    );
    if (session.subject?.kind !== "board") throw new Error("expected a board subject");
    session.subject = {
      ...session.subject,
      members: [
        { ...session.subject.members[0]!, durationSec: 5 },
        { ...session.subject.members[1]!, durationSec: 5 },
      ],
    };
    const rebuiltMembers = orderedShots(
      store
        .getBundle()
        .productions.find((candidate) => candidate.meta.id === "saltlight")!
        .scenes.find((candidate) => candidate.id === "sc_04")!,
    ).filter((shot) => shot.id === "sh_12" || shot.id === "sh_13");
    rebuiltMembers[0]!.durationSec = 5;
    rebuiltMembers[1]!.durationSec = 5;
    await assert.rejects(
      () => fileBenchSubjectTake(store, session, take),
      /older board timing/,
      "Accept refuses an old take after Rebuild made the session itself current",
    );
    currentMembers[0]!.durationSec = 4;
    currentMembers[1]!.durationSec = 6;
    session.subject = {
      ...session.subject,
      members: [
        { ...session.subject.members[0]!, durationSec: 4 },
        { ...session.subject.members[1]!, durationSec: 6 },
      ],
    };

    const filed = await fileBenchSubjectTake(store, session, take);
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const parent = production.takes.find((candidate) => candidate.id === parentId)!;
    const first = production.takes.find((candidate) => candidate.id === firstId)!;
    const second = production.takes.find((candidate) => candidate.id === secondId)!;
    assert.deepEqual(filed.productionTakeIds, [parentId, firstId, secondId]);
    assert.deepEqual(parent.coversShots, ["sh_12", "sh_13"]);
    assert.equal(production.selections["sh_12"]?.acceptedTakeId, firstId);
    assert.equal(production.selections["sh_13"]?.acceptedTakeId, secondId);
    assert.ok(Object.values(production.selections).every((selection) => selection.acceptedTakeId !== parentId));
    assert.deepEqual(first.segment, { passTakeId: parentId, inSec: 0, outSec: 4 });
    assert.deepEqual(second.segment, { passTakeId: parentId, inSec: 4, outSec: 10 });
    assert.deepEqual(
      [first.cost.estimatedMicroUsd, second.cost.estimatedMicroUsd],
      [40_000, 60_000],
    );
    assert.deepEqual([first.cost.actualMicroUsd, second.cost.actualMicroUsd], [null, null]);
    assert.ok(
      production.reviews.some(
        (decision) => decision.takeId === parentId && decision.decision === "accept" && decision.shotId === undefined,
      ),
      "the backing parent is reviewed without pretending it belongs to one shot",
    );
    assert.ok(production.takes.some((candidate) => candidate.id === "tk_01J8F0000000000000000000B2"));
    assert.equal(await readFile(source, "utf8"), "video bytes");
  });

  it("holds the world mutation gate from subject validation through the filing commit", async () => {
    const { dir, store } = await openWorld();
    const takeId = newId("tk") as BenchTake["id"];
    const productionTakeId = newId("tk");
    const artifactId = newId("ar");
    const { session, take } = sessionWithTake({
      subject: {
        kind: "shot",
        productionId: "saltlight",
        productionTitle: "Saltlight",
        sceneId: "sc_04",
        sceneNumber: 4,
        sceneTitle: "The verse rises",
        shotId: "sh_13",
        shotNumber: 13,
        shotTitle: "The lamps answer",
        durationSec: 6,
        aspect: "16:9",
      },
      takeId,
      request: {
        mode: "image",
        brief: "The lamps answer.",
        references: [],
        keyframes: [],
        provider: "fal",
        model: "test-image",
        params: { kind: "image", count: 1, aspect: "16:9" },
        productionProvenance: { canonRevision: store.getBundle().meta.canonRevision, sheets: {} },
        filing: {
          kind: "shot",
          productionId: "saltlight",
          sceneId: "sc_04",
          shotId: "sh_13",
          productionTakeId,
          frameArtifactId: artifactId,
        },
      },
      media: "take.jpg",
    });
    const source = join(dir, sessionMediaDir(session.id, take.id), take.media!.file);
    await mkdir(join(dir, sessionMediaDir(session.id, take.id)), { recursive: true });
    await writeFile(source, "still bytes");
    let entered!: () => void;
    const conversionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const conversionHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    const filing = fileBenchSubjectTake(store, session, take, {
      toPng: {
        write: async (_input, output) => {
          entered();
          await conversionHeld;
          await writeFile(output, "png bytes");
          return { ok: true };
        },
      },
    });
    await conversionEntered;
    let concurrentEntered = false;
    const concurrent = store.ownedWrite(async () => {
      concurrentEntered = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(concurrentEntered, false, "a scene edit cannot enter after filing validation");
    release();
    await filing;
    await concurrent;
    assert.equal(concurrentEntered, true);
  });
});

describe("the Arke filing outcome", () => {
  it("creates one deterministic scene thread across concurrent sessions and an immediate retry", async () => {
    const { store } = await openWorld();
    const takeId = newId("tk") as BenchTake["id"];
    const productionTakeId = newId("tk");
    const artifactId = newId("ar");
    const { session, take } = sessionWithTake({
      subject: {
        kind: "shot",
        productionId: "saltlight",
        productionTitle: "Saltlight",
        sceneId: "sc_04",
        sceneNumber: 4,
        sceneTitle: "The verse rises",
        shotId: "sh_13",
        shotNumber: 13,
        shotTitle: "The lamps answer",
        durationSec: 6,
        aspect: "16:9",
      },
      takeId,
      request: {
        mode: "image",
        brief: "The lamps answer.",
        references: [],
        keyframes: [],
        provider: "fal",
        model: "test-image",
        params: { kind: "image", count: 1 },
        productionProvenance: { canonRevision: store.getBundle().meta.canonRevision, sheets: {} },
        filing: {
          kind: "shot",
          productionId: "saltlight",
          sceneId: "sc_04",
          shotId: "sh_13",
          productionTakeId,
          frameArtifactId: artifactId,
        },
      },
      media: "take.png",
    });
    const filing: SubjectFilingOutcome = {
      productionTakeIds: [productionTakeId],
      affectedShotIds: ["sh_13"],
      artifactId,
      takes: [],
      decisions: [],
    };
    const otherSession = { ...session, id: newId("sess") as BenchSession["id"] };
    const otherTake = {
      ...take,
      id: newId("tk") as BenchTake["id"],
      requestId: "other-subject-dispatch",
    };
    const [first, concurrent] = await Promise.all([
      recordBenchOutcome(store, session, take, filing),
      recordBenchOutcome(store, otherSession, otherTake, filing),
    ]);
    assert.equal(concurrent, first, "one scene gets one live Arke thread");
    const second = await recordBenchOutcome(store, session, take, filing);
    assert.equal(second, first);
    assert.equal(first, `cv_${session.id.slice(5)}`);
    const { events } = await new WorldChatStore(conversationDir(store.dir, first)).read();
    assert.equal(events.filter(({ event }) => event.type === "conversation.created").length, 1);
    assert.equal(events.filter(({ event }) => event.type === "bench.outcome-recorded").length, 2);
    const loaded = foldConversation(first, CLOCK(), events).view;
    const message = loaded.messages.at(-1)!;
    assert.deepEqual(loaded.benchOutcomes[message.id]?.rows, [
      { shotId: "sh_13", shotNumber: 13, productionTakeId, artifactId },
    ]);
    assert.deepEqual(projectWorkspace(loaded, new Map()).messages.at(-1)?.benchOutcome?.rows, [
      { shotId: "sh_13", shotNumber: 13, productionTakeId, artifactId },
    ]);
  });
});
