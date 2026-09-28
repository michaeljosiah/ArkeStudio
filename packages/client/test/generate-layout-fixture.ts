import { FrameRunSchema, FrameRunStateSchema, foldFrameRun, type FrameRunJobFacts, type FrameRunState, type FrameRunQuote, type ClientMessage, type ClientState, type ManifestModel } from "@arke-studio/contracts";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { scenesLayoutFixture } from "./scenes-layout-fixture.js";
const RUN_ID = "fr_01J8E0000000000000000000R1";
const JOB_1 = "jb_01J8E0000000000000000000R1";
const JOB_2 = "jb_01J8E0000000000000000000R2";
const QUOTE_ID = "01J8E0000000000000000000Q2";
const SIGNATURE = `sha256:${"a".repeat(64)}`;

const IMAGE_MODEL: ManifestModel = {
  id: "frame-image",
  provider: "fal",
  capability: "image",
  displayName: "Frame image",
  accepts: { referenceImages: 4, referenceRoles: false, startFrame: false, endFrame: false },
  limits: { aspects: ["16:9"] },
  pricing: { kind: "perImage", microUsdPerImage: 37_000 },
};

function step(index: number, mode: "per-shot" | "board", shotIds: string[], jobId: string) {
  const panels = shotIds.map((shotId, panel) => ({ panel: panel + 1, shotId, role: "update" as const }));
  const layout = mode === "board" ? {
    columns: 2 as const,
    rows: 1,
    canvasWidth: 1536,
    canvasHeight: 432,
    regions: panels.map((panel, at) => ({ panel: panel.panel, x: at * 768, y: 0, width: 768, height: 432 })),
  } : undefined;
  const request = {
    prompt: `Frozen prompt ${index}`,
    panels,
    references: [],
    droppedReferences: [],
    provenance: { canonRevision: 42, artDirectionVersion: 3 },
    ...(layout === undefined ? {} : { layout }),
    aspect: "16:9",
    slotAtAuthorization: Object.fromEntries(shotIds.map((shotId) => [shotId, null])),
  };
  const output = mode === "board"
    ? { width: 1536, height: 432, aspect: "32:9" }
    : { width: 1536, height: 864, aspect: "16:9" };
  return {
    label: mode === "board" ? "Board A" : `Shot ${12 + index}`,
    requestShotIds: shotIds,
    updateShotIds: shotIds,
    request,
    dispatch: {
      worldId: FIXTURE_WORLD_ID,
      productionId: "saltlight",
      provider: "fal",
      model: IMAGE_MODEL.id,
      capability: "image" as const,
      target: mode === "board"
        ? { kind: "board-sheet" as const, coversShots: shotIds }
        : { kind: "shot" as const, id: shotIds[0]!, coversShots: shotIds },
      references: [],
      referenceCapacity: 4,
      output,
      routeOutput: { width: 1536, height: 864, aspect: "16:9" },
      cellOutput: { width: mode === "board" ? 768 : 1536, height: mode === "board" ? 432 : 864, aspect: "16:9" },
      estimatedMicroUsd: 37_000,
      cellEstimatedMicroUsd: 37_000,
      params: { prompt: request.prompt, references: [], output, request },
      landing: { dir: `incoming/${index}`, name: `frame-${index}.png` },
      idempotencyKey: `01J8E0000000000000000000K${index + 1}`,
    },
    sourceStepIndex: index,
    grain: "initial" as const,
    jobId,
    landingOutcomes: {},
  };
}

