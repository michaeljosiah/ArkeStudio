import { copyFile, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ART_DIRECTION_PATH,
  BuildJournalEntrySchema,
  BuildReviewSchema,
  buildItemDispatches,
  FoundingBuildRecordSchema,
  characterBriefProse,
  compileBuildItems,
  foldFoundingBuild,
  imageConstraintSuffix,
  keyArtBriefSettled,
  locationBriefProse,
  newId,
  ulid,
  type AppSettings,
  type BuildItem,
  type BuildJournalEntry,
  type BuildJobFacts,
  type BuildReview,
  type DomainEvent,
  type FoundingBuildRecord,
  type FoundingBuildState,
  type GenesisBlueprint,
  type Job,
  type LedgerEntry,
  type ManifestModel,
  type ModelManifest,
  type QueueStatus,
  type Sheet,
} from "@arke-studio/contracts";
import type { EnqueueInput } from "../queue/dispatcher.js";
import type { ProposalManager } from "../gate/proposals.js";
import type { WorldStore } from "./store.js";
import { atomicWriteFile } from "./atomic.js";
import { fromPortable, toExtendedLength } from "./paths.js";
import { foldBlueprint } from "../harness/blueprint.js";
import { openThread } from "../canon/authoring.js";
import { createSheetFromSentence } from "../sheets/authoring.js";
import {
  characterSheetRequest,
  imageModelFor,
  locationViewRequests,
  mainPhotoRequests,
  referenceBudgetFor,
} from "../references/generate.js";
import { acceptCharacterSheet, acceptLocationView, readKit } from "../references/kit.js";
import { acceptMainPhoto } from "../references/main-photo.js";
import { LOOK_PREVIEW_DIR, LOOK_PREVIEW_META, masterLookFile } from "../references/master-look.js";
import { adoptKeyArtCandidate } from "../references/key-art.js";
import { assembleKeyArt, keyArtComposition } from "../references/key-art-references.js";
import { pendingReferenceTake, recordReferenceTake, referenceReviewDecision } from "../references/takes.js";
import { KEY_ART_EXTENSIONS, WORLD_IMAGE_STEM, keyArtPrompt, worldImageRequest } from "../references/world-image.js";

/**
 * The founding build (SPEC-031): the blueprint folded, every precondition checked before the
 * screen, one immutable authorization record, and a run driven through five phases that
 * nothing but the author's Stop can halt. Everything lands settled; nothing arrives as a
 * decision. Recovery is a fold over the record and the journal — never a timer, never an
 * open screen.
 */

export const BUILD_DIR = "build";
export const BUILD_RECORD = "build.json";
export const BUILD_JOURNAL = "build.jsonl";
/** The sandbox marker that makes Begin idempotent across replays and resumes (R-16). */
const BEGUN_MARKER = "begun.json";

/** How often the driver re-reads a job it is waiting on when no push arrives. */
const WATCH_TICK_MS = 2_000;

export interface FoundingBuildPorts {
  nowIso(): string;
  manifest: ModelManifest | null;
  loadSettings(): Promise<AppSettings | null>;
  /** Null: no credential stored. The empty string is a provider whose key is not ours to hold. */
  credentialFor(provider: string): Promise<string | null>;
  harnessReady(): boolean;
  genesisDir(genesisId: string): Promise<string>;
  discardGenesis(genesisId: string): Promise<void>;
  releaseGenesis(genesisId: string): void;
  createWorld(input: {
    name: string;
    logline?: string;
    tone?: string;
    genre?: string;
    artDirection?: string;
    bible?: string;
  }): Promise<{ worldId: string }>;
  openWorld(worldId: string): Promise<void>;
  openStore(): WorldStore | null;
  gate(): ProposalManager | null;
  carryAttachments(genesisId: string, worldId: string): Promise<void>;
  /** Re-associate the conversation's jobs with the world it became (SPEC-031 R-55). */
  adoptScopedJobs(genesisId: string, worldId: string): Promise<void>;
  /** The conversation's own jobs, for the carry's provenance check (R-54). */
  scopedJobs(genesisId: string): Job[];
  /** Cancel the conversation's in-flight jobs — a preview mid-air at Begin is not waited for. */
  cancelScopedJobs(genesisId: string): Promise<void>;
  /** Author a staged sheet with the harness when it is ready; resolves when the draft landed. */
  authorSheet(
    store: WorldStore,
    gate: ProposalManager,
    input: { worldId: string; proposalId: string; path: string; scope: string; sheetType: string; name: string; seed: string },
  ): Promise<void>;
  enqueue(input: EnqueueInput): Promise<Job>;
  jobById(jobId: string): Job | undefined;
  /** The job's ledger row, when it has landed — a take should record what it actually cost. */
  ledgerEntryFor(jobId: string): Promise<LedgerEntry | undefined>;
  cancelJob(jobId: string): Promise<void>;
  queueStatuses(): QueueStatus[];
  refreshWorldSnapshot(worldId: string): Promise<void>;
  refreshWorldList(): Promise<void>;
  emit(event: DomainEvent): void;
  log(record: Record<string, unknown>): void;
}

/** Durable append with fsync — the journal is what recovery trusts (R-31). */
class BuildJournal {
  private chain: Promise<void> = Promise.resolve();
  constructor(readonly path: string) {}

