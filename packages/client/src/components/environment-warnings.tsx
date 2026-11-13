import { useEnvCheck } from "../lib/store.js";
import { Callout } from "./ui.js";

/** Environment problems belong on the reached setup/Home path (turn 280, SPEC-016 R-2). */
export function EnvironmentWarnings() {
  const env = useEnvCheck();
  if (!env || (env.pathBudgetOk && env.nativeIndexOk)) return null;
  return <div className="fy-firstrun__warnings">
    {!env.pathBudgetOk && <Callout tone="warning" title="Your data folder sits too deep">{env.pathBudgetDetail}</Callout>}
    {!env.nativeIndexOk && <Callout tone="warning" title="The search index could not load">{env.nativeIndexDetail}</Callout>}
  </div>;
}
