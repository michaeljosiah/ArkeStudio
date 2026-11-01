import {
  benchProductionWork, orderedShots, ProductionWorkSchema, productionShape, PROVIDERS,
  type BenchTake, type Job, type LedgerEntry, type ProductionSpendProjection,
  type ProductionSpendReceipt, type ProductionSpendRollup, type ProductionSpendSummary,
  type ProductionWork, type WorldBundle,
} from "@arke-studio/contracts";

export interface SpendEvidence {
  ledger: readonly LedgerEntry[];
  jobs: readonly Job[];
  bench: readonly { sessionId: string; takes: readonly BenchTake[] }[];
  ledgerUnavailable: boolean;
  historyUnavailable: boolean;
  ledgerIncomplete?: boolean;
  historyIncomplete?: boolean;
  benchIncomplete: boolean;
}
type Problem = ProductionSpendSummary["problems"][number];
const terminal = (job: Job) => ["succeeded", "failed", "cancelled"].includes(job.status);
const allowance = (source: string) => ["free-plan", "free-credit", "included-plan"].includes(source);
const local = (entry: LedgerEntry) => entry.actualSource === "local-zero" || (PROVIDERS as Record<string, { local: boolean }>)[entry.provider]?.local === true;
const object = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const safeMoney = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** One charge divided once. Invalid historical plans preserve the money as unallocated. */
export function allocateProductionSpend(amount: number, plan: readonly { shotId: string; durationSec: number }[]): Map<string, number> | null {
  if (!safeMoney(amount) || !plan.length || new Set(plan.map(shot => shot.shotId)).size !== plan.length ||
    plan.some(shot => !Number.isFinite(shot.durationSec) || shot.durationSec <= 0)) return null;
  const decimal = (value: number) => {
    const [mantissa, exponent = "0"] = String(value).split("e");
    const [whole, fraction = ""] = mantissa!.split(".");
    return { value: BigInt(whole! + fraction), scale: fraction.length - Number(exponent) };
  };
  const decimals = plan.map(shot => decimal(shot.durationSec));
  const scale = Math.max(...decimals.map(value => value.scale));
  const durations = decimals.map(value => value.value * 10n ** BigInt(scale - value.scale));
  const total = durations.reduce((sum, value) => sum + value, 0n);
  let allocated = 0;
  return new Map(plan.map((shot, index) => {
    // Decimal durations are exact rationals: no floating-point rounding can lose a micro-dollar.
    const share = index === plan.length - 1 ? amount - allocated : Number(BigInt(amount) * durations[index]! / total);
    allocated += share;
    return [shot.shotId, share];
  }));
}

interface Candidate { key: string; shotId: string; aliases: Set<string> }

