import { z } from "zod";
import type { ManifestModel, ModelManifest } from "./manifest.js";
import type { ProviderPlans } from "./settings.js";
import type { Job, LedgerEntry } from "./job.js";
import { formatMicroUsd } from "./money.js";
import { legacyVoiceModel, narratorAppliesTo, supportsVoiceUse } from "./voice.js";
import { estimateSpeechMicroUsd } from "./speech-pricing.js";
import { splitSpeechInput } from "./speech-input.js";

/**
 * A provider's Free plan (design turn 182): what the author's Plan row means for a read.
 *
 * No provider says through its API which plan a key is on, so the plan is the author's
 * statement, and the coordinator stamps it onto the manifest it serves — `speechPlan` on the
 * rows it covers — so every quote, confirmation, digest and price label reads one answer
 * wherever the manifest is read. Voice only: a key's other capabilities stay priced.
 */

/** The speech rows each plan covers. Google's voice design is priced regardless (it reads none of this). */
export const FREE_PLAN_SPEECH_MODELS = {
  google: ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"],
  mistral: ["voxtral-mini-tts"],
} as const;

/** Mistral's Free plan: this much API credit a month (read 2026-10-02). */
export const MISTRAL_FREE_CREDIT_MICRO_USD = 10_000_000;

export type SpeechPlan = NonNullable<ManifestModel["speechPlan"]>;

/** The plan a row reads under, or undefined for paid. A billed Google key reads priced until the author says Free again. */
export function speechPlanFor(plans: ProviderPlans, provider: string, modelId: string): SpeechPlan | undefined {
  if (provider === "google" && plans.google === "free" && plans.googleBilledAt === null
    && (FREE_PLAN_SPEECH_MODELS.google as readonly string[]).includes(modelId)) return "free-plan";
  if (provider === "mistral" && plans.mistral === "free-credit"
    && (FREE_PLAN_SPEECH_MODELS.mistral as readonly string[]).includes(modelId)) return "free-credit";
  return undefined;
}

/**
 * The manifest as the author's plans price it. Returns the same object when no plan applies, so
 * an all-paid installation serves exactly the manifest it shipped with.
 */
export function applyProviderPlans(manifest: ModelManifest, plans: ProviderPlans): ModelManifest {
  let changed = false;
  const models = manifest.models.map((model) => {
    const plan = model.capability === "voice-tts" ? speechPlanFor(plans, model.provider, model.id) : undefined;
    if (plan === model.speechPlan) return model;
    changed = true;
    const { speechPlan: _previous, ...rest } = model;
    return plan === undefined ? rest : { ...rest, speechPlan: plan };
  });
  return changed ? { ...manifest, models } : manifest;
}

/**
 * Whether a read at this price asks before it spends. A read that costs nothing asks nothing,
 * everywhere (SPEC-012 R-47, SPEC-047 R-17); a read drawn from the author's free credit keeps
 * its estimate and asks nothing while it fits in what is left of the month's credit. Past that
 * it asks, as a priced read does: Mistral bills the rest when pay-as-you-go is on, and Arke
 * cannot see whether it is (owner, 2026-10-02). Rows that are not found ask whenever there is
 * a price. `creditLeftMicroUsd` omitted means the credit is not known to be short.
 */
export function speechAsks(model: Pick<ManifestModel, "speechPlan"> | null | undefined, microUsd: number, creditLeftMicroUsd = Infinity): boolean {
  return microUsd > 0 && (model?.speechPlan !== "free-credit" || microUsd > creditLeftMicroUsd);
}

/**
 * What a set of reads would draw from the free credit: the sum of the prices of those whose
 * row is on it. A chapter or a book is weighed whole against the credit left, so reads that
 * each fit cannot together run past it unasked.
 */
export function freeCreditDraw(reads: Iterable<{ model: Pick<ManifestModel, "speechPlan"> | null | undefined; microUsd: number }>): number {
  let draw = 0;
  for (const read of reads) if (read.model?.speechPlan === "free-credit") draw += read.microUsd;
  return draw;
}

