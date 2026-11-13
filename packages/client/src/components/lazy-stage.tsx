import { Suspense, type ComponentProps } from "react";
import type { SceneStage } from "../screens/scene-workspace/stage.js";
import { preloadable } from "../lib/preloadable.js";
import { Loading } from "./loading.js";

// three.js reached the start-up script only through the Stage previews on cards in the root chat,
// about a ninth of it (issue 2797). The scene workspace loads the Stage with its own route.
const Stage = preloadable(() => import("../screens/scene-workspace/stage.js").then((m) => m.SceneStage));

/** The Stage, loaded the first time a card shows one. */
export function LazySceneStage(props: ComponentProps<typeof SceneStage>) {
  return <Suspense fallback={<Loading inline label="Stage" />}><Stage {...props} /></Suspense>;
}
