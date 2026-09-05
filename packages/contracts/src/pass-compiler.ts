import type { PropStateProvenance } from "./prop.js";
import type { ShotPropResolution } from "./planning.js";
import { characterAudioInstructions } from "./audio-reference.js";
import {
  assemblePassBlocks,
  bindingPreamble,
  boundFiles,
  composePrompt,
  DEFAULT_SHOT_SEC,
  passStructure,
  START_FRAME_PREAMBLE,
  type BoundaryFramePlan,
  type BoundReference,
  type ContinuationPlan,
  type ScenePlan,
  type ShotPlanEntry,
} from "./planning.js";
import {
  continueDispatchFor,
  dispatchDuration,
  estimateMicroUsd,
  frameDispatchFor,
  sceneImageOutput,
  type ManifestModel,
  type TaskMode,
} from "./manifest.js";
import type { SceneRecord } from "./scene-flow.js";
import type { Sheet } from "./world.js";
import type { WorldBundle } from "./client-state.js";

/**
 * The pass compiler (issue 398): one deterministic object per dispatch pass, compiled from the
 * plan's own authorities — the SPEC-019 bound order, composePrompt, the boundary frames of
 * issue 154 and the route-aware lengths of issue 390 — and consumed by everything downstream.
 * Review copy, the estimate, the durable plan (#391) and the provider payload all read THIS
 * object; none of them re-derives, because two derivations of one dispatch disagree eventually
 * and the disagreement presents as money spent on a request nobody reviewed.
 *
 * Deliberately a pure function: no clock, no randomness, no I/O. Compiling the same scene, plan
 * and model twice yields deep-equal passes, which is what makes the object inspectable before
 * enqueue and immutable after (#391). A model or route change is answered by recompiling — the
 * coordinator recomputes plan and passes server-side at dispatch, so a stale capability
 * assumption cannot ride a cached object into a job.
 *
 * Boundary note: #245's keyframe gate and #252's patchable prompts are still open. This module
 * consumes today's single authorities at exactly the seams those issues will replace — `bound`
 * for reference order, `composePrompt` for the final words — and persists no order or prompt of
 * its own, so their landing changes inputs here rather than adding a second copy of anything.
 */

/** Which provider route this pass will actually take — resolved before anything is priced. */
export type CompiledRoute =
  | { kind: "text" }
  | { kind: "reference" }
  | { kind: "frame"; mode: "first-frame" | "first-and-last-frame"; endpoint: string | null }
  /**
   * The extend route (SPEC-019 R-50, T-31). `predecessorTakeId` is the whole point of the
   * variant: the footage itself cannot be resolved here — planning is pure and a pass segment
   * has to be cut before it can be sent (T-32) — so what the compiled object carries is the
   * exact take the dispatch is authorized against, and the dispatch path resolves the bytes.
   */
  | { kind: "continuation"; endpoint: string | null; predecessorTakeId: string };

/** One transmitted reference, in its exact wire position, with its role and frozen version. */
export interface CompiledReference {
  /** 1-based, matching the transmitted array and the preamble's numbering (SPEC-019 R-2). */
  index: number;
  file: string;
  sheetId: string;
  /** The cited sheet's version at compile time; null when the sheet is gone from the bundle. */
  sheetVersion: number | null;
  /** What this asset is a reference for, in the words the prompt uses (R-4). */
  role: string;
  /** The subject's display name, so a screen names a person rather than a slug. */
  subject: string;
  /** The attachment that chose this file — what a screen reads to state a look is riding. */
  mode: BoundReference["mode"];
}

/** An input that did not ride, with its named reason — never a silent drop (issue 398). */
export interface CompiledDrop {
  sheetId: string;
  role: string;
  reason: string;
}

