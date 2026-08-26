import { join } from "node:path";
import type {
  ArtifactReferenceGeneration,
  ArtifactSidecar,
  CharacterReferenceWorkflow,
  Job,
  Provenance,
  Take,
  TakeCost,
} from "@arke-studio/contracts";
import { fileGeneratedArtifact } from "../artifacts/filing.js";
import type { WorldStore } from "../world/store.js";

/**
 * Every generated character reference is also a world artifact (issue 475).
 *
 * A paid picture used to be visible on the character's own surface and absent from the world's
 * shelf, its counts and the artifact lane of the picker: the bytes were in `references/` and the
 * artifact registry had never heard of them. The shelf is the durable history of what this
 * application made, so it has to hold what the character surfaces made too.
 *
 * Filed at finalization, not at acceptance. The requirement is to retain *every* generated
 * result — one still waiting on review, and one the kit later rejects — so nothing here reads a
 * review decision, and filing never moves, renames or claims the reference copy. The artifact is
 * a second, immutable copy that answers to the world; the kit keeps answering to the character.
 */
export async function fileGeneratedReferenceArtifact(
  store: WorldStore,
  input: {
    job: Job;
    workflow: CharacterReferenceWorkflow;
    sheetId: string;
    /**
     * World-relative path of the DURABLE copy — the take directory, or the kit's own tile. Never
     * `incoming/` or `candidates/` for a take-backed workflow: staging is swept once the take
     * owns the bytes (issue 231), so filing from there would race a deletion.
     */
    sourceFile: string;
    /** The reference take, where the workflow records one. The legacy tile path records none. */
    take?: Take;
    provenance: Provenance;
    cost: TakeCost;
  },
): Promise<ArtifactSidecar> {
  const { job, take } = input;
  // Forward slashes, always: a world path uses them (R-24), a landed path on Windows may not,
  // and the client matches this string against paths it spells itself.
  const sourceFile = input.sourceFile.replace(/\\/g, "/");
  const params = take?.params ?? job.params;
  const prompt = take?.prompt ?? (typeof params["prompt"] === "string" ? params["prompt"] : "");
  const references =
    take?.references ??
    (Array.isArray(params["references"])
      ? (params["references"] as unknown[]).filter((r): r is string => typeof r === "string")
      : []);
  const seed = params["seed"];
  const generation: ArtifactReferenceGeneration = {
    source: "character-reference",
    jobId: job.id,
    ...(take !== undefined ? { takeId: take.id } : {}),
    sheetId: input.sheetId,
    workflow: input.workflow,
    sourceFile,
    prompt,
    references,
    // The provider identity the job was dispatched with, not one looked up now. Which provider
    // made it is provenance; it is never what decides whether filing happens (issue 475).
    provider: take?.provider ?? job.provider,
    model: take?.model ?? job.model,
    params,
    provenance: input.provenance,
    ...(typeof seed === "number" && Number.isInteger(seed) ? { requestedSeed: seed } : {}),
    estimatedMicroUsd: input.cost.estimatedMicroUsd,
    costMicroUsd: input.cost.actualMicroUsd,
    ...(input.cost.actualSource !== undefined ? { costSource: input.cost.actualSource } : {}),
  };
  return fileGeneratedArtifact(store, {
    sourcePath: join(store.dir, ...sourceFile.split("/")),
    generation,
  });
}
