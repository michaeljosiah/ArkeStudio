import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_SHOT_SEC,
  FrameStepRequestSchema,
  FrameRunQuoteSchema,
  FrameRunSchema,
  aspectSupport,
  assembleBoardPrompt,
  boardPromptFor,
  estimateMicroUsd,
  foldFrameRun,
  newId,
  orderedShots,
  packBoards,
  packShotsFor,
  parseAspect,
  planScene,
  productionAspect,
  resolveCast,
  sceneImageOutput,
  compilePasses,
  type FrameRun,
  type FrameRunQuote,
  type FrameBoardLayout,
  type FrameRunJobFacts,
  type FrameRunState,
  type FrameRunStep,
  type FrameStepRequest,
  type Job,
  type ManifestModel,
  type ProductionBundle,
  type SceneRecord,
  type Take,
  type WorldBundle,
} from "@arke-studio/contracts";
import type { EnqueueInput } from "../queue/dispatcher.js";
import { decodePng, encodePng, type RgbaImage } from "../references/png.js";
import { recordTakesFromJob } from "../takes/arrival.js";
import type { BoundaryFrameMaker } from "../takes/boundary.js";
import { fileDrawnFrame, reviewAppendFor } from "../takes/drawn-frame.js";
import { atomicWriteFile, serializeFileMutation } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

function stepSettled(job: Job | undefined): boolean {
  return job !== undefined && TERMINAL.has(job.status) &&
    job.finalization?.status !== "pending" && job.finalization?.status !== "failed";
}

function runsDir(store: WorldStore, productionId: string): string {
  return join(store.dir, "productions", productionId, "runs");
}

function runPath(store: WorldStore, productionId: string, runId: string): string {
  return join(runsDir(store, productionId), `${runId}.json`);
}

async function writeRun(store: WorldStore, productionId: string, run: FrameRun): Promise<void> {
  await atomicWriteFile(runPath(store, productionId, run.id), JSON.stringify(FrameRunSchema.parse(run), null, 2) + "\n");
}

export async function readFrameRun(
  store: WorldStore,
  productionId: string,
  runId: string,
): Promise<FrameRun | null> {
  try {
    return FrameRunSchema.parse(JSON.parse(await readFile(toExtendedLength(runPath(store, productionId, runId)), "utf8")));
  } catch {
    return null;
  }
}

