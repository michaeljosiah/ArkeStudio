import type { RenderPlan } from "@arke-studio/contracts";
import type { EffectAuthoringProps } from "../lib/editor-effect-authoring.js";
import type { EffectAnalysisContext } from "./editor-effect-analysis.js";
import { EffectInspector } from "./editor-effect-inspector.js";
import { EffectAudioInspector } from "./editor-effect-audio.js";
import { EffectProtectionInspector } from "./editor-effect-protection.js";

/** The same controls can target Current or a reviewed pending version through their sinks. */
export function EffectPanel({ context, plan, scopeLabel, ...props }: EffectAuthoringProps & {
  context: EffectAnalysisContext;
  plan: RenderPlan | null;
  scopeLabel?: string;
}) {
  return <EffectInspector {...props}>
    <EffectAudioInspector {...props} context={context} plan={plan} />
    <EffectProtectionInspector {...props} scopeLabel={scopeLabel} />
  </EffectInspector>;
}