/** Whether a draw on the free credit runs past what is left of it this month. */
export function freeCreditOverrun(drawMicroUsd: number, creditLeftMicroUsd: number): boolean {
  return drawMicroUsd > 0 && drawMicroUsd > creditLeftMicroUsd;
}

/**
 * Whether the app narrator, as it resolves in this world, reads a reply without asking (design
 * turn 183): what decides whether a chat offers Read replies, which reads every reply as it
 * lands and so must never be the way a priced voice spends unasked.
 *
 * The shipped local voice reads for nothing, and so does any narrator that falls to it — no
 * choice, a choice that cannot narrate, or a clone chosen in another world. A local runtime is
 * unmetered. A Free plan key reads free; a free credit reads free while there is any left this
 * month. Everything else asks: a priced reader, a cloned voice through a hosted reader (its
 * recording is asked about before every read, issue 1215), and a choice the manifest does not
 * list, because the screen cannot see what it would cost — the coordinator still asks before it
 * spends, so a wrong "no" here costs a toggle, never money.
 *
 * With `text`, the question is about that one read: a free credit with room for something but
 * not for this reply would ask (codex on PR 1473), so an automatic read weighs the reply's own
 * estimate against what is left rather than only whether anything is.
 */
export function narratorReadsUnasked(
  stored: { provider: string; model?: string; voiceId: string; worldId?: string } | null,
  worldId: string | undefined,
  models: readonly ManifestModel[],
  creditLeftMicroUsd: number,
  text?: string,
  /** What is left of a model's free day (`freePlanAllowance(...).left`); absent is not known to be short. */
  freePlanLeft?: (model: string) => number,
): boolean {
  if (stored === null || !supportsVoiceUse(stored, "narration") || !narratorAppliesTo(stored, worldId)) return true;
  if (stored.provider === "kokoro") return true;
  const modelId = stored.model ?? legacyVoiceModel(stored.provider, stored.voiceId);
  const model = models.find((candidate) => candidate.provider === stored.provider && candidate.id === modelId);
  if (model === undefined) return false;
  if (model.pricing.kind === "unmetered") return true;
  if (stored.worldId !== undefined) return false;
  // A reply read on a free day with nothing left would put the day's question in front of the
  // author unasked, or meet Google's refusal; it is left for Listen. The toggle itself stays:
  // the day comes back at the reset, and the author's choice should come back with it.
  // Weighed in requests, as the read will be made (codex on PR 1475): a reply in two pieces with
  // one request left would ask.
  if (model.speechPlan === "free-plan") {
    if (text === undefined) return true;
    try {
      const requests = model.limits.maxSpeechUtf8Bytes !== undefined ? splitSpeechInput(text, model.limits).length : 1;
      return requests <= (freePlanLeft?.(model.id) ?? Infinity);
    } catch {
      return false;
    }
  }
  if (model.speechPlan !== "free-credit" || creditLeftMicroUsd <= 0) return false;
  if (text === undefined) return true;
  try {
    return !speechAsks(model, estimateSpeechMicroUsd(model, text), creditLeftMicroUsd);
  } catch {
    // A reply the reader cannot price is one it would ask about, not one it reads unasked.
    return false;
  }
}

/** What a reader says where the price was: `free plan` or `free credit`, or null when it is priced. */
export function speechPlanLabel(model: Pick<ManifestModel, "speechPlan"> | null | undefined): string | null {
  return model?.speechPlan === "free-plan" ? "free plan" : model?.speechPlan === "free-credit" ? "free credit" : null;
}

/**
 * A read's price as a screen shows it: the plan's name where the price was, for a free plan or
 * a free credit (design turn 182), else the price — `~` for a token reader's estimate, which
 * the read can pass (SPEC-049 R-6).
 */
export function speechPriceCopy(model: Pick<ManifestModel, "speechPlan" | "pricing"> | null | undefined, microUsd: number, creditLeftMicroUsd = Infinity): string {
  const priced = `${model?.pricing.kind === "perToken" ? "~" : ""}${formatMicroUsd(microUsd)}`;
  // Past the month's credit the read is priced again, and says so where the plan's name was.
  if (model?.speechPlan === "free-credit" && microUsd > creditLeftMicroUsd) return `${priced} · past free credit`;
  return speechPlanLabel(model) ?? priced;
}

