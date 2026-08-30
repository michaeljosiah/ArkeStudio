import {
  hasOwnFrame,
  orderedShots,
  resolveCast,
  shotCardState,
  shotCoverage,
  type ArtifactSidecar,
  type ProductionBundle,
  type SceneRecord,
  type Sheet,
  type Shot,
  type ShotCardState,
} from "@arke-studio/contracts";
import { mediaUrl } from "../../lib/media.js";
import { acceptedTakeId, takesForShot } from "../../lib/selectors.js";
import { selectedShotId, useWorkspaceSelection } from "./selection.js";

/**
 * The scene as rows (SPEC-029 R-23, SPEC-036 §1.5) — the prototype's §7.1, structure and values.
 *
 * A row is a flex band at least 158px tall: the frame filling its own 252px column edge to edge,
 * the body flexing beside it with the SCRIPT as the only thing at full weight, and a 158px
 * actions column behind a hairline. Selection is a 1.5px inset ring drawn over the row rather
 * than a border colour, so choosing a row cannot shift anything inside it by a pixel.
 *
 * Read-only at this step: the affordances the prototype writes through — the contentEditable
 * script, the reorder handle, the `···` menu — arrive with the editing step. What is here is the
 * anatomy, the derived states, and the labels.
 */

const CHIP: Record<ShotCardState, string> = {
  "needs attention": "needs attention",
  story: "story",
  storyboard: "storyboard",
  "production-ready": "production-ready",
  rendered: "rendered",
};

export function StoryboardRows({
  scene,
  production,
  artifacts,
  sheets,
  slug,
  digests,
  aspect,
}: {
  scene: SceneRecord;
  production: ProductionBundle;
  artifacts: readonly ArtifactSidecar[];
  sheets: readonly Sheet[];
  slug: string | undefined;
  digests: ReadonlyMap<string, string>;
  /** The production's delivery aspect, shown on every frame the way the prototype does. */
  aspect: string;
}) {
  const shots = orderedShots(scene);
  const { subject, select } = useWorkspaceSelection();
  const current = selectedShotId(subject);

  if (shots.length === 0) {
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
          production={production}
          artifacts={artifacts}
          sheets={sheets}
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
  production,
  artifacts,
  sheets,
  slug,
  digests,
  aspect,
  selected,
  onSelect,
}: {
  shot: Shot;
  production: ProductionBundle;
  artifacts: readonly ArtifactSidecar[];
  sheets: readonly Sheet[];
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
  const artifactId = production.selections[shot.id]?.startFrameArtifactId ?? null;
  const artifact = artifactId === null ? undefined : artifacts.find((candidate) => candidate.id === artifactId);
  const src = artifact !== undefined && slug !== undefined ? mediaUrl(slug, `artifacts/${artifact.file}`) : null;
  // Reference chips are INFERRED from the `@` tokens the script uses — there is no separate
  // list to fall out of step with the words (R-10).
  const refs = resolveCast(shot.description, [...sheets]).cast;
  const overrides = [
    shot.framing?.size === undefined ? null : `${shot.framing.size} override`,
    shot.framing?.movement === undefined ? null : `${shot.framing.movement} override`,
  ].filter((label): label is string => label !== null);

  return (
    <li className="fy-swrow" data-testid={`workspace-row-${shot.id}`} data-state={state}>
      {/*
        The whole row selects, and the ring is drawn OVER it rather than as a border — a border
        that appears on selection changes the box, and every row below it moves by a pixel.
      */}
      <div
        className="fy-swrow__band"
        data-selected={selected ? "true" : undefined}
        role="button"
        tabIndex={0}
        aria-current={selected ? "true" : undefined}
        aria-label={`Shot ${shot.number}, ${shot.title}, ${state}`}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onSelect();
        }}
      >
        {selected ? <span className="fy-swrow__ring" aria-hidden="true" /> : null}

        <div className="fy-swrow__frame" data-empty={src === null ? "true" : undefined}>
          {src === null ? (
            <div className="fy-swrow__hatch">
              <span className="fy-swrow__nofr">no frame yet</span>
            </div>
          ) : (
            <div className="fy-swrow__img" role="img" aria-label={shot.title} style={{ backgroundImage: `url(${src})` }} />
          )}
          <span className="fy-swrow__label">shot {shot.number}</span>
          <span className="fy-swrow__chipmeta">
            {aspect} · {(shot.durationSec ?? 0).toFixed(1)}s
            {shot.framing?.lens === undefined ? "" : ` · ${shot.framing.lens}`}
          </span>
        </div>

        <div className="fy-swrow__body">
          <div className="fy-swrow__titleline">
            <span className="fy-swrow__title">
              Shot {shot.number} · {shot.title}
            </span>
            <span className="fy-swchip" data-state={state}>
              {CHIP[state]}
            </span>
          </div>

          {coverage === "changed" ? (
            <div className="fy-swrow__stale">
              <span className="fy-swrow__stalelabel">script changed</span>
            </div>
          ) : null}

          {/* The script: the only thing on the row at full weight. */}
          <p className="fy-swrow__script">{shot.description}</p>

          {refs.length === 0 && overrides.length === 0 ? null : (
            <div className="fy-swrow__meta">
              {refs.length === 0 ? null : (
                <div className="fy-swrow__refs">
                  {refs.map((entry) => (
                    <span key={entry.sheet.id} className="fy-swrow__ref" title={entry.sheet.type}>
                      {entry.sheet.name}
                    </span>
                  ))}
                </div>
              )}
              {overrides.length === 0 ? null : (
                <div className="fy-swrow__overrides">
                  {overrides.map((label) => (
                    <span key={label} className="fy-swrow__override">
                      {label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="fy-swrow__actions">
          {/*
            The slot is fixed rather than flowing: in the wrapping meta row this line jumped as
            content reflowed, and a control that moves while you reach for it is misclicked.
          */}
          <p className="fy-swrow__slot">{shot.promptOverride === undefined ? "prompt · auto" : "edited by you"}</p>
        </div>
      </div>
    </li>
  );
}
