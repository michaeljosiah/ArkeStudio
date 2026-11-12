import { harnessModelReference, type HarnessAdapter, type ModelInfo } from "@arke-studio/contracts";

/** Discovery is presentation/preflight only; the runner rechecks ownership at dispatch. */
export function studioModelChoices(adapter: HarnessAdapter | null, models: readonly ModelInfo[],
  destination: (model: string, provider: string) => unknown): string[] {
  if (!adapter?.readiness().ready || adapter.privateSessions !== true) return [];
  return models.filter(model => !/(?:^|[-_/])embed(?:ding)?(?:[-_: /]|$)/i.test(model.id))
    .filter(model => destination(harnessModelReference(model), model.provider))
    .map(harnessModelReference).slice(0, 512);
}
