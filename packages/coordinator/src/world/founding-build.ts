import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BuildJournalEntrySchema,
  BuildReviewSchema,
  FoundingBuildRecordSchema,
  characterBriefProse,
  compileBuildItems,
  foldFoundingBuild,
  imageConstraintSuffix,
  keyArtBriefProse,
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
  type ManifestModel,
  type ModelManifest,
  type QueueStatus,
  type Sheet,
} from "@arke-studio/contracts";
import type { EnqueueInput } from "../queue/dispatcher.js";
import type { ProposalManager } from "../gate/proposals.js";
import type { WorldStore } from "./store.js";
import { atomicWriteFile } from "./atomic.js";
import { toExtendedLength } from "./paths.js";
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
import { adoptKeyArtCandidate } from "../references/key-art.js";
import { pendingReferenceTake, recordReferenceTake, referenceReviewDecision } from "../references/takes.js";
import { keyArtPrompt, worldImageRequest } from "../references/world-image.js";

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
  /** Author a staged sheet with the harness when it is ready; resolves when the draft landed. */
  authorSheet(
    store: WorldStore,
    gate: ProposalManager,
    input: { worldId: string; proposalId: string; path: string; scope: string; sheetType: string; name: string; seed: string },
  ): Promise<void>;
  enqueue(input: EnqueueInput): Promise<Job>;
  jobById(jobId: string): Job | undefined;
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

  async begin(genesisId: string, requestId: string): Promise<void> {
    // Two presses in one tick are one run (row 8): the second joins the first's promise.
    const inFlight = this.beginning.get(genesisId);
    if (inFlight) return inFlight;
    const work = this.beginWork(genesisId, requestId).finally(() => this.beginning.delete(genesisId));
    this.beginning.set(genesisId, work);
    return work;
  }

  private async beginWork(genesisId: string, requestId: string): Promise<void> {
    const sandbox = await this.ports.genesisDir(genesisId);
    const markerPath = join(sandbox, BEGUN_MARKER);
    const marker = await readFile(toExtendedLength(markerPath), "utf8")
      .then((raw) => JSON.parse(raw) as { worldId?: string })
      .catch(() => null);
    if (marker?.worldId !== undefined) {
      // A second press, a replayed frame or a resumed session joins the existing run (R-16).
      // A world builds once (R-37): there is no path here that builds it again.
      await this.resume(marker.worldId);
      return;
    }

    const blueprint = await foldBlueprint(sandbox);
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
    // proposed, and the bible it wrote (R-18). The record needs the world's folder to live in,
    // so this precedes it — the begun marker is what makes a crash here recoverable.
    const { worldId } = await this.ports.createWorld({
      name: blueprint.name,
      ...(blueprint.logline !== undefined ? { logline: blueprint.logline } : {}),
      ...(blueprint.tone !== undefined ? { tone: blueprint.tone.toLowerCase() } : {}),
      ...(blueprint.genre !== undefined ? { genre: blueprint.genre.toLowerCase() } : {}),
      ...(blueprint.look !== undefined ? { artDirection: blueprint.look } : {}),
      ...(blueprint.bible !== undefined ? { bible: blueprint.bible } : {}),
    });
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
    await atomicWriteFile(markerPath, JSON.stringify({ worldId, buildId: record.buildId, requestId }) + "\n");

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
   * Resume a run wherever the journal left it (R-33): a no-op for a completed or stopped
   * build beyond publishing its state, so the notice survives every restart (R-45).
   */
  async resume(worldId: string): Promise<void> {
    const store = this.ports.openStore();
    if (!store || store.worldId !== worldId) return;
    const active = await this.load(store.dir, worldId);
    if (!active) return;
    this.publish(active);
    const state = this.fold(active);
    if (state.status === "running" && !active.driving) this.drive(active);
  }

  /** Whether this world has a build at all — the world screen's "founded by a build" record (R-37). */
  has(worldId: string): boolean {
    return this.builds.has(worldId);
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
   * exactly as the build would have: settled, anchored, designated (R-49).
   */
  async runItems(worldId: string, itemKey?: string): Promise<void> {
    const store = this.ports.openStore();
    if (!store || store.worldId !== worldId) return;
    const active = await this.load(store.dir, worldId);
    if (!active) return;
    const state = this.fold(active);
    const runnable = new Set(["failed", "skipped", "held", "unauthorized", "pending"]);
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
      if (active.stopped && itemKey === undefined) break;
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

  /** A job the coordinator saw settle — wakes any wait on it without the tick. */
  noteJobSettled(jobId: string): void {
    const wakers = this.jobWakers.get(jobId);
    if (!wakers) return;
    for (const wake of wakers) wake();
    this.jobWakers.delete(jobId);
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
    if (item.idempotencyKey !== undefined || BUILD_IMAGE_ITEM(item)) {
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
      switch (item.kind) {
        case "world":
          await this.runWorld(active);
          break;
        case "author-sheet":
          await this.runAuthorSheet(active, item, store, gate);
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
      await this.append(active, { kind: "terminal", key: item.key, outcome: "landed", at: this.ports.nowIso() });
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
  }

  private async runAuthorSheet(
    active: ActiveBuild,
    item: BuildItem,
    store: WorldStore,
    gate: ProposalManager,
  ): Promise<void> {
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
    if (bundle.sheets.some((sheet) => sheet.type === item.sheetType && sheet.name === entity.name)) return;
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
    if (this.ports.harnessReady()) {
      const brief =
        item.sheetType === "character"
          ? characterBriefProse(blueprint.characters.find((c) => c.slug === item.subject)?.brief)
          : item.sheetType === "location"
            ? locationBriefProse(blueprint.locations.find((l) => l.slug === item.subject)?.brief)
            : "";
      const description = entity.description !== undefined ? `\n\nThe conversation settled: ${entity.description}` : "";
      const facts = brief !== "" ? `\n\nAppearance facts the conversation settled: ${brief}.` : "";
      await this.ports
        .authorSheet(store, gate, {
          worldId: active.record.worldId,
          proposalId: draft.proposal.id,
          path: draft.path,
          scope: draft.scope,
          sheetType: item.sheetType,
          name: entity.name,
          seed: `${seed}${description}${facts}`,
        })
        .catch(() => {});
    }
    // The gate is pre-authorized, not bypassed (§2.4): the proposal is accepted under the
    // press's authorization. A refusal discards it — nothing may rest in Needs you (R-25).
    const outcome = await gate.accept(draft.proposal.id).catch(() => null);
    if (outcome === null || outcome.status !== "accepted") {
      await gate.discard(draft.proposal.id).catch(() => {});
      throw new Error(`the ${item.sheetType} sheet could not be settled${outcome ? ` (${outcome.status})` : ""}`);
    }
    await this.ports.refreshWorldSnapshot(active.record.worldId).catch(() => {});
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
    // Recovery: an intent with a job id reconciles against the queue before anything is
    // dispatched again (R-34) — the pre-allocated idempotency key would dedup anyway, and
    // the journalled id saves even the lookup.
    if (folded?.state === "running" && folded.jobId !== undefined) return folded.jobId;

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
            candidate.state !== "pending" && candidate.state !== "skipped" && candidate.state !== "unauthorized",
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
    await this.append(active, { kind: "intent", key: item.key, at: this.ports.nowIso() });
    this.publish(active);
    try {
      // The pre-allocated key protects the first attempt's crash window — re-enqueueing it
      // joins the existing job (SPEC-024 D2). A retry after a terminal outcome is new work
      // the author just authorized, so it mints a fresh key rather than joining the failure.
      const retried = active.entries.some((entry) => entry.kind === "terminal" && entry.key === item.key);
      const job = await this.ports.enqueue({
        ...input,
        idempotencyKey: retried ? ulid() : (item.idempotencyKey ?? ulid()),
      });
      await this.append(active, { kind: "enqueued", key: item.key, jobId: job.id, at: this.ports.nowIso() });
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
        const request = worldImageRequest(bundle.meta, model, bundle.artDirection);
        const words = keyArtPrompt({
          composed: String(request.params["prompt"]),
          description: bundle.artDirection.description,
          suffix: imageConstraintSuffix(bundle.artDirection),
          authored: keyArtBriefProse(blueprint.keyArt!),
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
        const take = await recordReferenceTake(store, job);
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
        const take = await recordReferenceTake(store, job);
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
        const take = await recordReferenceTake(store, job);
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
        await adoptKeyArtCandidate(store);
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

function BUILD_IMAGE_ITEM(item: BuildItem): boolean {
  return (
    item.kind === "main-photo" ||
    item.kind === "establishing-view" ||
    item.kind === "sheet-image" ||
    item.kind === "key-art"
  );
}