  append(entry: BuildJournalEntry): Promise<void> {
    const validated = BuildJournalEntrySchema.parse(entry);
    const write = this.chain.then(async () => {
      await mkdir(toExtendedLength(dirname(this.path)), { recursive: true });
      const handle = await open(toExtendedLength(this.path), "a");
      try {
        await handle.appendFile(JSON.stringify(validated) + "\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.chain = write.catch(() => {});
    return write;
  }

  async read(): Promise<BuildJournalEntry[]> {
    let raw: string;
    try {
      raw = await readFile(toExtendedLength(this.path), "utf8");
    } catch {
      return [];
    }
    const entries: BuildJournalEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = BuildJournalEntrySchema.safeParse(JSON.parse(trimmed));
        if (parsed.success) entries.push(parsed.data);
      } catch {
        /* torn tail — recovery reads what is whole */
      }
    }
    return entries;
  }
}

interface ActiveBuild {
  record: FoundingBuildRecord;
  journal: BuildJournal;
  entries: BuildJournalEntry[];
  stopped: boolean;
  driving: boolean;
}

interface ImageRoute {
  model: ManifestModel;
  referenceImages: number;
}

export class FoundingBuildService {
  /** Builds this process knows about, keyed by worldId. */
  private readonly builds = new Map<string, ActiveBuild>();
  private readonly beginning = new Map<string, Promise<void>>();
  private readonly runningItems = new Map<string, Promise<void>>();
  /** Held-item rescues in flight, so one job's settle event lands once. */
  private readonly rescuing = new Set<string>();
  private readonly seenRunRequests = new Set<string>();
  /** Wakes the driver when a watched job settles, without waiting out the tick. */
  private readonly jobWakers = new Map<string, Set<() => void>>();

  constructor(private readonly ports: FoundingBuildPorts) {}

  // -------------------------------------------------------------------------
  // Preconditions and the review (R-10..R-12)
  // -------------------------------------------------------------------------

  /** The frozen image route, or null with the reasons a text-only build is offered (R-11). */
  private async resolveImageRoute(): Promise<{ route: ImageRoute | null; notes: string[] }> {
    const notes: string[] = [];
    const manifest = this.ports.manifest;
    if (!manifest) {
      notes.push("No model manifest is loaded — every file and sheet will be written, and no images will be made.");
      return { route: null, notes };
    }
    const model = imageModelFor(await this.ports.loadSettings(), manifest);
    if (!model) {
      notes.push(
        "No image model resolves — every file and sheet will be written, and no images will be made. The images stay runnable in one press once a provider is set up.",
      );
      return { route: null, notes };
    }
    const key = await this.ports.credentialFor(model.provider);
    if (key === null) {
      notes.push(
        `${model.displayName} resolved, but ${model.provider} has no credential — every file and sheet will be written, and no images will be made until one is added.`,
      );
      return { route: null, notes };
    }
    const referenceImages = referenceBudgetFor(model);
    if (referenceImages === 0) {
      // A model resolving is not a model being able to do the work (R-10): main photos and
      // establishing views will be made, and character sheets will not.
      notes.push(
        `${model.displayName} takes no reference images — main photos and establishing views will be made; character sheets will not.`,
      );
    }
    return { route: { model, referenceImages }, notes };
  }

  async plan(genesisId: string, requestId: string): Promise<void> {
    const refuse = (reason: string) =>
      this.ports.emit({
        at: this.ports.nowIso(),
        type: "build.plan",
        genesisId,
        requestId,
        plan: null,
        reason,
      });
    let blueprint: GenesisBlueprint;
    try {
      blueprint = await foldBlueprint(await this.ports.genesisDir(genesisId));
    } catch {
      refuse("the conversation's plan could not be read");
      return;
    }
    if (blueprint.name === undefined) {
      refuse("the world has no name yet — settle one in the conversation first");
      return;
    }
    const { route, notes } = await this.resolveImageRoute();
    if (!this.ports.harnessReady()) {
      notes.push("OpenCode is not running — sheets will hold their one-line summaries until authored later.");
    }
    if (!keyArtBriefSettled(blueprint.keyArt)) {
      // Named while it can still be answered, not invented from a logline (R-5, row 9a).
      notes.push("The world's one image was never settled — key art will not be made.");
    }
    if (blueprint.dropped.length > 0) {
      notes.push(
        `${blueprint.dropped.length} blueprint file${blueprint.dropped.length === 1 ? "" : "s"} could not be read and will not build: ${blueprint.dropped.join(", ")}`,
      );
    }
    const items = compileBuildItems(blueprint, route === null ? null : { model: route.model, referenceImages: route.referenceImages });
    const generations = items.filter((item) => item.authorized && item.idempotencyKey !== undefined).length;
    const estimateMicroUsd = items.filter((item) => item.authorized).reduce((sum, item) => sum + item.estimatedMicroUsd, 0);
    const plan: BuildReview = BuildReviewSchema.parse({
      genesisId,
      requestId,
      worldName: blueprint.name,
      counts: {
        characters: blueprint.characters.length,
        locations: blueprint.locations.length,
        factions: blueprint.factions.length,
        threads: blueprint.threads.length,
      },
      generations,
      estimateMicroUsd,
      imageModel: route?.model.displayName ?? null,
      notes,
      dropped: blueprint.dropped,
    });
    this.ports.emit({ at: this.ports.nowIso(), type: "build.plan", genesisId, requestId, plan });
  }

  // -------------------------------------------------------------------------
  // The press (R-13, R-16, R-17)
  // -------------------------------------------------------------------------

  async begin(genesisId: string, requestId: string, look?: string): Promise<void> {
    // Two presses in one tick are one run (row 8): the second joins the first's promise.
    const inFlight = this.beginning.get(genesisId);
    if (inFlight) return inFlight;
    const work = this.beginWork(genesisId, requestId, look).finally(() => this.beginning.delete(genesisId));
    this.beginning.set(genesisId, work);
    return work;
  }

  private async beginWork(genesisId: string, requestId: string, look?: string): Promise<void> {
    const sandbox = await this.ports.genesisDir(genesisId);
    const markerPath = join(sandbox, BEGUN_MARKER);
    const marker = await readFile(toExtendedLength(markerPath), "utf8")
      .then((raw) => JSON.parse(raw) as { worldId?: string })
      .catch(() => null);
    if (marker?.worldId !== undefined) {
      // A second press, a replayed frame or a resumed session joins the existing run (R-16).
      // A world builds once (R-37): there is no path here that builds it again. A marker
      // whose record never got written — the press died between the two — falls through and
      // finishes the founding against the world the marker names, rather than founding another.
      await this.ports.openWorld(marker.worldId);
      const store = this.ports.openStore();
      if (store && store.worldId === marker.worldId) {
        const known = await this.load(store.dir, marker.worldId);
        if (known) {
          await this.resume(marker.worldId);
          return;
        }
      }
    }

    const folded = await foldBlueprint(sandbox);
    // The look as the author left the words step (R-3): absent keeps the conversation's,
    // non-empty is their rewrite, the empty string is "Decide later" — founded with none.
    const effectiveLook = look === undefined ? folded.look : look.trim() === "" ? undefined : look.trim();
    const blueprint: GenesisBlueprint = {
      ...folded,
      ...(effectiveLook !== undefined ? { look: effectiveLook } : {}),
    };
    if (effectiveLook === undefined) delete (blueprint as { look?: string }).look;
    if (blueprint.name === undefined) {
      this.ports.emit({
        at: this.ports.nowIso(),
        type: "build.plan",
        genesisId,
        requestId,
        plan: null,
        reason: "the world has no name yet — settle one in the conversation first",
      });
      return;
    }
    const { route } = await this.resolveImageRoute();
    const items = compileBuildItems(
      blueprint,
      route === null ? null : { model: route.model, referenceImages: route.referenceImages },
    );
    const capMicroUsd = items.filter((item) => item.authorized).reduce((sum, item) => sum + item.estimatedMicroUsd, 0);

    // Wave 0 is the world itself: world.json, art direction v1 from the look the conversation
    // proposed, and the bible it wrote (R-18). The marker is written the moment the world's
    // identity exists and BEFORE the record — every window after that write re-enters the
    // same founding. One residual sliver remains, between createWorld resolving and the
    // marker landing; a crash exactly there can orphan one empty world (R-16, noted).
    let worldId = marker?.worldId;
    if (worldId === undefined) {
      const created = await this.ports.createWorld({
        name: blueprint.name,
        ...(blueprint.logline !== undefined ? { logline: blueprint.logline } : {}),
        ...(blueprint.tone !== undefined ? { tone: blueprint.tone.toLowerCase() } : {}),
        ...(blueprint.genre !== undefined ? { genre: blueprint.genre.toLowerCase() } : {}),
        ...(blueprint.look !== undefined ? { artDirection: blueprint.look } : {}),
        ...(blueprint.bible !== undefined ? { bible: blueprint.bible } : {}),
      });
      worldId = created.worldId;
      await atomicWriteFile(markerPath, JSON.stringify({ worldId, requestId }) + "\n");
    }
    await this.ports.openWorld(worldId);
    const store = this.ports.openStore();
    if (!store || store.worldId !== worldId) throw new Error("the new world did not open");

    const record: FoundingBuildRecord = FoundingBuildRecordSchema.parse({
      buildId: newId("fb"),
      requestId,
      worldId,
      genesisId,
      blueprint,
      artDirectionVersion: 1,
      capMicroUsd,
      image:
        route === null
          ? null
          : {
              provider: route.model.provider,
              model: route.model.id,
              displayName: route.model.displayName,
              referenceImages: route.referenceImages,
            },
      items,
      createdAt: this.ports.nowIso(),
    });
    await atomicWriteFile(join(store.dir, BUILD_DIR, BUILD_RECORD), JSON.stringify(record, null, 2) + "\n");

    const active: ActiveBuild = {
      record,
      journal: new BuildJournal(join(store.dir, BUILD_DIR, BUILD_JOURNAL)),
      entries: [],
      stopped: false,
      driving: false,
    };
    this.builds.set(worldId, active);
    this.publish(active);
    this.drive(active);
  }

  // -------------------------------------------------------------------------
  // Recovery (R-32..R-34)
  // -------------------------------------------------------------------------

  /** Load a world's build from disk into memory, when it has one. */
  async load(worldDir: string, worldId: string): Promise<ActiveBuild | null> {
    const known = this.builds.get(worldId);
    if (known) return known;
    let record: FoundingBuildRecord;
    try {
      const raw = await readFile(toExtendedLength(join(worldDir, BUILD_DIR, BUILD_RECORD)), "utf8");
      const parsed = FoundingBuildRecordSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return null;
      record = parsed.data;
    } catch {
      return null;
    }
    const journal = new BuildJournal(join(worldDir, BUILD_DIR, BUILD_JOURNAL));
    const active: ActiveBuild = {
      record,
      journal,
      entries: await journal.read(),
      stopped: false,
      driving: false,
    };
    active.stopped = active.entries.some((entry) => entry.kind === "stopped");
    this.builds.set(worldId, active);
    return active;
  }

  /**
   * Resume a run wherever the journal left it (R-33). A completed or stopped build still
   * reconciles anything in doubt — an Activity re-run cut off by a restart is work the
   * author paid for, and it lands here rather than showing "running" forever (R-34, R-49).
   */
  async resume(worldId: string): Promise<void> {
    const store = this.ports.openStore();
    if (!store || store.worldId !== worldId) return;
    const active = await this.load(store.dir, worldId);
    if (!active) return;
    this.publish(active);
    const state = this.fold(active);
    if (state.status === "running") {
      if (!active.driving) this.drive(active);
    } else {
      await this.reconcileInDoubt(active).catch(() => {});
    }
  }

  /**
   * Every item whose last journal word is an intent or an enqueue is in doubt (R-34): the
   * work may be running, landed, or dead. Reconcile against the queue by the journalled
   * job id — or re-enqueue the journalled idempotency key, which joins rather than re-buys —
   * and record the outcome. Never a timer, never a screen: this runs from resume and from
   * the driver's own first step.
   */
  private async reconcileInDoubt(active: ActiveBuild): Promise<void> {
    const lastByKey = new Map<string, BuildJournalEntry>();
    for (const entry of active.entries) {
      if (entry.kind === "intent" || entry.kind === "enqueued" || entry.kind === "terminal") {
        lastByKey.set(entry.key, entry);
      }
    }
    let settledAny = false;
    for (const [key, last] of lastByKey) {
      const item = active.record.items.find((candidate) => candidate.key === key);
      if (!item) continue;
      if (last.kind === "terminal") {
        // A held item is terminal for the build's purposes, not for the queue's (R-23): the
        // lane may have been resumed while this world was closed, and the paid result must
        // still land as the build would have landed it (R-49).
        if (last.outcome !== "held") continue;
        const enqueued = [...active.entries]
          .reverse()
          .find((entry): entry is Extract<BuildJournalEntry, { kind: "enqueued" }> => entry.kind === "enqueued" && entry.key === key);
        const job = enqueued ? this.ports.jobById(enqueued.jobId) : undefined;
        if (enqueued && (job?.status === "succeeded" || job?.status === "failed" || job?.status === "cancelled")) {
          await this.settleDispatched(active, item, enqueued.jobId).catch(() => {});
          settledAny = true;
        }
        continue;
      }
      if (item.kind === "world" || item.kind === "author-sheet" || item.kind === "thread" || item.kind === "finalize") {
        // Local work re-runs idempotently through the driver; an intent alone is enough.
        continue;
      }
      if (last.kind === "enqueued") {
        await this.settleDispatched(active, item, last.jobId).catch(() => {});
        settledAny = true;
        continue;
      }
      // An intent with a journalled key and no job id: the crash window between the append
      // and the enqueue. Re-enqueueing the same key joins the existing job when one was
      // made, and is the first dispatch when none was (row 22).
      const { route } = await this.resolveImageRoute();
      const jobId = await this.dispatchOne(active, item, route?.model ?? null).catch(() => null);
      await this.settleDispatched(active, item, jobId).catch(() => {});
      settledAny = true;
    }
    this.publish(active);
    // What recovery landed must reach the screen: the watcher suppresses app writes, so a
    // snapshot refresh is the only way the anchor becomes visible (P3, #494 review).
    if (settledAny) await this.ports.refreshWorldSnapshot(active.record.worldId).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Stop (R-35) and the notice (R-45)
  // -------------------------------------------------------------------------

  async stop(worldId: string): Promise<void> {
    const active = this.builds.get(worldId);
    if (!active || active.stopped) return;
    active.stopped = true;
    await this.append(active, { kind: "stopped", at: this.ports.nowIso() });
    // Cancellation of every build job that is not yet terminal is requested, best effort
    // (SPEC-009 R-14). A charge captured anyway is the ledger's to record, and it does.
    const state = this.fold(active);
    for (const item of state.items) {
      if (item.state === "running" && item.jobId !== undefined) {
        await this.ports.cancelJob(item.jobId).catch(() => {});
      }
    }
    this.wakeAll();
    this.publish(active);
  }

  async dismissNotice(worldId: string): Promise<void> {
    const active = this.builds.get(worldId);
    if (!active) return;
    await this.append(active, { kind: "notice-dismissed", at: this.ports.nowIso() });
    this.publish(active);
  }

  // -------------------------------------------------------------------------
  // Activity's path (R-48, R-49)
  // -------------------------------------------------------------------------

  /**
   * Run one item — or, with no key, everything runnable that has not landed — landing it
   * exactly as the build would have: settled, anchored, designated (R-49). Refused while
   * the run itself is going (its driver owns pending work, and two writers would race the
   * wave barrier and the authoring sessions), and serialized per world so a double press
   * joins rather than doubling.
   */
  async runItems(worldId: string, itemKey?: string, requestId?: string): Promise<void> {
    // A replayed frame is the same press, not a second spend (R-16's idempotency, applied here).
    if (requestId !== undefined) {
      if (this.seenRunRequests.has(requestId)) return;
      this.seenRunRequests.add(requestId);
      if (this.seenRunRequests.size > 200) {
        for (const old of this.seenRunRequests) {
          this.seenRunRequests.delete(old);
          if (this.seenRunRequests.size <= 100) break;
        }
      }
    }
    // Chained, not joined: a press naming a different item queues behind the one running
    // rather than being silently dropped.
    const work = (this.runningItems.get(worldId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.runItemsWork(worldId, itemKey));
    this.runningItems.set(worldId, work);
    void work.finally(() => {
      if (this.runningItems.get(worldId) === work) this.runningItems.delete(worldId);
    });
    return work;
  }

  private async runItemsWork(worldId: string, itemKey?: string): Promise<void> {
    const store = this.ports.openStore();
    if (!store || store.worldId !== worldId) return;
    const active = await this.load(store.dir, worldId);
    if (!active) return;
    let state = this.fold(active);
    if (state.status === "running" || active.driving) return;
    // Work a crash left mid-air settles first, with its journalled identity (R-34).
    await this.reconcileInDoubt(active).catch(() => {});
    state = this.fold(active);
    const runnable = new Set(["failed", "skipped", "unauthorized"]);
    const keys = state.items
      .filter((item) => (itemKey === undefined ? runnable.has(item.state) : item.key === itemKey))
      .map((item) => item.key);
    if (keys.length === 0) return;
    // An unauthorized item runs only when a route resolves NOW — the reason it was refused
    // may have been fixed, which is the whole point of the press (R-11).
    const { route } = await this.resolveImageRoute();
    for (const key of keys) {
      const item = active.record.items.find((candidate) => candidate.key === key);
      if (!item) continue;
      await this.runOne(active, item, route?.model ?? null).catch((err) => {
        this.ports.log({ kind: "build.item-failed", worldId, key, message: err instanceof Error ? err.message : String(err) });
      });
    }
    this.publish(active);
    await this.ports.refreshWorldSnapshot(worldId).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // The driver (R-17, R-18, R-23)
  // -------------------------------------------------------------------------

  /**
   * A job the coordinator saw settle — wakes any wait on it, and rescues a held item whose
   * lane the author resumed: the queue row's own action ran the work, and it must land as
   * the build would have landed it (R-23's promise, R-49's rule), not surface as a candidate
   * awaiting review. Without this, terminal `held` was forever: the notice could never clear
   * and paid work waited on a press that did not exist.
   */
  noteJobSettled(job: Job): void {
    const wakers = this.jobWakers.get(job.id);
    if (wakers) {
      for (const wake of wakers) wake();
      this.jobWakers.delete(job.id);
    }
    if (this.rescuing.has(job.id)) return;
    for (const active of this.builds.values()) {
      const enqueued = [...active.entries]
        .reverse()
        .find((entry): entry is Extract<BuildJournalEntry, { kind: "enqueued" }> => entry.kind === "enqueued" && entry.jobId === job.id);
      if (!enqueued) continue;
      const last = [...active.entries]
        .reverse()
        .find((entry) => (entry.kind === "intent" || entry.kind === "terminal") && entry.key === enqueued.key);
      if (last?.kind !== "terminal" || last.outcome !== "held") continue;
      const item = active.record.items.find((candidate) => candidate.key === enqueued.key);
      if (!item) continue;
      this.rescuing.add(job.id);
      void this.settleDispatched(active, item, job.id)
        .then(() => this.ports.refreshWorldSnapshot(active.record.worldId).catch(() => {}))
        .catch(() => {})
        .finally(() => this.rescuing.delete(job.id));
      return;
    }
  }

  private drive(active: ActiveBuild): void {
    if (active.driving) return;
    active.driving = true;
    void this.driveWork(active)
      .catch((err) => {
        this.ports.log({
          kind: "build.drive-failed",
          worldId: active.record.worldId,
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        active.driving = false;
      });
  }

  private async driveWork(active: ActiveBuild): Promise<void> {
    const { record } = active;
    // Anything a crash left in doubt settles first, with its journalled identity — never a
    // second dispatch for work the queue already has (R-34, rows 1 and 22).
    await this.reconcileInDoubt(active).catch(() => {});
    const model = await this.frozenModel(record);
    // The phases are the stages (R-39): one per wave boundary, and a wave does not begin
    // until every item in the wave before it is terminal (R-18).
    for (let stage = 1; stage <= 4; stage++) {
      if (this.parked(active)) return;
      if (active.stopped) break;
      const state = this.fold(active);
      const pending = record.items.filter((item) => {
        const folded = state.items.find((candidate) => candidate.key === item.key);
        return item.stage === stage && item.authorized && (folded?.state === "pending" || folded?.state === "running");
      });
      // Authoring before dispatch within the stage: a photo cites the sheet it is of, and
      // the sessions must not race token allocation, so sheets go one at a time.
      const order: Record<string, number> = { world: 0, "author-sheet": 1, thread: 2 };
      pending.sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3));
      const local = pending.filter((item) => item.idempotencyKey === undefined);
      const dispatched = pending.filter((item) => item.idempotencyKey !== undefined);
      for (const item of local) {
        if (this.parked(active)) return;
        if (active.stopped) break;
        await this.runOne(active, item, model).catch(() => {});
      }
      // Images fan out: every dispatch journalled before the next (R-31), the whole set
      // then watched to its end. No failure stops the run (R-23).
      const watched: Array<{ item: BuildItem; jobId: string | null }> = [];
      for (const item of dispatched) {
        if (this.parked(active)) return;
        if (active.stopped) break;
        const jobId = await this.dispatchOne(active, item, model).catch(() => null);
        watched.push({ item, jobId });
      }
      for (const { item, jobId } of watched) {
        if (this.parked(active)) return;
        await this.settleDispatched(active, item, jobId).catch(() => {});
      }
      this.publish(active);
    }
    if (!active.stopped && !active.entries.some((entry) => entry.kind === "completed")) {
      const state = this.fold(active);
      const unfinished = state.items.some(
        (item) => item.authorized && (item.state === "pending" || item.state === "running"),
      );
      // The run reaches the end of the last wave whatever failed along the way (R-23, R-24);
      // completion never claims a complete world — the shortfall in the fold carries what is
      // missing to the notice (R-36).
      if (!unfinished) {
        await this.append(active, { kind: "completed", at: this.ports.nowIso() });
      }
    }
    this.publish(active);
    await this.ports.refreshWorldSnapshot(record.worldId).catch(() => {});
    await this.ports.refreshWorldList().catch(() => {});
  }

  /** The driver runs only while its world is the open one; opening it again resumes (R-33). */
  private parked(active: ActiveBuild): boolean {
    const store = this.ports.openStore();
    return !store || store.worldId !== active.record.worldId;
  }

  private async frozenModel(record: FoundingBuildRecord): Promise<ManifestModel | null> {
    if (record.image === null || this.ports.manifest === null) return null;
    return (
      this.ports.manifest.models.find(
        (model) => model.id === record.image!.model && model.provider === record.image!.provider,
      ) ?? null
    );
  }

  // -------------------------------------------------------------------------
  // Item runners
  // -------------------------------------------------------------------------

  private async runOne(active: ActiveBuild, item: BuildItem, model: ManifestModel | null): Promise<void> {
    if (buildItemDispatches(item.kind)) {
      const jobId = await this.dispatchOne(active, item, model);
      await this.settleDispatched(active, item, jobId);
      return;
    }
    const store = this.ports.openStore();
    const gate = this.ports.gate();
    if (!store || store.worldId !== active.record.worldId || !gate) return;
    const already = this.fold(active).items.find((candidate) => candidate.key === item.key);
    if (already?.state === "landed") return;
    await this.append(active, { kind: "intent", key: item.key, at: this.ports.nowIso() });
    this.publish(active);
    try {
      let detail: string | undefined;
      switch (item.kind) {
        case "world":
          await this.runWorld(active);
          break;
        case "author-sheet":
          detail = await this.runAuthorSheet(active, item, store, gate);
          break;
        case "thread":
          await this.runThread(active, item, store, gate);
          break;
        case "finalize":
          await this.runFinalize(active);
          break;
        default:
          throw new Error(`${item.kind} is not a local item`);
      }
      await this.append(active, {
        kind: "terminal",
        key: item.key,
        outcome: "landed",
        ...(detail !== undefined ? { detail } : {}),
        at: this.ports.nowIso(),
      });
    } catch (err) {
      // The item fails alone; the run continues to the end (R-23).
      await this.append(active, {
        kind: "terminal",
        key: item.key,
        outcome: "failed",
        detail: err instanceof Error ? err.message : String(err),
        at: this.ports.nowIso(),
      });
    }
    this.publish(active);
  }

  private async runWorld(active: ActiveBuild): Promise<void> {
    // The world files were written by the press itself (they hold this record); what is left
    // is what the conversation was handed. Filing dedups by hash, so a crashed pass re-runs.
    await this.ports.carryAttachments(active.record.genesisId, active.record.worldId);
    // A preview still generating at Begin is cancelled, not waited for: its landing could
    // arrive after the sandbox sweep and resurrect the directory, and an image that was not
    // on disk when the author pressed is not an image the author approved (R-54).
    await this.ports.cancelScopedJobs(active.record.genesisId).catch(() => {});
    await this.carryLookPreview(active);
    // The conversation's own spend follows it into the world (SPEC-031 R-55): the preview's
    // job re-associates; its ledger entry keeps the scope the money was spent under, joinable
    // through this record's genesisId.
    await this.ports.adoptScopedJobs(active.record.genesisId, active.record.worldId).catch(() => {});
  }

  /**
   * A kept preview is not made twice (SPEC-031 R-54, D9, D11): the carried image becomes art
   * direction v1's master look — but ONLY when the look text it was generated from is the
   * look the world was founded on. A preview of rejected words is not carried: a wrong master
   * look is worse than none, because nothing downstream ever asks again.
   */
  private async carryLookPreview(active: ActiveBuild): Promise<void> {
    const store = this.ports.openStore();
    if (!store || store.worldId !== active.record.worldId) return;
    const foundedLook = active.record.blueprint.look;
    if (foundedLook === undefined) return;
    const sandbox = await this.ports.genesisDir(active.record.genesisId).catch(() => null);
    if (sandbox === null) return;
    let generatedFrom: string | undefined;
    try {
      const raw = await readFile(toExtendedLength(join(sandbox, LOOK_PREVIEW_DIR, LOOK_PREVIEW_META)), "utf8");
      generatedFrom = (JSON.parse(raw) as { look?: string }).look;
    } catch {
      return; // no preview was ever made — SPEC-017 R-2 treats a look with no image as ordinary
    }
    if (generatedFrom === undefined || generatedFrom.trim() !== foundedLook.trim()) return;
    // The image must be the one a SUCCEEDED preview job actually made of these words — the
    // sandbox is the agent's own working directory, and files alone cannot prove the author
    // pressed and approved anything (R-51, R-54). The job is the receipt: it exists only
    // through the pressed frame, and its lookText is what the picture was really made from.
    const receipts = this.ports
      .scopedJobs(active.record.genesisId)
      .filter((job) => job.target.kind === "look-preview")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latest = receipts[0];
    if (latest === undefined || latest.status !== "succeeded") return;
    if (typeof latest.params["lookText"] !== "string" || latest.params["lookText"].trim() !== foundedLook.trim()) {
      return;
    }
    // The landed name follows the bytes (FORMAT_PRESERVING_IMAGE_TARGETS), so the file is
    // whatever the job says it landed — and the carried copy keeps that extension.
    const landed = latest.landedFiles?.[0];
    if (landed === undefined) return;
    const image = join(sandbox, fromPortable(landed));
    if ((await stat(toExtendedLength(image)).catch(() => null))?.isFile() !== true) return;
    const extension = landed.slice(landed.lastIndexOf(".")).toLowerCase() || ".png";
    const destination = masterLookFile(active.record.artDirectionVersion, extension);
    await store.gateOp(async () => {
      await copyFile(toExtendedLength(image), toExtendedLength(join(store.dir, fromPortable(destination))));
      // Still v1, written before anything has read it: the record the world was founded
      // with simply gains the picture the author already approved in conversation.
      const recordPath = join(store.dir, fromPortable(ART_DIRECTION_PATH));
      const parsed = JSON.parse(await readFile(toExtendedLength(recordPath), "utf8")) as Record<string, unknown>;
      parsed["masterLook"] = destination;
      await atomicWriteFile(recordPath, JSON.stringify(parsed, null, 2) + "\n");
    });
    await this.ports.refreshWorldSnapshot(active.record.worldId).catch(() => {});
  }

  /** Returns a detail worth journalling — a sheet that stands on its seed because the agent failed. */
  private async runAuthorSheet(
    active: ActiveBuild,
    item: BuildItem,
    store: WorldStore,
    gate: ProposalManager,
  ): Promise<string | undefined> {
    const blueprint = active.record.blueprint;
    const entity =
      item.sheetType === "character"
        ? blueprint.characters.find((candidate) => candidate.slug === item.subject)
        : item.sheetType === "location"
          ? blueprint.locations.find((candidate) => candidate.slug === item.subject)
          : blueprint.factions.find((candidate) => candidate.slug === item.subject);
    if (!entity || item.sheetType === undefined) throw new Error("the blueprint no longer holds this entity");
    // Idempotent across recovery: a sheet that already exists under this name landed (R-34).
    const bundle = store.getBundle();
    if (bundle.sheets.some((sheet) => sheet.type === item.sheetType && sheet.name === entity.name)) {
      return undefined;
    }
    const seed = entity.line ?? entity.description ?? entity.name;
    const draft = await createSheetFromSentence(store, gate, {
      sheetType: item.sheetType,
      name: entity.name,
      sentence: seed,
    });
    this.ports.emit({
      at: this.ports.nowIso(),
      type: "proposal.staged",
      worldId: active.record.worldId,
      proposalId: draft.proposal.id,
    });
    let authoringNote: string | undefined;
    if (this.ports.harnessReady()) {
      const brief =
        item.sheetType === "character"
          ? characterBriefProse(blueprint.characters.find((c) => c.slug === item.subject)?.brief)
          : item.sheetType === "location"
            ? locationBriefProse(blueprint.locations.find((l) => l.slug === item.subject)?.brief)
            : "";
      const description = entity.description !== undefined ? `\n\nThe conversation settled: ${entity.description}` : "";
      const facts = brief !== "" ? `\n\nAppearance facts the conversation settled: ${brief}.` : "";
      // A drafting agent that dies must not take the sheet with it — the seed stands and is
      // settled below — but neither may it vanish silently: the detail rides the journal.
      authoringNote = await this.ports
        .authorSheet(store, gate, {
          worldId: active.record.worldId,
          proposalId: draft.proposal.id,
          path: draft.path,
          scope: draft.scope,
          sheetType: item.sheetType,
          name: entity.name,
          seed: `${seed}${description}${facts}`,
        })
        .then(
          () => undefined,
          (err: unknown) =>
            `authored from its one-line seed — the drafting agent failed (${err instanceof Error ? err.message : String(err)})`,
        );
    }
    // The gate is pre-authorized, not bypassed (§2.4): the proposal is accepted under the
    // press's authorization. A refusal discards it — nothing may rest in Needs you (R-25).
    const outcome = await gate.accept(draft.proposal.id).catch(() => null);
    if (outcome === null || outcome.status !== "accepted") {
      await gate.discard(draft.proposal.id).catch(() => {});
      throw new Error(`the ${item.sheetType} sheet could not be settled${outcome ? ` (${outcome.status})` : ""}`);
    }
    await this.ports.refreshWorldSnapshot(active.record.worldId).catch(() => {});
    return authoringNote;
  }

  private async runThread(
    active: ActiveBuild,
    item: BuildItem,
    store: WorldStore,
    gate: ProposalManager,
  ): Promise<void> {
    const index = Number(item.key.split(":")[1]) - 1;
    const question = active.record.blueprint.threads[index];
    if (question === undefined) throw new Error("the blueprint no longer holds this thread");
    const title = question.length > 80 ? `${question.slice(0, 77)}…` : question;
    // Idempotent across recovery: an open canon entry with this title landed already.
    if (store.getBundle().canon.some((entry) => entry.title === title)) return;
    await openThread(store, gate, { title, question, candidates: [] });
  }

  private async runFinalize(active: ActiveBuild): Promise<void> {
    // The sandbox goes with the conversation, and the world stands on its own (R-9): what
    // was carried was carried; abandoning nothing, deleting one directory.
    this.ports.releaseGenesis(active.record.genesisId);
    await this.ports.discardGenesis(active.record.genesisId).catch(() => {});
    await this.ports.refreshWorldSnapshot(active.record.worldId).catch(() => {});
    await this.ports.refreshWorldList().catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Image dispatch and landing (R-19..R-22, R-25..R-28)
  // -------------------------------------------------------------------------

  private async dispatchOne(active: ActiveBuild, item: BuildItem, model: ManifestModel | null): Promise<string | null> {
    const store = this.ports.openStore();
    if (!store || store.worldId !== active.record.worldId) return null;
    const state = this.fold(active);
    const folded = state.items.find((candidate) => candidate.key === item.key);
    if (folded?.state === "landed") return null;
    // Rejoin journalled work before anything is bought twice (R-34): the item's last
    // enqueued job, still alive or already succeeded, IS this item's work — a held photo
    // whose lane was resumed in Activity lands through its original job, never a second one.
    const lastEnqueued = [...active.entries]
      .reverse()
      .find((entry): entry is Extract<BuildJournalEntry, { kind: "enqueued" }> => entry.kind === "enqueued" && entry.key === item.key);
    if (lastEnqueued !== undefined) {
      const job = this.ports.jobById(lastEnqueued.jobId);
      if (job && job.status !== "failed" && job.status !== "cancelled") return lastEnqueued.jobId;
    }

    if (model === null) {
      await this.append(active, { kind: "intent", key: item.key, at: this.ports.nowIso() });
      await this.append(active, {
        kind: "terminal",
        key: item.key,
        outcome: "skipped",
        detail: "no image model resolves",
        at: this.ports.nowIso(),
      });
      return null;
    }
    // The cap bounds the run it authorized (R-15): work that would pass it is not dispatched.
    // A later press from Activity is its own authorization and is not bounded by it (R-48).
    if (state.status === "running") {
      const spent = state.items
        .filter(
          (candidate) =>
            candidate.key !== item.key &&
            candidate.state !== "pending" &&
            candidate.state !== "skipped" &&
            candidate.state !== "unauthorized",
        )
        .reduce((sum, candidate) => sum + candidate.estimatedMicroUsd, 0);
      if (spent + item.estimatedMicroUsd > active.record.capMicroUsd) {
        await this.append(active, { kind: "intent", key: item.key, at: this.ports.nowIso() });
        await this.append(active, {
          kind: "terminal",
          key: item.key,
          outcome: "skipped",
          detail: "the authorized cap was reached",
          at: this.ports.nowIso(),
        });
        return null;
      }
    }

    let input: EnqueueInput;
    try {
      input = await this.compileDispatch(active, item, store, model);
    } catch (err) {
      await this.append(active, { kind: "intent", key: item.key, at: this.ports.nowIso() });
      await this.append(active, {
        kind: "terminal",
        key: item.key,
        outcome: item.kind === "sheet-image" && err instanceof AnchorMissing ? "skipped" : "failed",
        detail: err instanceof Error ? err.message : String(err),
        at: this.ports.nowIso(),
      });
      return null;
    }
    // Every attempt's key is journalled in its intent BEFORE the enqueue, so no attempt's
    // crash window has anything to invent (R-31, R-34): an unsettled intent re-enqueues its
    // own key and joins whatever the queue already made of it. The first attempt uses the
    // record's pre-allocated key (SPEC-024 D2); a retry after a terminal outcome is new work
    // the author just authorized, so it mints fresh rather than joining the failure.
    const lastForKey = [...active.entries]
      .reverse()
      .find(
        (entry): entry is Extract<BuildJournalEntry, { kind: "intent" | "enqueued" | "terminal" }> =>
          (entry.kind === "intent" || entry.kind === "enqueued" || entry.kind === "terminal") &&
          entry.key === item.key,
      );
    let idempotencyKey: string;
    if (lastForKey?.kind === "intent" && lastForKey.idempotencyKey !== undefined) {
      idempotencyKey = lastForKey.idempotencyKey;
    } else {
      const retried = active.entries.some((entry) => entry.kind === "terminal" && entry.key === item.key);
      idempotencyKey = retried ? ulid() : (item.idempotencyKey ?? ulid());
      await this.append(active, { kind: "intent", key: item.key, idempotencyKey, at: this.ports.nowIso() });
    }
    this.publish(active);
    try {
      const job = await this.ports.enqueue({ ...input, idempotencyKey });
      await this.append(active, { kind: "enqueued", key: item.key, jobId: job.id, at: this.ports.nowIso() });
      // A stop that raced this dispatch still reaches the job (R-35): the sweep in stop()
      // saw no job id to cancel, so the request is made here instead.
      if (active.stopped) await this.ports.cancelJob(job.id).catch(() => {});
      this.publish(active);
      return job.id;
    } catch (err) {
      await this.append(active, {
        kind: "terminal",
        key: item.key,
        outcome: "failed",
        detail: err instanceof Error ? err.message : String(err),
        at: this.ports.nowIso(),
      });
      return null;
    }
  }

  /** The prompt compiled at dispatch from the brief, the look and the route (R-19). */
  private async compileDispatch(
    active: ActiveBuild,
    item: BuildItem,
    store: WorldStore,
    model: ManifestModel,
  ): Promise<EnqueueInput> {
    const bundle = store.getBundle();
    const blueprint = active.record.blueprint;
    const generationKey = active.record.buildId.slice(3, 11).toLowerCase();
    const sheetFor = (slug: string, type: string): Sheet => {
      const name =
        type === "character"
          ? blueprint.characters.find((c) => c.slug === slug)?.name
          : blueprint.locations.find((l) => l.slug === slug)?.name;
      const sheet = bundle.sheets.find((candidate) => candidate.type === type && candidate.name === name);
      if (!sheet) throw new Error(`the ${type} sheet for ${name ?? slug} is not in the world`);
      return sheet;
    };
    switch (item.kind) {
      case "main-photo": {
        const character = blueprint.characters.find((c) => c.slug === item.subject);
        const sheet = sheetFor(item.subject, "character");
        const kit = (await readKit(store, sheet.id))?.kit ?? null;
        const brief = characterBriefProse(character?.brief);
        const [request] = mainPhotoRequests(bundle.meta, bundle.artDirection, sheet, kit, model, {
          prompt: brief !== "" ? brief : "A first portrait, true to the sheet",
          // Generated, not chosen (R-21): one photo, which lands as the anchor.
          count: 1,
          identityReferences: [],
          generationKey,
        });
        if (!request) throw new Error("no main-photo request was built");
        return request.input;
      }
      case "establishing-view": {
        const location = blueprint.locations.find((l) => l.slug === item.subject);
        const sheet = sheetFor(item.subject, "location");
        const kit = (await readKit(store, sheet.id))?.kit ?? null;
        const brief = locationBriefProse(location?.brief);
        const [request] = locationViewRequests(bundle.meta, bundle.artDirection, sheet, kit, model, {
          name: "Establishing",
          ...(brief !== "" ? { prompt: brief } : {}),
          count: 1,
          generationKey,
        });
        if (!request) throw new Error("no establishing-view request was built");
        return request.input;
      }
      case "sheet-image": {
        const sheet = sheetFor(item.subject, "character");
        const kit = (await readKit(store, sheet.id))?.kit ?? null;
        if (!kit || (kit.mainPhoto?.file ?? kit.anchor) === undefined) {
          // Skip, not wait, not ask (R-22) — key art still runs with the anchors that landed.
          throw new AnchorMissing(`${sheet.name}'s main photo did not land, so the character sheet was not made`);
        }
        const request = characterSheetRequest(bundle.meta, bundle.artDirection, sheet, kit, model, generationKey);
        return request.input;
      }
      case "key-art": {
        if (!keyArtBriefSettled(blueprint.keyArt)) throw new Error("the key-art brief was never settled");
        const brief = blueprint.keyArt!;
        // The same assembly Regenerate uses (R-62): the cast's landed anchors ride as
        // identity references, a named character whose anchor failed is dropped and named,
        // and with no anchors at all the picture is still made from the lore and the look.
        const assembly = await assembleKeyArt(store, bundle, brief, model);
        if (assembly.dropped.length > 0) {
          this.ports.log({
            kind: "build.key-art-references-dropped",
            worldId: active.record.worldId,
            dropped: assembly.dropped,
          });
        }
        const cast = assembly.carried
          .filter((reference) => reference.role === "identity")
          .map((reference) => reference.name);
        const request = worldImageRequest(bundle.meta, model, bundle.artDirection, { index: 0, count: 1 }, assembly.referenceRoles, {
          provenance: {
            canonRevision: bundle.meta.canonRevision,
            artDirectionVersion: bundle.artDirection.version,
            sheets: assembly.sheets,
          },
          dropped: assembly.dropped,
        });
        const words = keyArtPrompt({
          composed: `${keyArtComposition({
            meta: bundle.meta,
            direction: bundle.artDirection,
            bible: blueprint.bible ?? "",
            brief,
            cast,
          })}${imageConstraintSuffix(bundle.artDirection)}`,
          description: bundle.artDirection.description,
          suffix: imageConstraintSuffix(bundle.artDirection),
        });
        return { ...request, params: { ...request.params, prompt: words } };
      }
      default:
        throw new Error(`${item.kind} does not dispatch`);
    }
  }

  /** Wait a dispatched item to a build-terminal state, then land it (R-23, R-25). */
  private async settleDispatched(active: ActiveBuild, item: BuildItem, jobId: string | null): Promise<void> {
    if (jobId === null) return;
    const outcome = await this.watchJob(active, jobId);
    if (outcome === "parked") return;
    if (outcome === "succeeded") {
      try {
        await this.landItem(active, item, jobId);
        await this.append(active, { kind: "terminal", key: item.key, outcome: "landed", at: this.ports.nowIso() });
      } catch (err) {
        await this.append(active, {
          kind: "terminal",
          key: item.key,
          outcome: "failed",
          detail: err instanceof Error ? err.message : String(err),
          at: this.ports.nowIso(),
        });
      }
    } else if (outcome === "held") {
      // A queue state whose exit is a human action does not hold a build (R-23): terminal
      // for the build's purposes, the job left where Activity can resume it.
      const job = this.ports.jobById(jobId);
      const lane = job ? this.ports.queueStatuses().find((status) => status.provider === job.provider) : undefined;
      await this.append(active, {
        kind: "terminal",
        key: item.key,
        outcome: "held",
        detail:
          job?.status === "needs-reconciliation"
            ? "the job needs reconciliation in Activity"
            : (lane?.reason ?? "the provider's lane is paused"),
        at: this.ports.nowIso(),
      });
    } else {
      const job = this.ports.jobById(jobId);
      await this.append(active, {
        kind: "terminal",
        key: item.key,
        outcome: "failed",
        detail: job?.error ?? (active.stopped ? "stopped — cancellation requested" : "the job did not land"),
        at: this.ports.nowIso(),
      });
    }
    this.publish(active);
  }

  private async watchJob(active: ActiveBuild, jobId: string): Promise<"succeeded" | "failed" | "held" | "parked"> {
    for (;;) {
      if (this.parked(active)) return "parked";
      const job = this.ports.jobById(jobId);
      if (!job) return "failed";
      if (job.status === "succeeded") return "succeeded";
      if (job.status === "failed" || job.status === "cancelled") return "failed";
      if (job.status === "needs-reconciliation") return "held";
      const lane = this.ports.queueStatuses().find((status) => status.provider === job.provider);
      if (lane?.paused === true && job.status === "queued") return "held";
      if (active.stopped && (job.status === "queued" || job.status === "submitting" || job.status === "running")) {
        // Stop requested cancellation; whatever the queue decides is what the fold reads.
        // Keep watching briefly — the cancel lands as a terminal status.
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, WATCH_TICK_MS);
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        const set = this.jobWakers.get(jobId) ?? new Set();
        set.add(wake);
        this.jobWakers.set(jobId, set);
      });
    }
  }

  /** Landing without review (R-25..R-28): accepted by the build, under the press's authorization. */
  private async landItem(active: ActiveBuild, item: BuildItem, jobId: string): Promise<void> {
    const store = this.ports.openStore();
    if (!store || store.worldId !== active.record.worldId) throw new Error("the world is not open");
    const job = this.ports.jobById(jobId);
    if (!job) throw new Error("the job is gone from the queue");
    // Best effort: the wake can outrun the ledger append, and a take with no cost row is
    // how the recovery path already records — but when the row is there, the take says
    // what the work actually cost.
    const ledgerEntry = await this.ports.ledgerEntryFor(jobId).catch(() => undefined);
    const bundle = store.getBundle();
    const blueprint = active.record.blueprint;
    const sheetOf = (type: "character" | "location") => {
      const name =
        type === "character"
          ? blueprint.characters.find((c) => c.slug === item.subject)?.name
          : blueprint.locations.find((l) => l.slug === item.subject)?.name;
      const sheet = bundle.sheets.find((candidate) => candidate.type === type && candidate.name === name);
      if (!sheet) throw new Error(`the ${type} sheet is not in the world`);
      return sheet;
    };
    switch (item.kind) {
      case "main-photo": {
        const sheet = sheetOf("character");
        const take = await recordReferenceTake(store, job, ledgerEntry);
        if (!take) throw new Error("the immutable take was not recorded");
        const kit = (await readKit(store, sheet.id))?.kit ?? null;
        if (kit?.mainPhoto?.sourceTakeId === take.id) return; // landed on an earlier pass (R-34)
        const candidate = job.landedFiles?.find((file) => file.startsWith(`references/${sheet.id}/candidates/`)) ?? null;
        const result = await acceptMainPhoto(store, sheet, store.getBundle(), { source: "take", takeId: take.id }, candidate);
        if (result.status === "failed") throw new Error(result.error);
        return;
      }
      case "establishing-view": {
        const sheet = sheetOf("location");
        const take = await recordReferenceTake(store, job, ledgerEntry);
        if (!take?.media) throw new Error("the immutable take was not recorded");
        const kit = (await readKit(store, sheet.id))?.kit ?? null;
        if (kit?.locationViews?.some((view) => view.sourceTakeId === take.id)) return;
        const frozen = take.params["provenance"] as { sheets?: Record<string, number> } | undefined;
        const sheetVersion = frozen?.sheets?.[sheet.id] ?? take.provenance.sheets[sheet.id];
        if (sheetVersion === undefined) throw new Error("the take does not name its sheet version");
        await acceptLocationView(store, sheet, {
          id: `lv_${take.id.slice(3)}`,
          name: "Establishing",
          file: `takes/${take.id}/${take.media}`,
          takeId: take.id,
          sheetVersion,
          artDirectionVersion: take.provenance.artDirectionVersion ?? bundle.artDirection.version,
          establishing: true,
          review: referenceReviewDecision(store.now(), take, "accept"),
        });
        return;
      }
      case "sheet-image": {
        const sheet = sheetOf("character");
        const take = await recordReferenceTake(store, job, ledgerEntry);
        if (!take?.media) throw new Error("the immutable take was not recorded");
        const fresh = store.getBundle();
        if (fresh.referenceReviews.some((review) => review.takeId === take.id)) return; // designated already
        const pending = pendingReferenceTake(fresh.referenceTakes, fresh.referenceReviews, take.id, sheet.id, "sheet");
        if (!pending) return;
        const frozen = take.params["provenance"] as { sheets?: Record<string, number>; anchorFile?: string } | undefined;
        const sheetVersion = frozen?.sheets?.[sheet.id] ?? take.provenance.sheets[sheet.id];
        if (sheetVersion === undefined || frozen?.anchorFile === undefined) {
          throw new Error("the take does not name the main photo it was conditioned on");
        }
        await acceptCharacterSheet(store, sheet, {
          file: `takes/${take.id}/${take.media}`,
          takeId: take.id,
          sheetVersion,
          anchorFile: frozen.anchorFile,
          artDirectionVersion: take.provenance.artDirectionVersion ?? bundle.artDirection.version,
          review: referenceReviewDecision(store.now(), take, "accept"),
        });
        return;
      }
      case "key-art": {
        const adopted = await adoptKeyArtCandidate(store);
        if (!adopted) {
          // Nothing waiting is a landing only when the art is already on disk from an
          // earlier pass — checked against the filesystem, never a scan that may lag.
          const already = (
            await Promise.all(
              KEY_ART_EXTENSIONS.map((extension) =>
                stat(toExtendedLength(join(store.dir, `${WORLD_IMAGE_STEM}${extension}`))).catch(() => null),
              ),
            )
          ).some((info) => info?.isFile() === true);
          if (!already) throw new Error("no key-art candidate landed to adopt");
        }
        await this.ports.refreshWorldList().catch(() => {});
        return;
      }
      default:
        throw new Error(`${item.kind} has no landing`);
    }
  }

  // -------------------------------------------------------------------------
  // The fold and its publication
  // -------------------------------------------------------------------------

  private fold(active: ActiveBuild): FoundingBuildState {
    const facts: BuildJobFacts[] = [];
    for (const entry of active.entries) {
      if (entry.kind !== "enqueued") continue;
      const job = this.ports.jobById(entry.jobId);
      if (job) facts.push({ id: job.id, status: job.status });
    }
    return foldFoundingBuild(
      active.record,
      active.entries,
      facts,
      active.record.blueprint.name ?? "The world",
    );
  }

  /** Everything the coordinator knows, for the snapshot's `app.builds`. */
  states(): FoundingBuildState[] {
    return [...this.builds.values()].map((active) => this.fold(active));
  }

  /**
   * Drop finished builds with nothing left to say — every item landed — from memory and the
   * snapshot. The record stays on disk; opening the world reloads it if it is ever needed.
   */
  forgetSettled(): void {
    const settled: string[] = [];
    for (const [worldId, active] of this.builds) {
      const state = this.fold(active);
      if (state.status === "running") continue;
      if (state.items.every((item) => item.state === "landed")) settled.push(worldId);
    }
    for (const worldId of settled) this.builds.delete(worldId);
  }

  private publish(active: ActiveBuild): void {
    this.ports.emit({ at: this.ports.nowIso(), type: "build.state", state: this.fold(active) });
  }

  private async append(active: ActiveBuild, entry: BuildJournalEntry): Promise<void> {
    await active.journal.append(entry);
    active.entries.push(entry);
  }

  private wakeAll(): void {
    for (const wakers of this.jobWakers.values()) for (const wake of wakers) wake();
    this.jobWakers.clear();
  }
}

/** A sheet-image whose anchor did not land is skipped, not failed (R-22). */
class AnchorMissing extends Error {}
