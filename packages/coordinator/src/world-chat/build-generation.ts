import type { ArkeGenerationBody } from "@arke-studio/contracts";
import { createHash } from "node:crypto";
import type { FoundingBuildService } from "../world/founding-build.js";
import type { EnqueueInput } from "../queue/dispatcher.js";
import type { GenerationQuoteSource } from "./generation-quotes.js";

export function buildGenerationSource(worldId: string, build: FoundingBuildService, freeze: (input: EnqueueInput) => EnqueueInput): GenerationQuoteSource {
  return {
    compile: async (action, actionId) => {
      if (action.kind !== "build-item-run") throw new Error("No founding quote source handles this action.");
      const quoted = await build.quoteItem(worldId, action.itemKey);
      const inputs = quoted.input ? [freeze({ ...quoted.input, params: { ...quoted.input.params,
        ...(quoted.input.provider === "comfyui" ? { seed: createHash("sha256").update(actionId).digest().readUInt32BE(0) % 0x7fffffff } : {}) } })] : [];
      const body: ArkeGenerationBody = { family: "generation", medium: inputs.length ? "image" : "document", purpose: `Founding item ${action.itemKey}`,
        prompt: quoted.input ? String(quoted.input.params.prompt) : quoted.description, references: (quoted.input?.params.references as string[] | undefined ?? []).map(file => ({ id: `ref_${createHash("sha256").update(file).digest("hex").slice(0, 24)}`, role: "Founding reference" })),
        provider: quoted.input?.provider ?? "Local world store", model: quoted.input?.model ?? "Approved founding content", quantity: 1,
        output: "The result is installed as decided in the original founding build", cost: "Pending quote",
        options: [{ label: "Model choice", value: "Current world image default, then Settings image routing default" },
          ...inputs.flatMap(input => Object.entries(input.params).filter(([key]) => !["prompt", "references", "referenceRoles", "provenance"].includes(key))
            .map(([label, value]) => ({ label, value: typeof value === "string" ? value : JSON.stringify(value) })))], cancellationSupported: inputs.length > 0,
      };
      return { body, inputs, authority: quoted.authority };
    },
    dispatch: async (action, id, inputs) => {
      if (action.kind !== "build-item-run") throw new Error("The founding action is unavailable.");
      const current = await build.quoteItem(worldId, action.itemKey);
      // runItems owns shutdown, Stop and durable build recovery. Its quoted input is consumed
      // instead of recompiling a different purchase after this card has been approved.
      void build.runItems(worldId, action.itemKey, id, { authority: current.authority, ...(inputs[0] ? { input: inputs[0] } : {}) }).catch(() => {});
      return { status: "queued", detail: "The approved founding item is running." };
    },
    reconcile: async (card, action) => {
      if (action.kind !== "build-item-run") return null;
      const state = await build.quotedItemState(worldId, action.itemKey);
      if (state?.running) return { status: "running", detail: "The founding item is running." };
      return state?.state === "landed" ? { status: "completed", receipt: { kind: "founding-item", id: card.actionId, summary: "The founding item was installed under the original founding decision." } }
        : { status: "failed", detail: "The founding item did not finish; inspect its existing work in Activity." };
    },
  };
}