export async function listFrameRuns(store: WorldStore, productionId: string): Promise<FrameRun[]> {
  const files = await readdir(toExtendedLength(runsDir(store, productionId))).catch(() => []);
  const runs: FrameRun[] = [];
  for (const file of files.filter((candidate) => candidate.endsWith(".json"))) {
    const run = await readFrameRun(store, productionId, file.slice(0, -5));
    if (run !== null) runs.push(run);
  }
  return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function selectedFrame(
  production: ProductionBundle,
  world: WorldBundle,
  shotId: string,
): { source: "take" | "artifact"; id: string; path: string } | null {
  const selection = production.selections[shotId];
  const artifactId = selection?.startFrameArtifactId ?? null;
  if (artifactId !== null) {
    const artifact = world.artifacts.find((candidate) => candidate.id === artifactId);
    if (
      artifact?.kind === "image" &&
      !world.artifacts.some((candidate) => candidate.supersedes === artifact.id)
    ) {
      return { source: "artifact", id: artifact.id, path: `artifacts/${artifact.file}` };
    }
  }
  const takeId = selection?.acceptedTakeId ?? null;
  const take = takeId === null ? undefined : production.takes.find((candidate) => candidate.id === takeId);
  return take !== undefined && (take.kind === "frame" || take.kind === "still") && take.media !== undefined
    ? { source: "take", id: take.id, path: `productions/${production.meta.id}/takes/${take.id}/${take.media}` }
    : null;
}

function frozenReferences(
  passes: ReturnType<typeof compilePasses>,
  capacity: number,
): FrameStepRequest["references"] {
  const unique = new Map<string, FrameStepRequest["references"][number]>();
  for (const reference of passes.flatMap((pass) => pass.references)) {
    if (reference.sheetVersion === null || unique.has(reference.file)) continue;
    unique.set(reference.file, {
      sheetId: reference.sheetId as FrameStepRequest["references"][number]["sheetId"],
      version: reference.sheetVersion,
      path: reference.file,
    });
  }
  return [...unique.values()].slice(0, Math.max(0, capacity));
}

function boardSheetPrompt(
  body: string,
  panels: FrameStepRequest["panels"],
  layout: FrameBoardLayout,
): string {
  const fixed = panels
    .filter((panel) => panel.role === "fixed")
    .map((panel, index) => `Panel ${panel.panel} must preserve reference image ${index + 1}.`);
  const unused = layout.columns * layout.rows - panels.length;
  const regions = layout.regions
    .map((region) => `Panel ${region.panel}: x ${region.x}, y ${region.y}, ${region.width}x${region.height}.`)
    .join(" ");
  return [
    `Render one ${panels.length}-panel sheet inside the ${layout.canvasWidth}x${layout.canvasHeight} canvas using this exact ${layout.columns}-column by ${layout.rows}-row layout. ${regions} Keep every pixel outside those rectangles blank. No gutters inside a panel, borders, captions, or text.${unused > 0 ? ` The final ${unused} grid position${unused === 1 ? " is" : "s are"} unused.` : ""}`,
    ...fixed,
    body,
  ].join("\n\n");
}

function boardLayout(panelCount: number, canvasWidth: number, canvasHeight: number, aspect: string): FrameBoardLayout {
  const columns = panelCount <= 4 ? 2 : 3;
  const rows = Math.ceil(panelCount / columns);
  const parts = /^([0-9]+(?:\.[0-9]+)?):([0-9]+(?:\.[0-9]+)?)$/.exec(aspect);
  if (parts === null || parseAspect(aspect) === null) throw new Error(`${aspect} is not a valid production aspect`);
  const decimals = Math.max(parts[1]!.split(".")[1]?.length ?? 0, parts[2]!.split(".")[1]?.length ?? 0);
  const scale10 = 10 ** decimals;
  let unitWidth = Math.round(Number(parts[1]) * scale10);
  let unitHeight = Math.round(Number(parts[2]) * scale10);
  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
  const divisor = gcd(unitWidth, unitHeight);
  unitWidth /= divisor;
  unitHeight /= divisor;
  const slotWidth = canvasWidth / columns;
  const slotHeight = canvasHeight / rows;
  const scale = Math.floor(Math.min(slotWidth / unitWidth, slotHeight / unitHeight));
  const width = unitWidth * scale;
  const height = unitHeight * scale;
  if (width < 1 || height < 1) throw new Error("the image canvas is too small for the board layout");
  const gridWidth = width * columns;
  const gridHeight = height * rows;
  const offsetX = Math.floor((canvasWidth - gridWidth) / 2);
  const offsetY = Math.floor((canvasHeight - gridHeight) / 2);
  return {
    columns,
    rows,
    canvasWidth,
    canvasHeight,
    regions: Array.from({ length: panelCount }, (_, index) => ({
      panel: index + 1,
      x: offsetX + (index % columns) * width,
      y: offsetY + Math.floor(index / columns) * height,
      width,
      height,
    })),
  };
}

function frozenDispatch(input: {
  runId: string;
  stepIndex: number;
  worldId: string;
  productionId: string;
  sceneId: string;
  sceneVersion: number;
  model: ManifestModel;
  request: FrameStepRequest;
  target: EnqueueInput["target"];
  output: ReturnType<typeof sceneImageOutput>;
  routeOutput: ReturnType<typeof sceneImageOutput>;
  cellOutput: ReturnType<typeof sceneImageOutput>;
  references: string[];
  estimatedMicroUsd: number;
  cellEstimatedMicroUsd: number;
  baseParams?: Record<string, unknown>;
  recipe?: EnqueueInput["recipe"];
  engine?: EnqueueInput["engine"];
}): FrameRunStep["dispatch"] {
  return {
    worldId: input.worldId,
    productionId: input.productionId,
    provider: input.model.provider,
    model: input.model.id,
    capability: "image",
    target: input.target,
    references: input.references,
    referenceCapacity: input.model.accepts.referenceImages,
    output: input.output,
    routeOutput: input.routeOutput,
    cellOutput: input.cellOutput,
    estimatedMicroUsd: input.estimatedMicroUsd,
    cellEstimatedMicroUsd: input.cellEstimatedMicroUsd,
    params: {
      ...input.baseParams,
      prompt: input.request.prompt,
      references: input.references,
      output: input.output,
      provenance: {
        canonRevision: input.request.provenance.canonRevision,
        artDirectionVersion: input.request.provenance.artDirectionVersion,
        sceneId: input.sceneId,
        sceneVersion: input.sceneVersion,
        sheets: Object.fromEntries(input.request.references.map((reference) => [reference.sheetId, reference.version])),
      },
      frameRun: input.runId,
      frameRunStep: input.stepIndex,
      landing: "frame-slot",
      request: input.request,
    },
    landing: {
      dir: `productions/${input.productionId}/incoming/${input.runId}/step-${input.stepIndex}`,
      name: `${input.runId}-step-${input.stepIndex}.png`,
    },
    idempotencyKey: deterministicUlid(`${input.runId}:step:${input.stepIndex}`),
    ...(input.recipe !== undefined ? { recipe: input.recipe } : {}),
    ...(input.engine !== undefined ? { engine: input.engine } : {}),
  };
}

export interface CompileFrameRunInput {
  worldId: string;
  productionId: string;
  scene: SceneRecord;
  production: ProductionBundle;
  world: WorldBundle;
  model: ManifestModel;
  mode: "per-shot" | "board";
  scope: "missing" | "all";
  boardCapSec: number;
  boardPanelCap?: number;
  /** Local recipe/engine identities resolved at authorization, never at delayed enqueue. */
  recipe?: EnqueueInput["recipe"];
  engine?: EnqueueInput["engine"];
  eligible: boolean;
  clock: () => string;
}

export interface QuoteFrameRunInput {
  requestId: string;
  quoteId: string;
  worldId: string;
  productionId: string;
  sceneId: string;
  mode: "per-shot" | "board";
  modelId: string;
  scope: "missing" | "all";
  clock: () => string;
  compile: () => CompileFrameRunInput;
}

export interface StartFrameRunInput {
  quotedMicroUsd: number;
  quoteSignature: string;
  jobs: () => readonly Job[];
  consumeQuote: () => FrameRunQuote | undefined;
  compile: () => CompileFrameRunInput;
}

/** Compile and persist exactly what the confirmation authorized, before the first enqueue. */
async function compileFrameRun(input: CompileFrameRunInput): Promise<FrameRun> {
  if (input.model.capability !== "image") throw new Error(`${input.model.displayName} is not an image model`);
  if (!input.eligible) throw new Error(`${input.model.displayName} is not currently eligible to run`);
  const shots = orderedShots(input.scene);
  const frameByShot = new Map(shots.map((shot) => [shot.id, selectedFrame(input.production, input.world, shot.id)]));
  const included = shots.filter((shot) => input.scope === "all" || frameByShot.get(shot.id) === null);
  if (included.length === 0) throw new Error("nothing to generate - this scope contains zero shots");

  const aspect = productionAspect(input.production.meta);
  const aspectVerdict = aspectSupport(input.model, aspect);
  if (!aspectVerdict.ok) {
    throw new Error(`${input.model.displayName} cannot deliver ${aspect}${aspectVerdict.supported.length > 0 ? ` - it offers ${aspectVerdict.supported.join(", ")}` : ""}`);
  }
  if (input.mode === "board" && (!Number.isInteger(input.boardPanelCap) || (input.boardPanelCap ?? 0) < 1)) {
    throw new Error("the routed video model has no finite storyboard panel cap");
  }
  if (!Number.isFinite(input.boardCapSec) || input.boardCapSec <= 0) {
    throw new Error("the routed video model has no finite board duration cap");
  }
  const runId = newId("fr");
  const routeOutput = sceneImageOutput(input.model, undefined, aspect);
  const plan = planScene(
    {
      world: input.world.meta,
      artDirection: input.world.artDirection,
      productionId: input.productionId,
      production: {
        ...(input.production.meta.styleOverride !== undefined ? { styleOverride: input.production.meta.styleOverride } : {}),
        ...(input.production.meta.musicPolicy !== undefined ? { musicPolicy: input.production.meta.musicPolicy } : {}),
        failureModes: input.production.meta.failureModes,
      },
      sheets: input.world.sheets,
      kits: input.world.referenceKits,
      scene: input.scene,
      selections: input.production.selections,
      model: input.model,
      artifacts: input.world.artifacts,
      takes: input.production.takes,
      aspect,
    },
    "per-shot",
  );
  const passes = compilePasses({
    productionId: input.productionId,
    scene: input.scene,
    plan,
    model: input.model,
    world: input.world,
  });
  const passByShot = new Map(passes.map((pass) => [pass.target.id, pass]));
  const includedIds = new Set(included.map((shot) => shot.id));
  let steps: FrameRunStep[];

  if (input.mode === "per-shot") {
    steps = included.map((shot, stepIndex) => {
      const pass = passByShot.get(shot.id);
      if (pass === undefined) throw new Error(`shot ${shot.number} could not compile an image request`);
      const references = frozenReferences([pass], input.model.accepts.referenceImages);
      const request: FrameStepRequest = {
        prompt: String(pass.params["prompt"]),
        panels: [{ panel: 1, shotId: shot.id, role: "update" }],
        references,
        droppedReferences: [],
        provenance: {
          canonRevision: input.world.meta.canonRevision,
          artDirectionVersion: input.world.artDirection.version,
        },
        aspect,
        slotAtAuthorization: { [shot.id]: input.production.selections[shot.id]?.startFrameArtifactId ?? null },
      };
      const referencePaths = references.map((reference) => reference.path);
      return {
        label: `Shot ${shot.number}`,
        requestShotIds: [shot.id],
        updateShotIds: [shot.id],
        request,
        dispatch: frozenDispatch({
          runId,
          stepIndex,
          worldId: input.worldId,
          productionId: input.productionId,
          sceneId: input.scene.id,
          sceneVersion: input.scene.version,
          model: input.model,
          request,
          target: { kind: "shot", id: shot.id, coversShots: [shot.id] },
          output: routeOutput,
          routeOutput,
          cellOutput: routeOutput,
          references: referencePaths,
          estimatedMicroUsd: estimateMicroUsd(input.model, {
            images: 1,
            referenceImages: referencePaths.length,
            megapixels: (routeOutput.width * routeOutput.height) / 1_000_000,
            ...(routeOutput.resolution !== undefined ? { resolution: routeOutput.resolution } : {}),
          }),
          cellEstimatedMicroUsd: estimateMicroUsd(input.model, {
            images: 1,
            referenceImages: referencePaths.length,
            megapixels: (routeOutput.width * routeOutput.height) / 1_000_000,
            ...(routeOutput.resolution !== undefined ? { resolution: routeOutput.resolution } : {}),
          }),
          baseParams: pass.params,
          ...(input.recipe !== undefined ? { recipe: input.recipe } : {}),
          ...(input.engine !== undefined ? { engine: input.engine } : {}),
        }),
        sourceStepIndex: stepIndex,
        grain: "initial",
        jobId: null,
        landingOutcomes: {},
      };
    });
  } else {
    const packed = packBoards(
      packShotsFor({
        scene: input.scene,
        shots,
        selections: input.production.selections,
        takes: input.production.takes,
        castOf: (shot) =>
          resolveCast(shot.description, input.world.sheets).cast
            .filter((entry) => entry.sheet.type === "character")
            .map((entry) => entry.sheet.id),
        defaultDurationSec: DEFAULT_SHOT_SEC,
      }),
      input.boardCapSec,
      new Set(input.scene.boards?.splits ?? []),
      new Set(input.scene.boards?.merges ?? []),
      (shotId) => frameByShot.get(shotId) !== null,
      input.boardPanelCap,
    );
    if (!packed.ok) {
      throw new Error(
        `shot ${packed.oversizeShot.number} is ${packed.oversizeShot.durationSec}s, over the ${packed.oversizeShot.capSec}s board limit`,
      );
    }
    const includedBoards = packed.boards.filter((board) => board.memberShotIds.some((shotId) => includedIds.has(shotId)));
    steps = includedBoards.map((board, stepIndex) => {
      const updateShotIds = board.memberShotIds.filter((shotId) => includedIds.has(shotId));
      const members = board.memberShotIds.map((id) => shots.find((shot) => shot.id === id)!).filter(Boolean);
      const panels = board.memberShotIds.map((shotId, index) => {
        if (includedIds.has(shotId)) return { panel: index + 1, shotId, role: "update" as const };
        const fixedImage = frameByShot.get(shotId);
        if (fixedImage === null || fixedImage === undefined) {
          throw new Error(`board ${board.letter}'s fixed shot ${shotId} has no dispatchable frame`);
        }
        return { panel: index + 1, shotId, role: "fixed" as const, fixedImage };
      });
      const fixedCount = panels.filter((panel) => panel.role === "fixed").length;
      if (fixedCount > input.model.accepts.referenceImages) {
        throw new Error(
          `board ${board.letter} needs ${fixedCount} fixed frame references, but ${input.model.displayName} accepts ${input.model.accepts.referenceImages}`,
        );
      }
      const boardPasses = board.memberShotIds.flatMap((shotId) => {
        const pass = passByShot.get(shotId);
        return pass === undefined ? [] : [pass];
      });
      const creativePrompt =
        boardPromptFor(input.scene, board.memberShotIds) ??
        assembleBoardPrompt({
          world: input.world.meta,
          sheets: input.world.sheets,
          scene: input.scene,
          shots: members,
          aspect,
          artDirection: input.world.artDirection.description,
        });
      const layout = boardLayout(panels.length, routeOutput.width, routeOutput.height, aspect);
      const firstRegion = layout.regions[0]!;
      const cellOutput = {
        width: firstRegion.width,
        height: firstRegion.height,
        aspect,
        ...(routeOutput.resolution !== undefined ? { resolution: routeOutput.resolution } : {}),
      };
      const request: FrameStepRequest = {
        prompt: boardSheetPrompt(creativePrompt, panels, layout),
        panels,
        references: frozenReferences(boardPasses, input.model.accepts.referenceImages - fixedCount),
        droppedReferences: [],
        provenance: {
          canonRevision: input.world.meta.canonRevision,
          artDirectionVersion: input.world.artDirection.version,
        },
        layout,
        aspect,
        slotAtAuthorization: Object.fromEntries(
          updateShotIds.map((shotId) => [shotId, input.production.selections[shotId]?.startFrameArtifactId ?? null]),
        ),
      };
      const references = [
        ...panels.flatMap((panel) => panel.fixedImage === undefined ? [] : [panel.fixedImage.path]),
        ...request.references.map((reference) => reference.path),
      ];
      const output = routeOutput;
      return {
        label: `Board ${board.letter}`,
        requestShotIds: [...board.memberShotIds],
        updateShotIds,
        request,
        dispatch: frozenDispatch({
          runId,
          stepIndex,
          worldId: input.worldId,
          productionId: input.productionId,
          sceneId: input.scene.id,
          sceneVersion: input.scene.version,
          model: input.model,
          request,
          target: { kind: "board-sheet", coversShots: [...board.memberShotIds] },
          output,
          routeOutput,
          cellOutput,
          references,
          estimatedMicroUsd: estimateMicroUsd(input.model, {
            images: 1,
            referenceImages: references.length,
            megapixels: (output.width * output.height) / 1_000_000,
            ...(output.resolution !== undefined ? { resolution: output.resolution } : {}),
          }),
          cellEstimatedMicroUsd: estimateMicroUsd(input.model, {
            images: 1,
            referenceImages: request.references.length + 1,
            megapixels: (routeOutput.width * routeOutput.height) / 1_000_000,
            ...(routeOutput.resolution !== undefined ? { resolution: routeOutput.resolution } : {}),
          }),
          ...(input.recipe !== undefined ? { recipe: input.recipe } : {}),
          ...(input.engine !== undefined ? { engine: input.engine } : {}),
        }),
        sourceStepIndex: stepIndex,
        grain: "initial",
        jobId: null,
        landingOutcomes: {},
      };
    });
  }

  if (steps.length === 0) throw new Error("nothing to generate - this scope compiled zero steps");
  const run = FrameRunSchema.parse({
    id: runId,
    sceneId: input.scene.id,
    sceneVersion: input.scene.version,
    mode: input.mode,
    model: input.model.id,
    steps,
    cursor: 0,
    paused: false,
    cancelled: false,
    createdAt: input.clock(),
  });
  return run;
}

function quoteProjection(run: FrameRun, input: CompileFrameRunInput) {
  return {
    worldId: input.worldId,
    productionId: input.productionId,
    sceneId: input.scene.id,
    sceneVersion: input.scene.version,
    mode: input.mode,
    modelId: input.model.id,
    scope: input.scope,
    steps: run.steps.map((step) => {
      const { frameRun: _frameRun, frameRunStep: _frameRunStep, ...stableParams } = step.dispatch.params;
      return {
        label: step.label,
        requestShotIds: step.requestShotIds,
        updateShotIds: step.updateShotIds,
        request: step.request,
        dispatch: {
          worldId: step.dispatch.worldId,
          productionId: step.dispatch.productionId,
          provider: step.dispatch.provider,
          model: step.dispatch.model,
          capability: step.dispatch.capability,
          target: step.dispatch.target,
          references: step.dispatch.references,
          referenceCapacity: step.dispatch.referenceCapacity,
          output: step.dispatch.output,
          routeOutput: step.dispatch.routeOutput,
          cellOutput: step.dispatch.cellOutput,
          estimatedMicroUsd: step.dispatch.estimatedMicroUsd,
          cellEstimatedMicroUsd: step.dispatch.cellEstimatedMicroUsd,
          params: stableParams,
          recipe: step.dispatch.recipe,
          engine: step.dispatch.engine,
        },
      };
    }),
  };
}

function quoteSignature(run: FrameRun, input: CompileFrameRunInput): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(quoteProjection(run, input))).digest("hex")}`;
}

export async function quoteFrameRun(store: WorldStore, input: QuoteFrameRunInput): Promise<FrameRunQuote> {
  return store.gateOp(async () => {
    try {
      const current = input.compile();
      const run = await compileFrameRun(current);
      return FrameRunQuoteSchema.parse({
        requestId: input.requestId,
        quoteId: input.quoteId,
        signature: quoteSignature(run, current),
        worldId: current.worldId,
        productionId: current.productionId,
        sceneId: current.scene.id,
        sceneVersion: current.scene.version,
        mode: current.mode,
        modelId: current.model.id,
        scope: current.scope,
        includedCount: new Set(run.steps.flatMap((step) => step.updateShotIds)).size,
        steps: run.steps.map((step) => ({
          label: step.label,
          requestShotIds: step.requestShotIds,
          updateShotIds: step.updateShotIds,
          estimatedMicroUsd: step.dispatch.estimatedMicroUsd,
        })),
        estimatedMicroUsd: run.steps.reduce((sum, step) => sum + step.dispatch.estimatedMicroUsd, 0),
        blockedReason: null,
        quotedAt: input.clock(),
      });
    } catch (error) {
      return FrameRunQuoteSchema.parse({
        requestId: input.requestId,
        quoteId: input.quoteId,
        signature: null,
        worldId: input.worldId,
        productionId: input.productionId,
        sceneId: input.sceneId,
        sceneVersion: null,
        mode: input.mode,
        modelId: input.modelId,
        scope: input.scope,
        includedCount: 0,
        steps: [],
        estimatedMicroUsd: null,
        blockedReason: error instanceof Error ? error.message : String(error),
        quotedAt: input.clock(),
      });
    }
  });
}

export async function startFrameRun(store: WorldStore, input: StartFrameRunInput): Promise<FrameRun> {
  return store.gateOp(async () => {
    const quote = input.consumeQuote();
    if (quote === undefined) throw new Error("that frame-run quote is no longer available; request a new quote");
    if (quote.blockedReason !== null || quote.signature === null || quote.estimatedMicroUsd === null) {
      throw new Error(quote.blockedReason ?? "that frame-run quote cannot authorize work");
    }
    const current = input.compile();
    if (
      quote.worldId !== current.worldId ||
      quote.productionId !== current.productionId ||
      quote.sceneId !== current.scene.id ||
      quote.mode !== current.mode ||
      quote.modelId !== current.model.id ||
      quote.scope !== current.scope
    ) throw new Error("the frame-run options do not match the quote");
    const run = await compileFrameRun(current);
    const signature = quoteSignature(run, current);
    const amount = run.steps.reduce((sum, step) => sum + step.dispatch.estimatedMicroUsd, 0);
    if (
      quote.signature !== input.quoteSignature ||
      signature !== input.quoteSignature ||
      quote.estimatedMicroUsd !== input.quotedMicroUsd ||
      amount !== input.quotedMicroUsd
    ) throw new Error("the frame-run quote is stale; request a new quote");
    for (const existing of await listFrameRuns(store, current.productionId)) {
      if (existing.sceneId !== current.scene.id) continue;
      const state = await frameRunState(store, current.productionId, existing, input.jobs());
      if (state.status === "active" || state.status === "paused") {
        throw new Error("this scene already has an active frame run");
      }
    }
    await mkdir(toExtendedLength(runsDir(store, current.productionId)), { recursive: true });
    await writeRun(store, current.productionId, run);
    return run;
  });
}

/** Settle a provisional start after first-step enqueue failed, without inventing a second spend. */
export async function abortFrameRunStart(
  store: WorldStore,
  productionId: string,
  runId: string,
  jobs: () => readonly Job[],
): Promise<string | null> {
  return serializeFileMutation(runPath(store, productionId, runId), async () => {
    const run = await readFrameRun(store, productionId, runId);
    if (run === null) return null;
    const first = run.steps[0];
    if (first === undefined) {
      await rm(toExtendedLength(runPath(store, productionId, runId)), { force: true });
      return null;
    }
    const journaled = jobs().find((job) => job.idempotencyKey === first.dispatch.idempotencyKey);
    if (journaled === undefined) {
      await rm(toExtendedLength(runPath(store, productionId, runId)), { force: true });
      return null;
    }
    const cancelled = FrameRunSchema.parse({
      ...run,
      cancelled: true,
      cursor: Math.max(run.cursor, 1),
      steps: run.steps.map((step, index) => index === 0 ? { ...step, jobId: journaled.id } : step),
    });
    await writeRun(store, productionId, cancelled);
    return journaled.id;
  });
}

export interface FrameRunDriverDeps {
  enqueue: (input: EnqueueInput) => Promise<{ id: string }>;
  jobById: (id: string) => Job | undefined;
}

function enqueueInput(
  step: FrameRunStep,
): EnqueueInput {
  const dispatch = step.dispatch;
  return {
    worldId: dispatch.worldId,
    productionId: dispatch.productionId,
    target: dispatch.target,
    capability: dispatch.capability,
    provider: dispatch.provider,
    model: dispatch.model,
    params: dispatch.params,
    estimatedMicroUsd: dispatch.estimatedMicroUsd,
    landing: dispatch.landing,
    idempotencyKey: dispatch.idempotencyKey,
    ...(dispatch.recipe !== undefined ? { recipe: dispatch.recipe } : {}),
    ...(dispatch.engine !== undefined ? { engine: dispatch.engine } : {}),
  };
}

function deterministicUlid(value: string): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const digest = createHash("sha256").update(value).digest();
  return Array.from({ length: 26 }, (_, index) => alphabet[digest[index % digest.length]! % 32]).join("");
}

/** Wake/advance one run. Serialization closes terminal-event and control-command races. */
export async function advanceFrameRun(
  store: WorldStore,
  productionId: string,
  runId: string,
  deps: FrameRunDriverDeps,
): Promise<FrameRun | null> {
  return serializeFileMutation(runPath(store, productionId, runId), async () => {
    let run = await readFrameRun(store, productionId, runId);
    if (run === null || run.paused || run.cancelled) return run;
    while (run.cursor < run.steps.length) {
      if (run.cursor > 0) {
        const previous = run.steps[run.cursor - 1]!;
        const previousJob = previous.jobId === null ? undefined : deps.jobById(previous.jobId);
        if (!stepSettled(previousJob)) return run;
      }
      const index = run.cursor;
      const step = run.steps[index]!;
      const job = await deps.enqueue(enqueueInput(step));
      run = FrameRunSchema.parse({
        ...run,
        steps: run.steps.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, jobId: job.id } : candidate),
        cursor: index + 1,
      });
      await writeRun(store, productionId, run);
      const current = deps.jobById(job.id);
      if (!stepSettled(current)) return run;
    }
    return run;
  });
}

async function mutateRun(
  store: WorldStore,
  productionId: string,
  runId: string,
  mutate: (run: FrameRun) => FrameRun,
): Promise<FrameRun | null> {
  return serializeFileMutation(runPath(store, productionId, runId), async () => {
    const run = await readFrameRun(store, productionId, runId);
    if (run === null) return null;
    const next = FrameRunSchema.parse(mutate(run));
    await writeRun(store, productionId, next);
    return next;
  });
}

export function pauseFrameRun(store: WorldStore, productionId: string, runId: string): Promise<FrameRun | null> {
  return mutateRun(store, productionId, runId, (run) => ({ ...run, paused: true }));
}

export function resumeFrameRun(store: WorldStore, productionId: string, runId: string): Promise<FrameRun | null> {
  return mutateRun(store, productionId, runId, (run) => ({ ...run, paused: false }));
}

export async function cancelFrameRun(
  store: WorldStore,
  productionId: string,
  runId: string,
  deps: Pick<FrameRunDriverDeps, "jobById"> & { cancel: (jobId: string) => Promise<void> },
): Promise<FrameRun | null> {
  const run = await mutateRun(store, productionId, runId, (current) => ({ ...current, cancelled: true }));
  if (run === null) return null;
  for (const jobId of run.steps.flatMap((step) => step.jobId === null ? [] : [step.jobId])) {
    const job = deps.jobById(jobId);
    if (job !== undefined && !TERMINAL.has(job.status)) await deps.cancel(jobId);
  }
  return run;
}

function retrySource(
  run: FrameRun,
  stepIndex: number,
  jobById: (id: string) => Job | undefined,
  grain: "step-retry" | "cell-retry",
  shotId?: string,
): FrameRunStep {
  if (run.cancelled) throw new Error("a cancelled frame run cannot be retried");
  const step = run.steps[stepIndex];
  if (step === undefined || step.jobId === null) throw new Error(`frame-run step ${stepIndex} has no settled attempt`);
  const job = jobById(step.jobId);
  if (job === undefined || !TERMINAL.has(job.status)) throw new Error(`frame-run step ${stepIndex} is not terminal`);
  if (job.finalization?.status === "pending" || job.finalization?.status === "failed") {
    throw new Error(`frame-run step ${stepIndex} still owes local finalization and cannot spend on a retry`);
  }
  if (job.status === "failed" && job.failureClass !== "transient") {
    throw new Error(`frame-run step ${stepIndex} has ${job.failureClass ?? "terminal"} failure and cannot be retried`);
  }
  if (job.status === "cancelled") throw new Error(`frame-run step ${stepIndex} was cancelled and cannot be retried`);
  const descendsFrom = (candidateIndex: number): boolean => {
    let at = run.steps[candidateIndex]?.retryOf;
    while (at !== undefined) {
      if (at === stepIndex) return true;
      at = run.steps[at]?.retryOf;
    }
    return false;
  };
  const blocking = run.steps.find((candidate, index) => {
    if (index === stepIndex || candidate.retryOf === undefined || !descendsFrom(index)) return false;
    const requestedShots = grain === "cell-retry" ? [shotId!] : step.updateShotIds;
    if (!candidate.updateShotIds.some((candidateShot) => requestedShots.includes(candidateShot))) return false;
    if (candidate.jobId === null) return true;
    const descendant = jobById(candidate.jobId);
    if (
      grain === "step-retry" &&
      candidate.grain === "cell-retry" &&
      descendant !== undefined &&
      descendant.finalization?.status !== "pending" &&
      descendant.finalization?.status !== "failed" &&
      TERMINAL.has(descendant.status)
    ) return false;
    return true;
  });
  if (blocking !== undefined) {
    throw new Error(`${grain === "cell-retry" ? shotId : `frame-run source ${step.sourceStepIndex}`} already has a newer retry attempt`);
  }
  return step;
}

async function refuseRetryWhileAnotherRunOwnsScene(
  store: WorldStore,
  productionId: string,
  run: FrameRun,
  jobById: (id: string) => Job | undefined,
): Promise<void> {
  for (const candidate of await listFrameRuns(store, productionId)) {
    if (candidate.id === run.id || candidate.sceneId !== run.sceneId) continue;
    const jobs = candidate.steps.flatMap((step) => {
      const job = step.jobId === null ? undefined : jobById(step.jobId);
      return job === undefined ? [] : [job];
    });
    const state = await frameRunState(store, productionId, candidate, jobs);
    if (state.status === "active" || state.status === "paused") {
      throw new Error("this scene already has an active frame run");
    }
  }
}

function retryDispatch(
  run: FrameRun,
  productionId: string,
  source: FrameRunStep,
  request: FrameStepRequest,
  stepIndex: number,
  target: EnqueueInput["target"],
  references: string[],
  output: FrameRunStep["dispatch"]["output"],
  estimatedMicroUsd: number,
): FrameRunStep["dispatch"] {
  const dispatch = source.dispatch;
  const params = {
    ...dispatch.params,
    prompt: request.prompt,
    references,
    output,
    frameRun: run.id,
    frameRunStep: stepIndex,
    request,
  };
  return {
    ...dispatch,
    target,
    references,
    output,
    estimatedMicroUsd,
    params,
    productionId,
    landing: {
      dir: `productions/${productionId}/incoming/${run.id}/step-${stepIndex}`,
      name: `${run.id}-step-${stepIndex}.png`,
    },
    idempotencyKey: deterministicUlid(`${run.id}:step:${stepIndex}`),
  };
}

function currentSlots(production: ProductionBundle, shotIds: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(shotIds.map((shotId) => [shotId, production.selections[shotId]?.startFrameArtifactId ?? null]));
}

export async function retryFrameStep(
  store: WorldStore,
  productionId: string,
  runId: string,
  stepIndex: number,
  getProduction: () => ProductionBundle | undefined,
  jobById: (id: string) => Job | undefined,
): Promise<FrameRun | null> {
  return store.gateOp(async () => {
    const existing = await readFrameRun(store, productionId, runId);
    if (existing === null) return null;
    await refuseRetryWhileAnotherRunOwnsScene(store, productionId, existing, jobById);
    const production = getProduction();
    if (production === undefined) throw new Error(`production ${productionId} is no longer available`);
    return mutateRun(store, productionId, runId, (run) => {
      const source = retrySource(run, stepIndex, jobById, "step-retry");
      const appendedIndex = run.steps.length;
      const request = { ...source.request, slotAtAuthorization: currentSlots(production, source.updateShotIds) };
      const next: FrameRun = {
        ...run,
        paused: false,
        steps: [...run.steps, {
          ...source,
          label: `${source.label} retry`,
          request,
          dispatch: retryDispatch(
            run,
            productionId,
            source,
            request,
            appendedIndex,
            source.dispatch.target,
            source.dispatch.references,
            source.dispatch.output,
            source.dispatch.estimatedMicroUsd,
          ),
          sourceStepIndex: source.sourceStepIndex,
          grain: "step-retry",
          retryOf: stepIndex,
          jobId: null,
          landingOutcomes: {},
        }],
      };
      delete next.dismissed;
      return next;
    });
  });
}

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
}

function panelTakeId(jobId: string, panel: number): string {
  return `tk_${deterministicUlid(`${jobId}:${panel}`)}`;
}

export async function retryFrameCell(
  store: WorldStore,
  productionId: string,
  runId: string,
  stepIndex: number,
  shotId: string,
  getProduction: () => ProductionBundle | undefined,
  jobById: (id: string) => Job | undefined,
): Promise<FrameRun | null> {
  return store.gateOp(() => retryFrameCellUnderGate(
    store,
    productionId,
    runId,
    stepIndex,
    shotId,
    getProduction,
    jobById,
  ));
}

async function retryFrameCellUnderGate(
  store: WorldStore,
  productionId: string,
  runId: string,
  stepIndex: number,
  shotId: string,
  getProduction: () => ProductionBundle | undefined,
  jobById: (id: string) => Job | undefined,
): Promise<FrameRun | null> {
  const existing = await readFrameRun(store, productionId, runId);
  if (existing === null) return null;
  await refuseRetryWhileAnotherRunOwnsScene(store, productionId, existing, jobById);
  const production = getProduction();
  if (production === undefined) throw new Error(`production ${productionId} is no longer available`);
  const source = retrySource(existing, stepIndex, jobById, "cell-retry", shotId);
  if (!source.requestShotIds.includes(shotId as never)) {
    throw new Error(`${shotId} is not a panel in frame-run step ${stepIndex}`);
  }
  const ancestors = new Set<number>();
  let ancestor: number | undefined = stepIndex;
  while (ancestor !== undefined) {
    ancestors.add(ancestor);
    ancestor = existing.steps[ancestor]?.retryOf;
  }
  const boardAttempt = existing.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step, index }) => {
      if (!ancestors.has(index) || step.dispatch.target.kind !== "board-sheet") return false;
      if (!step.requestShotIds.includes(shotId as never) || step.jobId === null) return false;
      const job = jobById(step.jobId);
      return job?.status === "succeeded" && job.finalization?.status !== "pending" && job.finalization?.status !== "failed";
    })
    .sort((a, b) => b.index - a.index)[0]?.step;
  if (boardAttempt === undefined) throw new Error("a cell retry requires a successful board-sheet attempt for that shot");
  const sourceJob = boardAttempt.jobId === null ? undefined : jobById(boardAttempt.jobId);
  const parent = production.takes.find((take) => take.jobId === sourceJob?.id && take.boardSheetParent === true);
  if (sourceJob === undefined || parent?.media === undefined) throw new Error("the board sheet for this cell is unavailable");
  const path = `productions/${productionId}/takes/${parent.id}/${parent.media}`;
  const bytes = await readFile(toExtendedLength(join(store.dir, path)));
  return mutateRun(store, productionId, runId, (run) => {
    const currentSource = retrySource(run, stepIndex, jobById, "cell-retry", shotId);
    const appendedIndex = run.steps.length;
    const capacity = boardAttempt.dispatch.referenceCapacity;
    if (capacity === 0) throw new Error(`${boardAttempt.dispatch.model} accepts no image references, so a cell retry cannot preserve board context`);
    const keptCreative = boardAttempt.request.references.slice(0, Math.max(0, capacity - 1));
    const dropped = [
      ...boardAttempt.request.panels.flatMap((panel) => panel.fixedImage === undefined
        ? []
        : [{ path: panel.fixedImage.path, reason: "the parent board replaces the fixed panel reference" }]),
      ...boardAttempt.request.references.slice(keptCreative.length).map((reference) => ({
        path: reference.path,
        reason: "the parent board takes the retry's last reference slot",
      })),
    ];
    const request = FrameStepRequestSchema.parse({
      ...boardAttempt.request,
      prompt: `${boardAttempt.request.prompt}\n\nReturn only panel ${boardAttempt.request.panels.find((panel) => panel.shotId === shotId)?.panel ?? 1} as one full-frame image. Preserve the board's cast, light, grade, and staging.`,
      panels: [{ panel: 1, shotId: shotId as FrameStepRequest["panels"][number]["shotId"], role: "update" }],
      references: keptCreative,
      contextImages: [{ source: "board-sheet", jobId: sourceJob.id, path, hash: hash(bytes) }],
      droppedReferences: [...boardAttempt.request.droppedReferences, ...dropped],
      layout: undefined,
      slotAtAuthorization: currentSlots(production, [shotId]),
    });
    const references = [...request.references.map((reference) => reference.path), path];
    const next: FrameRun = {
      ...run,
      paused: false,
      steps: [...run.steps, {
        label: `${source.label} - ${shotId} retry`,
        requestShotIds: [shotId],
        updateShotIds: [shotId],
        request,
        dispatch: retryDispatch(
          run,
          productionId,
          currentSource,
          request,
          appendedIndex,
          { kind: "shot", id: shotId, coversShots: [shotId] },
          references,
          boardAttempt.dispatch.routeOutput,
          boardAttempt.dispatch.cellEstimatedMicroUsd,
        ),
        sourceStepIndex: source.sourceStepIndex,
        grain: "cell-retry",
        retryOf: stepIndex,
        jobId: null,
        landingOutcomes: {},
      }],
    };
    delete next.dismissed;
    return next;
  });
}

