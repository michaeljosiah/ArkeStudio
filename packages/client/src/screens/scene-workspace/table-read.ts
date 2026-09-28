import { useCallback, useEffect, useRef, useState } from "react";
import type { ProductionBundle, RehearsalLine, SceneRecord, TableReadPlan } from "@arke-studio/contracts";
import { planTableRead, prepareTableRead, subscribeRehearsalResults, useStore } from "../../lib/store.js";

/**
 * The scene's table-read plan, asked for and kept current (SPEC-044 R-33): which lines have a
 * read — a selected performance, or the table-read cache — and what preparing the rest costs.
 * Preview's Play lines reads it, and a visual novel's beats read it for whether each line is
 * voiced and to voice the rest (turn 174); both ask the same plan the same way.
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
  // Narration is read in the app's narrator (turn 174), so a narrator changed while the scene is
  // open is a new plan: the old one names another voice's cache and price.
  const narrator = lines.some((line) => line.narration) ? JSON.stringify(state?.app.narrator ?? null) : "";
  // So is a speaker's voice assigned, cleared or replaced — by World Chat, say — while the lines
  // stay as they were: the plan quoted and cached the voice they had (codex round 8).
  const speakers = [...new Set(lines.flatMap((line) => (line.speakerSheetId === undefined ? [] : [line.speakerSheetId])))].sort();
  // A speaker retired or restored changes whether their lines can be read at all (codex round 13).
  const speakerVoices = JSON.stringify(speakers.map((id) => {
    const sheet = state?.world?.sheets.find((candidate) => candidate.id === id);
    return [id, sheet?.voice ?? null, sheet?.retired ?? false];
  }));
  // And so is a voice provider made ready — validated, repaired, its speech probe answering — or
  // a model turned on or off: a line the plan called unavailable may be preparable now (codex
  // round 12). Only what the plan reads of a provider is watched, not when it was last checked.
  const readiness = JSON.stringify([
    (state?.app.providers ?? []).map((provider) => [provider.id, provider.configured, provider.validation, provider.fault,
      provider.probes.some((probe) => probe.capability === "voice-tts" && probe.available)]),
    state?.app.models.disabled ?? [],
  ]);
  useEffect(() => {
    // The last line gone takes its plan with it: the plan names lines no longer there, and its
    // token would prepare them (codex round 10).
    if (lines.length === 0) { planRequest.current = null; setPlan(null); return; }
    if (connection === "open") requestPlan();
  }, [lines.length, scene.version, production.performanceReview.reviewHash, production.performanceReview.selectionHash, cacheJobs, narrator, speakerVoices, readiness, connection, requestPlan]);
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

/**
 * Every prepared voice across a production's scenes, for a visual novel's preview (turn 174): the
 * player is mounted once, so its beats must carry their voices from the start. Each scene's plan
 * is asked for when `key` changes (a preview opening), and `ready` says every answer is in — or
 * that no studio is there to answer, when the preview reads as text rather than waiting forever.
 */
export function useProductionVoiceFiles({
  worldId,
  productionId,
  scenes: sceneList,
  key,
}: {
  worldId: string | undefined;
  productionId: string | undefined;
  /** The scenes the preview will read, at the versions it will read them. */
  scenes: ReadonlyArray<{ id: string; version: number }>;
  /** Null asks nothing; each new value asks again. */
  key: number | null;
}): { files: ReadonlyMap<string, string>; ready: boolean } {
  const { state, connection } = useStore();
  const [files, setFiles] = useState<ReadonlyMap<string, string>>(new Map());
  const [ready, setReady] = useState(false);
  /** The key whose answers are all in: the preview it opened has mounted, and is not asked again. */
  const settled = useRef<number | null>(null);
  // Versions ride in the key, so a scene edited while its plan is asked restarts the batch: a
  // line keeps its id through an edit, and a voice for its old text must not ride the new one.
  const scenes = sceneList.map((scene) => `${scene.id}@${scene.version}`).join("|");
  // So do the voices the lines are read in: a narrator or a character recast mid-batch would
  // mount one story in two voices (codex round 11), and a speaker retired mid-batch one voiced in
  // some scenes and read in others (codex round 14).
  // And the reads accepted for its lines: a performance selected, cleared or rejected mid-batch
  // changes which audio a plan names (codex round 18).
  const review = state?.world?.productions.find((candidate) => candidate.meta.id === productionId)?.performanceReview;
  const voicesKey = JSON.stringify([
    state?.app.narrator ?? null,
    (state?.world?.sheets ?? []).map((sheet) => [sheet.id, sheet.voice ?? null, sheet.retired ?? false]),
    review?.reviewHash ?? null,
    review?.selectionHash ?? null,
  ]);
  useEffect(() => {
    if (key !== null && settled.current === key) return;
    setFiles(new Map());
    setReady(false);
    if (key === null || worldId === undefined || productionId === undefined) return;
    // No studio to answer, or it went away mid-batch: the preview reads as text rather than
    // waiting on answers that will never come. Back before the preview opened, it asks again.
    if (connection !== "open") {
      settled.current = key;
      setReady(true);
      return;
    }
    /** Each request, with the scene version its answer must be for. */
    const pending = new Map<string, number>();
    const found = new Map<string, string>();
    const off = subscribeRehearsalResults((result) => {
      const version = pending.get(result.requestId);
      if (version === undefined) return;
      pending.delete(result.requestId);
      // A plan for another version than the one the preview reads is not this scene's: its lines
      // read as text rather than in a voice made for other words (codex round 9).
      if (result.plan?.sceneVersion === version) for (const item of result.plan.items) if (item.file !== undefined) found.set(item.lineId, item.file);
      if (pending.size === 0) {
        settled.current = key;
        setFiles(new Map(found));
        setReady(true);
      }
    });
    for (const entry of scenes === "" ? [] : scenes.split("|")) {
      const at = entry.lastIndexOf("@");
      const requestId = planTableRead(worldId, productionId, entry.slice(0, at));
      if (requestId !== null) pending.set(requestId, Number(entry.slice(at + 1)));
    }
    if (pending.size === 0) {
      settled.current = key;
      setReady(true);
    }
    return off;
  }, [key, worldId, productionId, scenes, voicesKey, connection]);
  return { files, ready };
}
