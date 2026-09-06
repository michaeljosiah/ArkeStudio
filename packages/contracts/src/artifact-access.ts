import type { ProductionBundle } from "./client-state.js";
import type { TimelineState } from "./timeline.js";

/** Resolve against the whole world so an ownership refusal is never described as lost media. */
export function resolveProductionArtifact<T extends { id: string; production?: string | null }>(
  artifacts: readonly T[], artifactId: string, productionId: string,
): { ok: true; artifact: T } | { ok: false; code: "missing" | "other-production"; reason: string } {
  const artifact = artifacts.find(candidate => candidate.id === artifactId);
  if (artifact === undefined) return { ok: false, code: "missing", reason: `artifact ${artifactId}, which this world does not have` };
  if (artifact.production != null && artifact.production !== productionId) return {
    ok: false, code: "other-production",
    reason: `artifact ${artifactId}, which belongs to another production. Import the file into this production or remove this reference`,
  };
  return { ok: true, artifact };
}

/** Legacy clocks still need scope checks even where they bypass the saved-timeline planner. */
export function legacyArtifactScopeRefusal(production: ProductionBundle,
  artifacts: readonly { id: string; production?: string | null }[], timeline: TimelineState | undefined = production.timeline): string | null {
  const references: Array<{ label: string; id: string }> = [];
  if (timeline?.status !== "ready" && production.spine) references.push({ label: "Master track", id: production.spine.trackArtifactId });
  if (timeline?.status !== "ready" || timeline.timeline.migratedCut !== true) {
    for (const overlay of production.cut.overlays) references.push({ label: overlay.id, id: overlay.artifactId });
    for (const track of production.cut.audio) for (const [index, entry] of track.entries.entries()) {
      if (entry.artifactId !== undefined) references.push({ label: `${track.label} entry ${index + 1}`, id: entry.artifactId });
    }
  }
  for (const reference of references) {
    const resolved = resolveProductionArtifact(artifacts, reference.id, production.meta.id);
    if (!resolved.ok && resolved.code === "other-production") return `${reference.label} cites ${resolved.reason}`;
  }
  return null;
}
