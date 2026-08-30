import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  orderedShots,
  writerSceneView,
  type ArtifactSidecar,
  type ProductionBundle,
  type SceneRecord,
  type WorldBundle,
} from "@arke-studio/contracts";
import { seconds } from "../../lib/format.js";
import { useBlockDigests } from "../storyboard.js";
import { SceneFlow } from "./flow.js";
import { StoryboardRows } from "./rows.js";
import { SceneIndex } from "./scene-index.js";
import { SelectionProvider, selectedShotId, type WorkspaceSubject } from "./selection.js";

/**
 * The scene authoring shell (SPEC-029 R-21..R-29), behind `settings.internal.sceneWorkspace`.
 *
 * `scene index | Storyboard or Flow | Arke` — the three columns turn 103 binds, with Storyboard
 * the default. Read-only at this step: it lands where it can be walked before it replaces the
 * horizontal strip, and every write arrives with the editing step.
 *
 * The selection lives HERE, above the tabs, which is the whole of why switching views keeps it
 * (T-18). A per-view selection is unmounted with its view; that is not a bug you can patch
 * inside either view, so the state is hoisted rather than synchronised.
 */
export function SceneWorkspace({
  world,
  production,
  scene,
}: {
  world: WorldBundle;
  production: ProductionBundle;
  scene: SceneRecord;
}) {
  const navigate = useNavigate();
  // The same digests the strip compares citations against — one hook, cached on the blocks
  // array itself, so mounting this beside anything else costs no second sweep of the script.
  const digests = useBlockDigests(writerSceneView(scene));
  const [view, setView] = useState<"storyboard" | "flow">("storyboard");
  // Arke can be put away (R-28). Local to the session rather than a setting: it is a gesture
  // about right now — "give me the width" — not a preference about how the app should be.
  const [dock, setDock] = useState(true);
  const [subject, setSubject] = useState<WorkspaceSubject>({ kind: "scene" });
  const selection = useMemo(() => ({ subject, select: setSubject }), [subject]);

  const shots = orderedShots(scene);
  const artifacts: readonly ArtifactSidecar[] = world.artifacts;
  const aspect = production.meta.aspect ?? "16:9";
  // The cap the boards pack against, so Flow packs exactly as the rows do. Absent a model, the
  // widest common clip length rather than a guess that would draw boards nothing would render.
  const capSec = 10;
  const totalSec = shots.reduce((sum, shot) => sum + (shot.durationSec ?? 0), 0);
  const framed = shots.filter((shot) => production.selections[shot.id]?.startFrameArtifactId != null).length;
  const focus = selectedShotId(subject);
  const focused = focus === null ? undefined : shots.find((shot) => shot.id === focus);

  return (
    <SelectionProvider value={selection}>
      <div className="fy-sw" data-screen="scene-detail" data-testid="scene-workspace" data-dock={dock ? "true" : "false"}>
        <SceneIndex
          production={production}
          artifacts={artifacts}
          currentSceneId={scene.id}
          onOpen={(sceneId) => navigate(`/w/${world.meta.worldId}/p/${production.meta.id}/scenes/${sceneId}`)}
        />

        <main className="fy-sw__centre">
          <header className="fy-sw__head">
            <h1 className="fy-sw__title">
              Scene {scene.number} · {scene.title}
            </h1>
            <p className="fy-sw__metrics">
              {shots.length} shots · {seconds(totalSec)} · {framed} frames filed
            </p>
          </header>

          {/*
            Tabs are a mode of working, not a rendering of the same thing — so they are a
            radiogroup rather than links: choosing one is a choice about this scene, and it
            must not take the address bar with it or the browser Back button becomes an undo
            for something nobody did.
          */}
          <div className="fy-sw__tabs" role="radiogroup" aria-label="View">
            {(["storyboard", "flow"] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="radio"
                aria-checked={view === candidate}
                className="fy-sw__tab"
                data-on={view === candidate ? "true" : undefined}
                onClick={() => setView(candidate)}
              >
                {candidate === "storyboard" ? "Storyboard" : "Flow"}
              </button>
            ))}
            <span className="fy-sw__coverage">
              {shots.length - framed} of {shots.length} without a frame
            </span>
            <button
              type="button"
              className="fy-sw__put"
              aria-pressed={!dock}
              onClick={() => setDock((on) => !on)}
            >
              {dock ? "Hide Arke" : "Show Arke"}
            </button>
          </div>

          {view === "storyboard" ? (
            <StoryboardRows
              scene={scene}
              production={production}
              artifacts={artifacts}
              sheets={world.sheets}
              slug={world.meta.slug}
              digests={digests}
              aspect={aspect}
            />
          ) : (
            <SceneFlow
              scene={scene}
              production={production}
              sheets={world.sheets}
              artifacts={artifacts}
              slug={world.meta.slug}
              capSec={capSec}
            />
          )}
        </main>

        {/*
          Arke's dock follows the selection and nothing else — there is no "ask Arke to look at
          this" action, because the thing being looked at is the thing that is selected. The
          thread itself arrives with the dock's own step; this is the subject line it will read.
        */}
        {dock ? (
        <aside className="fy-sw__dock" aria-label="Arke">
          <p className="fy-sw__subject" data-testid="workspace-subject">
            {focused === undefined
              ? `Arke · Scene ${scene.number}`
              : `Arke · Shot ${focused.number}`}
          </p>
        </aside>
        ) : null}
      </div>
    </SelectionProvider>
  );
}
