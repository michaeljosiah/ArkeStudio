import type { FoundingBuildState, Job, ModelManifest } from "@arke-studio/contracts";
import { humanNumber, usd } from "../lib/format.js";
import type { QueueEnqueueResult } from "../lib/store.js";

/**
 * What the notification after a dispatch says (design turn 79). The Activity row arriving early:
 * a dot, the target named target-then-kind, and one mono line of `model · cost`.
 *
 * The path is deliberately absent. The user pressed the button on the surface that owns the work,
 * so repeating "The Undersong · Bell Watch · ep 3" tells them where they are standing; the title
 * localises it and Activity holds the rest (79's second binding).
 */

export type NoteTone = "queued" | "warning" | "refused" | "back";

export interface QueueNote {
  /** Stable across the job's life, so `running` and `came back` update the row rather than stack. */
  id: string;
  tone: NoteTone;
  /** Pulses while something is actually running. */
  live?: boolean;
  title: string;
  /** `model · cost`, plus `· N queued` only when something is ahead of it. Never wraps. */
  meta: string;
  /** A refusal's third line, and the only band allowed to wrap. */
  reason?: string;
  /** Where the fix is — not always Activity, and absent when nothing queued. */
  action?: { label: string; to: string };
  /**
   * The thing that came back, world-relative, when it is a picture. Stands where the dot would be
   * (79g). Resolving it to a URL needs the world slug, which only the open world has, so the
   * renderer falls back to the dot rather than the path being wrong.
   */
  thumb?: { worldId: string; path: string };
}

const PICTURE = /\.(png|jpe?g|webp|gif)$/i;

/** What is being made, as a plain noun. Unknown kinds humanise their own slug. */
const NOUN: Record<string, [one: string, many: string]> = {
  shot: ["clip", "clips"],
  "scene-pass": ["shot", "shots"],
  storyboard: ["panel", "panels"],
  "character-sheet": ["character sheet", "character sheets"],
  "character-look": ["look", "looks"],
  "main-photo-candidate": ["main photo", "main photos"],
  "establish-candidate": ["reference", "references"],
  "reference-tile": ["reference", "references"],
  "location-view-candidate": ["location view", "location views"],
  "voice-line": ["voice line", "voice lines"],
  "voice-preview": ["voice preview", "voice previews"],
  "bench-take": ["take", "takes"],
  "world-image": ["world image", "world images"],
  "master-look": ["master look", "master looks"],
};

/** A commanded batch that never reaches a job — the enqueue was refused before one existed. */
const COMMAND_NOUN: Record<string, [one: string, many: string]> = {
  "dispatch-scene": ["shot", "shots"],
  "generate-main-photo": ["main photo", "main photos"],
  "generate-character-looks": ["look", "looks"],
  "generate-character-sheet": ["character sheet", "character sheets"],
  "generate-missing-tiles": ["reference", "references"],
  "regenerate-tile": ["reference", "references"],
  "establish-look": ["reference", "references"],
};

/**
 * Uploads never reach the queue: nothing was enqueued and nothing spends, so an Activity button
 * would send the user to a screen with no row on it (the existing `inActivity: false` case).
 */
const NEVER_QUEUES = new Set(["upload-master-look", "upload-world-image", "upload-artifacts", "pick-staged-reference"]);

function noun(kind: string, count: number): string {
  const pair = NOUN[kind];
  if (pair) return count === 1 ? pair[0] : pair[1];
  const words = kind.replaceAll("-", " ");
  return count === 1 ? words : `${words}s`;
}