export async function frameRunState(
  store: WorldStore,
  productionId: string,
  run: FrameRun,
  jobs: readonly Job[],
): Promise<FrameRunState> {
  void store;
  const wanted = new Set(run.steps.flatMap((step) => step.jobId === null ? [] : [step.jobId]));
  const facts: FrameRunJobFacts[] = jobs.filter((job) => wanted.has(job.id)).map((job) => ({
    id: job.id,
    status: job.status,
    failureClass: job.failureClass ?? null,
    error: job.error,
    providerHeld: job.status === "running" && job.failureClass === "provider-fault",
    ...(job.finalization !== undefined
      ? { finalization: job.finalization.status, finalizationError: job.finalization.error }
      : {}),
  }));
  return foldFrameRun(run, facts);
}

export async function dismissFrameRun(
  store: WorldStore,
  productionId: string,
  runId: string,
  jobs: () => readonly Job[],
): Promise<boolean> {
  return serializeFileMutation(runPath(store, productionId, runId), async () => {
    const run = await readFrameRun(store, productionId, runId);
    if (run === null) return false;
    const state = await frameRunState(store, productionId, run, jobs());
    if (state.status === "active" || state.status === "paused") throw new Error("an active frame run cannot be dismissed");
    await writeRun(store, productionId, { ...run, dismissed: true });
    return true;
  });
}