/** #250 / SPEC-008 turn 255: ledger money and candidate counts have separate authorities. */
export function productionSpend(world: WorldBundle, evidence: SpendEvidence): ProductionSpendProjection {
  const latest = new Map(evidence.jobs.filter(job => job.worldId === world.meta.worldId).map(job => [job.id as string, job]));
  const ledger = new Map<string, LedgerEntry>();
  const duplicates = new Set<string>();
  for (const entry of evidence.ledger) if (entry.worldId === world.meta.worldId) {
    if (ledger.has(entry.jobId)) duplicates.add(entry.jobId);
    else ledger.set(entry.jobId, entry);
  }
  const benchByJob = new Map<string, BenchTake>();
  const benchWork = new Map<string, ProductionWork>();
  for (const session of evidence.bench) for (const take of session.takes) {
    const jobId = take.jobId ?? [...latest.values()].find(job => job.target.kind === "bench-take" && job.target.id === `${session.sessionId}/${take.id}`)?.id;
    if (jobId) { benchByJob.set(jobId, take); const work = benchProductionWork(take.request); if (work) benchWork.set(jobId, work); }
  }
  const productions: ProductionSpendProjection["productions"] = {};
  for (const production of world.productions) {
    const shape = productionShape(production.meta);
    if (!shape.hasScenes || shape.dispatchCapability !== "video") continue;
    const id = production.meta.id;
    const sceneShots = new Map(production.scenes.map(scene => [scene.id as string, new Set(orderedShots(scene).map(shot => shot.id as string))]));
    const shotScenes = new Map([...sceneShots].flatMap(([sceneId, shots]) => [...shots].map(shotId => [shotId, sceneId] as const)));
    const receipts: ProductionSpendReceipt[] = [];
    const missing = new Set<string>();
    const candidates = new Map<string, Candidate>();
    const relevantJobs = new Set<string>();
    const candidateJobs = new Set<string>();
    const passParents = new Set(production.takes.flatMap(take => take.segment ? [take.segment.passTakeId as string] : []));
    const problem = new Set<Problem>();
    let countsPartial = evidence.benchIncomplete || evidence.historyUnavailable || !!evidence.historyIncomplete;
    if (evidence.ledgerUnavailable) problem.add("ledger-unreadable");
    if (evidence.historyUnavailable) problem.add("history-unreadable");
    if (evidence.ledgerIncomplete || evidence.historyIncomplete) problem.add("history-incomplete");
    if (evidence.benchIncomplete) problem.add("bench-incomplete");

    const workFor = (job: Job): ProductionWork | null => {
      const frozen = ProductionWorkSchema.safeParse(job.params.productionWork);
      if (frozen.success) return frozen.data;
      const fromBench = benchWork.get(job.id);
      if (fromBench) return fromBench;
      if (job.productionId !== id || !["shot", "scene-pass", "board-sheet"].includes(job.target.kind) || !["image", "video"].includes(job.capability)) return null;
      const provenance = object(job.params.provenance);
      const sceneId = typeof provenance.sceneId === "string" ? provenance.sceneId
        : job.target.kind === "scene-pass" ? job.target.id : job.target.id ? shotScenes.get(job.target.id) : undefined;
      if (!sceneId) return { productionId: id, sceneId: "unknown", kind: job.capability === "video" ? "video" : "frame", shots: [] };
      const plan = Array.isArray(job.params.shotPlan) ? job.params.shotPlan.map(raw => {
        const item = object(raw);
        return { shotId: String(item.shotId ?? ""), durationSec: Number(item.endSec) - Number(item.startSec), takeId: "" };
      }) : job.target.kind === "shot" && job.target.id ? [{ shotId: job.target.id, durationSec: 1, takeId: "" }] : [];
      return { productionId: id, sceneId, kind: job.capability === "video" ? "video" : "frame", shots: plan };
    };
    const addCandidate = (shotId: string, jobId: string | undefined, alias: string) => {
      if (!shotScenes.has(shotId)) return;
      if ([...candidates.values()].some(candidate => candidate.shotId === shotId && candidate.aliases.has(alias))) {
        if (jobId) candidateJobs.add(jobId);
        return;
      }
      const key = `${jobId ?? alias}/${shotId}`;
      const existing = candidates.get(key);
      if (existing) existing.aliases.add(alias);
      else candidates.set(key, { key, shotId, aliases: new Set([alias]) });
      if (jobId) candidateJobs.add(jobId);
    };

    for (const job of latest.values()) {
      const work = workFor(job);
      if (work?.productionId !== id) continue;
      relevantJobs.add(job.id);
      const entry = ledger.get(job.id);
      if (!entry && terminal(job)) missing.add(job.id);
      const recorded = entry ? entry.actualMicroUsd ?? entry.estimatedMicroUsd : null;
      const overflow = recorded !== null && !safeMoney(recorded);
      if (overflow) problem.add("amount-overflow");
      const source = !entry || overflow ? "unavailable" : allowance(entry.actualSource ?? "") ? entry.actualSource!
        : local(entry) ? "local-zero" : entry.actualMicroUsd === null ? "estimated" : entry.actualSource ?? "unknown-actual";
      const amount = !entry || overflow ? null : allowance(source) || source === "local-zero" ? 0 : recorded;
      const valid = sceneShots.has(work.sceneId) && work.shots.every(shot => sceneShots.get(work.sceneId)!.has(shot.shotId));
      const allocation = valid && amount !== null ? allocateProductionSpend(amount, work.shots) : null;
      receipts.push({ jobId: job.id, ...(sceneShots.has(work.sceneId) ? { sceneId: work.sceneId } : {}), kind: work.kind,
        provider: job.provider, model: job.model, outcome: terminal(job) ? job.status as "succeeded" | "failed" | "cancelled" : job.status === "needs-reconciliation" ? "unknown" : "pending",
        source, microUsd: amount, recordedMicroUsd: overflow ? null : recorded,
        shots: valid ? work.shots.filter(shot => Number.isFinite(shot.durationSec) && shot.durationSec > 0).map(shot => ({ shotId: shot.shotId, durationSec: shot.durationSec, microUsd: allocation?.get(shot.shotId) ?? null })) : [],
        unallocatedMicroUsd: allocation === null ? amount ?? 0 : 0 });
      if (amount !== null && allocation === null) problem.add("allocation-missing");
      if (duplicates.has(job.id)) problem.add("history-incomplete");
      const take = benchByJob.get(job.id);
      if (take?.media && work.kind === "video") for (const shot of work.shots) addCandidate(shot.shotId, job.id, shot.takeId);
    }

    const retainHistoricalWork = (jobId: string, work: ProductionWork, provider: string, model: string) => {
      if (receipts.some(row => row.jobId === jobId)) return;
      const entry = ledger.get(jobId), recorded = entry ? entry.actualMicroUsd ?? entry.estimatedMicroUsd : null;
      const overflow = recorded !== null && !safeMoney(recorded);
      if (overflow) problem.add("amount-overflow");
      const source = !entry || overflow ? "unavailable" : allowance(entry.actualSource ?? "") ? entry.actualSource! : local(entry) ? "local-zero"
        : entry.actualMicroUsd === null ? "estimated" : entry.actualSource ?? "unknown-actual";
      const amount = !entry || overflow ? null : allowance(source) || source === "local-zero" ? 0 : recorded;
      const valid = sceneShots.has(work.sceneId) && work.shots.every(shot => sceneShots.get(work.sceneId)!.has(shot.shotId));
      const allocation = valid && amount !== null ? allocateProductionSpend(amount, work.shots) : null;
      receipts.push({ jobId, ...(sceneShots.has(work.sceneId) ? { sceneId: work.sceneId } : {}), kind: work.kind,
        provider, model, outcome: entry?.outcome ?? "succeeded", source, microUsd: amount, recordedMicroUsd: overflow ? null : recorded,
        shots: valid ? work.shots.filter(shot => Number.isFinite(shot.durationSec) && shot.durationSec > 0)
          .map(shot => ({ shotId: shot.shotId, durationSec: shot.durationSec, microUsd: allocation?.get(shot.shotId) ?? null })) : [],
        unallocatedMicroUsd: allocation === null ? amount ?? 0 : 0 });
      if (amount !== null && allocation === null) problem.add("allocation-missing");
      if (!entry) missing.add(jobId);
      if (!latest.has(jobId)) { problem.add("history-incomplete"); countsPartial = true; }
    };

    // A retained reservation can precede enqueue, or outlive a lost app-root job history.
    for (const session of evidence.bench) for (const take of session.takes) {
      const work = benchProductionWork(take.request);
      if (work?.productionId !== id || !take.media) continue;
      const jobId = take.jobId ?? [...latest.values()].find(job => job.target.id === `${session.sessionId}/${take.id}`)?.id;
      if (work.kind === "video") for (const shot of work.shots) addCandidate(shot.shotId, jobId, shot.takeId);
      retainHistoricalWork(jobId ?? `${session.sessionId}/${take.id}`, work, take.request.provider, take.request.model);
    }
    for (const take of production.takes) {
      if (["frame", "still"].includes(take.kind) && take.provider !== "user" && take.provider !== "upload" && take.media &&
        (!take.jobId || !latest.has(take.jobId) || relevantJobs.has(take.jobId))) {
        if (!take.jobId || !latest.has(take.jobId) || !ledger.has(take.jobId)) {
          const sceneId = take.provenance.sceneId ?? shotScenes.get(take.coversShots[0] ?? "") ?? "unknown";
          retainHistoricalWork(take.jobId ?? take.id, { productionId: id, sceneId, kind: "frame",
            shots: take.coversShots.map(shotId => ({ shotId, durationSec: 1, takeId: take.id })) }, take.provider, take.model);
        }
      }
      if (take.kind !== "clip" || passParents.has(take.id) || take.provider === "user" || take.provider === "upload" || (!take.media && !take.segment)) continue;
      if (take.coversShots.length !== 1) continue;
      const job = take.jobId ? latest.get(take.jobId) : undefined;
      const filing = job ? benchByJob.get(job.id)?.request.filing : undefined;
      if (!take.segment && (job?.target.kind === "scene-pass" || (filing?.kind === "board" && take.id === filing.productionTakeId))) continue;
      // An imported or unrelated generated item must not become production video work.
      if (job && !relevantJobs.has(job.id)) continue;
      addCandidate(take.coversShots[0]!, take.jobId, take.id);
      if (!take.jobId || !ledger.has(take.jobId)) missing.add(take.jobId ?? take.id);
      if (!take.jobId || !latest.has(take.jobId)) countsPartial = true;
    }
    for (const jobId of relevantJobs) {
      const job = latest.get(jobId)!;
      if (job.capability === "video" && job.status === "succeeded" && job.finalization?.status !== "failed" &&
        job.finalization?.status !== "pending" && !candidateJobs.has(jobId)) countsPartial = true;
    }
    // Retain known production money if its target history has gone; do not invent a shot.
    for (const entry of ledger.values()) if (entry.productionId === id && !latest.has(entry.jobId) && !receipts.some(row => row.jobId === entry.jobId)) {
      const recorded = entry.actualMicroUsd ?? entry.estimatedMicroUsd;
      const overflow = !safeMoney(recorded);
      if (overflow) problem.add("amount-overflow");
      const source = overflow ? "unavailable" : allowance(entry.actualSource ?? "") ? entry.actualSource! : local(entry) ? "local-zero"
        : entry.actualMicroUsd === null ? "estimated" : entry.actualSource ?? "unknown-actual";
      const amount = overflow ? null : allowance(source) || source === "local-zero" ? 0 : recorded;
      receipts.push({ jobId: entry.jobId, kind: "unknown", provider: entry.provider, model: entry.model, outcome: entry.outcome,
        source, microUsd: amount, recordedMicroUsd: overflow ? null : recorded, shots: [], unallocatedMicroUsd: amount ?? 0 });
      problem.add("history-incomplete");
    }
    if (missing.size) problem.add("history-incomplete");
    if (countsPartial) problem.add("counts-incomplete");

    const summarize = (scope: "production" | "scene" | "shot", scopeId?: string): ProductionSpendSummary => {
      const rows = receipts.filter(row => scope === "production" || (scope === "scene"
        ? row.sceneId === scopeId : row.shots.some(shot => shot.shotId === scopeId)));
      const scopedCandidates = [...candidates.values()].filter(candidate => scope === "production" || (scope === "scene" ? shotScenes.get(candidate.shotId) === scopeId : candidate.shotId === scopeId));
      const selected = new Set(scopedCandidates.filter(candidate => candidate.aliases.has(production.selections[candidate.shotId]?.acceptedTakeId ?? "")).map(candidate => candidate.shotId)).size;
      const known = rows.filter(row => row.microUsd !== null);
      const sum = known.reduce((total, row) => total + (scope === "shot" ? row.shots.find(shot => shot.shotId === scopeId)?.microUsd ?? 0 : row.microUsd!), 0);
      const unallocated = scope === "shot" ? 0 : known.reduce((total, row) => total + row.unallocatedMicroUsd, 0);
      const sources = new Map<string, { source: ProductionSpendReceipt["source"]; entries: number; microUsd: number }>();
      for (const row of known) {
        const previous = sources.get(row.source) ?? { source: row.source, entries: 0, microUsd: 0 };
        previous.entries++;
        previous.microUsd += scope === "shot" ? row.shots.find(shot => shot.shotId === scopeId)?.microUsd ?? 0 : row.microUsd!;
        sources.set(row.source, previous);
      }
      const hasWork = rows.length > 0 || scopedCandidates.length > 0;
      const unavailable = evidence.ledgerUnavailable || evidence.historyUnavailable || (!known.length && (rows.some(row => row.outcome !== "pending") || scopedCandidates.length > 0));
      const overflow = !safeMoney(sum) || !safeMoney(unallocated) || [...sources.values()].some(source => !safeMoney(source.microUsd));
      const partial = problem.has("history-incomplete") || problem.has("bench-incomplete") || problem.has("allocation-missing") ||
        rows.some(row => row.microUsd === null && row.outcome !== "pending") || unallocated > 0 ||
        rows.some(row => !row.shots.length && row.kind !== "unknown");
      return { spentMicroUsd: unavailable || overflow ? null : sum, unallocatedMicroUsd: overflow ? 0 : unallocated,
        coverage: unavailable || overflow ? "unavailable" : partial ? "partial" : hasWork ? "complete" : "empty",
        generated: scopedCandidates.length, selected, countsPartial,
        localRuns: known.filter(row => row.source === "local-zero").length,
        sources: overflow ? [] : [...sources.values()], problems: [...new Set([...problem, ...(overflow ? ["amount-overflow" as const] : [])])] };
    };
    const rollup: ProductionSpendRollup = { total: summarize("production"), scenes: {}, shots: {}, receipts };
    for (const sceneId of sceneShots.keys()) rollup.scenes[sceneId] = summarize("scene", sceneId);
    for (const shotId of shotScenes.keys()) rollup.shots[shotId] = summarize("shot", shotId);
    productions[id] = rollup;
  }
  return { worldId: world.meta.worldId, productions };
}