export interface CompiledPass {
  target: { kind: "shot" | "scene-pass"; id: string; coversShots: string[] };
  model: {
    id: string;
    provider: ManifestModel["provider"];
    capability: ManifestModel["capability"];
    displayName: string;
  };
  /** Resolved first: the route decides askable lengths, wire fields, and what may ride. */
  route: CompiledRoute;
  /**
   * The exact wire parameter bag the job carries — prompt, references, duration, size, task
   * mode, provenance. The one copy: review reads `params["prompt"]`, the enqueue carries the
   * whole bag verbatim, and the take records it, so all three are the same request by
   * construction.
   */
  params: Record<string, unknown>;
  /** The transmitted references, typed for review — same order as `params["references"]`. */
  references: CompiledReference[];
  /** The durable boundary still this pass opens on (issue 154), when one travels. */
  frame?: BoundaryFramePlan;
  /** The predecessor footage this pass extends (SPEC-019 R-50), when it is a continuation. */
  continuation?: ContinuationPlan;
  /** The seconds actually asked of the route, when the pass has a length at all. */
  askedSec?: number;
  estimatedMicroUsd: number;
  /** Everything that did NOT ride, each with its named reason. */
  dropped: CompiledDrop[];
  /** The source versions frozen into this compile — what #391 persists beside the plan. */
  sources: {
    canonRevision: number;
    artDirectionVersion: number;
    sceneId: string;
    sceneVersion: number;
    sheets: Record<string, number>;
  };
  landing: { dir: string };
}

/**
 * How a chosen size travels to the provider, which is not one answer.
 *
 * Video routes read a top-level `resolution` word and the studio's `aspect` (issue 389), which
 * each transport maps to its route's spelling. Image routes size from `output.width/height` and
 * ignore both — and fal forwards any top-level field it does not recognise, so sending them
 * beside `image_size` would put fields in an image request that path never sends.
 */
function sizeParams(model: ManifestModel, plan: ScenePlan): Record<string, unknown> {
  if (model.capability === "image") {
    return plan.tier !== undefined || plan.aspect !== undefined
      ? { output: sceneImageOutput(model, plan.tier, plan.aspect) }
      : {};
  }
  return {
    ...(plan.resolution !== undefined ? { resolution: plan.resolution } : {}),
    ...(plan.aspect !== undefined ? { aspect: plan.aspect } : {}),
  };
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
  const output = sceneImageOutput(model, plan.tier, plan.aspect);
  return estimateMicroUsd(model, {
    images: 1,
    referenceImages,
    megapixels: (output.width * output.height) / 1_000_000,
    ...(output.resolution !== undefined ? { resolution: output.resolution } : {}),
  });
}

/**
 * The seconds a video job may ask for, on the route it will take (issue 390). Refused rather
 * than clamped when the request is longer than anything the route offers: a 22s shot dispatched
 * as a 15s clip is paid-for footage that cannot cover what was asked for.
 */