function cropImage(source: RgbaImage, panelIndex: number, layout: FrameBoardLayout) {
  const region = layout.regions[panelIndex];
  if (region === undefined) throw new Error(`board layout has no panel ${panelIndex + 1}`);
  const x = Math.floor((region.x * source.width) / layout.canvasWidth);
  const y = Math.floor((region.y * source.height) / layout.canvasHeight);
  const right = Math.floor(((region.x + region.width) * source.width) / layout.canvasWidth);
  const bottom = Math.floor(((region.y + region.height) * source.height) / layout.canvasHeight);
  const width = right - x;
  const height = bottom - y;
  const pixels = new Uint8Array(width * height * 4);
  for (let py = 0; py < height; py++) {
    const from = ((y + py) * source.width + x) * 4;
    pixels.set(source.pixels.subarray(from, from + width * 4), py * width * 4);
  }
  return { image: { width, height, pixels }, geometry: { x, y, width, height } };
}

async function pngBytes(
  store: WorldStore,
  parent: Take,
  productionId: string,
  toPng?: BoundaryFrameMaker,
): Promise<Uint8Array> {
  const path = join(store.dir, "productions", productionId, "takes", parent.id, parent.media!);
  const original = await readFile(toExtendedLength(path));
  try {
    decodePng(original);
    return original;
  } catch {
    // Landing names express caller intent, not provider bytes. A JPEG returned under the requested
    // .png name still needs conversion before deterministic pixel cropping.
  }
  if (toPng === undefined) throw new Error("board sheet panel extraction requires PNG media or the image converter");
  const temporary = join(store.dir, ".cache", "frame-runs", `${newId("fr")}.png`);
  await mkdir(toExtendedLength(join(store.dir, ".cache", "frame-runs")), { recursive: true });
  try {
    const converted = await toPng.write(path, temporary, 0);
    if (!converted.ok) throw new Error(`board sheet could not be converted to PNG: ${converted.reason}`);
    return await readFile(toExtendedLength(temporary));
  } finally {
    await rm(toExtendedLength(temporary), { force: true }).catch(() => {});
  }
}

