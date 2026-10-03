import { createHash } from "node:crypto";
import {
  characterImageEstimateIsUsable, estimateMicroUsd, imageOutputFor, imageConstraintSuffix, stagedReferenceKey, stagedWorldImage, orderedLocationViews,
  type AppSettings, type ArkeGenerationBody, type ModelManifest, type ModelWorldChatAction,
} from "@arke-studio/contracts";
import type { EnqueueInput } from "../queue/dispatcher.js";
import type { WorldStore } from "../world/store.js";
import { readKit } from "../references/kit.js";
import { mainPhotoRequests, characterSheetRequest, characterLookRequests, establishRequests,
  locationViewRequests, tileRequest, missingTileAngles, imageModelFor } from "../references/generate.js";
import { masterLookRequest, stagedFor } from "../references/master-look.js";
import { worldImageRequest } from "../references/world-image.js";
import { assembleKeyArt, keyArtComposition, readKeyArtBrief } from "../references/key-art-references.js";
import type { GenerationQuoteSource } from "./generation-quotes.js";

/** Uses the same compilers and world image default as the matching screens (SPEC-050 R-13..16). */
export function imageGenerationSource(store: WorldStore, ports: {
  manifest: ModelManifest | null; settings(): Promise<AppSettings | null>;
  freeze(input: EnqueueInput): EnqueueInput;
}): GenerationQuoteSource {
  return { compile: async (action: ModelWorldChatAction, actionId: string) => {
    if (action.kind !== "reference-generation" && action.kind !== "image-generation") throw new Error("No image quote source handles this action.");
    if (!ports.manifest) throw new Error("The image model catalogue is unavailable.");
    const bundle = store.getBundle();
    const settings = await ports.settings();
    const model = imageModelFor(settings, ports.manifest, action.modelId, bundle.meta.models);
    if (!model) throw new Error("No image model resolves. Choose an image model in Settings.");
    const request = action.request;
    let inputs: EnqueueInput[];
    if (action.kind === "reference-generation") {
      const req = action.request;
      const sheet = bundle.sheets.find(sheet => sheet.id === req.sheetId);
      if (!sheet) throw new Error("The reference sheet is unavailable.");
      if (sheet.type !== (req.operation === "location-view" ? "location" : "character")) throw new Error("This generation does not match the sheet's kind.");
      const kit = (await readKit(store, sheet.id))?.kit ?? null;
      switch (req.operation) {
        case "main-photo": {
          const identityReferences = req.identityReferenceIds.map(id => {
            const take = bundle.referenceTakes.find(take => take.id === id && take.reference && take.media);
            if (!take?.reference || !take.media) throw new Error("An identity reference is unavailable. Read the references again.");
            return `references/${take.reference.sheetId}/takes/${take.id}/${take.media}`;
          });
          inputs = mainPhotoRequests(bundle.meta, bundle.artDirection, sheet, kit, model,
            { prompt: req.prompt, count: req.count, identityReferences, generationKey: actionId,
              staged: stagedWorldImage(bundle, stagedReferenceKey("main-photo", sheet.id)) }).map(request => request.input);
          break;
        }
        case "character-sheet":
          if (!kit) throw new Error("Accept a main photo before generating a character sheet.");
          inputs = [characterSheetRequest(bundle.meta, bundle.artDirection, sheet, kit, model, actionId,
            req.styleOverride, undefined, stagedWorldImage(bundle, stagedReferenceKey("character-sheet", sheet.id))).input]; break;
        case "character-looks":
          if (!kit) throw new Error("Accept a main photo before generating character looks.");
          inputs = characterLookRequests(bundle.meta, bundle.artDirection, sheet, kit, model,
            { kind: req.lookKind, mode: req.mode, prompt: req.prompt, count: req.count, generationKey: actionId,
              staged: stagedWorldImage(bundle, stagedReferenceKey("look", sheet.id)) }).map(request => request.input); break;
        case "establish-look": inputs = establishRequests(bundle.meta, sheet, kit, model, req.count, bundle.artDirection)
          .map((request, index) => ({ ...request.input, landing: { ...request.input.landing!, name: `candidate-${actionId}-${index + 1}.png` } })); break;
        case "location-view": {
          const establishing = kit ? orderedLocationViews(kit)[0] : undefined;
          inputs = locationViewRequests(bundle.meta, bundle.artDirection, sheet, kit, model,
            { name: req.name, prompt: req.prompt, count: req.count, generationKey: actionId,
              anchorFile: req.establishing ? undefined : establishing?.file,
              staged: stagedWorldImage(bundle, stagedReferenceKey("location-view", sheet.id)) }).map(request => request.input); break;
        }
        case "regenerate-tile": inputs = [tileRequest(bundle.meta, sheet, kit, model, req.angle, bundle.artDirection).input]; break;
        case "missing-tiles": {
          const missing = missingTileAngles(kit, req.group);
          if (!missing.ok) throw new Error(missing.reason);
          inputs = missing.angles.map(angle => tileRequest(bundle.meta, sheet, kit, model, angle, bundle.artDirection).input); break;
        }
      }
    } else {
      const req = action.request;
      switch (req.operation) {
        case "master-look": {
          const references = stagedFor(bundle, stagedReferenceKey("master-look"), model);
          inputs = Array.from({ length: req.count }, (_, index) => masterLookRequest(bundle.meta, model, bundle.artDirection,
            { prompt: req.prompt, aspect: req.aspect, references,
              referenceRoles: references.map(file => ({ file, role: stagedWorldImage(bundle, "master-look")?.role ?? "style" })), slot: { index, count: req.count } })); break;
        }
        case "world-image": {
          const brief = await readKeyArtBrief(store.dir);
          const staged = stagedWorldImage(bundle, stagedReferenceKey("world-image"));
          const assembly = await assembleKeyArt(store, bundle, brief, model, staged?.file);
          const prompt = req.prompt !== undefined ? `${req.prompt} No text, no logos.${imageConstraintSuffix(bundle.artDirection)}` : (brief ? `${keyArtComposition({ meta: bundle.meta, direction: bundle.artDirection,
            bible: bundle.bible.present ? bundle.bible.text : "", brief, cast: assembly.carried.filter(ref => ref.role === "identity").map(ref => ref.name) })}${imageConstraintSuffix(bundle.artDirection)}` : undefined);
          inputs = Array.from({ length: req.count }, (_, index) => {
            const input = worldImageRequest(bundle.meta, model, bundle.artDirection, { index, count: req.count }, assembly.referenceRoles,
              { provenance: { canonRevision: bundle.meta.canonRevision, artDirectionVersion: bundle.artDirection.version, sheets: assembly.sheets }, dropped: assembly.dropped });
            return prompt ? { ...input, params: { ...input.params, prompt } } : input;
          }); break;
        }
        case "prop-state": {
          const prop = bundle.props.find(prop => prop.id === req.propId);
          const state = prop?.states.find(state => state.id === req.stateId);
          if (!prop || !state) throw new Error("The prop state is unavailable.");
          const output = imageOutputFor(model);
          const prompt = `${bundle.artDirection.description}. ${prop.name}, ${state.name}. ${req.prompt}${imageConstraintSuffix(bundle.artDirection)}`;
          const estimate = estimateMicroUsd(model, { images: 1, megapixels: output.width * output.height / 1_000_000 });
          inputs = Array.from({ length: req.count }, (_, index) => ({ worldId: store.worldId, target: { kind: "prop-state-candidate", id: `${prop.id}/${state.id}` },
            capability: "image", provider: model.provider, model: model.id, estimatedMicroUsd: estimate,
            params: { prompt, output, provenance: { canonRevision: bundle.meta.canonRevision, sheets: {}, artDirectionVersion: bundle.artDirection.version } },
            landing: { dir: `references/${prop.id}/incoming`, name: `state-${state.id}-${actionId}-${index + 1}.png` } })); break;
        }
      }
    }
    if (inputs.some(input => !characterImageEstimateIsUsable(model, input.estimatedMicroUsd))) throw new Error("The image route has no usable published estimate. Choose another model.");
    if (inputs.length === 0) throw new Error("There are no missing images to generate.");
    inputs = inputs.map((input, index) => ports.freeze({ ...input, params: { ...input.params,
      ...(input.target.kind === "character-sheet" ? { generationQuotePendingSelection: true } : {}),
      ...(input.provider === "comfyui" ? { seed: createHash("sha256").update(`${actionId}/${index}`).digest().readUInt32BE(0) % 0x7fffffff } : {}),
    } }));
    const references = [...new Map(inputs.flatMap(input => (input.params.references as string[] | undefined ?? []).map(file =>
      [file, { id: `ref_${createHash("sha256").update(file).digest("hex").slice(0, 24)}`, role: (input.params.referenceRoles as Array<{ file: string; role: string }> | undefined)?.find(ref => ref.file === file)?.role ?? "identity" }] as const))).values()];
    const prompts = [...new Set(inputs.map(input => String(input.params.prompt)))];
    const body: ArkeGenerationBody = { family: "generation", medium: "image", purpose: request.operation.replaceAll("-", " "),
      prompt: prompts.map((prompt, index) => prompts.length === 1 ? prompt : `${index + 1}. ${prompt}`).join("\n\n"),
      references, provider: model.provider, model: model.id, quantity: inputs.length, output: "Pending image candidates; selection requires a separate card", cost: "Pending quote",
      options: [{ label: "Model choice", value: action.modelId ? "Named in this request" : bundle.meta.models?.image ? "World image default" : "Settings image routing default" },
        ...inputs.flatMap((input, index) => Object.entries(input.params).filter(([key]) => !["prompt", "references", "referenceRoles", "provenance", "characterName", "generationQuotePendingSelection"].includes(key))
          .map(([label, value]) => ({ label: inputs.length === 1 ? label : `${index + 1}: ${label}`, value: typeof value === "string" ? value : JSON.stringify(value) })))],
      privacy: [references.length ? "Attached references and the prompt are sent to the configured provider runtime." : "The prompt is sent to the configured provider runtime."],
      cancellationSupported: true,
    };
    return { inputs, body, authority: { model, defaultModel: bundle.meta.models?.image ?? settings?.routing?.image ?? null } };
  } };
}
