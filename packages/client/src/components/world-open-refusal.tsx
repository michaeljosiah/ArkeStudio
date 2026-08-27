import { useNavigate } from "react-router";
import { EmptyState } from "./layout.js";
import { Button } from "./ui.js";
import { openWorld, useStore } from "../lib/store.js";

/**
 * The world was asked for and refused (issue 571).
 *
 * Shared because the world's routes are two trees, not one: `/w/:worldId` renders under
 * `WorldLayout` and `/w/:worldId/p/:prodId` is a sibling under `ProductionLayout`. Both read the
 * same absent bundle, so a refusal surfaced in only one of them leaves every production screen —
 * which is where the world in the report kept its work — on its loader indefinitely.
 */

export interface WorldOpenRefusal {
  worldId: string;
  reason: string;
}

/** This world's refusal, and only this one's — the failure outlives the world that was asked for. */
export function useWorldOpenRefusal(worldId: string | undefined): WorldOpenRefusal | null {
  const failure = useStore().state?.worldOpenFailure ?? null;
  // Switching to another world leaves the failure on the wire until one opens, and it would
  // otherwise follow the person onto a world that is opening fine.
  return failure !== null && failure.worldId === worldId ? failure : null;
}

export function WorldOpenRefusal({
  worldId,
  reason,
  stranded = false,
}: {
  worldId: string;
  reason: string;
  /**
   * True where the surrounding layout draws no chrome — the fixed workspaces (a proposal, a
   * model sheet, the Bench) deliberately render none, and their child supplies the breadcrumb.
   * Replacing that child with a refusal offering only Try again strands anybody who launched or
   * reloaded at such a URL: retrying a world that will not open is not a way out of it.
   */
  stranded?: boolean;
}) {
  const navigate = useNavigate();
  return (
    // `overflow-wrap` inherits, and the reason is usually a path: without it a deep
    // `.history/productions/…` runs past the dashed edge rather than wrapping inside it.
    <div style={{ padding: "var(--space-6) var(--gutter)", overflowWrap: "anywhere" }}>
      <EmptyState
        title="This world did not open"
        hint={reason}
        action={
          <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "center" }}>
            <Button onClick={() => openWorld(worldId)}>Try again</Button>
            {stranded && (
              <Button variant="ghost" onClick={() => navigate("/worlds")}>
                Worlds
              </Button>
            )}
          </div>
        }
      />
    </div>
  );
}