/** Preserve the board parent, derive update-panel children, then use ordinary fenced arrival. */
export async function recordBoardSheetFromJob(
  store: WorldStore,
  production: ProductionBundle,
  job: Job,
  actualMicroUsd: number | null,
  actualSource: Take["cost"]["actualSource"],
  toPng?: BoundaryFrameMaker,
): Promise<Take[]> {
  const request = FrameStepRequestSchema.parse(job.params["request"]);
  if (request.layout === undefined) throw new Error("board sheet has no frozen layout");
  const parents = await recordTakesFromJob(store, job, actualMicroUsd, {}, actualSource);
  const parent = parents[0];
  if (parent === undefined || parent.media === undefined) throw new Error("board sheet finalization produced no parent take");
  const currentProduction = store.getBundle().productions.find((candidate) => candidate.meta.id === production.meta.id);
  if (!currentProduction?.reviews.some((review) => review.takeId === parent.id)) {
    const parentReview = await reviewAppendFor(store, production.meta.id, {
      ts: store.now(),
      takeId: parent.id,
      decision: "accept",
      by: `frame-run:${job.id}`,
    });
    await store.commit({ kind: "board-sheet-accepted", source: `frame-run:${job.id}`, files: [parentReview] });
  }
  const parentPath = join(store.dir, "productions", production.meta.id, "takes", parent.id, parent.media);
  const parentBytes = await readFile(toExtendedLength(parentPath));
  const parentHash = hash(parentBytes);
  const sourceBytes = await pngBytes(store, parent, production.meta.id, toPng);
  const source = decodePng(sourceBytes);
  if (source.width * request.layout.canvasHeight !== source.height * request.layout.canvasWidth) {
    throw new Error(
      `board sheet is ${source.width}x${source.height}, not the frozen ${request.layout.canvasWidth}x${request.layout.canvasHeight} canvas`,
    );
  }
  const cropSourceHash = hash(sourceBytes);
  const landed: Take[] = [parent];
  const updatePanels = request.panels.filter((panel) => panel.role === "update");
  const existingChildren = store.getBundle().productions
    .find((candidate) => candidate.meta.id === production.meta.id)?.takes
    .filter((take) => take.panel?.parentTakeId === parent.id) ?? [];
  let allocatedEstimated = existingChildren.reduce((sum, take) => sum + take.cost.estimatedMicroUsd, 0);
  let allocatedActual = existingChildren.reduce((sum, take) => sum + (take.cost.actualMicroUsd ?? 0), 0);
  for (const [updateIndex, panel] of updatePanels.entries()) {
    let child = store.getBundle().productions
      .find((candidate) => candidate.meta.id === production.meta.id)?.takes
      .find((take) => take.panel?.parentTakeId === parent.id && take.panel.index === panel.panel);
    if (child === undefined) {
      const cropped = cropImage(source, panel.panel - 1, request.layout);
      const bytes = encodePng(cropped.image);
      const childId = panelTakeId(job.id, panel.panel);
      const estimated = updateIndex === updatePanels.length - 1
        ? job.estimatedMicroUsd - allocatedEstimated
        : Math.floor(job.estimatedMicroUsd / updatePanels.length);
      const actual = actualMicroUsd === null
        ? null
        : updateIndex === updatePanels.length - 1
          ? actualMicroUsd - allocatedActual
          : Math.floor(actualMicroUsd / updatePanels.length);
      allocatedEstimated += estimated;
      allocatedActual += actual ?? 0;
      const { boardSheetParent: _boardSheetParent, ...childBase } = parent;
      child = {
        ...childBase,
        id: childId,
        coversShots: [panel.shotId],
        media: `panel-${panel.panel}.png`,
        cost: {
          estimatedMicroUsd: estimated,
          actualMicroUsd: actual,
          ...(actual !== null && actualSource !== undefined ? { actualSource } : {}),
          allocated: true,
        },
        panel: {
          parentTakeId: parent.id,
          sourceJobId: job.id,
          index: panel.panel,
          shotId: panel.shotId,
          crop: cropped.geometry,
          parentHash,
          cropSourceHash,
          hash: hash(bytes),
        },
      };
      const dir = join(store.dir, "productions", production.meta.id, "takes", childId);
      await atomicWriteFile(join(dir, `panel-${panel.panel}.png`), bytes);
      await atomicWriteFile(join(dir, "take.json"), JSON.stringify(child, null, 2) + "\n");
    }
    landed.push(child);
    const fresh = store.getBundle().productions.find((candidate) => candidate.meta.id === production.meta.id);
    if (fresh === undefined) throw new Error("the board sheet's production is unavailable");
    const decision = {
      ts: store.now(),
      takeId: child.id,
      shotId: panel.shotId,
      decision: "accept" as const,
      by: `frame-run:${job.id}`,
    };
    const filed = await fileDrawnFrame(store, fresh, {
      take: child,
      shotId: panel.shotId,
      producedBy: `frame-run:${job.id}`,
      toPng,
      alsoCommit: [await reviewAppendFor(store, production.meta.id, decision)],
      expectedArtifactId: request.slotAtAuthorization[panel.shotId] ?? null,
    });
    if (!filed.ok) throw new Error(`the frame for ${panel.shotId} could not be filed: ${filed.reason}`);
    await recordFrameLandingOutcome(store, production.meta.id, job, panel.shotId, "superseded" in filed ? "superseded" : "filed");
  }
  return landed;
}

export async function recordFrameLandingOutcome(
  store: WorldStore,
  productionId: string,
  job: Pick<Job, "params">,
  shotId: string,
  outcome: "filed" | "superseded",
): Promise<void> {
  const runId = job.params["frameRun"];
  const stepIndex = job.params["frameRunStep"];
  if (typeof runId !== "string" || typeof stepIndex !== "number" || !Number.isInteger(stepIndex)) return;
  await mutateRun(store, productionId, runId, (run) => {
    const step = run.steps[stepIndex];
    if (step === undefined || !step.updateShotIds.includes(shotId as never)) return run;
    const previous = step.landingOutcomes[shotId as never];
    if (previous === "filed" && outcome === "superseded") return run;
    return {
      ...run,
      steps: run.steps.map((candidate, index) => index === stepIndex
        ? { ...candidate, landingOutcomes: { ...candidate.landingOutcomes, [shotId]: outcome } }
        : candidate),
    };
  });
}
