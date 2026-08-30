import {
  hasOwnFrame,
  orderedShots,
  sortScenes,
  type ArtifactSidecar,
  type ProductionBundle,
  type SceneRecord,
} from "@arke-studio/contracts";
import { acceptedTakeId } from "../../lib/selectors.js";

/**
 * The scene index (SPEC-029 R-22): every scene in the production, switchable without a trip
 * back to the episode page.
 *
 * Order follows the authority that owns it and never the graph (R-19): `Episode.scenes[]` for an
 * episodic production, `sortScenes` otherwise, and episodic scenes no episode lists are named
 * separately rather than folded in at the end as if they were last.
 *
 * Counts only — no rationale (turn 69's binding). "2 of 5 framed" is a fact a person can act on;
 * a sentence explaining what framing is belongs in the spec.
 */
export function SceneIndex({
  production,
  artifacts,
  currentSceneId,
  onOpen,
}: {
  production: ProductionBundle;
  artifacts: readonly ArtifactSidecar[];
  currentSceneId: string;
  onOpen: (sceneId: string) => void;
}) {
  const groups = indexGroups(production);
  return (
    <nav className="fy-swindex" data-testid="workspace-index" aria-label="Scenes">
      {groups.map((group) => (
        <section key={group.label ?? "all"} className="fy-swindex__group">
          {group.label === null ? null : <h2 className="fy-swindex__head">{group.label}</h2>}
          <ul className="fy-swindex__list">
            {group.scenes.map((scene) => {
              const counts = coverageOf(scene, production, artifacts);
              return (
                <li key={scene.id}>
                  <button
                    type="button"
                    className="fy-swindex__scene"
                    data-current={scene.id === currentSceneId ? "true" : undefined}
                    aria-current={scene.id === currentSceneId ? "page" : undefined}
                    onClick={() => onOpen(scene.id)}
                  >
                    <span className="fy-swindex__no">{scene.number}</span>
                    <span className="fy-swindex__title">{scene.title}</span>
                    <span className="fy-swindex__counts">
                      {counts.shots} shots · {counts.framed} framed · {counts.rendered} rendered
                    </span>
                    {counts.needsAttention === 0 ? null : (
                      <span className="fy-swindex__mark">{counts.needsAttention} need attention</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}

/** Scenes in the order their own authority gives them, with unassigned episodic scenes apart. */
function indexGroups(production: ProductionBundle): Array<{ label: string | null; scenes: SceneRecord[] }> {
  const byId = new Map(production.scenes.map((scene) => [scene.id, scene] as const));
  if (production.episodes.length === 0) {
    return [{ label: null, scenes: sortScenes(production.scenes) }];
  }
  const listed = new Set<string>();
  const groups = production.episodes.map((episode) => {
    const scenes = episode.scenes.flatMap((id) => {
      const scene = byId.get(id);
      if (scene === undefined) return [];
      listed.add(id);
      return [scene];
    });
    return { label: episode.title, scenes };
  });
  const unassigned = sortScenes(production.scenes.filter((scene) => !listed.has(scene.id)));
  return unassigned.length === 0 ? groups : [...groups, { label: "Not in an episode", scenes: unassigned }];
}

function coverageOf(
  scene: SceneRecord,
  production: ProductionBundle,
  artifacts: readonly ArtifactSidecar[],
): { shots: number; framed: number; rendered: number; needsAttention: number } {
  const shots = orderedShots(scene);
  let framed = 0;
  let rendered = 0;
  let needsAttention = 0;
  for (const shot of shots) {
    if (hasOwnFrame(production.selections[shot.id], artifacts)) framed += 1;
    if (acceptedTakeId(production, shot.id) !== null) rendered += 1;
    if (shot.description.trim() === "") needsAttention += 1;
  }
  return { shots: shots.length, framed, rendered, needsAttention };
}
