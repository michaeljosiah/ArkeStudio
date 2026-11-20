import { Suspense, type ComponentProps } from "react";
import type { ScenePlan } from "../screens/scene-workspace/plan.js";
import { preloadable } from "../lib/preloadable.js";
import { Loading } from "./loading.js";

// The Plan draws with three.js. Imported outright by the scene page it put all of three.js in the
// start-up script, 335 KB past the bundle's budget (the check that failed on PR 3270); the Stage
// is kept out the same way (issue 2797, lazy-stage.tsx).
const Plan = preloadable(() => import("../screens/scene-workspace/plan.js").then((m) => m.ScenePlan));

/** The Plan's own chunk, asked for ahead of the press that shows it. */
export const preloadScenePlan = (): Promise<unknown> => Plan.preload();

/** The Plan on a scene, loaded the first time its view is opened. */
export function LazyScenePlan(props: ComponentProps<typeof ScenePlan>) {
  return <Suspense fallback={<Loading inline label="Plan" />}><Plan {...props} /></Suspense>;
}