export function generateFrameRun(options: {
  mode?: "per-shot" | "board";
  sceneVersion?: number;
  paused?: boolean;
  cancelled?: boolean;
  first?: Partial<FrameRunJobFacts>;
  second?: Partial<FrameRunJobFacts>;
  firstLanding?: "filed" | "superseded";
  secondLanding?: "filed" | "superseded";
} = {}): FrameRunState {
  const mode = options.mode ?? "per-shot";
  const steps = mode === "board"
    ? [step(0, mode, ["sh_12", "sh_13"], JOB_1)]
    : [step(0, mode, ["sh_12"], JOB_1), step(1, mode, ["sh_13"], JOB_2)];
  if (options.firstLanding !== undefined) steps[0]!.landingOutcomes = Object.fromEntries(steps[0]!.updateShotIds.map((id) => [id, options.firstLanding]));
  if (options.secondLanding !== undefined && steps[1] !== undefined) steps[1].landingOutcomes = { sh_13: options.secondLanding };
  const run = FrameRunSchema.parse({
    id: RUN_ID,
    sceneId: "sc_04",
    sceneVersion: options.sceneVersion ?? 2,
    mode,
    model: IMAGE_MODEL.id,
    steps,
    cursor: steps.length,
    paused: options.paused ?? false,
    cancelled: options.cancelled ?? false,
    createdAt: "2026-08-30T12:00:00Z",
  });
  const facts: FrameRunJobFacts[] = [
    { id: JOB_1, status: "running", etaSec: 9, ...options.first },
    ...(mode === "board" ? [] : [{ id: JOB_2, status: "queued" as const, etaSec: null, ...options.second }]),
  ];
  return FrameRunStateSchema.parse(foldFrameRun(run, facts));
}

export function generateQuote(message: Extract<ClientMessage, { kind: "frame-run-quote" }>, blockedReason: string | null = null): FrameRunQuote {
  const shotIds = message.shotId === undefined ? ["sh_12", "sh_13"] : [message.shotId];
  const estimatedMicroUsd = message.shotId === undefined ? 81_234 : 37_000;
  return {
    requestId: message.requestId,
    quoteId: QUOTE_ID,
    signature: blockedReason === null ? SIGNATURE : null,
    worldId: message.worldId,
    productionId: message.productionId,
    sceneId: message.sceneId,
    sceneVersion: blockedReason === null ? 2 : null,
    mode: message.mode,
    modelId: message.modelId,
    scope: message.scope,
    ...(message.shotId === undefined ? {} : { shotId: message.shotId }),
    includedCount: blockedReason === null ? shotIds.length : 0,
    steps: blockedReason === null ? [{
      label: message.shotId === undefined ? "Board A" : `Shot ${message.shotId.replace(/^sh_0*/, "")}`,
      requestShotIds: shotIds,
      updateShotIds: shotIds,
      references: shotIds.includes("sh_12")
        ? [{ sheetId: "maren-kest", version: 4, path: "references/maren-kest/model-sheet-v4.png" }]
        : [],
      estimatedMicroUsd,
    }] : [],
    estimatedMicroUsd: blockedReason === null ? estimatedMicroUsd : null,
    blockedReason,
    quotedAt: "2026-08-30T12:00:01Z",
  };
}


export function generateLayoutFixture(mode = "normal"): ClientState {
  const state = scenesLayoutFixture();
  const world = state.world!, production = world.productions[0]!;
  const scene = production.scenes.find(scene => scene.id === "sc_04")!;
  const clip = production.takes.find(take => take.kind === "clip")!;
  production.takes = Array.from({length:4}, (_,i) => ({...structuredClone(clip), id:'layout-take-'+i, kind:mode==='stills'?'frame':'clip', coversShots:['sh_12'], model:'Seedance 2.0', media:mode==='stills'?'frame.png':'clip.mp4', provenance:{...clip.provenance, sheets:{'maren-kest':4,'the-vigil':2}}}));
  production.selections.sh_12 = {acceptedTakeId:production.takes[1]!.id, trimInSec:0};
  state.app.manifest!.models.push({...IMAGE_MODEL, displayName:'FLUX.2 Pro'});
  state.app.routing.defaults.image = IMAGE_MODEL.id;
  if (mode === 'running' || mode === 'completed') {
    const complete = mode === 'completed';
    const run = generateFrameRun(complete ? {sceneVersion:scene.version,first:{status:'succeeded'},second:{status:'succeeded'},firstLanding:'filed',secondLanding:'filed'} : {sceneVersion:scene.version,second:{status:'failed',error:'Provider returned a dark frame',failureClass:'transient'}});
    state.frameRuns = [run];
    const image = world.artifacts.find(item => item.kind === 'image')!;
    world.artifacts.push({...structuredClone(image),id:'ar_layout_frame',file:'layout-frame.png',links:['sh_12'],origin:{by:'system',producedBy:'frame-run:'+JOB_1}});
    production.selections.sh_12.startFrameArtifactId = 'ar_layout_frame';
  }
  return state;
}
