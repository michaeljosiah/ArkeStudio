import type { ClientState } from "./client-state.js";
import type { Job } from "./job.js";
import type { LedgerEntry } from "./job.js";
import { isReplayableFinalization } from "./job.js";
import { PROVIDERS } from "./provider.js";
import type { Take } from "./take.js";

/**
 * The Activity read model (SPEC-014): nothing is added to the needs-you queue — every entry is
 * a query over world, queue and provider state (R-3, D1). A take leaves because a decision now
 * exists; a proposal leaves because it resolved. Correct by construction, not by maintenance.
 */

// ---------------------------------------------------------------------------
// Needs you (R-3..R-5, D1..D3)
// ---------------------------------------------------------------------------

/** Urgency classes (§2.4): unresolved money, blocked work, read-only worlds, paid work, WIP. */
export type NeedsYouClass = 1 | 2 | 3 | 4 | 5;

export type NeedsYouAction =
  | "resolve"
  | "retry-finalization"
  | "settings"
  | "reconcile"
  | "review"
  | "open-proposal"
  | "open-world"
  | "review-extraction";

export interface NeedsYouEntry {
  urgency: NeedsYouClass;
  kind:
    | "job-needs-reconciliation"
    | "job-finalization-failed"
    | "provider-paused"
    | "external-edits"
    | "unreviewed-take"
    | "open-proposal"
    | "extraction-batch"
    | "closed-world-attention";
  title: string;
  detail: string;
  /** Recency for within-class ordering. */
  at: string;
  worldId?: string;
  /** State-permitted actions only (R-13, D10). */
  actions: NeedsYouAction[];
  /** For closed-world counts: the as-of label the honesty rule requires (R-7, D4). */
  asOf?: string;
  ref?: string;
  /** Exact in-app review destination when the derived item owns one. */
  reviewPath?: string;
}

/**
 * Where a waiting reference take is actually decided.
 *
 * A location view is not decided on a character screen. It used to land there because every kind
 * but `look` and `main-photo` fell through to the character kit, so Review on a location view
 * opened another entity's reference set — a screen with no way to accept the thing that sent you
 * there. Kinds are named here rather than defaulted, so the next one added has to answer this
 * question instead of inheriting an answer.
 */
function referenceReviewPath(worldId: string, sheetId: string, kind: Take["kind"]): string {
  switch (kind) {
    case "look":
      return `/w/${worldId}/cast/${sheetId}/looks`;
    case "main-photo":
      return `/w/${worldId}/cast/${sheetId}/main-photo`;
    case "location-view":
      return `/w/${worldId}/locations/${sheetId}/reference`;
    default:
      return `/w/${worldId}/cast/${sheetId}/kit`;
  }
}

