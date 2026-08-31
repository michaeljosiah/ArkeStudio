import { useEffect, useState } from "react";
import { type PlanState } from "@arke-studio/contracts";
import { Button, Callout } from "../../components/ui.js";
import { usd } from "../../lib/format.js";
import {
  listPlans,
  planCancel,
  planContinue,
  planReconfirm,
  subscribePlanStates,
} from "../../lib/store.js";

/** Durable multi-pass authorization stays with the scene after the dispatch route retires. */
export function PlansPanel({
  worldId,
  prodId,
  sceneId,
  refused,
}: {
  worldId: string;
  prodId: string;
  sceneId: string;
  refused: string | null;
}) {
  const [states, setStates] = useState<PlanState[] | null>(null);
  const [optionsFor, setOptionsFor] = useState<string | null>(null);
  useEffect(() => {
    setStates(null);
    const offStates = subscribePlanStates((event) => {
      if (event.productionId === prodId) {
        setStates(event.states.filter((state) => state.sceneId === sceneId));
      }
    });
    listPlans(worldId, prodId);
    return offStates;
  }, [worldId, prodId, sceneId]);
  if ((!states || states.length === 0) && refused === null) return null;
  const passLine = (state: PlanState, pass: PlanState["passes"][number]): string => {
    const label = `pass ${pass.passIndex + 1}`;
    if (pass.state === "blocked") return `${label} · blocked — ${pass.reason ?? "extraction failed"}`;
    if (pass.state === "failed") return `${label} · failed — ${pass.reason ?? "the job failed"}`;
    if (pass.state === "halted") return `${label} · will not run — ${pass.reason ?? state.haltReason ?? ""}`;
    return `${label} · ${pass.state}`;
  };
  return (
    <div style={{ marginTop: 14 }}>
      <div className="fy-listhead">Plans</div>
      {refused !== null && (
        <Callout tone="warning" title="Plan refused">
          {refused}
        </Callout>
      )}
      {(states ?? []).map((state) => (
        <div key={state.planId} className="fy-boardcard" style={{ marginTop: 8 }}>
          <div className="fy-boardcard__head">
            {state.policy === "review-gated" ? "Review-gated" : "Pre-authorized"} · {state.status} · cap{" "}
            {usd(state.capMicroUsd)}
          </div>
          <button
            type="button"
            className="fy-linkbtn"
            aria-expanded={optionsFor === state.planId}
            onClick={() => setOptionsFor((open) => open === state.planId ? null : state.planId)}
          >
            Generation options
          </button>
          {optionsFor === state.planId ? (
            <div className="fy-boardcard fy-boardcard--quiet" data-testid={`generation-options-${state.planId}`}>
              <div className="fy-boardcard__head">
                Strategy · {state.policy === "review-gated" ? "ask before each pass" : `pre-authorized to ${usd(state.capMicroUsd)}`}
              </div>
              <div className="fy-boardcard__mono">
                {state.passes.map((pass) => (
                  <span key={pass.passIndex}>
                    pass {pass.passIndex + 1} · {usd(pass.estimatedMicroUsd)}
                    {pass.reason === undefined ? "" : ` · ${pass.reason}`}
                    {"\n"}
                  </span>
                ))}
                {state.haltReason === undefined ? "" : `warning · ${state.haltReason}`}
              </div>
            </div>
          ) : null}
          <div className="fy-boardcard__mono">
            {state.passes.map((pass) => (
              <span key={pass.passIndex}>
                {passLine(state, pass)}
                {"\n"}
              </span>
            ))}
            {state.haltReason !== undefined && `halted: ${state.haltReason}`}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            {state.next.kind === "await-continue" && (
              <Button
                variant="primary"
                onClick={() =>
                  planContinue(worldId, prodId, state.planId, (state.next as { passIndex: number }).passIndex)
                }
              >
                Continue · pass {state.next.passIndex + 1} ·{" "}
                {usd(state.passes[state.next.passIndex]?.estimatedMicroUsd ?? 0)}
              </Button>
            )}
            {state.next.kind === "await-reconfirm" && (
              <Button
                variant="primary"
                onClick={() =>
                  planReconfirm(
                    worldId,
                    prodId,
                    state.planId,
                    (state.next as { passIndex: number }).passIndex,
                  )
                }
              >
                Reconfirm · pass {state.next.passIndex + 1} runs past the {usd(state.capMicroUsd)} cap
              </Button>
            )}
            {state.status !== "completed" && state.status !== "cancelled" && (
              <Button variant="ghost" onClick={() => planCancel(worldId, prodId, state.planId)}>
                Cancel plan
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
