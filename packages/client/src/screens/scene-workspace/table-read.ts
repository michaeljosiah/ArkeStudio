import { useCallback, useEffect, useRef, useState } from "react";
import type { ProductionBundle, RehearsalLine, SceneRecord, TableReadPlan } from "@arke-studio/contracts";
import { planTableRead, prepareTableRead, subscribeRehearsalResults, useStore } from "../../lib/store.js";

/**
 * The scene's table-read plan, asked for and kept current (SPEC-044 R-33): which lines have a
 * read — a selected performance, or the table-read cache — and what preparing the rest costs.
 * Preview's Play lines reads it, and a visual novel's beats read it for whether each line is
 * voiced and to voice the rest (turn 172); both ask the same plan the same way.
 *
 * The plan is asked for when the lines, the reviews or the cache's jobs change, so a count and a
 * price are current before a press, and again when the connection returns: a request that found
 * no studio was never sent.
 */
export function useTableReadPlan({
  worldId,
  production,
  scene,
  lines,
}: {
  worldId: string;
  production: ProductionBundle;
  scene: SceneRecord;
  lines: readonly RehearsalLine[];
}) {
  const { state, connection } = useStore();
  const [plan, setPlan] = useState<TableReadPlan | null>(null);
  const [notice, setNotice] = useState("");
  const [preparing, setPreparing] = useState(false);
  const planRequest = useRef<string | null>(null);
  const prepareRequest = useRef<string | null>(null);
  const requestPlan = useCallback(() => {
    planRequest.current = planTableRead(worldId, production.meta.id, scene.id);
  }, [worldId, production.meta.id, scene.id]);
  useEffect(() => subscribeRehearsalResults((result) => {
    if (result.requestId !== planRequest.current && result.requestId !== prepareRequest.current) return;
    if (result.requestId === prepareRequest.current) {
      prepareRequest.current = null; setPreparing(false);
      // A preparation that went through whole says itself through the refreshed plan; what did
      // not — a refusal, or lines the queue or the local engine would not take — is said in the
      // result's own words (codex round 3). A refusal's token is spent, so the plan is asked again.
      setNotice(result.status === "refused" || /could not be prepared|not queued/.test(result.reason) ? result.reason : "");
      if (result.status === "refused") requestPlan();
    } else planRequest.current = null;
    if (result.plan) setPlan(result.plan);
    else if (result.status === "refused") setNotice(result.reason);
  }), [requestPlan]);
  const cacheJobs = state?.app.jobs.filter((job) => job.target.kind === "table-read-cache" && job.worldId === worldId).map((job) => `${job.id}:${job.status}`).join("|") ?? "";
  useEffect(() => {
    if (lines.length > 0 && connection === "open") requestPlan();
  }, [lines.length, scene.version, production.performanceReview.reviewHash, production.performanceReview.selectionHash, cacheJobs, connection, requestPlan]);
  const prepare = useCallback(() => {
    if (plan === null) return;
    setNotice("");
    setPreparing(true);
    prepareRequest.current = prepareTableRead(worldId, production.meta.id, scene.id, plan.confirmationToken, plan.totalEstimatedMicroUsd);
    if (prepareRequest.current === null) { setPreparing(false); setNotice("The studio is disconnected."); }
  }, [plan, worldId, production.meta.id, scene.id]);
  return { plan, notice, preparing, prepare };
}

export type LineVoice = "voiced" | "voicing" | "unvoiced";

/** Each planned line's state as a beat shows it: it has a read, one is being made, or neither. */
export function lineVoices(plan: TableReadPlan | null): ReadonlyMap<string, LineVoice> {
  return new Map((plan?.items ?? []).map((item) => [
    item.lineId,
    item.file !== undefined ? "voiced" : item.route === "generating" ? "voicing" : "unvoiced",
  ]));
}