function askedSeconds(model: ManifestModel, requestedSec: number, what: string, route: CompiledRoute): number {
  const taskMode: TaskMode =
    route.kind === "continuation" ? "continue" : route.kind === "frame" ? route.mode : "generate";
  const choice = dispatchDuration(model, requestedSec, {
    taskMode,
    withReferences: route.kind === "reference",
  });
  if (choice.kind === "over-cap") {
    throw new Error(
      `${what} runs ${requestedSec}s — longer than the ${choice.longest}s ${model.displayName} can make${
        choice.becauseReferences ? " on the reference route it will take" : ""
      }`,
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

function compiledReferences(
  bound: ScenePlan["shots"][number]["bound"],
  sheets: readonly Sheet[],
): CompiledReference[] {
  return bound.map((reference) => ({
    index: reference.index,
    file: reference.file,
    sheetId: reference.sheetId,
    sheetVersion: sheets.find((sheet) => sheet.id === reference.sheetId)?.version ?? null,
    role: reference.rolePhrase,
    subject: reference.subject,
    mode: reference.mode,
  }));
}

function droppedOf(
  budget: { dropped: Array<{ sheetId: string; referenceRole?: "primary" | "secondary" }> },
  extra: CompiledDrop[] = [],
): CompiledDrop[] {
  return [
    ...budget.dropped.map((candidate) => ({
      sheetId: candidate.sheetId,
      role: candidate.referenceRole ?? "primary",
      reason:
        candidate.referenceRole === "secondary"
          ? "the main photo is dropped — its sheet still travels, over the model's reference budget"
          : "over the model's reference budget",
    })),
    ...extra,
  ];
}

export interface CompilePassesInput {
  productionId: string;
  scene: SceneRecord;
  plan: ScenePlan;
  model: ManifestModel;
  world: Pick<WorldBundle, "meta" | "sheets" | "artDirection">;
  /**
   * Compile every whole-scene pass after the first as a frame-routed continuation (SPEC-024
   * R-6): the pass opens on a boundary still cut from the previous pass's clip, which does not
   * exist yet — so the route, the preamble and the price commit to the first-frame route now,
   * and the frame fields are bound at materialisation. Requires a model with a first-frame
   * route; ignored otherwise, because a chain no route can honour is just today's independent
   * passes wearing a promise.
   */
  chainWholeSceneFrames?: boolean;
}

/** The compiled passes for one dispatch, in enqueue order. Pure, deterministic, inspectable. */
export function compilePasses(input: CompilePassesInput): CompiledPass[] {
  const { productionId, scene, plan, model, world } = input;
  const audioPlans = plan.mode === "per-shot" ? plan.shots.map(s => s.audioReferences) : plan.passReferences.map(p => p.audioReferences);
  const audioProblems = audioPlans.flatMap(a => a?.problems ?? []);
  if (audioProblems.length) throw new Error(audioProblems.join(" "));
  if (input.chainWholeSceneFrames && plan.mode === "whole-scene" && audioPlans.slice(1).some(a => a?.references.length)) {
    throw new Error("Chained frame routes cannot carry character audio references. Use independent referenced passes or explicitly disable audio references.");
  }
  const styleSource = (overridden: boolean) =>
    overridden
      ? { version: world.artDirection.version, source: "generation", transport: "text" }
      : plan.productionStyleOverride
        ? {
            version: world.artDirection.version,
            source: "production",
            transport: "text",
            description: plan.productionStyleOverride,
          }
        : { version: world.artDirection.version, source: "world", transport: "text" };
  const provenanceFor = (
    sheetIds: string[],
    propStates: readonly ShotPropResolution[] = [],
  ): {
    canonRevision: number;
    sheets: Record<string, number>;
    artDirectionVersion: number;
    propStates?: PropStateProvenance[];
  } => ({
    canonRevision: world.meta.canonRevision,
    artDirectionVersion: world.artDirection.version,
    sheets: Object.fromEntries(
      sheetIds
        .map((id) => world.sheets.find((s) => s.id === id))
        .filter((s): s is Sheet => s !== undefined)
        .map((s) => [s.id, s.version]),
    ),
    // Turn 105's five fields, frozen at dispatch for every cited prop — the unresolved ones
    // included, since "no state was chosen" is a fact about this take too (issue 536).
    ...(propStates.length > 0
      ? {
          propStates: propStates.map((entry) => ({
            propId: entry.propId,
            stateId: entry.stateId,
            referenceId: entry.referenceId,
            resolutionSource: entry.resolutionSource,
            overrideSource: entry.overrideSource,
          })),
        }
      : {}),
  });
  const sourcesFor = (sheets: Record<string, number>): CompiledPass["sources"] => ({
    canonRevision: world.meta.canonRevision,
    artDirectionVersion: world.artDirection.version,
    sceneId: scene.id,
    sceneVersion: scene.version,
    sheets,
  });
  // An impossible delivery shape cannot compile in either mode (issue 389): the refusal names
  // the model and what it does offer, before any job exists to fail.
  if (plan.warnings.aspectUnsupported !== null) {
    const bad = plan.warnings.aspectUnsupported;
    throw new Error(`${bad.model} cannot deliver ${bad.aspect} — it offers ${bad.supported.join(", ")}`);
  }

  if (plan.mode === "per-shot") {
    // A stale frame selection cannot compile (issue 154): the plan named it, and composing the
    // request anyway would send a shot to open on an artifact this world cannot produce.
    const stale = plan.warnings.staleFrames;
    if (stale.length > 0) {
      const worst = stale[0]!;
      throw new Error(`shot ${worst.number}'s start frame is unusable: ${worst.detail}`);
    }
    return plan.shots.map((entry) => {
      // The route, before anything priced or packed reads it (issue 398): a boundary frame takes
      // the first-frame route, references take the edit sibling, and the words below say so.
      const frameRoute = entry.frame !== undefined ? frameDispatchFor(model, 1) : null;
      const framed = entry.frame !== undefined && frameRoute !== null;
      // The plan already refused every continuation the graph or the model could not honour, so
      // a resolved one here is one the compiler commits to. Ahead of the frame route because the
      // plan resolved it that way, and the two must not disagree about which route a shot takes.
      const continueRoute = entry.continuation !== undefined ? continueDispatchFor(model) : null;
      const continued = entry.continuation !== undefined && continueRoute !== null;
      const route: CompiledRoute = continued
        ? {
            kind: "continuation",
            endpoint: continueRoute!.route,
            predecessorTakeId: entry.continuation!.takeId,
          }
        : framed
          ? { kind: "frame", mode: frameRoute!.mode, endpoint: frameRoute!.route }
          : entry.bound.length > 0
            ? { kind: "reference" }
            : { kind: "text" };
      // A frame mode may lock the aspect (issue 389): the picture decides the shape, and
      // sending a chosen ratio beside it puts a field on the wire the route never declared.
      // The extend route locks it for the same reason one input up — the footage being extended
      // already has a shape, and a request that disagrees with it is a request to letterbox.
      const lockedHere = new Set<string>(continued ? continueRoute!.locked : framed ? frameRoute!.locked : []);
      const size = Object.fromEntries(
        Object.entries(sizeParams(model, plan)).filter(([key]) => !lockedHere.has(key)),
      );
      // Video is always asked, even for a shot with no authored length: the plan priced the
      // default (DEFAULT_SHOT_SEC, route-rounded), so leaving the wire empty would run the
      // provider's own default at the provider's own price — the estimate and the bill for two
      // different requests, inside the object whose whole contract is that they are one.
      const askedSec =
        model.capability === "video"
          ? askedSeconds(model, entry.shot.durationSec ?? DEFAULT_SHOT_SEC, `shot ${entry.shot.number}`, route)
          : entry.shot.durationSec !== undefined
            ? askedSeconds(model, entry.shot.durationSec, `shot ${entry.shot.number}`, route)
            : undefined;
      const provenance = provenanceFor(entry.budget.carried.map((c) => c.sheetId), entry.propStates);
      return {
        target: { kind: "shot" as const, id: entry.shot.id, coversShots: [entry.shot.id] },
        model: {
          id: model.id,
          provider: model.provider,
          capability: model.capability,
          displayName: model.displayName,
        },
        route,
        params: {
          // Preamble + overridable body + derived negatives (SPEC-019 R-3, R-13). The array
          // below comes from the same bound records the preamble numbers, so the stated order
          // and the sent order are one structure rather than two that can drift (R-2, D2).
          prompt: composePrompt(entry.parts),
          ...(entry.audioReferences && (entry.audioReferences.disabled || entry.audioReferences.references.length) ? { audioReferences: entry.audioReferences } : {}),
          artDirection: styleSource(entry.prompt.overridden),
          // A continued shot sends no images at all: the extend route declares one video field
          // and nothing else, so an empty list here is the accurate description of the request.
          references: continued ? [] : framed ? [entry.frame!.file] : boundFiles(entry.bound),
          ...(continued
            ? {
                taskMode: "continue",
                ...(continueRoute!.route !== null ? { route: continueRoute!.route } : {}),
                // The predecessor edge, which is the reason this whole path exists (R-53). It
                // rides as a param because that is what arrival reads to record the edge on the
                // take, and it is stripped before the wire exactly as `startFrame` is — the
                // footage itself travels as the route's video field.
                //
                // Deliberately the ONLY continuation field in the bag. Where those bytes live is
                // derivable from it, because a take is immutable: its media and its segment range
                // cannot drift between compile and dispatch, so a frozen second copy of them
                // could only ever agree or be wrong.
                continuedFrom: entry.continuation!.takeId,
              }
            : framed
              ? {
                  taskMode: frameRoute!.mode,
                  ...(frameRoute!.route !== null ? { route: frameRoute!.route } : {}),
                  // The durable identity of what was sent (issue 154): the take records the frame
                  // it opened on, and the job can be audited against the exact bytes by hash.
                  startFrame: entry.frame!.file,
                  frameArtifact: { id: entry.frame!.artifactId, hash: entry.frame!.hash },
                }
              : {}),
          ...(askedSec !== undefined ? { durationSec: askedSec } : {}),
          ...size,
          provenance,
        },
        references: continued || framed ? [] : compiledReferences(entry.bound, world.sheets),
        ...(framed ? { frame: entry.frame! } : {}),
        ...(continued ? { continuation: entry.continuation! } : {}),
        ...(askedSec !== undefined ? { askedSec } : {}),
        estimatedMicroUsd: entry.estimatedMicroUsd,
        dropped: droppedOf(
          entry.budget,
          continued || framed
            ? [...new Set(entry.budget.carried.map((c) => c.sheetId))].map((sheetId) => ({
                sheetId,
                role: "primary",
                reason: continued
                  ? "the extend route takes one video and no images — the predecessor's footage rides instead"
                  : "the frame route takes one image — the boundary frame rides instead",
              }))
            : [],
        ),
        sources: sourcesFor(provenance.sheets),
        landing: { dir: `productions/${productionId}/incoming/${entry.shot.id}` },
      };
    });
  }

  if (!plan.pack.ok) return [];
  const chainFrameRoute = input.chainWholeSceneFrames === true ? frameDispatchFor(model, 1) : null;
  return plan.pack.passes.map((pass, position) => {
    const shotsInPass = pass.plan.map((p) => plan.shots.find((s) => s.shot.id === p.shotId)!);
    const passReferencePlan = plan.passReferences.find((candidate) => candidate.passIndex === pass.index)!;
    // A chained continuation pass (SPEC-024 R-6): opens on the previous pass's boundary still,
    // which does not exist yet. The first-frame route takes one image, so the sheet references
    // step aside now — named — and the frame fields are bound at materialisation.
    const chained = chainFrameRoute !== null && model.capability === "video" && position > 0;
    const references = chained ? [] : boundFiles(passReferencePlan.bound);
    const route: CompiledRoute = chained
      ? { kind: "frame", mode: chainFrameRoute.mode, endpoint: chainFrameRoute.route }
      : references.length > 0
        ? { kind: "reference" }
        : { kind: "text" };
    const passSeconds = askedSeconds(model, pass.durationSec, `scene pass ${pass.index}`, route);
    if (references.length > model.accepts.referenceImages) {
      throw new Error(`scene pass ${pass.index} exceeds ${model.displayName}'s reference limit`);
    }
    // One clip, composed once (SPEC-019 R-5, R-6). Joining each shot's whole prompt restated the
    // world's art direction twice per shot; the summary, the standing description and the
    // persistent constraint now belong to the pass, and a shot contributes only its beat.
    const passBlocks = assemblePassBlocks({
      world: world.meta,
      sheets: world.sheets as Sheet[],
      scene,
      entries: shotsInPass.map((entry) => ({ shot: entry.shot, prompt: entry.prompt })),
      artDirection: plan.effectiveStyle,
      carriedSheetIds: new Set(passReferencePlan.bound.map((reference) => reference.sheetId)),
      capability: model.capability,
    });
    const passBody = [
      passBlocks.summary,
      passBlocks.standing,
      passBlocks.spatial,
      passBlocks.beats
        .map((beat) => `[shot ${beat.shot.number} · ${beat.shot.durationSec ?? 4}s] ${beat.text}`)
        .join("\n"),
      passBlocks.persistent,
    ]
      .map((block) => block.trim())
      .filter((block) => block.length > 0)
      .join("\n\n");
    const provenance = provenanceFor(passReferencePlan.budget.carried.map((candidate) => candidate.sheetId), passReferencePlan.propStates);
    return {
      target: { kind: "scene-pass" as const, id: scene.id, coversShots: pass.plan.map((p) => p.shotId) },
      model: {
        id: model.id,
        provider: model.provider,
        capability: model.capability,
        displayName: model.displayName,
      },
      route,
      params: {
        prompt: composePrompt({
          // The shape of the clip, said in the prompt and not only in the parameters — the cuts
          // below are only where we say they are if the model divides the clip where we do.
          structure: passStructure({
            shotCount: pass.plan.length,
            askedSec: passSeconds,
            // From the plan, not re-looked-up (issue 389): the dialog showed this plan, and the
            // prompt's stated shape must be the shape the parameters ask for. A chained pass
            // whose frame route locks the ratio states none — the boundary image decides the
            // shape, and words claiming otherwise are the two-authorities drift in prose.
            aspect:
              chained && chainFrameRoute!.locked.includes("aspect") ? undefined : plan.aspect,
          }),
          // A chained pass states what its one image will be (SPEC-024 R-6); a referenced pass
          // numbers its assets. Never both — the route carries one or the other.
          preamble: chained ? START_FRAME_PREAMBLE : [bindingPreamble(passReferencePlan.bound), passReferencePlan.audioReferences ? characterAudioInstructions(passReferencePlan.audioReferences) : null].filter(Boolean).join("\n"),
          body: passBody,
          // From the plan, not recomputed here: the dialog showed these and the dispatch has to
          // be the same request (R-9).
          negatives: passReferencePlan.negatives,
        }),
        ...(passReferencePlan.audioReferences && (passReferencePlan.audioReferences.disabled || passReferencePlan.audioReferences.references.length) ? { audioReferences: passReferencePlan.audioReferences } : {}),
        artDirection: styleSource(false),
        references,
        durationSec: passSeconds,
        // A chained pass's frame mode may lock the aspect (issue 389) — the picture decides the
        // shape, exactly as the per-shot framed branch already enforces. Spreading unfiltered
        // put a chosen ratio on a route that never declared the field.
        ...Object.fromEntries(
          Object.entries(sizeParams(model, plan)).filter(
            ([key]) => !(chained && key === "aspect" && chainFrameRoute!.locked.includes("aspect")),
          ),
        ),
        // The explicit plan (R-19, D11): SPEC-013 segments from these, never guesses — which is
        // why it has to describe the clip that was actually asked for. A pass snapped from 5s to
        // 6s left a second nobody reviewed and nobody could cut from.
        shotPlan: coverPlan(pass.plan, passSeconds),
        provenance,
      },
      references: chained ? [] : compiledReferences(passReferencePlan.bound, world.sheets),
      askedSec: passSeconds,
      // Priced at the same size and the same length the job runs at. Recomputing it without
      // either queued a 1080p pass carrying a 720p figure, priced a pass of stills as if it
      // were footage, and used the seconds planned rather than the seconds asked for.
      estimatedMicroUsd: passEstimate(model, plan, passSeconds, references.length),
      dropped: droppedOf(
        passReferencePlan.budget,
        chained
          ? [...new Set(passReferencePlan.bound.map((reference) => reference.sheetId))].map((sheetId) => ({
              sheetId,
              role: "primary",
              reason: "the frame route takes one image — the previous pass's boundary frame rides instead",
            }))
          : [],
      ),
      sources: sourcesFor(provenance.sheets),
      landing: { dir: `productions/${productionId}/incoming/${scene.id}-pass-${pass.index}` },
    };
  });
}
