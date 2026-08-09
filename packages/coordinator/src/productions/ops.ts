import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assemblePassBlocks,
  bindingPreamble,
  boundFiles,
  composePrompt,
  dispatchDuration,
  estimateMicroUsd,
  parseMentions,
  planScene,
  sceneImageOutput,
  SceneSchema,
  ulid,
  type ArtifactSidecar,
  type ManifestModel,
  type ProductionBundle,
  type ProposalSkill,
  type Scene,
  type ScenePlan,
  type Shot,
  type ShotPlanEntry,
  type WorldBundle,
} from "@arke-studio/contracts";
import { decodePng, drawScaled, encodePng, solidImage, type RgbaImage } from "../references/png.js";
import { atomicWriteFile } from "../world/atomic.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { slugify, uniqueSlug } from "../world/slug.js";
import { JsonFile, MarkdownFile, sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";
import type { EnqueueInput } from "../queue/dispatcher.js";

/**
 * Production operations (SPEC-012): a production is a lens, not a container (D1) — nothing
 * here copies a world entity; scenes and chapters cite by id and read through at dispatch.
 */

// ---------------------------------------------------------------------------
// Creation (R-1, R-2)
// ---------------------------------------------------------------------------

export async function createProduction(
  store: WorldStore,
  input: { title: string; format: "story" | "video" | "stills"; logline?: string },
): Promise<string> {
  const taken = store.getBundle().productions.map((p) => p.meta.id);
  const slug = uniqueSlug(input.title, "production", taken);
  const meta = {
    id: slug,
    format: input.format,
    title: input.title,
    ...(input.logline !== undefined ? { logline: input.logline } : {}),
    status: "in-progress",
    created: store.now(),
    updated: store.now(),
  };
  await store.commit({
    kind: "production-create",
    source: "form",
    files: [
      {
        path: `productions/${slug}/production.json`,
        action: "create",
        content: JSON.stringify(meta, null, 2) + "\n",
        baseHash: null,
      },
    ],
  });
  return slug;
}

// ---------------------------------------------------------------------------
// Chapters (R-4, R-5, D3): order in frontmatter, direct saves cut no version
// ---------------------------------------------------------------------------

export async function createChapter(
  store: WorldStore,
  productionId: string,
  input: { title: string; order: number },
): Promise<string> {
  const slug = slugify(input.title) || `chapter-${input.order}`;
  const doc = MarkdownFile.create(
    {
      id: slug,
      title: input.title,
      order: input.order,
      version: 1,
      created: store.now().slice(0, 10),
      updated: store.now().slice(0, 10),
    },
    "",
  );
  await store.commit({
    kind: "chapter-create",
    source: "form",
    files: [
      { path: `productions/${productionId}/chapters/${slug}.md`, action: "create", content: doc.serialize(), baseHash: null },
    ],
  });
  return slug;
}

/** Direct authoring: saves in place, no proposal, no version cut (R-5). */
export async function saveChapter(
  store: WorldStore,
  productionId: string,
  chapterFile: string,
  body: string,
): Promise<void> {
  const path = `productions/${productionId}/chapters/${chapterFile}.md`;
  const live = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
  const doc = MarkdownFile.parse(live);
  doc.setBody(body);
  await store.commit({
    kind: "chapter-save",
    source: "editor",
    files: [{ path, action: "replace", content: doc.serialize(), baseHash: sha256(live), preserveVersion: true }],
  });
}

/** Reorder: frontmatter only — no file renamed, no history path moved (R-4, D3). */
export async function reorderChapters(
  store: WorldStore,
  productionId: string,
  orderedFiles: string[],
): Promise<void> {
  const files = [];
  for (const [index, file] of orderedFiles.entries()) {
    const path = `productions/${productionId}/chapters/${file}.md`;
    const live = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
    const doc = MarkdownFile.parse(live);
    if ((doc.data["order"] as number) === index + 1) continue;
    doc.setData({ order: index + 1 });
    files.push({ path, action: "replace" as const, content: doc.serialize(), baseHash: sha256(live), preserveVersion: true });
  }
  if (files.length === 0) return;
  await store.commit({ kind: "chapter-reorder", source: "form", files });
}

// ---------------------------------------------------------------------------
// Scene drafting (R-7, D4): a proposal skeleton the agent fills; accepting
// creates shots and dispatches nothing
// ---------------------------------------------------------------------------

export interface SceneDraft {
  proposalId: string;
  path: string;
  /** The retrieval-scope statement the drafting agent is given. */
  scope: string;
  instruction: string;
  /**
   * The authoring skill this draft is being shaped under, or null when the target family has
   * none (SPEC-019 R-20). Null is an ordinary outcome and the scope line says so, because a
   * fallback nobody is told about is indistinguishable from a fallback that misfired.
   */
  skill: ProposalSkill | null;
}

export async function draftSceneSkeleton(
  store: WorldStore,
  gate: {
    stage(input: {
      kind: "scene-draft";
      summary: string;
      source: string;
      targets: Array<{ path: string; content: string }>;
      skill?: ProposalSkill;
    }): Promise<{ id: string }>;
  },
  input: {
    productionId: string;
    brief: string;
    /**
     * The skill resolved for the production's target model family, from the shipped registry.
     * Passed in rather than looked up here: the registry lives in the adapter package and the
     * dependency runs one way (SPEC-005 D5).
     */
    skill?: { id: string; version: number; family: string } | null;
  },
): Promise<SceneDraft> {
  const bundle = store.getBundle();
  const production = bundle.productions.find((p) => p.meta.id === input.productionId);
  const number = (production?.scenes.reduce((a, s) => Math.max(a, s.number), 0) ?? 0) + 1;
  const slug = slugify(input.brief.split(/[.!?\n]/)[0] ?? "scene").slice(0, 40) || `scene-${number}`;
  const file = `${String(number).padStart(2, "0")}-${slug}`;
  const path = `productions/${input.productionId}/scenes/${file}.json`;
  const skill = input.skill ?? null;
  const skeleton: Scene = {
    id: `sc_${String(number).padStart(2, "0")}`,
    number,
    slug,
    title: input.brief.split(/[.!?\n]/)[0]?.trim() ?? `Scene ${number}`,
    status: "draft",
    version: 1,
    // Written into the skeleton rather than stamped at accept, so it travels the ordinary
    // proposal path and lands with the scene (R-21). The proposal record (R-19) explains the
    // draft; this is what dispatch compares against months later, when the proposal is gone.
    ...(skill !== null
      ? { draftedWith: { skillId: skill.id, version: skill.version, family: skill.family } }
      : {}),
    shots: [],
  };
  const proposal = await gate.stage({
    kind: "scene-draft",
    summary: `Scene ${number}: ${skeleton.title}`,
    source: "chat:studio",
    targets: [{ path, content: JSON.stringify(skeleton, null, 2) + "\n" }],
    // Recorded on the proposal the skill shaped (R-19), the same discipline as provenance at
    // dispatch — two scenes drafted under different guidance differ for a recoverable reason.
    ...(skill !== null ? { skill } : {}),
  });
  const characters = bundle.sheets.filter((s) => s.type === "character" && s.retired !== true).length;
  // Whichever way it went, the scope line says it (R-20). A fallback nobody is told about looks
  // exactly like a fallback that misfired, and the difference matters when the shots read oddly.
  const guidance =
    skill !== null
      ? ` · drafting guidance: ${skill.id}@v${skill.version} (${skill.family})`
      : " · drafting guidance: general — no skill ships for this model family";
  const scope = `drafts with: ${bundle.meta.name} · canon v${bundle.meta.canonRevision}${
    bundle.meta.tone ? ` · tone: ${bundle.meta.tone}` : ""
  } · ${characters} character${characters === 1 ? "" : "s"} available${guidance}`;
  const instruction = `${scope}\n\nDraft scene ${number} in ${path} from this brief: "${input.brief}". Fill the shots array: each shot needs id ("sh_" + number), number, title, description with @mentions for every character and the location, camera, audio, durationSec. Propose an inherits block (location, timeOfDay, tone). Check canon for anything the brief touches and keep every line consistent with it. Do not touch any other file.`;
  return { proposalId: proposal.id, path, scope, instruction, skill };
}

// ---------------------------------------------------------------------------
// Shots and prompt overrides (R-10, R-15, D6)
// ---------------------------------------------------------------------------

async function readScene(store: WorldStore, productionId: string, sceneFile: string): Promise<{ scene: Scene; raw: string; path: string }> {
  const path = `productions/${productionId}/scenes/${sceneFile}.json`;
  const raw = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
  return { scene: SceneSchema.parse(JSON.parse(raw)), raw, path };
}

/**
 * Store or clear a prompt override (R-15): production output, not gated change — the scene's
 * version is preserved, and the recorded sheet versions make staleness computable (R-16).
 */
export async function setPromptOverride(
  store: WorldStore,
  bundle: WorldBundle,
  input: { productionId: string; sceneFile: string; shotId: string; text: string | null },
): Promise<void> {
  const { scene, raw, path } = await readScene(store, input.productionId, input.sceneFile);
  const shots: Shot[] = scene.shots.map((shot) => {
    if (shot.id !== input.shotId) return shot;
    if (input.text === null) {
      const { promptOverride: _dropped, ...rest } = shot;
      return rest as Shot;
    }
    const sheetVersions: Record<string, number> = {};
    for (const slug of parseMentions(shot.description)) {
      const sheet = bundle.sheets.find((s) => s.id === slug);
      if (sheet) sheetVersions[slug] = sheet.version;
    }
    return { ...shot, promptOverride: { text: input.text, sheetVersions } };
  });
  const doc = JsonFile.parse(raw);
  doc.set({ shots });
  await store.commit({
    kind: "prompt-override",
    source: "editor",
    files: [{ path, action: "replace", content: doc.serialize(), baseHash: sha256(raw), preserveVersion: true }],
  });
}

// ---------------------------------------------------------------------------
// Boards (R-11..R-13, D8): local, deterministic; export files exactly one artifact
// ---------------------------------------------------------------------------

const BOARD_COLS = 4;
const BOARD_CELL = 320;
const BOARD_GAP = 12;

/** Compile the board image from selected/pinned frames — local, free, repeatable (R-11). */
export async function compileBoard(store: WorldStore, production: ProductionBundle, scene: Scene): Promise<Uint8Array> {
  const rows = Math.max(1, Math.ceil(scene.shots.length / BOARD_COLS));
  const width = BOARD_COLS * BOARD_CELL + (BOARD_COLS + 1) * BOARD_GAP;
  const height = rows * BOARD_CELL + (rows + 1) * BOARD_GAP;
  const canvas: RgbaImage = solidImage(width, height, [24, 24, 26, 255]);
  for (const [i, shot] of scene.shots.entries()) {
    const selection = production.selections[shot.id];
    const takeId = selection?.startFrameTakeId ?? selection?.acceptedTakeId ?? null;
    const col = i % BOARD_COLS;
    const row = Math.floor(i / BOARD_COLS);
    const x = BOARD_GAP + col * (BOARD_CELL + BOARD_GAP);
    const y = BOARD_GAP + row * (BOARD_CELL + BOARD_GAP);
    if (takeId === null) continue; // an empty slot stays a gap — same discipline as the grid
    const take = production.takes.find((t) => t.id === takeId);
    if (!take?.media) continue;
    try {
      const bytes = await readFile(
        toExtendedLength(join(store.dir, "productions", production.meta.id, "takes", takeId, take.media)),
      );
      drawScaled(canvas, decodePng(Uint8Array.from(bytes)), x, y, BOARD_CELL, BOARD_CELL);
    } catch {
      /* an unreadable frame stays a gap rather than failing the board */
    }
  }
  return encodePng(canvas);
}

/** Record the compiled board on the scene (R-12): lives in scene storage, not artifacts (D8). */
export async function landBoard(
  store: WorldStore,
  productionId: string,
  sceneFile: string,
  png: Uint8Array,
  clock: () => string,
): Promise<void> {
  await store.gateOp(async () => {
    const { scene, raw, path } = await readScene(store, productionId, sceneFile);
    const image = `boards/scene-${scene.number}.png`;
    await atomicWriteFile(join(store.dir, "productions", productionId, fromPortable(image)), png);
    const doc = JsonFile.parse(raw);
    doc.set({ board: { version: scene.version, compiledAt: clock(), image } });
    await store.commitUnserialised({
      kind: "board-compile",
      source: "form",
      files: [{ path, action: "replace", content: doc.serialize(), baseHash: sha256(raw), preserveVersion: true }],
    });
  });
}

/** Export files exactly one artifact per invocation (R-13): a kept snapshot, immutable. */
export async function exportBoard(
  store: WorldStore,
  productionId: string,
  scene: Scene,
  png: Uint8Array,
  clock: () => string,
): Promise<string> {
  const stamp = clock().replace(/[-:TZ.]/g, "").slice(0, 14);
  const file = `board-${productionId}-scene-${scene.number}-v${scene.version}-${stamp}.png`;
  const sidecar: ArtifactSidecar = {
    id: `ar_${ulid()}`,
    kind: "board",
    file,
    hash: `sha256:${createHash("sha256").update(png).digest("hex").slice(0, 16)}`,
    origin: { by: "system", producedBy: `board-export:${productionId}/scene-${scene.number}@v${scene.version}` },
    links: [productionId, scene.id],
    created: clock(),
  };
  await store.gateOp(async () => {
    await atomicWriteFile(join(store.dir, "artifacts", file), png);
    await store.commitUnserialised({
      kind: "board-export",
      source: "form",
      files: [
        {
          path: `artifacts/${file}.json`,
          action: "create",
          content: JSON.stringify(sidecar, null, 2) + "\n",
          baseHash: null,
        },
      ],
    });
  });
  return file;
}

// ---------------------------------------------------------------------------
// Dispatch composition (T-18): the plan becomes SPEC-009 requests, verbatim
// ---------------------------------------------------------------------------

/**
 * How a chosen size travels to the provider, which is not one answer.
 *
 * Video routes read a top-level `resolution` word. Image routes size from `output.width/height`
 * and ignore that word entirely — and fal forwards any top-level field it does not recognise, so
 * sending `resolution: "4MP"` beside `image_size` would put a field in an image request that the
 * character-image path never sends.
 */
function sizeParams(model: ManifestModel, plan: ScenePlan): Record<string, unknown> {
  if (model.capability === "image") {
    return plan.tier !== undefined ? { output: sceneImageOutput(model, plan.tier) } : {};
  }
  return plan.resolution !== undefined ? { resolution: plan.resolution } : {};
}

/** A whole-scene pass, priced the way its capability is actually billed. */
function passEstimate(
  model: ManifestModel,
  plan: ScenePlan,
  durationSec: number,
  referenceImages: number,
): number {
  if (model.capability !== "image") {
    return estimateMicroUsd(model, {
      durationSec,
      ...(plan.resolution !== undefined ? { resolution: plan.resolution } : {}),
    });
  }
  const output = sceneImageOutput(model, plan.tier);
  return estimateMicroUsd(model, {
    images: 1,
    referenceImages,
    megapixels: (output.width * output.height) / 1_000_000,
    ...(output.resolution !== undefined ? { resolution: output.resolution } : {}),
  });
}

/**
 * The seconds a video job may ask for. Refused rather than clamped when the request is longer
 * than anything the route offers: a 22s shot dispatched as a 15s clip is paid-for footage that
 * cannot cover what was asked for, and the dialog already names the shot before anyone presses.
 */
function askedSeconds(model: ManifestModel, requestedSec: number, what: string): number {
  const choice = dispatchDuration(model, requestedSec);
  if (choice.kind === "over-cap") {
    throw new Error(
      `${what} runs ${requestedSec}s — longer than the ${choice.longest}s ${model.displayName} can make`,
    );
  }
  return choice.kind === "asked" ? choice.seconds : requestedSec;
}

/**
 * The shot plan stretched to the clip that was actually asked for. Segmentation and the
 * per-shot charge split both read these boundaries, so a plan that stops short of the clip
 * hides the tail from review and prorates the money over the wrong total.
 */
function coverPlan(plan: ShotPlanEntry[], seconds: number): ShotPlanEntry[] {
  const last = plan[plan.length - 1];
  if (!last || last.endSec >= seconds) return plan;
  return [...plan.slice(0, -1), { ...last, endSec: seconds }];
}

export function composeDispatches(
  worldId: string,
  productionId: string,
  scene: Scene,
  plan: ScenePlan,
  model: ManifestModel,
  world: WorldBundle,
): EnqueueInput[] {
  // Provenance frozen at dispatch (SPEC-013 R-2): canon revision and every cited sheet version.
  const provenanceFor = (
    sheetIds: string[],
  ): { canonRevision: number; sheets: Record<string, number>; artDirectionVersion: number } => ({
    canonRevision: world.meta.canonRevision,
    artDirectionVersion: world.artDirection.version,
    sheets: Object.fromEntries(
      sheetIds
        .map((id) => world.sheets.find((s) => s.id === id))
        .filter((s): s is NonNullable<typeof s> => s !== undefined)
        .map((s) => [s.id, s.version]),
    ),
  });
  if (plan.mode === "per-shot") {
    return plan.shots.map((entry) => ({
      worldId,
      productionId,
      target: { kind: "shot", id: entry.shot.id, coversShots: [entry.shot.id] },
      capability: model.capability,
      provider: model.provider,
      model: model.id,
      params: {
        // Preamble + overridable body + derived negatives (SPEC-019 R-3, R-13). The array below
        // comes from the same bound records the preamble numbers, so the stated order and the
        // sent order are one structure rather than two that can drift (R-2, D2).
        prompt: composePrompt(entry.parts),
        references: boundFiles(entry.bound),
        // The length the plan priced, which is the length the route can actually be asked for.
        // Sending the raw shot seconds meant the job asked for something no route accepts, and
        // the client then had nothing to translate.
        ...(entry.shot.durationSec !== undefined
          ? { durationSec: askedSeconds(model, entry.shot.durationSec, `shot ${entry.shot.number}`) }
          : {}),
        ...sizeParams(model, plan),
        provenance: provenanceFor(entry.budget.carried.map((c) => c.sheetId)),
      },
      estimatedMicroUsd: entry.estimatedMicroUsd,
      landing: { dir: `productions/${productionId}/incoming/${entry.shot.id}` },
    }));
  }
  if (!plan.pack.ok) return [];
  return plan.pack.passes.map((pass) => {
    const shotsInPass = pass.plan.map((p) => plan.shots.find((s) => s.shot.id === p.shotId)!);
    const passReferencePlan = plan.passReferences.find((candidate) => candidate.passIndex === pass.index)!;
    const references = boundFiles(passReferencePlan.bound);
    const passSeconds = askedSeconds(model, pass.durationSec, `scene pass ${pass.index}`);
    if (references.length > model.accepts.referenceImages) {
      throw new Error(`scene pass ${pass.index} exceeds ${model.displayName}'s reference limit`);
    }
    // One clip, composed once (SPEC-019 R-5, R-6). Joining each shot's whole prompt restated the
    // world's art direction twice per shot; the summary, the standing description and the
    // persistent constraint now belong to the pass, and a shot contributes only its beat.
    const passBlocks = assemblePassBlocks({
      world: world.meta,
      sheets: world.sheets,
      scene,
      entries: shotsInPass.map((entry) => ({ shot: entry.shot, prompt: entry.prompt })),
      ...(world.artDirection.description !== undefined
        ? { artDirection: world.artDirection.description }
        : {}),
      carriedSheetIds: new Set(passReferencePlan.bound.map((reference) => reference.sheetId)),
    });
    const passBody = [
      passBlocks.summary,
      passBlocks.standing,
      passBlocks.beats
        .map((beat) => `[shot ${beat.shot.number} · ${beat.shot.durationSec ?? 4}s] ${beat.text}`)
        .join("\n"),
      passBlocks.persistent,
    ]
      .map((block) => block.trim())
      .filter((block) => block.length > 0)
      .join("\n\n");
    return {
      worldId,
      productionId,
      target: { kind: "scene-pass", id: scene.id, coversShots: pass.plan.map((p) => p.shotId) },
      capability: model.capability,
      provider: model.provider,
      model: model.id,
      params: {
        prompt: composePrompt({
          preamble: bindingPreamble(passReferencePlan.bound),
          body: passBody,
          // From the plan, not recomputed here: the dialog showed these and the dispatch has to
          // be the same request (R-9).
          negatives: passReferencePlan.negatives,
        }),
        references,
        durationSec: passSeconds,
        ...sizeParams(model, plan),
        // The explicit plan (R-19, D11): SPEC-013 segments from these, never guesses — which is
        // why it has to describe the clip that was actually asked for. A pass snapped from 5s to
        // 6s left a second nobody reviewed and nobody could cut from.
        shotPlan: coverPlan(pass.plan, passSeconds),
        provenance: provenanceFor(passReferencePlan.budget.carried.map((candidate) => candidate.sheetId)),
      },
      // Priced at the same size and the same length the job runs at. Recomputing it without
      // either queued a 1080p pass carrying a 720p figure, priced a pass of stills as if it
      // were footage, and used the seconds planned rather than the seconds asked for.
      estimatedMicroUsd: passEstimate(model, plan, passSeconds, references.length),
      landing: { dir: `productions/${productionId}/incoming/${scene.id}-pass-${pass.index}` },
    };
  });
}

export { planScene };