function commandNoun(command: string, count: number): string {
  const pair = COMMAND_NOUN[command];
  if (pair) return count === 1 ? pair[0] : pair[1];
  return count === 1 ? "generation" : "generations";
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/**
 * A prefixed opaque id — `sess_01M0649N4RH2WC7QN50JXX9P7R`, `tk_…`. Title-casing one produces
 * `Sess_01M0649N4RH2WC7QN50JXX9P7R, take running`, which is worse than saying nothing: it fills
 * the one line the reader scans with an identifier they cannot use. Witnessed on a real bench
 * dispatch. Kept distinct from `sh_12`/`sc_04`, which are short and are names a person uses.
 */
const OPAQUE_ID = /^[a-z]+_[0-9A-HJKMNP-TV-Z]{20,}$/i;

/**
 * What the work belongs to, said the way the rest of the app says it. `params.characterName` when
 * the enqueue recorded one, otherwise the first segment of the target id — `sh_12` is Shot 12 and
 * `maren-kest/g1` is Maren Kest. A ULID names a world, which the title never needs.
 */
export function subjectOf(job: Job): string | null {
  const named = job.params["characterName"];
  if (typeof named === "string" && named.trim()) return named.trim();
  const head = job.target.id?.split("/")[0];
  if (!head || ULID.test(head) || OPAQUE_ID.test(head)) return null;
  if (/^sh_\d+$/.test(head)) return humanNumber(head, "Shot");
  if (/^sc_\d+$/.test(head)) return humanNumber(head, "Scene");
  if (/^\d+$/.test(head)) return null;
  return head
    .split("-")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * The title says what happened, in one word at the end: `Shot 2, clip queued`. Without the verb
 * the notification names a thing and some figures and never states its own purpose — read cold,
 * `Shot 2, clip / Seedance 2.0 · ~$1.82` could be a status readout rather than a receipt. The verb
 * costs one word and buys the whole sentence, and it replaces the count the meta line used to
 * carry, so the notification gets shorter rather than longer.
 */
function title(subject: string | null, what: string, verb: string): string {
  const said = `${what} ${verb}`;
  if (!subject) return said[0]!.toUpperCase() + said.slice(1);
  return `${subject}, ${said}`;
}

/** The manifest's own name for the row, so the notification and the picker agree. */
function modelName(job: Job, manifest: ModelManifest | null): string {
  const row = manifest?.models.find((m) => m.id === job.model && m.provider === job.provider);
  return row?.displayName ?? job.model;
}

/**
 * A tilde marks an estimate, as 68c has it; a bare figure is money already spent. A batch states
 * its total, because that is the figure the surface quoted — four shots at $1.37 dispatched from
 * a button reading $5.46 must not come back saying $1.37.
 */
function money(jobs: readonly Job[], spent: boolean): string {
  const total = jobs.reduce((sum, job) => sum + job.estimatedMicroUsd, 0);
  if (total === 0) return "local";
  return spent ? usd(total) : `~${usd(total)}`;
}

/**
 * What the batch belongs to, but only when every job in it agrees — four looks are all Maren
 * Kest's, while four separately dispatched shots have four different subjects and the notification
 * says so by naming none of them.
 */
function sharedSubject(jobs: readonly Job[]): string | null {
  if (jobs.length === 0) return null;
  const first = subjectOf(jobs[0]!);
  return jobs.every((job) => subjectOf(job) === first) ? first : null;
}

const AHEAD_OF = new Set(["queued", "submitting"]);

/**
 * How many non-terminal jobs sit in front of this one; 0 once it is the one running. The rest of
 * its own batch never counts — four shots dispatched together are one press, and telling the user
 * three things are "ahead" of their own dispatch is noise dressed as information.
 */
function ahead(job: Job, jobs: readonly Job[], batch: ReadonlySet<string>): number {
  return jobs.filter(
    (other) =>
      other.id !== job.id &&
      !batch.has(other.id) &&
      other.deletedAt === undefined &&
      AHEAD_OF.has(other.status) &&
      other.createdAt <= job.createdAt,
  ).length;
}

/**
 * The only thing the figures line still says about time. The state itself is the title's verb and
 * the count is the title's number, so this is left with the one fact neither of them carries:
 * whether the user is waiting behind anything.
 */
function pace(job: Job, jobs: readonly Job[], batch: ReadonlySet<string>): string | null {
  if (job.status === "running" || job.status === "submitting") return null;
  const n = ahead(job, jobs, batch);
  return n > 0 ? `${n} ahead` : null;
}

/** What happened, in one word — the same vocabulary Activity's rows use. */
function verbOf(job: Job | undefined): string {
  if (!job) return "queued";
  if (job.status === "running" || job.status === "submitting") return "running";
  if (job.status === "succeeded") return "ready";
  if (job.status === "failed" || job.status === "needs-reconciliation") return "failed";
  return "queued";
}

/** Distinct reasons, joined — the provider's own words, never a paraphrase. */
function reasonOf(result: QueueEnqueueResult): string | undefined {
  const seen = result.failures
    .map((f) => f.reason)
    .filter((reason, i, all) => all.indexOf(reason) === i);
  return seen.length > 0 ? seen.join(" ") : undefined;
}

/**
 * A credential refusal is fixed in Providers, not in Activity — the action names where the fix is
 * rather than always pointing at the ledger of what failed.
 */
const CREDENTIAL = /\b(key|credential|unauthori[sz]ed|401|403)\b/i;

function refusalAction(reason: string | undefined): QueueNote["action"] {
  if (reason && CREDENTIAL.test(reason)) return { label: "Providers", to: "/settings/providers" };
  return { label: "Activity", to: "/activity" };
}

/**
 * The notification for one enqueue answer. `jobs` is the client's own job list — every id in
 * `acceptedJobIds` resolves against it, which is where the model, the estimate and the queue
 * depth come from. No new event is needed.
 */
export function enqueueNote(
  result: QueueEnqueueResult,
  jobs: readonly Job[],
  manifest: ModelManifest | null,
): QueueNote | null {
  if (result.disposition === "not-queued") return null;

  const accepted = result.acceptedJobIds
    .map((id) => jobs.find((job) => job.id === id))
    .filter((job): job is Job => job !== undefined);
  const first = accepted[0];
  const count = result.acceptedJobIds.length;

  if (result.disposition === "accepted" || result.disposition === "partial") {
    const partial = result.disposition === "partial";
    // Without the job records there is still an honest thing to say: the count and the command's
    // own noun. This is the shape a reconnect leaves behind, not an error.
    const what = first
      ? `${partial || count > 1 ? `${count}${partial ? ` of ${result.requestedCount}` : ""} ` : ""}${noun(first.target.kind, count)}`
      : `${count} ${commandNoun(result.command, count)}`;
    const meta = first
      ? [modelName(first, manifest), money(accepted, false), pace(first, jobs, new Set(result.acceptedJobIds))]
          .filter((part): part is string => part !== null)
          .join(" · ")
      : "nothing to price yet";
    return {
      id: `queue:${result.requestId}`,
      tone: partial ? "warning" : "queued",
      ...(first && (first.status === "running" || first.status === "submitting") ? { live: true } : {}),
      title: title(sharedSubject(accepted), what, verbOf(first)),
      meta,
      ...(partial && reasonOf(result) ? { reason: reasonOf(result)! } : {}),
      action: { label: "Activity", to: "/activity" },
    };
  }

  const reason = reasonOf(result);
  if (NEVER_QUEUES.has(result.command)) {
    return {
      id: `queue:${result.requestId}`,
      tone: "refused",
      title: "That image can’t be used",
      meta: "nothing spent",
      ...(reason ? { reason } : {}),
    };
  }
  return {
    id: `queue:${result.requestId}`,
    tone: "refused",
    title: "Nothing was queued",
    meta: "nothing spent",
    ...(reason ? { reason } : {}),
    action: refusalAction(reason),
  };
}

/**
 * The same row once the work came back: the actual spend rather than an estimate, and the way to
 * the thing itself. Carries the enqueue's id when there is one, so it updates that row in place
 * instead of arriving beside it to contradict it.
 */
export function readyNote(
  job: Job,
  manifest: ModelManifest | null,
  noteId: string | undefined,
): QueueNote {
  const subject = subjectOf(job);
  const to =
    job.target.kind === "character-sheet" && job.target.id
      ? `/w/${job.worldId}/cast/${job.target.id.split("/")[0]}/kit`
      : "/activity";
  const landed = job.landedFiles?.find((file) => PICTURE.test(file));
  return {
    id: noteId ?? `job:${job.id}`,
    tone: "back",
    title: title(subject, noun(job.target.kind, 1), "ready"),
    meta: [modelName(job, manifest), money([job], true)].join(" · "),
    action: { label: to === "/activity" ? "Activity" : "View", to },
    ...(landed ? { thumb: { worldId: job.worldId, path: landed } } : {}),
  };
}

/**
 * The founding build's completion notice (SPEC-031 §1.9). The same shape as every other
 * note — a title, a reason, one call to action — but never a toast: the build's last moments
 * are exactly when the author is least likely to be watching, so it persists on the world
 * until dismissed or the work it names is no longer outstanding (R-45). A count and a cause,
 * once — fifteen failures from one dead credential is one sentence (R-46). It informs and
 * points; Activity acts (R-47): no retry, no accept, no discard.
 */
export function foundingNote(build: FoundingBuildState): QueueNote | null {
  if (build.status === "running" || build.shortfall === null || build.noticeDismissed) return null;
  const { count, cause } = build.shortfall;
  return {
    id: `build:${build.buildId}`,
    tone: "warning",
    title: `${count} item${count === 1 ? "" : "s"} from the founding build did not land`,
    meta: build.status === "stopped" ? "stopped by you" : "the world is open and usable",
    reason: cause,
    action: { label: "Activity", to: "/activity" },
  };
}

/** A job that failed after it was queued: Activity is exactly where it can be retried. */
export function failedNote(
  job: Job,
  manifest: ModelManifest | null,
  noteId: string | undefined,
): QueueNote {
  return {
    id: noteId ?? `job:${job.id}`,
    tone: "refused",
    title: title(subjectOf(job), noun(job.target.kind, 1), "failed"),
    meta: [modelName(job, manifest), job.status === "failed" ? "not charged" : "held"].join(" · "),
    ...(job.error ? { reason: job.error } : {}),
    action: { label: "Activity", to: "/activity" },
  };
}
