import { createHash } from "node:crypto";
import {
  attachmentFor, characterAudioRoute, characterImageEstimateIsUsable, foldBenchSession, orderedShots, resolveCast,
  type AppSettings, type ArkeGenerationBody, type BenchSubject, type ModelManifest,
} from "@arke-studio/contracts";
import { resolveSubjectCastVoices } from "../audio/reference-inputs.js";
import { planBenchDispatch } from "../bench/service.js";
import { prepareBenchSubject, subjectModelFor, subjectReferenceRouting, type SubjectSourceReader } from "../bench/subject.js";
import type { EnqueueInput } from "../queue/dispatcher.js";
import type { WorldStore } from "../world/store.js";
import type { GenerationQuoteSource } from "./generation-quotes.js";

/** Chat shares Bench's production compiler, then sends its frozen inputs to normal take arrival.
 * No Bench session or selection is created by preparing or completing generation (SPEC-051 R-4..7). */
export function productionGenerationSource(store: WorldStore, ports: {
  manifest: ModelManifest | null;
  settings(): Promise<AppSettings | null>;
  sources: SubjectSourceReader;
  freeze(input: EnqueueInput): EnqueueInput;
  planOptions?: Pick<Parameters<typeof planBenchDispatch>[3], "recipeVersionOf" | "adapterRecipeFor" | "localFreeze">;
}): GenerationQuoteSource {
  return {
    compile: async (action, actionId, at) => {
      if (action.kind !== "production-take-generation") throw new Error("The production generation action is unavailable.");
      const world = store.getBundle();
      const production = world.productions.find(p => p.meta.id === action.productionId);
      const scene = production?.scenes.find(s => s.id === action.sceneId);
      if (!production || !scene) throw new Error("That scene is no longer available.");
      const settings = await ports.settings();
      const model = action.modelId
        ? ports.manifest?.models.find(m => m.id === action.modelId && m.capability === action.mode) ?? null
        : subjectModelFor(production, action.mode, settings, ports.manifest);
      if (!model || settings?.models.disabled.includes(model.id)) throw new Error("Choose an enabled model for this generation mode.");
      const shotIds = action.target.kind === "shot" ? [action.target.shotId] : action.target.memberShotIds;
      const shots = orderedShots(scene);
      if (new Set(shotIds).size !== shotIds.length || shotIds.some(id => !shots.some(s => s.id === id))) throw new Error("A generation target is no longer in this scene.");
      const retake = action.retakeOf ? production.takes.find(t => t.id === action.retakeOf) : undefined;
      if (action.retakeOf && (!retake || !shotIds.every(id => retake.coversShots.includes(id)))) throw new Error("The retake must belong to these shots.");
      // The named model resolves before prefill so reference lanes and packing use that route.
      const resolvedWorld = { ...world, productions: world.productions.map(p => p === production
        ? { ...p, meta: { ...p.meta, models: { ...p.meta.models, [action.mode]: model.id } } } : p) };
      const targets = action.mode === "image" && action.target.kind === "board"
        ? shotIds.map(shotId => ({ kind: "shot" as const, shotId })) : [action.target];
      if (action.mode === "image" && action.target.kind === "board") {
        const board = await prepareBenchSubject(world, { productionId: action.productionId, sceneId: action.sceneId,
          subject: action.target, mode: "video", settings, manifest: ports.manifest, sources: ports.sources });
        if (!board.ok) throw new Error(board.reason);
      }
      const inputs: EnqueueInput[] = [];
      const offered = new Map<string, { id: string; role: string }>();
      const exclusions: string[] = [];
      const authorities: unknown[] = [];
      const audioSubjects: BenchSubject[] = [];
      let durationSec: number | undefined;
      // A board of start frames means one ordinary candidate frame per member, not an accepted grid.
      for (const target of targets) {
        const prepared = await prepareBenchSubject(resolvedWorld, { productionId: action.productionId,
          sceneId: action.sceneId, subject: target, mode: action.mode, settings, manifest: ports.manifest, sources: ports.sources });
        if (!prepared.ok) throw new Error(prepared.reason);
        const prefill = prepared.prefill;
        const routing = subjectReferenceRouting(prefill.references, prefill.subject, model);
        const session = foldBenchSession({ schemaVersion: 1, id: `sess_${actionId.slice(4)}`, createdAt: at, subject: prefill.subject }, []);
        session.tokenRegistry = prefill.references;
        session.subjectTokens = prefill.references.map(ref => ref.token);
        session.composer = { ...prefill.composer, ...routing, provider: model.provider, model: model.id,
          brief: [prefill.composer.brief, ...(retake ? [`Retake ${retake.id}.`] : []), ...(action.instruction ? [action.instruction] : [])].join("\n\n") };
        if (session.composer.params.kind === "image") session.composer.params.count = action.count ?? 1;
        const route = action.mode === "video" ? characterAudioRoute(model) : null;
        const cast = route ? await resolveSubjectCastVoices(store, prefill.subject, actionId, route.local === true, { acknowledge: false, at })
          : { references: [], notSent: [], refused: [] };
        if (cast.refused.length) throw new Error(cast.refused.map(ref => `${ref.name}: ${ref.reason}`).join(" · "));
        if (route) audioSubjects.push(prefill.subject);
        const plan = planBenchDispatch(session, resolvedWorld, ports.manifest, { ...ports.planOptions,
          worldId: store.worldId, requestId: actionId, at, performanceReferences: cast.references,
          localFreeze: ports.planOptions?.localFreeze ? (id, from) => ({ ...ports.planOptions!.localFreeze!(id, from),
            seed: createHash("sha256").update(`${actionId}/${inputs.length}`).digest().readUInt32BE(0) % 0x7fffffff }) : undefined });
        if (!plan.ok) throw new Error(plan.reason);
        const active = new Set([...routing.activeTokens, ...routing.keyframeTokens]);
        for (const ref of prefill.references) {
          const key = `${target.kind === "shot" ? target.shotId : "board"}/${ref.token}`;
          if (active.has(ref.token)) offered.set(key, { id: `ref_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`, role: ref.label ?? ref.kind });
          else exclusions.push(`${ref.label ?? ref.token}: this route does not carry this reference.`);
        }
        offered.set(`target/${target.kind === "shot" ? target.shotId : "board"}`, {
          id: target.kind === "shot" ? target.shotId : action.sceneId, role: prefill.title });
        for (const ref of cast.references) offered.set(ref.performance.id, { id: ref.performance.id, role: `Cast voice: ${ref.characterName}` });
        exclusions.push(...cast.notSent.map(ref => `${ref.name}: voice not sent · ${ref.reason}`));
        authorities.push({ subject: prefill.subject, references: prefill.references, cast: cast.references });
        const repetitions = action.mode === "video" ? action.count ?? 1 : 1;
        for (let copy = 0; copy < repetitions; copy++) for (const [index, input] of plan.inputs.entries()) {
          const snapshot = plan.reserved[index]!.request;
          const filing = snapshot.filing;
          if (!filing) throw new Error("The production filing plan is unavailable.");
          if (filing.kind === "board") durationSec = filing.members.at(-1)!.endSec;
          const coversShots = filing.kind === "shot" ? [filing.shotId] : filing.members.map(m => m.shotId);
          const shotPlan = filing.kind === "board" ? filing.members.map(({ shotId, number, startSec, endSec }) => ({ shotId, number, startSec, endSec })) : undefined;
          inputs.push(ports.freeze({ ...input, productionId: action.productionId,
            target: target.kind === "shot" ? { kind: "shot", id: target.shotId, coversShots } : { kind: "scene-pass", id: scene.id, coversShots },
            params: { ...input.params, generationQuoteProduction: true, provenance: { ...snapshot.productionProvenance, sceneId: scene.id, sceneVersion: scene.version },
              ...(shotPlan && target.kind === "board" ? { shotPlan } : {}), ...(retake ? { retakeOf: retake.id } : {}),
              ...(input.provider === "comfyui" ? { seed: createHash("sha256").update(`${actionId}/${inputs.length}`).digest().readUInt32BE(0) % 0x7fffffff } : {}) },
            landing: { dir: `incoming/production-generation/${actionId}/${inputs.length}` } }));
        }
      }
      if (inputs.some(input => !characterImageEstimateIsUsable(model, input.estimatedMicroUsd))) throw new Error("This route has no usable published generation estimate.");
      if (action.target.kind === "board" && action.mode === "image") {
        // Validate the named board's current membership before authorizing member frame jobs.
        const first = shots.findIndex(s => s.id === shotIds[0]);
        if (shots.slice(first, first + shotIds.length).some((s, i) => s.id !== shotIds[i])) throw new Error("Board members must be consecutive in scene order.");
      }
      const usedSheets = new Map<string, typeof world.sheets[number]>();
      for (const id of shotIds) for (const { sheet } of resolveCast(shots.find(s => s.id === id)!.description, world.sheets).cast) usedSheets.set(sheet.id, sheet);
      const location = world.sheets.find(s => s.id === scene.inherits?.location);
      if (location) usedSheets.set(location.id, location);
      const withoutKit = [...usedSheets.values()].filter(sheet => attachmentFor(world.referenceKits.find(k => k.sheetId === sheet.id) ?? null,
        sheet, "primary", { productionId: action.productionId, sceneId: scene.id }).file === null);
      exclusions.push(...withoutKit.map(sheet => `${sheet.name} has no reference kit. Approve a ${sheet.type === "location" ? "location-view" : "main-photo"} kit-generation card first to establish its appearance.`));
      const prompts = [...new Set(inputs.map(input => String(input.params.prompt)))];
      const body: ArkeGenerationBody = { family: "generation", medium: action.mode,
        purpose: `${retake ? `Retake ${retake.id}: ` : ""}${action.target.kind === "shot" ? shots.find(s => s.id === shotIds[0])!.title : "Board"}`,
        prompt: prompts.map((prompt, i) => prompts.length === 1 ? prompt : `${i + 1}. ${prompt}`).join("\n\n"),
        references: [...offered.values()], exclusions, provider: model.provider, model: model.id, quantity: inputs.length,
        output: "Immutable candidate takes on the named shots; select with a separate take-review card", cost: "Pending quote",
        ...(durationSec ? { durationSec } : {}),
        options: [{ label: "Model choice", value: action.modelId ? "Named in this request" : production.meta.models?.[action.mode] ? "Production model" : "Settings routing default" },
          ...Object.entries(inputs[0]!.params).filter(([key]) => !["prompt", "provenance", "references", "audioReferences", "referenceMedia", "shotPlan", "generationQuoteProduction"].includes(key))
            .map(([label, value]) => ({ label, value: typeof value === "string" ? value : JSON.stringify(value) }))],
        privacy: ["The resolved prompts and carried image, video and cast-audio references go to the configured provider runtime."], cancellationSupported: true };
      return { inputs, body, authority: { model, sceneVersion: scene.version, defaultModel: production.meta.models?.[action.mode] ?? settings?.routing?.[action.mode] ?? null,
        subjects: authorities, missingKits: withoutKit.map(sheet => sheet.id) }, materialization: audioSubjects };
    },
    beforeDispatch: async (_action, actionId, _inputs, materialization, at) => {
      for (const subject of materialization as BenchSubject[]) {
        // The quote already resolved the exact destination; acknowledgement records the person's approval.
        const model = ports.manifest?.models.find(m => m.id === _inputs[0]?.model);
        const route = model ? characterAudioRoute(model) : null;
        if (!route) continue;
        const cast = await resolveSubjectCastVoices(store, subject, actionId, route.local === true, { at });
        if (cast.refused.length) throw new Error("The approved cast audio could not be cleared.");
      }
    },
  };
}