export function computeNeedsYou(state: ClientState): NeedsYouEntry[] {
  const entries: NeedsYouEntry[] = [];

  // Class 1 — unresolved spend: only the user can decide (D3). Global and precise (R-6).
  for (const job of state.app.jobs) {
    if (job.finalization?.status === "failed") {
      // Every kind the queue can replay gets the action, or the row strands: a failed
      // finalization cannot be deleted, so an entry with no retry has no way out at all.
      const retryable = isReplayableFinalization(job);
      entries.push({
        urgency: 1,
        kind: "job-finalization-failed",
        title: `${job.model} output needs attention`,
        detail: job.finalization.error ?? "generation completed, but its result is not ready",
        at: job.finalization.updatedAt,
        worldId: job.worldId,
        actions: retryable ? ["retry-finalization"] : [],
        ref: job.id,
      });
      continue;
    }
    if (job.status !== "needs-reconciliation") continue;
    entries.push({
      urgency: 1,
      kind: "job-needs-reconciliation",
      title: `${job.provider} submission needs your answer`,
      detail: job.error ?? "the outcome was not witnessed",
      at: job.updatedAt,
      worldId: job.worldId,
      actions: ["resolve"],
      ref: job.id,
    });
  }

  // Class 2 — blocked work: every queued job behind a bad credential is stalled.
  for (const queue of state.app.queues) {
    if (!queue.paused) continue;
    entries.push({
      urgency: 2,
      kind: "provider-paused",
      title: `${queue.provider} is paused`,
      detail: `${queue.reason ?? "paused"} — ${queue.held} job${queue.held === 1 ? "" : "s"} held, not failed`,
      at: "9999-12-31T00:00:00Z", // pauses have no timestamp; they sort newest within class
      actions: ["settings"],
      ref: queue.provider,
    });
  }

  const world = state.world;

  // Class 3 — a world read-only until reconciled.
  if (world && world.externalEdits.length > 0) {
    entries.push({
      urgency: 3,
      kind: "external-edits",
      title: `${world.meta.name} has ${world.externalEdits.length} external edit${world.externalEdits.length === 1 ? "" : "s"}`,
      detail: world.externalEdits.map((e) => e.path).slice(0, 3).join(", "),
      at: world.meta.updated,
      worldId: world.meta.worldId,
      actions: ["reconcile"],
    });
  }

  // Class 4 — money already spent, sitting unused: precise for the OPEN world (R-7).
  if (world) {
    const decidedReferences = new Set((world.referenceReviews ?? []).map((review) => review.takeId));
    for (const take of world.referenceTakes ?? []) {
      if (decidedReferences.has(take.id)) continue;
      entries.push({
        urgency: 4,
        kind: "unreviewed-take",
        title: "reference take awaiting review",
        detail: `${take.kind} for ${take.reference?.sheetId ?? "reference set"}`,
        at: take.completedAt ?? take.dispatchedAt,
        worldId: world.meta.worldId,
        actions: ["review"],
        ref: take.id,
        ...(take.reference?.sheetId
          ? { reviewPath: referenceReviewPath(world.meta.worldId, take.reference.sheetId, take.kind) }
          : {}),
      });
    }
    for (const production of world.productions) {
      const decided = new Set(production.reviews.map((r) => r.takeId));
      for (const take of production.takes) {
        if (decided.has(take.id)) continue; // unreviewed is the ABSENCE of a decision (SPEC-013 R-7)
        entries.push({
          urgency: 4,
          kind: "unreviewed-take",
          title: `take awaiting review · ${production.meta.title}`,
          detail: `${take.kind} for ${take.coversShots.join(", ")}`,
          at: take.completedAt ?? take.dispatchedAt,
          worldId: world.meta.worldId,
          actions: ["review"],
          ref: take.id,
          // A take is decided where it was made (design 55): Review lands in the production's
          // Generate, on the contact-sheet lens when the take is a frame or a still.
          reviewPath: `/w/${world.meta.worldId}/p/${production.meta.id}/generate${
            take.kind === "frame" || take.kind === "still" ? "?view=stills" : ""
          }`,
        });
      }
    }
    // Class 5 — an extraction batch: ONE entry per artifact, granularity inside (SPEC-015 R-15, D5).
    for (const artifact of world.artifacts ?? []) {
      const pending = artifact.extraction?.pending.length ?? 0;
      if (pending === 0) continue;
      entries.push({
        urgency: 5,
        kind: "extraction-batch",
        title: `${pending} extracted fact${pending === 1 ? "" : "s"} from ${artifact.file}`,
        detail:
          artifact.extraction!.droppedCount > 0
            ? `${artifact.extraction!.droppedCount} candidate${artifact.extraction!.droppedCount === 1 ? "" : "s"} dropped — quotes did not verify`
            : "each accepts or rejects on its own",
        at: artifact.created,
        worldId: world.meta.worldId,
        actions: ["review-extraction"],
        ref: artifact.id,
      });
    }
    // Class 5 — work in progress, waiting but costing nothing.
    for (const staged of world.proposals) {
      entries.push({
        urgency: 5,
        kind: "open-proposal",
        title: staged.proposal.summary,
        detail: `proposal · ${staged.proposal.kind}`,
        at: staged.proposal.created,
        worldId: world.meta.worldId,
        actions: ["open-proposal"],
        ref: staged.proposal.id,
      });
    }
  }

  // Closed worlds: counts from the registry, as-of labelled, opening makes them precise (R-7).
  for (const summary of state.worlds) {
    if (world && summary.worldId === world.meta.worldId) continue;
    const attention = summary.attention;
    if (!attention || (attention.unreviewedTakes === 0 && attention.openProposals === 0)) continue;
    const bits: string[] = [];
    if (attention.unreviewedTakes > 0) bits.push(`${attention.unreviewedTakes} unreviewed take${attention.unreviewedTakes === 1 ? "" : "s"}`);
    if (attention.openProposals > 0) bits.push(`${attention.openProposals} open proposal${attention.openProposals === 1 ? "" : "s"}`);
    entries.push({
      urgency: attention.unreviewedTakes > 0 ? 4 : 5,
      kind: "closed-world-attention",
      title: `${summary.name} · ${bits.join(" · ")}`,
      detail: "a count, not a list — open the world for the items",
      at: attention.asOf,
      worldId: summary.worldId,
      actions: ["open-world"],
      asOf: attention.asOf,
    });
  }

  // Class before recency (R-5, D2) — otherwise it is a feed, not a queue.
  return entries.sort((a, b) => a.urgency - b.urgency || b.at.localeCompare(a.at));
}

// ---------------------------------------------------------------------------
// Running (R-2, D6, D7): everything long enough to be worth watching
// ---------------------------------------------------------------------------

