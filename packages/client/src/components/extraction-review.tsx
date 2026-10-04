import type { ArtifactSidecar } from "@arke-studio/contracts";
import { resolveExtraction } from "../lib/store.js";
import { Badge, Button } from "./ui.js";

/** The source-verified choices are human decisions on both artifact screens and in chat. */
export function ExtractionReviewCandidates({ worldId, artifact }: { worldId: string; artifact: ArtifactSidecar }) {
  return <div className="scr-sectionlist">
    {artifact.extraction?.pending.map(candidate => <div key={candidate.hash} className="scr-sheetsection">
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
        <Badge tone="outline">{candidate.kind}</Badge>
        <strong style={{ font: "var(--type-ui)" }}>{candidate.name}</strong>
        {candidate.section && <span style={{ font: "var(--type-label)", color: "var(--muted-foreground)" }}>→ {candidate.section}</span>}
      </div>
      <span>{candidate.body}</span>
      <span className="scr-field__hint">“{candidate.quote}”{candidate.line !== undefined ? ` — line ${candidate.line}` : ""} · verified against the source</span>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button onClick={() => resolveExtraction(worldId, artifact.id, candidate.hash, "accept")}>Accept — commits on its own</Button>
        <Button variant="ghost" onClick={() => resolveExtraction(worldId, artifact.id, candidate.hash, "reject")}>Reject — leaves no trace</Button>
      </div>
    </div>)}
  </div>;
}
