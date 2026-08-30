import {
  hasOwnFrame,
  orderedShots,
  shotCardState,
  shotCoverage,
  type ArtifactSidecar,
  type ProductionBundle,
  type SceneRecord,
  type Shot,
  type ShotCardState,
} from "@arke-studio/contracts";
import { mediaUrl } from "../../lib/media.js";
import { acceptedTakeId, takesForShot } from "../../lib/selectors.js";
import { seconds } from "../../lib/format.js";
import { selectedShotId, useWorkspaceSelection } from "./selection.js";

/**
 * The scene as rows, read top to bottom (SPEC-029 R-23, SPEC-036 §1.5).
 *
 * Read-only at this step: the shell lands where it can be walked and reviewed before it replaces
 * the strip, and every write — the script, the reorder, the insert — arrives with the editing
 * step. What is here is the anatomy and the derivations, because those are what the rest of the
 * workspace is built against.
 *
 * Three regions, and the proportions are the point: the frame on the left, the SCRIPT dominant
 * in the body, and the actions in a fixed-width column. The actions column is fixed because in
 * a wrapping row the `prompt · auto` line jumped as content reflowed, and a control that moves
 * while you reach for it is a control you misclick.
 */

const CHIP_LABEL: Record<ShotCardState, string> = {
  "needs attention": "needs attention",
  story: "story",
  storyboard: "storyboard",
  "production-ready": "production-ready",
  rendered: "rendered",
};

/** The picture a row shows, or null for the hatched placeholder. Artifacts only — see R-20. */
function frameSrc(
  production: ProductionBundle,
  artifacts: readonly ArtifactSidecar[],
  slug: string | undefined,
  shotId: string,
): string | null {
  const id = production.selections[shotId]?.startFrameArtifactId ?? null;
  if (id === null || slug === undefined) return null;
  const artifact = artifacts.find((candidate) => candidate.id === id);
  return artifact === undefined ? null : mediaUrl(slug, `artifacts/${artifact.file}`);
}

export function StoryboardRows({
  scene,
  production,
  artifacts,
  slug,
  digests,
  aspect,
}: {
  scene: SceneRecord;
  production: ProductionBundle;
  artifacts: readonly ArtifactSidecar[];
  slug: string | undefined;
  digests: ReadonlyMap<string, string>;
  /** The production's delivery aspect: a 9:16 production gets 9:16 rows, not letterboxed ones. */
  aspect: string;
}) {
  const shots = orderedShots(scene);
  const { subject, select } = useWorkspaceSelection();
  const current = selectedShotId(subject);

  if (shots.length === 0) {
    /*
     * An empty scene is not an error and does not explain itself (R-29). Both doors, no prose:
     * the shell's own copy rules say labels, counts and refusals — never rationale.
     */
    return (
      <div className="fy-swempty" data-testid="workspace-empty">
        <p className="fy-swempty__line">No shots yet.</p>
      </div>
    );
  }

  return (
    <ol className="fy-swrows" data-testid="workspace-rows" aria-label={`Shots in scene ${scene.number}`}>
      {shots.map((shot) => (
        <Row
          key={shot.id}
          shot={shot}
          scene={scene}
          production={production}
          artifacts={artifacts}
          slug={slug}
          digests={digests}
          aspect={aspect}
          selected={shot.id === current}
          onSelect={() => select({ kind: "shot", shotId: shot.id })}
        />
      ))}
    </ol>
  );
}

function Row({
  shot,
  scene,
  production,
  artifacts,
  slug,
  digests,
  aspect,
  selected,
  onSelect,
}: {
  shot: Shot;
  scene: SceneRecord;
  production: ProductionBundle;
  artifacts: readonly ArtifactSidecar[];
  slug: string | undefined;
  digests: ReadonlyMap<string, string>;
  aspect: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const accepted = acceptedTakeId(production, shot.id);
  const acceptedTake = accepted === null ? undefined : takesForShot(production, shot.id).find((t) => t.id === accepted);
  const coverage = shotCoverage(shot, digests);
  const state = shotCardState({
    blankScript: shot.description.trim() === "",
    clipAccepted: acceptedTake?.kind === "clip",
    hasFrame: hasOwnFrame(production.selections[shot.id], artifacts),
    coverage,
  });
  const src = frameSrc(production, artifacts, slug, shot.id);
  const lens = shot.framing?.lens;

  return (
    <li
      className="fy-swrow"
      data-testid={`workspace-row-${shot.id}`}
      data-state={state}
      data-selected={selected ? "true" : undefined}
      aria-current={selected ? "true" : undefined}
    >
      {/*
        One control carries the row's identity and its selection, so the row announces itself
        once rather than as a stack of nested buttons — R-63's "one focus stop per shot".
      */}
      <button type="button" className="fy-swrow__hit" onClick={onSelect} aria-label={`Shot ${shot.number}, ${state}`}>
        <span className="fy-swrow__frame" data-aspect={aspect} data-empty={src === null ? "true" : undefined}>
          {src === null ? (
            <span className="fy-swrow__nofr">no frame yet</span>
          ) : (
            <img className="fy-swrow__img" src={src} alt="" />
          )}
          <span className="fy-swrow__label">shot {shot.number}</span>
          <span className="fy-swrow__meta">
            {aspect} · {seconds(shot.durationSec)}
            {lens === undefined ? "" : ` · ${lens}`}
          </span>
        </span>
      </button>

      <div className="fy-swrow__body">
        <p className="fy-swrow__title">
          {shot.title}
          <span className="fy-swchip" data-state={state}>
            {CHIP_LABEL[state]}
          </span>
        </p>
        {coverage === "changed" ? <p className="fy-swrow__stale">script changed</p> : null}
        {/* The script at full weight: everything else on the row is quieter than this. */}
        <p className="fy-swrow__script">{shot.description}</p>
        {shot.promptOverride === undefined ? null : <p className="fy-swrow__over">prompt edited</p>}
      </div>

      <div className="fy-swrow__actions">
        {/*
          The slot is fixed rather than flowing, and it says what the prompt IS rather than
          offering to change it — this step reads, the next one writes.
        */}
        <p className="fy-swrow__slot">{shot.promptOverride === undefined ? "prompt · auto" : "edited by you"}</p>
        <p className="fy-swrow__scene">
          {scene.number}·{shot.number}
        </p>
      </div>
    </li>
  );
}
