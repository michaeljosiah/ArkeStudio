import { setTimeout as delay } from "node:timers/promises";
import { OpenCodeError } from "../http.js";
import { modelEnabled, type WireModel } from "../model-metadata.js";
import { OpenCodeV2Http, sameDirectory, type V2Envelope } from "./http.js";

/**
 * OpenCode forks Copilot's first model sync per location. Until it settles, the catalogue
 * can return a bare @ai-sdk/github-copilot package that its own runner cannot resolve (#1696).
 * Global discovery is not evidence for a new scratch directory. Wait only before publishing
 * the session; no prompt, model substitution or credential operation belongs in this retry.
 */
export async function waitForSessionModel(
  http: OpenCodeV2Http,
  model: { providerID: string; id: string } | null,
  location: string | undefined,
  callerSignal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<WireModel | null> {
  if (model !== null && model.providerID !== "github-copilot") return null;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  const scoped = async <T>(path: string): Promise<T> => {
    const envelope = await http.req<V2Envelope<T>>("GET", path, undefined, { location, signal });
    // Missing scope is not proof of readiness either: v2 silently ignores v1's query form.
    if (location !== undefined && !sameDirectory(envelope?.location?.directory, location)) {
      throw new Error("OpenCode model catalog did not confirm the session location");
    }
    return envelope?.data;
  };
  try {
    if (model === null) {
      // An unpinned session resolves its default only when the runner starts. Inspect the same
      // location's default/fallback, without turning that observation into a new saved choice.
      try {
        const preferred = await scoped<WireModel>("/api/model/default");
        if (preferred?.providerID && preferred.id && preferred.package) {
          model = { providerID: preferred.providerID, id: preferred.id };
        }
      } catch (error) {
        if (!(error instanceof OpenCodeError && error.status === 503)) throw error;
      }
    }
    for (;;) {
      signal.throwIfAborted();
      try {
        if (model !== null && model.providerID !== "github-copilot") return null;
        const rows = await scoped<WireModel[]>("/api/model");
        if (!Array.isArray(rows)) throw new Error("OpenCode returned an invalid model catalog");
        if (model === null) {
          const fallback = rows.find(row => row.providerID && row.id && row.package && modelEnabled(row));
          // No default or available model retains the harness's own unconfigured behavior.
          if (!fallback) return null;
          model = { providerID: fallback.providerID!, id: fallback.id! };
          if (model.providerID !== "github-copilot") return null;
        }
        const row = rows.find(row => row.providerID === model!.providerID && row.id === model!.id);
        if (row && modelEnabled(row) &&
          (row.package === "aisdk:@ai-sdk/anthropic" || row.package === "aisdk:@ai-sdk/github-copilot")) {
          signal.throwIfAborted();
          return row;
        }
      } catch (error) {
        // The measured catalogue endpoint also answers 503 while its plugin flush is pending.
        // Auth, scope and protocol errors must stay errors rather than masquerading as warm-up.
        if (!(error instanceof OpenCodeError && error.status === 503)) throw error;
      }
      await delay(250, undefined, { signal });
    }
  } catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason;
    if (deadline.aborted) {
      throw new Error(`${model ? `GitHub Copilot model ${model.id}` : "OpenCode's default model"} is not ready in this session: OpenCode did not provide a usable model route. No prompt was sent.`);
    }
    throw error;
  }
}