export interface RunningEntry {
  kind: "job" | "model-download" | "export";
  title: string;
  detail: string;
  /** 0..100 where known; null where the work reports none. */
  percent: number | null;
  ref: string;
  worldId?: string;
  /** Cancellable now? (R-13: only what the state permits.) */
  cancellable: boolean;
}

const RUNNING_JOB = new Set(["queued", "submitting", "running"]);

export function computeRunning(
  state: ClientState,
  extras: {
    sidecar?: { state: string; detail: string } | null;
    exports?: Record<string, { productionId: string; status: string; percent: number }>;
  } = {},
): RunningEntry[] {
  const entries: RunningEntry[] = [];
  for (const job of state.app.jobs) {
    const finalizing = job.status === "succeeded" && job.finalization?.status === "pending";
    if (!RUNNING_JOB.has(job.status) && !finalizing) continue;
    entries.push({
      kind: "job",
      title: `${job.model} · ${job.target.kind}${job.target.id !== undefined ? ` ${job.target.id}` : ""}`,
      detail: finalizing ? `${job.provider} · generated · preparing result` : `${job.provider} · ${job.status}`,
      percent: null,
      ref: job.id,
      worldId: job.worldId,
      cancellable: !finalizing,
    });
  }
  if (extras.sidecar?.state === "downloading") {
    entries.push({
      kind: "model-download",
      title: "local voice model",
      detail: extras.sidecar.detail, // "downloading kokoro — 40 of 92 MB": beside generations (D6)
      percent: null,
      ref: "voxa-download",
      cancellable: false,
    });
  }
  for (const [id, e] of Object.entries(extras.exports ?? {})) {
    if (e.status !== "running") continue;
    entries.push({
      kind: "export",
      title: `export · ${e.productionId}`,
      detail: "rendering locally",
      percent: e.percent,
      ref: id,
      cancellable: true,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Actions per state (R-13, D10): never offered when the state cannot perform it
// ---------------------------------------------------------------------------

export type JobAction = "watch" | "cancel" | "retry" | "resolve" | "delete";

/**
 * Whether the user may drop this job from Activity's history. Terminal only — work still in
 * flight is cancelled, not deleted — and never while finalization is pending or failed, because
 * a pending one is still working and a failed one is a class-1 needs-you item with a retry on it.
 * Deleting either would remove an entry the user still has a decision to make about (D1, D10).
 */
export function canDeleteJob(job: Job): boolean {
  if (job.status !== "succeeded" && job.status !== "failed" && job.status !== "cancelled") return false;
  return job.finalization?.status !== "pending" && job.finalization?.status !== "failed";
}

export function jobActions(job: Job): JobAction[] {
  switch (job.status) {
    case "queued":
    case "submitting":
      return ["cancel"];
    case "running":
      return ["watch", "cancel"];
    case "failed":
      return canDeleteJob(job) ? ["retry", "delete"] : ["retry"];
    case "needs-reconciliation":
      return ["resolve"];
    case "succeeded":
    case "cancelled":
      // A cancel on a completed job is the small dishonesty (D10); a delete is not — the work is
      // over, and the row is the user's own history to keep or drop.
      return canDeleteJob(job) ? ["delete"] : [];
  }
}

/** The surface a job was dispatched from: where to go, and what that place is called. */
export interface JobOrigin {
  path: string;
  /** The destination as a button says it — a place, not an instruction. */
  label: string;
  /** The same place inside a sentence, where "Looks" would read as a stray proper noun. */
  where: string;
}

/**
 * Reference work is dispatched from a sheet's own screens, one per kind — the screen that owns
 * the dialog, not the sheet's overview, because a retry means opening that dialog again.
 */
const REFERENCE_ORIGINS: Record<string, Omit<JobOrigin, "path"> & { segment: string }> = {
  "main-photo-candidate": { segment: "main-photo", label: "Main photo", where: "the main photo screen" },
  "character-sheet": { segment: "model-sheet", label: "Character sheet", where: "the character sheet screen" },
  "character-look": { segment: "looks", label: "Looks", where: "the looks screen" },
  "location-view-candidate": { segment: "reference", label: "Location views", where: "the location's reference tab" },
  "reference-tile": { segment: "kit", label: "Reference kit", where: "the reference kit" },
  "establish-candidate": { segment: "kit", label: "Reference kit", where: "the reference kit" },
  "voice-preview": { segment: "voice", label: "Voice", where: "the voice screen" },
};

/**
 * Where a failed job can be run again from (issue 226).
 *
 * Activity printed one line under every failure — "retry from its production's dispatch dialog"
 * — and character looks, character sheets and main photos belong to no production and have no
 * such dialog. The only instruction on the row pointed at a screen that does not exist for that
 * job, so a failed look was a dead end: the character's own page reads `0 productions`.
 *
 * Null is the honest answer where the origin cannot be named from the job alone, and the row
 * then says that a retry costs again and leaves it there, rather than sending someone
 * somewhere wrong.
 */
export function jobOrigin(job: Job): JobOrigin | null {
  if (job.target.kind === "voice-preview" && job.params["purpose"] === "bible-section") {
    return { path: `/w/${job.worldId}/bible`, label: "Bible", where: "the bible" };
  }
  const reference = REFERENCE_ORIGINS[job.target.kind];
  if (reference) {
    // Every reference target id is the sheet's slug followed by whatever distinguishes this
    // one request from its siblings — the generation key, the candidate number, the voice.
    const sheetId = job.target.id?.split("/")[0] ?? "";
    if (sheetId.length === 0) return null;
    // Reading a sheet's Essence or Appearance aloud is queued as a voice preview too, but it
    // did not start in the voice picker and cannot be re-run there: that screen auditions and
    // assigns voices, and has no way to ask for this paragraph again. The sheet does.
    if (job.target.kind === "voice-preview" && job.params["purpose"] === "sheet-section") {
      return { path: `/w/${job.worldId}/cast/${sheetId}`, label: "Character", where: "the character's own page" };
    }
    const { segment, label, where } = reference;
    return { path: `/w/${job.worldId}/cast/${sheetId}/${segment}`, label, where };
  }
  if (job.target.kind === "world-image") {
    return { path: `/w/${job.worldId}`, label: "World", where: "the world's own screen" };
  }
  // A bench take's target id is "<sessionId>/<takeId>", so the origin is the exact session —
  // the durable route is how a particular session is reopened at all (issue 305 §1).
  if (job.target.kind === "bench-take") {
    const sessionId = job.target.id?.split("/")[0] ?? "";
    if (sessionId.length === 0) return null;
    return { path: `/w/${job.worldId}/artifacts/bench/${sessionId}`, label: "Bench", where: "its bench session" };
  }
  // Shots, scene passes, storyboards and lines are the production's. A line is the exception
  // among them: it has its own dialog, and the shot dispatch dialog carries no dialogue or
  // delivery controls, so sending a failed line there would be the same dead end again.
  if (job.productionId !== undefined) {
    const line = job.target.kind === "voice-line";
    return {
      path: `/w/${job.worldId}/p/${job.productionId}/generate/${line ? "voice-line" : "dispatch"}`,
      label: line ? "Voice line" : "Dispatch",
      where: line ? "its production's voice-line dialog" : "its production's dispatch dialog",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Spend (R-8, R-10, R-12, D8, D9)
// ---------------------------------------------------------------------------

export interface SpendSummary {
  periodDays: number;
  totalMicroUsd: number;
  /** True when the total mixes provider-reported and derived figures (R-10, D8). */
  mixed: boolean;
  reportedEntries: number;
  derivedEntries: number;
  /** Unmetered runs: counted, never $0.00 line items (R-12, D9). */
  unmeteredRuns: number;
  byProvider: Array<{ provider: string; microUsd: number; entries: number; unmetered: boolean }>;
}

export function spendSummary(ledger: LedgerEntry[], periodDays: number, now: Date): SpendSummary {
  const cutoff = now.getTime() - periodDays * 24 * 60 * 60 * 1000;
  const inWindow = ledger.filter((e) => Date.parse(e.ts) >= cutoff);
  const byProvider = new Map<string, { microUsd: number; entries: number; unmetered: boolean }>();
  let total = 0;
  let reported = 0;
  let derived = 0;
  let unmetered = 0;
  for (const entry of inWindow) {
    const local = (PROVIDERS as Record<string, { local: boolean } | undefined>)[entry.provider]?.local === true;
    if (entry.actualSource === "local-zero" || local) {
      unmetered += 1;
      const row = byProvider.get(entry.provider) ?? { microUsd: 0, entries: 0, unmetered: true };
      row.entries += 1;
      byProvider.set(entry.provider, row);
      continue;
    }
    const amount = entry.actualMicroUsd ?? entry.estimatedMicroUsd;
    total += amount;
    if (entry.actualSource === "provider-reported") reported += 1;
    else derived += 1;
    const row = byProvider.get(entry.provider) ?? { microUsd: 0, entries: 0, unmetered: false };
    row.microUsd += amount;
    row.entries += 1;
    byProvider.set(entry.provider, row);
  }
  return {
    periodDays,
    totalMicroUsd: total,
    mixed: reported > 0 && derived > 0,
    reportedEntries: reported,
    derivedEntries: derived,
    unmeteredRuns: unmetered,
    byProvider: [...byProvider.entries()]
      .map(([provider, row]) => ({ provider, ...row }))
      .sort((a, b) => b.microUsd - a.microUsd),
  };
}
