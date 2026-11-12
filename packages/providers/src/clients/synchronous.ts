import { ARTIFACT_RESULT_LIMITS } from "@arke-studio/contracts";
import type { FetchedArtifact, PollResult, ProviderClient } from "../types.js";
import { readArtifactBody } from "./artifact-body.js";

/**
 * What every synchronous client shares (#2824): its submit answers with the result whole, so
 * there is nothing to poll, fetch or cancel. By the time there is an id, the bytes already exist.
 */
export function syncOnly(id: string): Pick<ProviderClient, "poll" | "fetchArtifacts" | "cancel"> {
  return {
    poll: async (): Promise<PollResult> => ({ state: "failed", error: `${id}: synchronous results must be returned by submit` }),
    fetchArtifacts: async (): Promise<FetchedArtifact[]> => {
      throw new Error(`${id}: synchronous artifacts are returned by submit`);
    },
    cancel: async () => {},
  };
}

/**
 * A synchronous answer's audio, read under the per-file bound an asynchronous client's fetch is
 * held to rather than buffered whatever its size: a response that never ends, or a port that
 * belongs to something else, cannot take the coordinator's memory with it.
 */
export function readSyncAudio(response: Response, signal?: AbortSignal): Promise<Uint8Array> {
  return readArtifactBody(response, ARTIFACT_RESULT_LIMITS.maxFileBytes, signal);
}
