import { deriveProductionReadiness, type ProductionPlanCard, type ReadinessCheck } from "@arke-studio/contracts";
import { useStore } from "../lib/store.js";

function Checklist({ checks }: { checks: readonly ReadinessCheck[] }) {
  return <ul className="fy-production-plan__checks">{checks.map(check => <li key={check.key}>
    <span aria-label={check.status === "ready" ? "Complete" : check.status === "not-required" ? "Not required" : check.status === "blocked" ? "Blocked" : "Incomplete"}>
      {check.status === "ready" ? "✓" : check.status === "not-required" ? "—" : "○"}
    </span>{" "}<span>{check.label}{check.total > 1 ? ` · ${check.completed}/${check.total}` : ""}</span>
    <small>{check.detail}{check.missingIds.length ? ` Missing: ${check.missingIds.slice(0,4).join(", ")}${check.missingIds.length > 4 ? ", …" : ""}.` : ""}</small>
  </li>)}</ul>;
}

/** SPEC-051 R-40: a live checklist and proposed steps, with no execution or approval control. */
export function ProductionPlanCardView({ card }: { card: ProductionPlanCard }) {
  const world = useStore().state?.world;
  const production = world?.meta.worldId === card.worldId ? world.productions.find(p => p.meta.id === card.productionId) : undefined;
  const readiness = world && production ? deriveProductionReadiness(world, production, card.exports) : null;
  return <article className="fy-production-plan" aria-label="Production plan">
    <p className="fy-chatcard__eyebrow">Production plan · current state</p>
    <h3>{readiness?.title ?? card.productionId}</h3>
    {readiness ? <>
      <Checklist checks={readiness.checks} />
      {readiness.scenes.map(scene => <details key={scene.sceneId} open={readiness.scenes.length < 3}>
        <summary>{scene.title} · {scene.ready ? "Complete" : "Work remains"}</summary>
        <Checklist checks={scene.checks} />
      </details>)}
    </> : <p>This production is unavailable. Reopen its conversation to read readiness.</p>}
    {card.nextSteps.length > 0 && <div><h4>Proposed next steps</h4><ol>{card.nextSteps.map((step,index) => <li key={index}>{step}</li>)}</ol></div>}
    <p className="fy-production-plan__note">Ask for a step when you want Arke to prepare its cards.</p>
  </article>;
}
