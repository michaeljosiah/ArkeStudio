import { useEffect, useState } from "react";
import { orderedShots, type PlanState, type SceneRecord } from "@arke-studio/contracts";
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
  scene,
  refused,
}: {
  worldId: string;
  prodId: string;
  scene: SceneRecord;
  refused: string | null;
}) {
  const sceneId = scene.id;
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
  // Shots by number (SPEC-044 R-25): the summary holds ids, the scene says what they are called.
  const numbers = new Map(orderedShots(scene).map((shot) => [shot.id, shot.number]));
  const shotsLabel = (ids: readonly string[]): string | null => {
    const found = ids.map((id) => numbers.get(id)).filter((number): number is number => number !== undefined);
    if (found.length === 0) return null;
    if (found.length === 1) return `shot ${found[0]}`;
    const contiguous = found.every((number, index) => index === 0 || number === found[index - 1]! + 1);
    return contiguous ? `shots ${found[0]}–${found[found.length - 1]}` : `shots ${found.join(", ")}`;
  };
  // R-24's line, per pass, from the recorded summary alone: what rides, then what will not,
  // each as one clause; then the pass's state as before.
  const castClauses = (member: NonNullable<PlanState["passes"][number]["carries"]>["cast"][number]): string[] => {
    const riding = [member.voice === "rides" ? "voice" : null, member.look === "rides" ? "look" : member.look === "kit" ? "sheet" : null]
      .filter((part): part is string => part !== null);
    return [
      ...(riding.length > 0 ? [`${member.name}: ${riding.join(", ")}`] : []),
      ...(member.look === "not-sent" ? [`${member.name}: look not sent${member.reason === undefined ? "" : ` · ${member.reason}`}`] : []),
      ...(member.voice === "not-sent" ? [`${member.name}: voice not sent${member.voiceReason === undefined ? "" : ` · ${member.voiceReason}`}`] : []),
      // The read that did not ride is said even though the sample did (R-28).
      ...(member.voice === "rides" && member.voiceReason !== undefined ? [`${member.name}: read not sent · ${member.voiceReason} · the sample rides`] : []),
    ];
  };
  const passLine = (state: PlanState, pass: PlanState["passes"][number]): string => {
    const carries = pass.carries;
    const head = [
      `pass ${pass.passIndex + 1}`,
      carries === undefined ? null : shotsLabel(carries.shotIds),
      pass.askedSec === undefined ? null : `${pass.askedSec.toFixed(1)}s`,
      usd(pass.estimatedMicroUsd),
      carries?.frame === undefined ? null : `frame: ${shotsLabel([carries.frame.shotId]) ?? "shot"}`,
      carries?.place === undefined ? null
        : carries.place.rides ? `${carries.place.name}: plate`
        : `${carries.place.name}: plate not sent${carries.place.reason === undefined ? "" : ` · ${carries.place.reason}`}`,
      ...(carries?.cast.flatMap(castClauses) ?? []),
    ].filter((part): part is string => part !== null);
    const status =
      pass.state === "blocked" ? `blocked — ${pass.reason ?? "extraction failed"}`
      : pass.state === "failed" ? `failed — ${pass.reason ?? "the job failed"}`
      : pass.state === "halted" ? `will not run — ${pass.reason ?? state.haltReason ?? ""}`
      : pass.state;
    return `${head.join(" · ")} · ${status}`;
  };
  // R-25: timing is one clause on the pass it changes. Per-shot generation uses the authored
  // length; whole-scene packing leaves the shot out, and says so.
  const timingLines = (state: PlanState, pass: PlanState["passes"][number]): string[] =>
    (pass.carries?.timing ?? []).map((entry) =>
      `shot ${entry.number} · not on the Cut · ${state.mode === "per-shot" ? `uses its ${entry.durationSec.toFixed(1)}s` : "left out"}`);
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
                {timingLines(state, pass).map((line) => `${line}\n`).join("")}
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
