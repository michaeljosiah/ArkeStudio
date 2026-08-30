import { linearizeSceneFlow, type SceneRecord } from "@arke-studio/contracts";
import { selectedShotId, useWorkspaceSelection } from "./selection.js";

/**
 * Flow, read-only (SPEC-029 R-24, R-25, R-28, R-29).
 *
 * Entry, the shots in canonical order, Exit, and the sequence edges between them — and nothing
 * else. No provider, job, take, artifact, prompt or audience-choice nodes appear here: R-24
 * names them because a canvas that shows everything is a canvas nobody can read, and because
 * those belong to other authorities that this view would otherwise quietly duplicate.
 *
 * Rendered as a SEMANTIC SEQUENCE rather than a positioned canvas: a list of nodes with explicit
 * `goes to` rows between them. R-28 requires exactly this below 900px, and building it as the
 * only representation means the narrow case is not a second implementation that drifts — the
 * canvas is never required to complete an operation, so there is nothing here that a keyboard
 * cannot reach. Positions are not stored (§1.16 keeps manual coordinates out of v1), so there is
 * no layout to lose by not drawing one.
 */
export function SceneFlow({ scene }: { scene: SceneRecord }) {
  const sequence = linearizeSceneFlow(scene);
  const { subject, select } = useWorkspaceSelection();
  const current = selectedShotId(subject);

  if (sequence.kind === "invalid") {
    /*
     * An invalid graph shows what can be recovered and says why the order cannot be trusted —
     * it never invents edges (R-29, R-59). The findings are the message; there is no summary
     * and no score, because a number would hide the sentence somebody can act on.
     */
    return (
      <div className="fy-swflow fy-swflow--invalid" data-testid="workspace-flow-invalid">
        <p className="fy-swflow__why">This scene has no order that can be trusted.</p>
        <ul className="fy-swflow__findings">
          {sequence.findings.map((finding) => (
            <li key={`${finding.kind}:${finding.about}`}>{finding.message}</li>
          ))}
        </ul>
      </div>
    );
  }

  const shots = sequence.shots;
  return (
    <div className="fy-swflow" data-testid="workspace-flow">
      <ol className="fy-swflow__seq" aria-label={`Flow of scene ${scene.number}`}>
        <li className="fy-swnode" data-kind="entry">
          <span className="fy-swnode__kind">Entry</span>
        </li>
        {shots.map((pair, index) => (
          <li key={pair.nodeId} className="fy-swseg">
            {/* The edge is addressable in its own right: R-25 lets Arke's subject be one. */}
            <button
              type="button"
              className="fy-swedge"
              onClick={() =>
                select({
                  kind: "edge",
                  fromShotId: index === 0 ? null : shots[index - 1]!.shot.id,
                  toShotId: pair.shot.id,
                })
              }
            >
              goes to
            </button>
            <button
              type="button"
              className="fy-swnode fy-swnode--shot"
              data-kind="shot"
              data-selected={pair.shot.id === current ? "true" : undefined}
              aria-current={pair.shot.id === current ? "true" : undefined}
              onClick={() => select({ kind: "shot", shotId: pair.shot.id })}
              aria-label={`Shot ${pair.shot.number}, ${pair.shot.title}, 1 in, 1 out`}
            >
              <span className="fy-swnode__kind">Shot {pair.shot.number}</span>
              <span className="fy-swnode__title">{pair.shot.title}</span>
            </button>
          </li>
        ))}
        <li className="fy-swseg">
          <button
            type="button"
            className="fy-swedge"
            onClick={() =>
              select({ kind: "edge", fromShotId: shots.at(-1)?.shot.id ?? null, toShotId: null })
            }
          >
            goes to
          </button>
          <span className="fy-swnode" data-kind="exit">
            <span className="fy-swnode__kind">Exit</span>
          </span>
        </li>
      </ol>
    </div>
  );
}
