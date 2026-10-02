import type { ManifestModel, ModelManifest } from "./manifest.js";
import type { ProviderPlans } from "./settings.js";
import type { LedgerEntry } from "./job.js";
import { formatMicroUsd } from "./money.js";
import { legacyVoiceModel, narratorAppliesTo, supportsVoiceUse } from "./voice.js";
import { estimateSpeechMicroUsd } from "./speech-pricing.js";

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
): boolean {
  if (stored === null || !supportsVoiceUse(stored, "narration") || !narratorAppliesTo(stored, worldId)) return true;
  if (stored.provider === "kokoro") return true;
  const modelId = stored.model ?? legacyVoiceModel(stored.provider, stored.voiceId);
  const model = models.find((candidate) => candidate.provider === stored.provider && candidate.id === modelId);
  if (model === undefined) return false;
  if (model.pricing.kind === "unmetered") return true;
  if (stored.worldId !== undefined) return false;
  if (model.speechPlan === "free-plan") return true;
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
 * a free credit (design turn 182), else the price — `up to` for a token ceiling.
 */
export function speechPriceCopy(model: Pick<ManifestModel, "speechPlan" | "pricing"> | null | undefined, microUsd: number, creditLeftMicroUsd = Infinity): string {
  const priced = `${model?.pricing.kind === "perToken" ? "up to " : ""}${formatMicroUsd(microUsd)}`;
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

export type FreePlanStop = { kind: "free-limit"; provider: "google"; resetsAt: string } | { kind: "billed"; provider: "google" };

/** Recognise a read's failure as the end of a free plan, with when a daily limit resets. */
export function freePlanStop(error: string | null | undefined, now: Date = new Date()): FreePlanStop | null {
  if (typeof error !== "string") return null;
  if (error.includes(GOOGLE_FREE_LIMIT)) return { kind: "free-limit", provider: "google", resetsAt: nextPacificMidnight(now).toISOString() };
  if (error.includes(GOOGLE_BILLED)) return { kind: "billed", provider: "google" };
  return null;
}

/** A free plan's end as a read's failure says it, without the provider's detail: the limit, or the billed key; else null. */
export function freePlanFailure(error: string | null | undefined): string | null {
  const stop = freePlanStop(error);
  return stop === null ? null : stop.kind === "free-limit" ? GOOGLE_FREE_LIMIT : `${GOOGLE_BILLED} · key looks paid`;
}

/** A free plan's end as one line of text, with the time left for a daily limit; null for any other reason. */
export function freePlanNote(reason: string | null | undefined, now: Date = new Date()): string | null {
  const stop = freePlanStop(reason, now);
  return stop === null ? null : stop.kind === "free-limit" ? freeLimitLine(stop, now) : `${GOOGLE_BILLED} · key looks paid`;
}

/**
 * The next midnight in Pacific time, when Google's free daily quota resets. Computed through
 * the platform's time zone data, so daylight saving moves it the hour it really moves.
 */
export function nextPacificMidnight(now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Pacific wall-clock now, read as if it were UTC, gives the zone's offset from the real instant.
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour") % 24, part("minute"), part("second"));
  const offset = wall - Math.floor(now.getTime() / 1000) * 1000;
  const midnight = Date.UTC(part("year"), part("month") - 1, part("day") + 1, 0, 0, 0) - offset;
  // An offset that changes between now and midnight (the DST switch happens at 02:00, after
  // midnight) cannot move this; the guard only keeps the answer in the future.
  return new Date(midnight > now.getTime() ? midnight : midnight + 24 * 60 * 60 * 1000);
}

/** `5 h 12 m` — the time left before a reset, labels only. */
export function formatTimeLeft(from: Date, to: Date): string {
  const minutes = Math.max(0, Math.ceil((to.getTime() - from.getTime()) / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} m` : `${minutes} m`;
}

/** The line a free limit shows: `Google free limit reached · resets 00:00 PT · 5 h 12 m`. */
export function freeLimitLine(stop: Extract<FreePlanStop, { kind: "free-limit" }>, now: Date = new Date()): string {
  return `${GOOGLE_FREE_LIMIT} · resets 00:00 PT · ${formatTimeLeft(now, new Date(stop.resetsAt))}`;
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
