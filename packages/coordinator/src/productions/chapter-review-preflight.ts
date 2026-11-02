import { harnessModelReference, type ChapterReviewCheck, type ChapterReviewPreflight, type ClientState, type ModelInfo } from "@arke-studio/contracts";
import type { SessionInput } from "../harness/session-files.js";
import { selectHarnessModel } from "../harness/model-catalog.js";
import type { ReviewSource } from "./chapter-review.js";

export async function preflightChapterReview(source: Pick<ReviewSource, "images" | "record">, checks: readonly ChapterReviewCheck[], deps: {
  models(): Promise<ModelInfo[]>; app(): ClientState["app"]; sessionInput: SessionInput;
  override(agent: string): string | undefined; productionModel?: string;
  cloudAllowed(provider: string): Promise<boolean>;
}): Promise<ChapterReviewPreflight> {
  const pictures = source.images.length, readablePictures = source.images.filter(image => !image.error).length;
  const specialists: Array<"script" | "prose" | "visual"> = [];
  if (checks.includes("prose")) specialists.push("prose");
  // Picture findings use the script role for text-only consolidation, even without a script check.
  if (checks.includes("script") || readablePictures) specialists.push("script");
  if (readablePictures) specialists.push("visual");
  let models: ModelInfo[] = [], catalogueError: string | undefined;
  if (specialists.length) {
    try { models = await deps.models(); }
    catch { catalogueError = "Models could not be verified. Refresh readiness or check Settings → Harness."; }
  }
  const routes: ChapterReviewPreflight["models"] = [];
  for (const specialist of specialists) {
    const agent = `chapter-${specialist}-reviewer`, override = deps.override(agent);
    const inherited = override ?? deps.productionModel;
    const route: ChapterReviewPreflight["models"][number] = { specialist, model: inherited ?? null,
      source: override ? "specialist" : deps.productionModel ? "production" : "default" };
    try {
      if (catalogueError) throw new Error(catalogueError);
      const configured = await deps.sessionInput({ agent, ...(inherited ? { model: inherited } : {}) });
      const defaults = models.filter(model => model.isDefault);
      const model = inherited ?? configured.model ?? configured.agents?.[agent]?.model ?? (defaults.length === 1 ? harnessModelReference(defaults[0]!) : undefined);
      if (!model) throw new Error("Choose a specialist model in Settings → Harness; the harness default is unknown.");
      route.model = model;
      const selection = selectHarnessModel(model, models, deps.app(), specialist === "visual");
      if (selection.reason) throw new Error(selection.reason.replace("Stage designer", "Chapter visual reviewer"));
      route.model = selection.sessionModel!;
      const provider = models.find(value => harnessModelReference(value) === route.model)?.provider;
      if (specialist === "visual" && provider !== "ollama" && (!provider || !await deps.cloudAllowed(provider)))
        throw new Error("Cloud image inspection is disabled for this reviewer. Check Settings → Privacy.");
    } catch (error) { route.reason = error instanceof Error ? error.message : "Reviewer unavailable."; }
    routes.push(route);
  }
  return { checks: [...checks], ready: routes.every(route => !route.reason), models: routes, pictures, readablePictures,
    narrationRecords: source.record ? Object.keys(source.record.takes).length : 0 };
}