/*
 * The two ways a free plan ends, as a read's failure says them. The provider client writes these
 * words into the error; a reader recognises them by their opening, so a free limit is never
 * mistaken for a generic failure and a billed read never for a free one.
 */
export const GOOGLE_FREE_LIMIT = "Google free limit reached";
export const GOOGLE_BILLED = "Google billed this read";

export type FreePlanStop = { kind: "free-limit"; provider: "google"; resetsAt: string; limit?: number } | { kind: "billed"; provider: "google" };

/**
 * What Google said of a daily limit it refused for, as a failure carries it after the opening:
 * ` · 10 a day · resets 2026-10-03T00:00:28.000Z`. The reset is an instant, not the "retry in
 * 45m28s" Google wrote, because the failure is read again long after it was written; a reader
 * that finds neither falls back to midnight Pacific.
 */
export function freeLimitDetail(detail: { limit?: number | undefined; resetsAt?: string | undefined }): string {
  return `${detail.limit !== undefined ? ` · ${detail.limit} a day` : ""}${detail.resetsAt !== undefined ? ` · resets ${detail.resetsAt}` : ""}`;
}

/** Recognise a read's failure as the end of a free plan, with when a daily limit resets. */
export function freePlanStop(error: string | null | undefined, now: Date = new Date()): FreePlanStop | null {
  if (typeof error !== "string") return null;
  if (error.includes(GOOGLE_FREE_LIMIT)) {
    const reset = /resets (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(error)?.[1];
    const limit = /(\d+) a day/.exec(error)?.[1];
    // A reset already past (an old failure read again) rolls to the next midnight, as every
    // failure without one does, rather than counting down to nothing forever.
    const named = reset !== undefined ? Date.parse(reset) : NaN;
    return { kind: "free-limit", provider: "google",
      resetsAt: Number.isFinite(named) && named > now.getTime() ? new Date(named).toISOString() : nextPacificMidnight(now).toISOString(),
      ...(limit !== undefined ? { limit: Number(limit) } : {}) };
  }
  if (error.includes(GOOGLE_BILLED)) return { kind: "billed", provider: "google" };
  return null;
}

/**
 * A free plan's end as a read's failure says it, without the provider's other words: the limit
 * with what Google said of it, or the billed key; else null.
 */
export function freePlanFailure(error: string | null | undefined): string | null {
  const stop = freePlanStop(error);
  if (stop === null) return null;
  if (stop.kind === "billed") return `${GOOGLE_BILLED} · key looks paid`;
  // The reset rides only where Google named one: a failure that said nothing keeps saying the
  // opening alone, and every reader still falls back to midnight Pacific for it.
  // Carried as written, never re-read against the clock: the failure is passed on, not judged.
  const named = typeof error === "string" ? /resets (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(error)?.[1] : undefined;
  return `${GOOGLE_FREE_LIMIT}${freeLimitDetail({ limit: stop.limit, resetsAt: named })}`;
}

/**
 * Requests a day on Google's free tier, per speech model (design turn 182 follow-up). No Google
 * API reports what is left of a day, so a read is weighed against this before it starts. Flash
 * TTS is what Google's own 429 said on 2026-10-02 — "limit: 10 requests per day on Free Tier"
 * for gemini-3.8-flash-tts. Flash-Lite's figure was not observed; it is given Flash's, the
 * conservative reading, until a refusal says otherwise (an observed limit always wins).
 */
export const GOOGLE_FREE_DAILY_REQUESTS: Readonly<Record<string, number>> = {
  "gemini-3.8-flash-tts": 10,
  "gemini-3.8-flash-lite-tts": 10,
};

/** What a free tier's refusal told Arke: the model's daily limit and when it resets. Kept by the queue until the reset. */
export interface FreePlanLimit {
  provider: string;
  model: string;
  limit?: number;
  resetsAt: string;
  observedAt: string;
}

/** A model's free day as Arke can know it: requests allowed, left (Infinity for a model with no known limit), when the day resets, and whether Google has said it is used up. */
export interface FreePlanAllowance {
  model: string;
  allowed: number;
  left: number;
  resetsAt: string;
  /** Google refused for the day and the reset it named has not come: nothing is sent until it does. */
  reached: boolean;
}

/**
 * What is left of a model's free day. The day starts at the last midnight Pacific, when Google
 * resets the free quota — or at a reset Google itself named, when that is later: on 2026-10-02
 * a refusal at 23:14 UTC said "retry in 45m28s", which is not midnight Pacific, and what Google
 * said is the better evidence. The requests counted are the free-plan reads the ledger holds
 * since then that Google took — succeeded, or answered with usage; a refused request has no
 * usage and is not counted. Reads made from another machine on the same key are invisible here,
 * which is why a refusal outranks the count. `pending` is the free-plan reads queued and not yet
 * settled (codex on PR 1475): they have no ledger line, and two page reads pressed together
 * would each otherwise see the whole day.
 */
export function freePlanAllowance(ledger: readonly LedgerEntry[], model: string, now: Date = new Date(), observed?: FreePlanLimit | null, pending = 0): FreePlanAllowance {
  // A model with no known figure is not weighed: inventing a limit would ask before every read.
  const allowed = observed?.limit ?? GOOGLE_FREE_DAILY_REQUESTS[model] ?? Infinity;
  const observedReset = observed ? Date.parse(observed.resetsAt) : NaN;
  if (Number.isFinite(observedReset) && observedReset > now.getTime()) {
    return { model, allowed, left: 0, resetsAt: new Date(observedReset).toISOString(), reached: true };
  }
  const next = nextPacificMidnight(now);
  let start = lastPacificMidnight(now).getTime();
  if (Number.isFinite(observedReset) && observedReset > start) start = observedReset;
  let used = 0;
  for (const entry of ledger) {
    if (entry.provider !== "google" || entry.model !== model || entry.speechQuote?.plan !== "free-plan") continue;
    if (Date.parse(entry.ts) < start) continue;
    const taken = entry.outcome === "succeeded" || entry.speechUsage !== undefined;
    // A retried read keeps its earlier answered attempts beside the last one (codex on PR 1475);
    // each was a request. Where the last is itself archived this counts one over, the safe side.
    used += (taken ? 1 : 0) + (entry.speechAttempts?.length ?? 0);
  }
  return { model, allowed, left: Math.max(0, allowed - used - pending), resetsAt: next.toISOString(), reached: false };
}

/** A read the free day cannot cover: how many requests it needs, against what the day allows and has left. Carried on the read's question. */
export const FreePlanShortSchema = z
  .object({ requests: z.number().int().min(1), allowed: z.number().int().min(0), left: z.number().int().min(0) })
  .strict();
export type FreePlanShort = z.infer<typeof FreePlanShortSchema>;

/**
 * Weigh a read's requests on free-plan rows against each model's free day, whole: a chapter or a
 * page is one question, so reads that each fit cannot together run past the day unasked. Returns
 * the first model the read would run short on, with its allowance, or null when every one fits.
 */
export function freePlanShortfall(
  reads: Iterable<{ model: Pick<ManifestModel, "id" | "speechPlan"> | null | undefined; requests: number }>,
  allowance: (model: string) => FreePlanAllowance,
): { short: FreePlanShort; allowance: FreePlanAllowance } | null {
  const needed = new Map<string, number>();
  for (const read of reads) {
    if (read.model?.speechPlan !== "free-plan" || read.requests <= 0) continue;
    needed.set(read.model.id, (needed.get(read.model.id) ?? 0) + read.requests);
  }
  // A model Google has already refused for the day comes first: that read is refused outright,
  // and asking about another model's shortfall would send it to meet the queue's refusal.
  let short: { short: FreePlanShort; allowance: FreePlanAllowance } | null = null;
  for (const [model, requests] of needed) {
    const day = allowance(model);
    if (requests <= day.left) continue;
    if (day.reached) return { short: { requests, allowed: day.allowed, left: day.left }, allowance: day };
    short ??= { short: { requests, allowed: day.allowed, left: day.left }, allowance: day };
  }
  return short;
}

/**
 * Whether a job on screen says Google refused this model's free day and the day has not reset
 * (codex on PR 1475): the queue's memory of the refusal is the coordinator's, but the refused
 * job is in every window's list, so a screen deciding to read unasked can see it too. A reset
 * the failure named decides; without one, a refusal since the last midnight Pacific does.
 */
export function freeDayRefused(jobs: readonly Pick<Job, "provider" | "model" | "status" | "error" | "updatedAt">[], model: string, now: Date = new Date()): boolean {
  const since = lastPacificMidnight(now).getTime();
  return jobs.some((job) => {
    if (job.provider !== "google" || job.model !== model || job.status !== "failed" || !job.error?.includes(GOOGLE_FREE_LIMIT)) return false;
    const named = /resets (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(job.error)?.[1];
    return named !== undefined ? Date.parse(named) > now.getTime() : Date.parse(job.updatedAt) >= since;
  });
}

/** A free day already used up, as a read's failure says it, so the free-limit stop and its remedy show. */
export function freeLimitReason(allowance: Pick<FreePlanAllowance, "allowed" | "resetsAt">): string {
  return `${GOOGLE_FREE_LIMIT}${freeLimitDetail({ limit: Number.isFinite(allowance.allowed) && allowance.allowed > 0 ? allowance.allowed : undefined, resetsAt: allowance.resetsAt })}`;
}

/**
 * The question a read past the free day asks, in the confirm the free credit's overrun already
 * uses: `122 reads · free plan allows 10 a day`, answered `Read until the limit`.
 *
 * The answer names no count (codex on PR 1475): the read is not capped at what Arke counts left —
 * that is an estimate, Flash-Lite's figure a guess, and another machine's reads invisible — but
 * goes until Google itself refuses, and stops there keeping what it made. `Read 10 now` would
 * promise ten and could read more, or fewer.
 */
export function freePlanAskCopy(short: FreePlanShort): { line: string; confirm: string } {
  return {
    line: `${short.requests} read${short.requests === 1 ? "" : "s"} · free plan allows ${short.allowed} a day${short.left < short.allowed ? ` · ${short.left} left` : ""}`,
    confirm: "Read until the limit",
  };
}

/** A free plan's end as one line of text, with when a daily limit resets; null for any other reason. */
export function freePlanNote(reason: string | null | undefined, now: Date = new Date()): string | null {
  const stop = freePlanStop(reason, now);
  return stop === null ? null : stop.kind === "free-limit" ? freeLimitLine(stop, now) : `${GOOGLE_BILLED} · key looks paid`;
}

/**
 * The next midnight in Pacific time, when Google's free daily quota resets. Computed through
 * the platform's time zone data, so daylight saving moves it the hour it really moves.
 */
export function nextPacificMidnight(now: Date): Date {
  const day = pacificDay(now);
  return new Date(pacificMidnightOf(day.year, day.month, day.day + 1));
}

/** The midnight Pacific that began today's free day: the other end of `nextPacificMidnight`. */
export function lastPacificMidnight(now: Date): Date {
  const day = pacificDay(now);
  return new Date(pacificMidnightOf(day.year, day.month, day.day));
}

const PACIFIC_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function pacificDay(at: Date): { year: number; month: number; day: number } {
  const parts = PACIFIC_PARTS.formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: part("year"), month: part("month"), day: part("day") };
}

/** The Pacific wall clock at an instant, read as if it were UTC, less the instant: the zone's offset then. */
function pacificOffset(at: number): number {
  const parts = PACIFIC_PARTS.formatToParts(new Date(at));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour") % 24, part("minute"), part("second")) - Math.floor(at / 1000) * 1000;
}

/**
 * 00:00 Pacific on a calendar day (the day may overflow its month), with the offset in force at
 * that midnight rather than now's (codex on PR 1475): an answer computed the evening before a
 * daylight-saving switch was an hour off, and the day's start computed the morning after one a
 * whole day off. Two passes: the first lands within the hour, the second on the midnight itself.
 * Pacific switches at 02:00, so midnight always exists and is never doubled.
 */
function pacificMidnightOf(year: number, month: number, day: number): number {
  const wall = Date.UTC(year, month - 1, day, 0, 0, 0);
  const near = wall - pacificOffset(wall);
  return wall - pacificOffset(near);
}

/** `5 h 12 m` — the time left before a reset, labels only. */
export function formatTimeLeft(from: Date, to: Date): string {
  const minutes = Math.max(0, Math.ceil((to.getTime() - from.getTime()) / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} m` : `${minutes} m`;
}

/** `17:00` — an instant on the Pacific clock Google's free quota keeps. */
export function pacificClock(at: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(at);
}

/**
 * After the opening, what a free limit says: `10 a day · resets 00:00 PT · 5 h 12 m`. The reset
 * is the one Google named when it named one — `resets 17:00 PT` for the 2026-10-02 refusal —
 * so the clock and the countdown never disagree.
 */
export function freeLimitTail(stop: Extract<FreePlanStop, { kind: "free-limit" }>, now: Date = new Date()): string {
  const resets = new Date(stop.resetsAt);
  return `${stop.limit !== undefined ? `${stop.limit} a day · ` : ""}resets ${pacificClock(resets)} PT · ${formatTimeLeft(now, resets)}`;
}

/** The line a free limit shows: `Google free limit reached · resets 00:00 PT · 5 h 12 m`. */
export function freeLimitLine(stop: Extract<FreePlanStop, { kind: "free-limit" }>, now: Date = new Date()): string {
  return `${GOOGLE_FREE_LIMIT} · ${freeLimitTail(stop, now)}`;
}

/**
 * What the month's free credit has drawn (design turn 182): the Mistral pane's "This month".
 * The calendar month as this machine keeps it — the reader's month, not the ledger's UTC.
 */
export function freeCreditThisMonth(ledger: readonly LedgerEntry[], provider: string, now: Date = new Date()): { microUsd: number; characters: number; reads: number } {
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let microUsd = 0;
  let characters = 0;
  let reads = 0;
  for (const entry of ledger) {
    if (entry.provider !== provider || entry.actualSource !== "free-credit" || Date.parse(entry.ts) < start) continue;
    microUsd += entry.actualMicroUsd ?? entry.estimatedMicroUsd;
    characters += entry.speechQuote?.quantities.characters ?? 0;
    reads += 1;
  }
  return { microUsd, characters, reads };
}

/** What is left of the month's Mistral free credit, never below zero. */
export function freeCreditLeft(ledger: readonly LedgerEntry[], now: Date = new Date()): number {
  return Math.max(0, MISTRAL_FREE_CREDIT_MICRO_USD - freeCreditThisMonth(ledger, "mistral", now).microUsd);
}

/**
 * A table read's door names the plan instead of a price when every line it would send goes on a
 * free plan or credit (design turn 182); null when any line is priced, or none is sent.
 */
export function tableReadPlanNote(
  plan: { items: readonly { route: string; provider?: string; model?: string }[] } | null | undefined,
  models: readonly Pick<ManifestModel, "id" | "provider" | "speechPlan">[],
): string | null {
  const cloud = (plan?.items ?? []).filter((item) => item.route === "cloud");
  if (cloud.length === 0) return null;
  const labels = new Set(cloud.map((item) => speechPlanLabel(models.find((model) => model.id === item.model && (item.provider === undefined || model.provider === item.provider)))));
  if (labels.has(null)) return null;
  return labels.has("free credit") ? "free credit" : "free plan";
}

/** `214k`, `4.1k`, `980` — a count as a mono label shows it. */
export function compactCount(value: number): string {
  if (value < 1000) return String(value);
  const thousands = value / 1000;
  return `${thousands < 10 ? (Math.round(thousands * 10) / 10).toString() : Math.round(thousands).toString()}k`;
}
