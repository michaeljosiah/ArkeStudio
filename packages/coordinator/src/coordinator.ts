import { tmpdir } from "node:os";
import { writeSessionFiles, type SessionInput } from "./harness/session-files.js";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname, join, resolve, sep } from "node:path";
import {
  DomainEventSchema,
  JobSchema,
  REFERENCE_FINALIZATION_TARGETS,
  imageConstraintSuffix,
  stagedReferenceKey,
  LedgerEntrySchema,
  OPENCODE_AVAILABILITY,
  type Capability,
  type ClientMessage,
  type HarnessAvailability,
  type ClientState,
  type DomainEvent,
  type HarnessAdapter,
  type HealthComponent,
  buildExportPlan,
  exportOverlays,
  deriveEpisodeCut,
  episodeExportRefusals,
  sortScenes,
  buildFfmpegArgs,
  buildSpineExportPlan,
  buildSpineFfmpegArgs,
  deriveSpineCut,
  spineExportRefusals,
  ulid,
  CutFileSchema,
  deriveCut,
  designatedCompilation,
  comfyUiRecoveryDecision,
  estimateMicroUsd,
  modelForCapability,
  gateLocalRuntimes,
  planScene,
  previewLineFor,
  SceneSchema,
  type ConversationId,
  type WorldChatCheckReceipt,
  type Job,
  type LedgerEntry,
  type ModelManifest,
  type ProviderId,
  type ProviderToolStatus,
  orderedLocationViews,
  type QueueCommand,
  type RuntimeProbes,
  type VoiceCandidate,
  type ArtifactGeneration,
  type BenchSession,
  type SessionId,
  deliveryParams as mapDelivery,
  type Delivery,
  narratorFor,
} from "@arke-studio/contracts";
import { BenchStore, sessionDir as benchSessionDir, sessionMediaDir } from "./bench/store.js";
import {
  discoverBenchSessions,
  openBenchSession,
  planBenchDispatch,
  addBenchReference,
  type WorldFileReader,
  recoverBenchSession,
  type BenchRecoveryJobFacts,
  type OpenedBench,
} from "./bench/service.js";
import { AppLog } from "./app-log.js";
import { AppSettingsFile, routingFaults } from "./app-settings.js";
import { AskService } from "./canon/ask.js";
import { CredentialStore, type Cipher } from "./credentials/store.js";
import { buildDiagnosticsBundle } from "./diagnostics.js";
import {
  compileBoard,
  composeDispatches,
  createChapter,
  createProduction,
  draftSceneSkeleton,
  exportBoard,
  landBoard,
  overviewSteer,
  productionCreatedBy,
  proposeEpisode,
  proposeSeason,
  proposeStoryOverview,
  reorderChapters,
  reorderEpisodes,
  reorderScenes,
  deleteScene,
  restoreScene,
  saveChapter,
  saveScene,
  setProductionAspect,
  setPromptOverride,
} from "./productions/ops.js";
import {
  advancePlan,
  advanceAllPlans,
  appendPlanEvents,
  createDispatchPlan,
  listPlans,
  planState,
  type PlanDriverDeps,
} from "./productions/plans.js";
import {
  appendTraversal,
  exportInteractive,
  interactiveFindings,
  proposeBranchCanon,
  saveRouting,
  type InteractiveExportResult,
} from "./productions/interactive.js";
import { ProviderService, type KeyValidator } from "./providers/service.js";
import { ProviderToolService, type ToolProbe } from "./providers/tool.js";
import { ProviderCallStore } from "./providers/call-store.js";
import { JobQueue, type DispatchClient, type EnqueueInput } from "./queue/dispatcher.js";
import { enqueueInputs } from "./queue/acknowledge.js";
import {
  extractText,
  resolveCandidate,
  storeBatch,
  verifyCandidates,
  type RawCandidate,
} from "./artifacts/extraction.js";
import { ATTACHABLE_EXTENSIONS, ATTACHABLE_IMAGE_EXTENSIONS, backfillMediaInfo, fileArtifact, fileGeneratedArtifact, importFolder } from "./artifacts/filing.js";
import { attachToSandbox, sandboxAttachments } from "./artifacts/genesis-attachments.js";
import { makeAdapterExtractor } from "./artifacts/model.js";
import { recordTakesFromJob } from "./takes/arrival.js";
import type { TakeQcAnalyzer } from "./takes/qc.js";
import { backfillPosters, writePosterFor, type TakePosterMaker } from "./takes/poster.js";
import { chainBoundaryFrame, type BoundaryFrameMaker } from "./takes/boundary.js";

/**
 * How long an opening bench session may spend drawing pictures it should already have. Long
 * enough for an ordinary session in one pass, short enough that nobody waits on it.
 */
const BENCH_POSTER_BACKFILL_MS = 5_000;
import { exportWorld, runExport, type ExportHandle, type FfmpegRunner } from "./takes/export.js";
import { measureMediaInfo, type MediaProbe } from "./media/probe.js";
import {
  acceptTake,
  audioDesignFor,
  moveOverlay,
  placeOverlay,
  rejectTake,
  removeOverlay,
  saveAudioTracks,
  setTrim,
} from "./takes/review.js";
import {
  normalizeSpeechText,
  authoritativeSheetSpeech,
  previewCacheFile,
  speechCacheFile,
  VoiceService,
  type CloudVoiceSource,
  type SidecarLike,
  voiceLineRequest,
} from "./voice/service.js";
import {
  AUDIO_EXTENSIONS as CLONEABLE_AUDIO_EXTENSIONS,
  audioBytesLookRight,
  clipFor,
  cloneVoice,
  MIN_CLONE_SECONDS,
  wavSeconds,
} from "./voice/library.js";
import { atomicWriteFile } from "./world/atomic.js";
import { applyTurnBibleEdits, readBible, restoreBible, saveBible } from "./world/bible.js";
import { checkPathBudget, fromPortable, toExtendedLength } from "./world/paths.js";
import { imageFormatOf } from "./queue/verify.js";
import { readContainedImageReferences } from "./world/reference-files.js";
import { sampleWorldAvailable } from "./world/sample-world.js";
import {
  characterLookRequests,
  characterSheetRequest,
  establishRequests,
  imageModelFor,
  locationViewRequests,
  mainPhotoRequests,
  missingTileAngles,
  tileRequest,
} from "./references/generate.js";
import { makeArtDirector, worldBrief } from "./references/art-director.js";
import { enhancerBrief } from "./bench/enhancer.js";
import { LYRICS_MAX_CHARS, lyricistBrief } from "./bench/lyricist.js";
import {
  KEY_ART_EXTENSIONS,
  WORLD_IMAGE_DIR,
  WORLD_IMAGE_STEM,
  keyArtPrompt,
  worldImageRequest,
} from "./references/world-image.js";
import {
  MASTER_LOOK_DIR,
  MASTER_LOOK_DIR_ACCEPTED,
  masterLookFile,
  masterLookRequest,
  stagedFor,
  stagedReferenceDir,
} from "./references/master-look.js";
import {
  acceptCharacterLook,
  acceptCharacterSheet,
  acceptLocationView,
  attachCharacterLook,
  compileGrid,
  designate,
  landGrid,
  lockTile,
  readKit,
  promoteCharacterLook,
  setStyleOverride,
  supersedeTile,
} from "./references/kit.js";
import {
  pendingReferenceTake,
  recordReferenceReview,
  recordReferenceTake,
  recordUploadedCharacterSheetTake,
  recordUploadedLocationViewTake,
  referenceReviewDecision,
} from "./references/takes.js";
import {
  acceptMainPhoto,
  mainPhotoFailureReason,
  mainPhotoLogRecord,
  type MainPhotoAcceptanceStage,
} from "./references/main-photo.js";
import { LLM_ENV_PROVIDERS } from "@arke-studio/adapter-opencode";
import { SecretRegistry } from "./redact.js";
import { detectDrift, evaluateSpend } from "./spend/analytics.js";
import { LedgerFile } from "./spend/ledger.js";
import {
  openThread,
  stageCanonAmendment,
  stageCanonEntry,
  stageThreadSettlement,
} from "./canon/authoring.js";
import { ChangeLog } from "./change-log.js";
import { AuthoringService, settlePermission } from "./harness/authoring.js";
import { GenesisService } from "./harness/genesis.js";
import { LocalSetupService, type SetupDeps } from "./setup/local-setup.js";
import { SETUP_CATALOGUE, type CatalogueEntry } from "./setup/catalogue.js";
import { sanitizeComfyUiMedia } from "./comfyui/sanitize.js";
import type { ComfyUiEngineService } from "./comfyui/engine.js";
import { GrantStore } from "./harness/grants.js";
import { WorldQueryServer } from "./harness/world-query.js";
import { ConversationInUseError, WorldChatService } from "./world-chat/service.js";
import { acceptDecided, explainAcceptRefusal } from "./gate/proposals.js";
import { rejectPoint, returnToRail, savePoint, wrapUp, WrapUpError } from "./world-chat/wrapup.js";
import { recoverConversations } from "./world-chat/recovery.js";
import { recoverWrapUps } from "./world-chat/wrapup-recovery.js";
import { titleFrom } from "./world-chat/title.js";
import { describeEntryContext } from "./world-chat/entry-context.js";
import { budgetFor, currentLookContext } from "./world-chat/context.js";
import { discoverConversations } from "./world-chat/discover.js";
import { recordResolution, sendBack } from "./world-chat/resolution.js";
import { WorldChatStore, conversationDir } from "./world-chat/store.js";
import { WorldChatRunner } from "./world-chat/run.js";
import { WorldChatRunnerCache } from "./world-chat/runner-cache.js";
import { QueryLeaseRegistry } from "./world-chat/lease.js";
import { WorldChatRetrieval } from "./world-chat/retrieval.js";
import {
  AttachmentError,
  CHAT_DOCUMENT_EXTENSIONS,
  refuseUnreadable,
  WorldChatAttachmentStore,
  MAX_TEXT_PER_RUN_CHARS,
} from "./world-chat/attachments.js";
import { planFor } from "./world-chat/check-plan.js";
import { createRunScratch, removeRunScratch } from "./world-chat/run-scratch.js";
import { projectWorkspace } from "./world-chat/project.js";
import { refsForCanon, refsForSheet, ripplesForCanonEntry, searchCanon } from "./index-db/queries.js";
import {
  createSheetFromSentence,
  duplicateSheet,
  stageGuestPromotion,
  stageSheetRename,
  stageSheetStatus,
  applyVoiceAssignment,
} from "./sheets/authoring.js";
import { ReadModel } from "./read-model.js";
import { ChildSupervisor, type SupervisorStatus } from "./supervisor.js";
import { Transport } from "./transport.js";
import type { WorldProvider } from "./world-provider.js";
import type { WorldStore } from "./world/store.js";

/**
 * The coordinator: the application's domain layer, embedded in the Electron main process
 * (SPEC-001 D2) — never a separately launched server. Wires the world provider, read model,
 * transport, change log, harness adapter and child supervisors into one lifecycle.
 */

/**
 * What the host's file dialog offers to filter by. A hint for the picker, nothing more: the
 * dialog also offers "All files", so the name arriving back is whatever the user typed and the
 * decision is taken on the bytes below.
 *
 * Bare, no leading dot. Electron's `FileFilter.extensions` is specified without one, and a
 * dotted list makes the dialog reject the filter — which the caller's `.catch(() => [])` would
 * then render as a cancelled dialog, so the button would look like it did nothing at all. Every
 * other picker in the app passes bare extensions for the same reason (`ATTACHABLE_EXTENSIONS`
 * strips its dots explicitly); this list is checked against nothing, so it keeps none.
 */
const IMPORTABLE_IMAGES = ["png", "jpg", "jpeg", "webp"] as const;

const UNSUPPORTED_IMAGE = "That file is not an image the studio can hold. Choose a PNG, JPEG or WebP.";

/**
 * The host's dialog allows multiple selections — it is the same seam that attaches whole folders
 * of files — but a main photo and a character sheet are each exactly one image. Taking the first
 * of several and reporting success would quietly discard the rest, so the extras are refused out
 * loud instead (PR review).
 */
const ONE_IMAGE_ONLY = "Choose a single image: this replaces one picture, not a set.";

/**
 * The same ceiling `readContainedImageReferences` enforces when a reference is about to be sent.
 * Refusing here rather than there is the whole point: an image accepted as the identity anchor
 * and then silently dropped at dispatch is worse than one that was never accepted.
 */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 - 1;

/**
 * Read a picked file, refusing anything the dispatch path would later refuse (PR #241 review).
 *
 * The extension is checked by *reading* it — `imageFormatOf` looks at signatures and trailers,
 * so a text file renamed `.png`, or a PNG that stopped downloading halfway, is caught here
 * instead of becoming an accepted reference with a broken preview. The format the bytes actually
 * carry is what names the stored file, the same rule the dispatcher applies when it lands a
 * generated artifact, so a JPEG called `.png` is stored as the JPEG it is.
 *
 * The returned extension carries its dot (`.png`), unlike `IMPORTABLE_IMAGES` above: that one is
 * a dialog filter and this one builds a filename. They are never interchangeable.
 */
async function readPickedImage(
  source: string,
): Promise<{ data: Uint8Array; extension: string } | { error: string }> {
  const tooBig = { error: "That image is over 50 MB, which is more than an image model will accept." };
  const unreadable = { error: "That file could not be read. Try choosing it again." };
  const info = await stat(toExtendedLength(source)).catch(() => null);
  if (!info?.isFile()) return unreadable;
  // Cheap enough to refuse a 4 GB file without reading it, but not the answer: an editor or a
  // sync client can finish writing between the two calls, so the bytes in hand are measured too.
  if (info.size > MAX_UPLOAD_BYTES) return tooBig;
  const data = await readFile(toExtendedLength(source)).then(
    (bytes) => Uint8Array.from(bytes),
    () => null,
  );
  if (!data) return unreadable;
  if (data.byteLength > MAX_UPLOAD_BYTES) return tooBig;
  const format = imageFormatOf(data);
  if (!format) return { error: UNSUPPORTED_IMAGE };
  return { data, extension: format.extension };
}

/** Put verified bytes in a sheet's candidate set under a name of our making, never the user's. */
async function landUploadedImage(
  store: WorldStore,
  sheetId: string,
  name: string,
  data: Uint8Array,
): Promise<void> {
  await atomicWriteFile(join(store.dir, "references", sheetId, "candidates", name), data);
}

export interface CoordinatorOptions {
  provider: WorldProvider;
  observeEvent?: (event: DomainEvent) => void;
  adapter: HarnessAdapter | null;
  changeLogPath: string;
  appVersion: string;
  /** Optional NDJSON seeds so fixtures light the Activity screens (jobs.jsonl / ledger.jsonl). */
  jobsSeedPath?: string;
  ledgerSeedPath?: string;
  /**
   * The sample world this build carries (SPEC-016 R-6), or null when it carries none. Where it
   * lives is the shell's to know — packaged, in resources; in dev, in the repo — so it arrives
   * here as a path rather than being looked for.
   */
  sampleWorldPath?: string | null;
  /** App root for remembered grants (SPEC-005 R-16). Absent → grants are session-only. */
  appRoot?: string;
  /** Session-config builders from the adapter package, injected to keep dependencies one-way. */
  authoring?: {
    agentForPurpose: (purpose: "authoring" | "drafting" | "extraction" | "ask" | "art-prompt") => string;
    /**
     * The shipped roster, injected like everything else from the adapter package. The
     * coordinator needs it to show what each agent is for and to tell an edited brief from the
     * original — it never needs to know how a prompt is assembled.
     */
    roster?: ReadonlyArray<{ name: string; description: string; brief: string }>;
    /**
     * The shipped skill registry (SPEC-019 R-14, R-15). Injected like the roster so the
     * dependency stays one-way: the coordinator resolves a family and asks for a document, and
     * never learns how one is written or where it is stored.
     */
    skillFor?: (
      purpose: "scene-drafting" | "storyboard",
      family: string | undefined,
    ) => { id: string; version: number; family: string } | null;
  };
  /** SPEC-008: credential cipher (Electron safeStorage in the desktop; a fake in tests). */
  cipher?: Cipher;
  /**
   * Arrival-time motion QC (#248). Wired by the desktop host only when it can resolve an ffmpeg
   * binary; absent everywhere else, which is an ordinary state and not a degraded one — takes
   * simply record no measurement.
   */
  takeQcAnalyzer?: TakeQcAnalyzer;
  takePosterMaker?: TakePosterMaker;
  /**
   * Boundary-frame extraction (issue 154), on the same terms as the poster maker: wired only
   * where an ffmpeg binary resolves. Absent means accepting a take chains only the legacy
   * steering pointer, and the reason is logged rather than silent.
   */
  boundaryFrameMaker?: BoundaryFrameMaker;
  /**
   * The credential file's name inside the app root. Only dev overrides it, and only because its
   * cipher is not safeStorage: `ARKE_STUDIO_ROOT` can point the dev coordinator at a real app
   * root, and two ciphers sharing one file would leave whichever wrote last unreadable by the
   * other. Separate names keep dev out of the desktop's way entirely.
   */
  credentialsFileName?: string;
  /**
   * Which OpenCode generation the host wired, from launch-time discovery — surfaced whole
   * into app state so Settings can name it (issue 327 §9, SPEC-005 R-1).
   */
  harnessInfo?: {
    generation: "v2" | "v1" | "claude";
    source: "configured" | "path" | "bundled";
    version: string | null;
    beta: boolean;
    rejectedV2Version?: string | null;
  };
  /**
   * Deliver stored provider keys to the harness child's spawn environment (SPEC-005 D5).
   * Called with the current keys at start, before the child first spawns, and again when an
   * LLM credential changes. Under v2's redirected profile this is the ONLY credential path —
   * the shared store v1 silently leaned on is closed by design (issue 327 §2).
   */
  relaunchHarness?: (credentials: Record<string, string | undefined>) => Promise<void>;
  /** Shared with provider-call capture so known credentials are scrubbed from owner-visible payloads. */
  secretRegistry?: SecretRegistry;
  providerCalls?: ProviderCallStore;
  /** SPEC-008: per-provider key validators, injected from @arke-studio/providers. */
  validators?: Partial<Record<ProviderId, KeyValidator>>;
  /**
   * Providers whose credential lives in a tool we drive rather than in `credentials.dat`
   * (issue #137). Absent in tests and in any build with no such provider.
   */
  toolProbes?: Partial<Record<ProviderId, ToolProbe>>;
  /** SPEC-008: the shipped model manifest. */
  manifest?: ModelManifest;
  /** SPEC-008: local runtime probing, injected so tests measure nothing. */
  probeRuntime?: () => Promise<RuntimeProbes>;
  /**
   * Which bring-your-own harnesses this machine has (SPEC-005 R-1). Injected because it spawns
   * subprocesses, and because the coordinator has no business knowing how a Claude Code install
   * is recognised. Returns only the harnesses that can be absent — the bundled one is constant.
   *
   * Discovery only. The confinement probe spends a live turn against the user's own
   * subscription, which is fine at launch when they have asked for the harness and wrong when
   * they have merely opened Settings.
   */
  detectHarnesses?: (configuredPath: string | null) => Promise<HarnessAvailability[]>;
  /** The host's native file dialog for pointing at a Claude Code PATH does not carry. */
  chooseClaudeExecutable?: () => Promise<string | null>;
  /**
   * The ComfyUI engine (SPEC-021): the service that discovers, supervises and verifies it,
   * plus the host's own directory pickers — selected paths go straight to settings and never
   * cross to the renderer, the same discipline Voxa's executable picker keeps.
   */
  comfyui?: {
    service: ComfyUiEngineService;
    choosePath?: () => Promise<string | null>;
    chooseModelsDir?: () => Promise<string | null>;
  };
  /**
   * Catalogue entries the host derives from data this package must not own — the per-recipe
   * weight entries, built from the provider layer's recipe facts (SPEC-021 §2.4).
   */
  setupExtraEntries?: readonly CatalogueEntry[];
  /**
   * Fetching the local runtimes at setup: Ollama and its default model, the voice models.
   * Absent → nothing is fetched and the app behaves exactly as before.
   */
  setup?: SetupDeps;
  /**
   * Choosing files to attach. The dialog belongs to the host, and so does the path it returns:
   * the renderer asks for an attachment and learns only that artifacts now exist, never where
   * they came from — the preload's promise of "no paths" survives (SPEC-001 R-9).
   * Absent → attaching says so instead of doing nothing.
   */
  pickFiles?: (input: { accept: readonly string[] }) => Promise<readonly string[]>;
  /** SPEC-009: dispatch clients (submit/poll/fetch/cancel + declarations), per provider. */
  dispatchClients?: Record<string, DispatchClient>;
  /** SPEC-013 R-19: the local encoder for exports; absent → exports state the reason. */
  ffmpeg?: FfmpegRunner;
  /**
   * Measuring media on this machine (#253). Wired by the desktop host when it can resolve
   * ffprobe. Absent means nothing can be measured — a master track cannot be assigned and take
   * durations stay unknown, which the spine states rather than guessing around.
   */
  mediaProbe?: MediaProbe;
  /** SPEC-015: the extraction model seam; every candidate is re-verified regardless (R-13). */
  extractor?: (text: string, artifactFile: string, signal?: AbortSignal) => Promise<RawCandidate[]>;
  /** Desktop-owned update commands. Electron APIs remain outside the coordinator. */
  updates?: {
    check: () => Promise<void>;
    download: () => Promise<void>;
    installAndRestart: () => Promise<void>;
    installOnClose: () => Promise<void>;
    acknowledge: () => void;
  };
  /** SPEC-016 R-17: open a path in the platform file manager, injected from the desktop. */
  openPath?: (path: string) => void;
  /** SPEC-016 R-2: whether the native index binding loaded, known only to the desktop shell. */
  nativeIndex?: { ok: boolean; reason?: string };
  /** SPEC-011: the Voxa sidecar and voice catalogue sources, injected from the desktop. */
  voice?: {
    sidecar: SidecarLike | null;
    /** Poll the sidecar's degradation state; null health = not started. */
    sidecarHealth?: () => Promise<{
      state: "not-started" | "downloading" | "unavailable" | "ready";
      detail: string;
      runtime?: ClientState["app"]["voiceRuntime"];
    }>;
    /** Host-owned executable picker. The selected path never crosses to the renderer. */
    chooseExecutable?: () => Promise<string | null>;
    applySettings?: (settings: import("@arke-studio/contracts").VoxaSettings) => Promise<void>;
    restart?: () => Promise<void>;
    localPresets: VoiceCandidate[];
    cloudSources: CloudVoiceSource[];
  };
}

const SUPERVISOR_HEALTH: Record<
  SupervisorStatus,
  { status: "starting" | "healthy" | "unhealthy" | "unavailable" }
> = {
  unconfigured: { status: "unavailable" },
  starting: { status: "starting" },
  healthy: { status: "healthy" },
  unhealthy: { status: "unhealthy" },
  stopped: { status: "unavailable" },
  failed: { status: "unavailable" },
};

/**
 * Reads a world-relative file for the bench, and refuses anything that is not really inside the
 * world.
 *
 * The second of two gates. `WorldFilePathSchema` settles the shape of the path as it arrives;
 * this settles the only question that shape cannot answer — where the path actually lands once
 * the filesystem has had its say about separators, links and normalisation. A regular
 * expression and a resolved path disagree often enough that both are worth having.
 */
function worldFileReader(worldDir: string): WorldFileReader {
  return {
    read: async (path) => {
      const resolvedWorld = resolve(worldDir);
      const target = resolve(resolvedWorld, path);
      // `startsWith` on the directory plus a separator: "…/world" must not admit "…/worldly".
      if (target !== resolvedWorld && !target.startsWith(resolvedWorld + sep)) {
        return { refused: "that file is not in this world" };
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(toExtendedLength(target));
      } catch {
        return { refused: "that picture is no longer in the world" };
      }
      return { hash: `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}` };
    },
  };
}

/**
 * A refusal, cut to the length its own event allows (driven 2026-08-22).
 *
 * `world-chat.wrap-up-refused` bounds `detail` at 300, and the gate's wording can be longer —
 * so emitting the refusal verbatim threw on its own schema, the emit never reached a client,
 * and the person who pressed Wrap up got nothing at all. A refusal that is too long to send is
 * the worst possible thing for it to be: the button did nothing and said nothing. Trimmed at a
 * word so the sentence still reads, and never silent again.
 */
const REFUSAL_DETAIL_MAX = 300;
export function refusalDetail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= REFUSAL_DETAIL_MAX) return flat === "" ? "This could not be written." : flat;
  const cut = flat.slice(0, REFUSAL_DETAIL_MAX - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > 80 ? cut.slice(0, at) : cut).replace(/[.,;:\s]+$/, "")}…`;
}

export class Coordinator {
  private readonly readModel: ReadModel;
  private readonly transport: Transport;
  private readonly changeLog: ChangeLog;
  private readonly supervisors = new Map<HealthComponent, ChildSupervisor>();
  private readonly worldQuery: WorldQueryServer;
  private readonly worldChatRunners = new WorldChatRunnerCache<WorldChatRunner>();
  private readonly grants: GrantStore | null;
  private readonly authoring: AuthoringService | null;
  private readonly genesis: GenesisService | null;
  private readonly setup: LocalSetupService | null;
  /** actionClass per pending permission id, for remember-on-always (R-16). */
  private readonly pendingPermissions = new Map<string, string>();
  /** Genesis sandboxes whose attachments are still being carried into a new world. */
  private readonly carrying = new Map<string, Promise<void>>();
  /** Documents being read for facts right now, so the reading can be stopped (SPEC-015 §2). */
  private readonly reading = new Map<string, AbortController>();
  /**
   * Clips chosen or recorded for a clone, held between 74c and 74d (SPEC-022 T-10).
   *
   * The path lives here rather than travelling to the renderer and back, which is what lets the
   * host keep ownership of its own file dialog (SPEC-001 R-9). Bounded because a dialog opened
   * and abandoned ten times should not accumulate ten temp files: staging past the cap discards
   * the oldest, and cancelling discards its own.
   */
  private readonly stagedClips = new Map<string, { path: string; fileName: string }>();

  /** How many staged clips a dialog may leave behind before the oldest is dropped. */
  private static readonly MAX_STAGED_CLIPS = 8;
  /** Session config builder with the user's agent settings folded in. */
  /** Session input plus whatever Settings currently says — read per call, never captured. */
  private readonly sessionInput: SessionInput;

  /**
   * Put a clip somewhere the clone can read it, and say what is wrong with it if anything is.
   *
   * The checks are deliberately the ones that can be made from the bytes alone. `cloneVoice` runs
   * the same magic-byte check again when it writes the clip into the world — this is not that
   * check moved, it is that check brought forward, so 74c can refuse before a name is typed.
   */
  private async stageClip(
    bytes: Uint8Array,
    fileName: string,
    extension: string,
  ): Promise<{ ok: true; clipId: string; seconds: number | null } | { ok: false; reason: string }> {
    if (!CLONEABLE_AUDIO_EXTENSIONS.has(extension)) {
      return { ok: false, reason: `${fileName} is not audio this can clone — use ${[...CLONEABLE_AUDIO_EXTENSIONS].join(" or ")}` };
    }
    if (!audioBytesLookRight(bytes, extension)) {
      return { ok: false, reason: `that file is named .${extension} but its contents are not ${extension} audio` };
    }
    const seconds = wavSeconds(bytes);
    // Only WAV states its own length cheaply, so this is the clip whose length can be checked.
    // An MP3 goes through with `seconds: null` rather than being refused on a guess — the format
    // hint on 74c asks for three seconds, and what cannot be read is not enforced as if it were.
    if (seconds !== null && seconds < MIN_CLONE_SECONDS) {
      return { ok: false, reason: `that clip is ${seconds.toFixed(1)}s — a voice needs ${MIN_CLONE_SECONDS} seconds or more to clone from` };
    }
    const clipId = `clip_${ulid()}`;
    const dir = join(tmpdir(), "arke-voice-clips");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${clipId}.${extension}`);
    await atomicWriteFile(path, bytes);
    // Oldest first: a Map iterates in insertion order, so the abandoned dialogs go before this one.
    while (this.stagedClips.size >= Coordinator.MAX_STAGED_CLIPS) {
      const oldest = this.stagedClips.keys().next();
      if (oldest.done) break;
      await this.dropStagedClip(oldest.value);
    }
    this.stagedClips.set(clipId, { path, fileName });
    return { ok: true, clipId, seconds };
  }

  /** Forget a staged clip and take its temp file with it. Silent about a clip already gone. */
  private async dropStagedClip(clipId: string): Promise<void> {
    const clip = this.stagedClips.get(clipId);
    if (!clip) return;
    this.stagedClips.delete(clipId);
    await rm(clip.path, { force: true }).catch(() => {});
  }

  /**
   * The authoring skill for a purpose, chosen by the family of the model that would actually do
   * the work (SPEC-019 R-16). Null whenever anything is missing — no registry, no manifest, no
   * routed model, or a family that ships no document — because every one of those is the same
   * ordinary outcome: draft under general guidance and say so (R-20).
   */
  private async skillForPurpose(
    purpose: "scene-drafting" | "storyboard",
    capability: Capability,
  ): Promise<{ id: string; version: number; family: string } | null> {
    const resolve = this.opts.authoring?.skillFor;
    if (!resolve || !this.opts.manifest) return null;
    const settings = this.appSettings ? await this.appSettings.load() : null;
    if (settings) this.researchWeb = settings.research.web === true;
    const model = modelForCapability(this.opts.manifest, settings?.routing, capability);
    return resolve(purpose, model?.family);
  }
  /** Per-agent model and brief overrides, as last read from settings. */
  private agentOverrides: Record<string, { model?: string; brief?: string }> | undefined;

  /**
   * The model family the next authoring session drafts for (SPEC-019 R-16), cached the way the
   * agent overrides are: read when settings are read, so a session started later in the run
   * carries the routing the user actually has. Undefined means no skill is injected and the
   * agents draft under general guidance (R-20).
   */
  private skillFamily: string | undefined;
  private appearanceWrite = Promise.resolve();
  private voiceModelsChanged = false;
  private started = false;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  /** Request ids whose create-production is still running — redelivery waits, never doubles (#384). */
  private readonly creatingProductions = new Set<string>();
  /** In-flight dispatch-scene-planned requestIds (SPEC-024 R-12): the same redelivery guard. */
  private readonly creatingPlans = new Set<string>();
  private readonly activeMessages = new Set<Promise<void>>();
  private readonly backgroundWork = new Set<Promise<unknown>>();
  /** SPEC-008: redaction registry, credential store, provider statuses, ledger, settings. */
  private readonly secrets: SecretRegistry;
  private readonly appLog: AppLog | null;
  /** Whether the studio may read a page online; mirrored from settings (2026-08-22). */
  private researchWeb = false;
  private readonly credentials: CredentialStore | null;
  private readonly providerService: ProviderService;
  /** One per provider whose credential is external (issue #137); empty when none are wired. */
  private readonly providerTools = new Map<ProviderId, ProviderToolService>();
  private readonly ledger: LedgerFile | null;
  private readonly appSettings: AppSettingsFile | null;
  /** SPEC-009: the dispatch engine. Null without an app root, clients and a ledger. */
  private readonly jobQueue: JobQueue | null;
  /** SPEC-011: catalogue, matching, previews and dictation. Null without voice wiring. */
  private readonly voiceService: VoiceService | null;
  /** SPEC-013: exports in flight, cancellable by id (R-21). */
  private readonly exports = new Map<string, ExportHandle>();
  /** `worldId:productionId` whose export is being set up or is already running — one at a time. */
  private readonly exportsInFlight = new Set<string>();
  /** Cancels the media backfill (issue 283) — optional migration work nothing should wait for. */
  private backfillAbort: AbortController | null = null;
  /** The store whose backfill is running, so reopening the same world joins it rather than racing it. */
  private backfillStore: WorldStore | null = null;

  constructor(private readonly opts: CoordinatorOptions) {
    this.secrets = opts.secretRegistry ?? new SecretRegistry();
    this.readModel = new ReadModel(opts.appVersion);
    this.changeLog = new ChangeLog(opts.changeLogPath);
    this.appLog = opts.appRoot ? new AppLog(join(opts.appRoot, "logs", "app.jsonl"), this.secrets) : null;
    this.credentials =
      opts.appRoot && opts.cipher
        ? new CredentialStore(
            join(opts.appRoot, opts.credentialsFileName ?? "credentials.dat"),
            opts.cipher,
            this.secrets,
          )
        : null;
    this.providerService = new ProviderService(this.credentials, opts.validators ?? {}, this.appLog);
    for (const [id, probe] of Object.entries(opts.toolProbes ?? {})) {
      if (!probe) continue;
      this.providerTools.set(
        id as ProviderId,
        new ProviderToolService(id as ProviderId, probe, (status) => this.emitToolStatus(status), this.appLog),
      );
    }
    this.ledger = opts.appRoot ? new LedgerFile(join(opts.appRoot, "ledger.jsonl")) : null;
    this.appSettings = opts.appRoot ? new AppSettingsFile(join(opts.appRoot, "settings.json")) : null;
    this.jobQueue =
      opts.appRoot && opts.dispatchClients && this.ledger
        ? new JobQueue({
            journalPath: join(opts.appRoot, "queue", "jobs.jsonl"),
            clients: opts.dispatchClients,
            getKey: async (provider) =>
              this.credentials ? this.credentials.get(provider as ProviderId) : null,
            emit: (event) => {
              this.emit(event);
              // A plan job settling is what unblocks its dependents (SPEC-024 R-18): advance is
              // a fold plus one durable act, so firing it here costs nothing when nothing moved.
              if (
                event.type === "job.updated" &&
                (event.job.status === "succeeded" ||
                  event.job.status === "failed" ||
                  event.job.status === "cancelled")
              ) {
                void this.advancePlansForJob(event.job).catch(() => {});
              }
            },
            ledger: {
              readJobIds: () => this.ledger!.readJobIds(),
              has: async (jobId) => (await this.ledger!.readAll()).some((e) => e.jobId === jobId),
              append: (entry) => this.recordLedger(entry),
            },
            landInWorld: async (worldId, fn) => {
              try {
                if (this.opts.provider.withWorldStore) {
                  await this.opts.provider.withWorldStore(worldId, (store) =>
                    store.ownedWrite(() => fn(store.dir)),
                  );
                  return true;
                }
                const store = this.opts.provider.openStore?.();
                if (!store || store.worldId !== worldId) return false;
                await store.ownedWrite(() => fn(store.dir));
                return true;
              } catch {
                return false;
              }
            },
            readImageReferences: async (worldId, paths) => {
              if (this.opts.provider.withWorldStore) {
                return this.opts.provider.withWorldStore(worldId, (store) =>
                  readContainedImageReferences(store.dir, paths),
                );
              }
              const store = this.opts.provider.openStore?.();
              if (!store || store.worldId !== worldId) throw new Error("the owning world is unavailable");
              return readContainedImageReferences(store.dir, paths);
            },
            onProviderFault: (provider, message) => this.reportProviderFault(provider as ProviderId, message),
            onTerminal: (job) => this.onJobTerminal(job),
            onFinalizationFailure: (job) => {
              void this.appLog?.append({
                kind: "job.finalization-failed",
                jobId: job.id,
                worldId: job.worldId,
                targetKind: job.target.kind,
              });
            },
            // Enqueue admission (SPEC-021 R-16): a recipe whose readiness is not ready is
            // refused with the readiness reason before anything is journalled. `unknown`
            // dispatches (D15) — the floor could not be checked, which is not a refusal.
            admit: async (input) => {
              if (input.provider !== "comfyui") return { ok: true };
              const service = this.opts.comfyui?.service;
              if (!service) return { ok: false, reason: "local recipes are not configured in this build" };
              const status = await service.status(this.readModel.getState().app.runtime?.probes ?? null);
              const recipe = status.recipes.find((r) => r.recipeId === input.model);
              if (!recipe) return { ok: false, reason: `"${input.model}" is not a shipped recipe` };
              if (recipe.state === "disabled") {
                return { ok: false, reason: recipe.reason ?? "the recipe is not ready on this machine" };
              }
              return { ok: true };
            },
            // Per-source recovery for local-engine jobs (SPEC-021 §2.11): the pure decision
            // table over the identity frozen at enqueue, against the engine resolved now.
            recoverLocal: (job) => {
              if (job.provider !== "comfyui") return null;
              if (job.status !== "running" && job.status !== "submitting") return null;
              return comfyUiRecoveryDecision({
                status: job.status,
                engine: job.engine,
                currentInstanceId: this.opts.comfyui?.service.instanceId() ?? null,
              });
            },
            // Landed-media sanitisation (SPEC-021 §2.10): strip embedded workflow metadata
            // before verification; refuse containers the sanitiser does not handle.
            prepareArtifact: (job, artifact) => {
              if (job.provider !== "comfyui") return { ok: true, artifact };
              const result = sanitizeComfyUiMedia(artifact.name, artifact.data);
              if (!result.ok) return result;
              return { ok: true, artifact: { ...artifact, data: result.data } };
            },
          })
        : null;
    this.voiceService = opts.voice
      ? new VoiceService({
          sidecar: opts.voice.sidecar,
          localPresets: opts.voice.localPresets,
          cloudSources: opts.voice.cloudSources,
          getKey: async (provider) =>
            this.credentials ? this.credentials.get(provider as ProviderId) : null,
          emit: (event) => this.emit(event),
        })
      : null;
    this.transport = new Transport({
      getSnapshot: () => this.getState(),
      onMessage: (msg) => {
        const updateCommand = msg.kind === "install-update-and-restart" || msg.kind === "install-update-on-close";
        // Every handler answers its own failures; this is the backstop. One that throws instead
        // used to become an unhandled rejection, which Node is entitled to exit on — a single
        // malformed or stale frame could take the studio down with it, and the log would say
        // nothing. Recorded and survived: a bad frame is a bad frame, not the end of the session.
        const handling = this.handleClientMessage(msg)
          .catch((err: unknown) => {
            void this.appLog?.append({
              kind: "message.failed",
              command: msg.kind,
              message: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => this.activeMessages.delete(handling));
        if (!updateCommand) this.activeMessages.add(handling);
      },
      // GET /media/<world-slug>/<world-relative-file> — read-only renderer media.
      serveFile: async (urlPath) => {
        const match = /^\/media\/([^/]+)\/(.+)$/.exec(urlPath);
        if (!match || !this.opts.provider.serveMedia) return null;
        return this.opts.provider.serveMedia(match[1]!, match[2]!);
      },
      log: (line) => void this.appLog?.append({ kind: "transport.dropped", message: line }),
    });
    this.worldQuery = new WorldQueryServer(() => this.opts.provider.openStore?.() ?? null);
    // Every session config goes through here, so a per-agent override reaches genesis,
    // authoring, extraction and ask alike — or none of them. Read at build time rather than
    // captured, so changing a model in Settings applies to the next session, not the next run.
    this.sessionInput = (input) => ({
      ...input,
      ...(this.agentOverrides ? { agents: this.agentOverrides } : {}),
      ...(this.skillFamily !== undefined ? { skillFamily: this.skillFamily } : {}),
    });
    this.grants = opts.appRoot ? new GrantStore(opts.appRoot) : null;
    this.authoring =
      opts.adapter && opts.authoring
        ? new AuthoringService(opts.adapter, (event) => this.emit(event), {
            sessionInput: this.sessionInput,
            agentForPurpose: opts.authoring.agentForPurpose,
          })
        : null;
    this.genesis =
      opts.adapter && opts.authoring
        ? new GenesisService(opts.adapter, (event) => this.emit(event), {
            sessionInput: this.sessionInput,
          })
        : null;
    this.setup =
      opts.setup && opts.appRoot
        ? new LocalSetupService(
            opts.setup,
            (event) => {
              // The snapshot carries it too: a window that opens mid-download still sees it.
              if (event.type === "setup.status") {
                const previous = this.readModel.getState().app.setup;
                const completedVoiceModel = event.setup.components.some((component) => {
                  if (component.id !== "kokoro-82m" && component.id !== "whisper-base-en") return false;
                  const before = previous?.components.find((item) => item.id === component.id)?.state;
                  return component.state === "ready" && before !== "ready" && before !== "present";
                });
                this.readModel.setSetup(event.setup);
                if (completedVoiceModel) this.voiceModelsChanged = true;
                if (!event.setup.running && this.voiceModelsChanged) {
                  this.voiceModelsChanged = false;
                  void opts.voice?.restart?.().catch(() => {});
                }
              }
              this.emit(event);
            },
            {
              appRoot: opts.appRoot,
              // The static catalogue plus what the host derives from provider-owned data —
              // the per-recipe weight entries (SPEC-021 §2.4). One list, one service.
              catalogue: [...SETUP_CATALOGUE, ...(opts.setupExtraEntries ?? [])],
              // Weight entries land in the folder the engine actually reads: the same
              // resolver detection, launch and pre-flight use, so nothing can disagree.
              externalDirs: { "comfyui-models": () => this.opts.comfyui?.service.modelsDir() ?? null },
            },
          )
        : null;
    this.askService = opts.authoring
      ? new AskService(opts.adapter, {
          sessionInput: this.sessionInput,
          scratchRoot: opts.appRoot ? `${opts.appRoot}/.ask` : `${opts.changeLogPath}.ask`,
        })
      : null;
  }

  private readonly askService: AskService | null;
  private readonly pendingVoiceReads = new Map<string, { token: string; input: EnqueueInput }>();

  getState(): ClientState {
    const state = this.readModel.getState();
    // Asked of the service on the way out rather than folded in, because a run starts and ends
    // without the world changing, and the world is re-scanned for reasons of its own — anything
    // stored would be stale by the next rescan (issue 239). Allocation-free when nothing is
    // running, which is nearly always.
    const authoringRuns = this.authoring?.liveRuns() ?? [];
    return authoringRuns.length === 0 ? state : { ...state, authoringRuns };
  }

  /**
   * Refuse an action that writes into a proposal while an authoring turn is still writing to it
   * (issue 239). Answers true when it has refused, so the caller returns.
   *
   * Every handler that touches the proposal's files goes through here — accept, discard, rebase,
   * an in-place field edit, a conflict choice — because they all interleave with the agent, not
   * just the two that settle it. `proposal-mark-seen` deliberately does not: it records that a
   * person looked, touches no file the agent is holding, and refusing it would be noise.
   *
   * The refusal is a `proposal.blocked` rather than silence, because a client that got here
   * believed the proposal was settled and needs to be told why nothing happened. It is followed
   * by a snapshot: the client only offered the action because its view of the run was stale, and
   * a reason without the state that closes the gate leaves it free to ask again (review of
   * PR 371). `getState()` reads the live runs at broadcast time, so this needs no rescan.
   */
  private refuseWhileDrafting(worldId: string, proposalId: string): boolean {
    if (!this.authoring?.isRunning(proposalId)) return false;
    this.emit({
      at: new Date().toISOString(),
      type: "proposal.blocked",
      worldId,
      proposalId,
      reason: "drafting",
      detail: "the studio is still writing into this proposal — cancel the run first",
    });
    this.transport.broadcastSnapshot();
    return true;
  }

  private trackBackground<T>(work: Promise<T>): void {
    this.backgroundWork.add(work);
    void work.finally(() => this.backgroundWork.delete(work)).catch(() => {});
  }

  /** Validate, fold, log, broadcast — the one path every event takes (R-3). */
  emit(event: DomainEvent): void {
    const parsed = DomainEventSchema.parse(event);
    this.readModel.apply(parsed);
    if (
      parsed.type !== "health.changed" &&
      parsed.type !== "appearance.changed" &&
      parsed.type !== "update.status" &&
      parsed.type !== "voice.runtime-test"
    ) {
      // Health and application appearance are transient/user-interface state, not domain audit.
      void this.changeLog.append({ kind: "event", event: parsed });
    }
    this.transport.broadcast(parsed);
    try {
      this.opts.observeEvent?.(parsed);
    } catch {
      /* host observers cannot interrupt domain event delivery */
    }
  }

  /**
   * Serialized: two credential changes in quick succession must not run overlapping
   * restart chains — the interleave spawned a second child and reported a spurious terminal
   * "failed" over the one coming up healthy. Tracked in backgroundWork so stop() waits it
   * out — an untracked refresh racing shutdown respawned the harness after its supervisor
   * had already stopped.
   */
  private harnessEnvWork: Promise<void> = Promise.resolve();

  /**
   * Stored LLM keys → the harness spawn environment, via the host's closure. Failure is
   * contained: an unreadable key or a relaunch error leaves readiness to say what the
   * harness can actually do, and the other children unaffected.
   */
  private refreshHarnessEnv(): Promise<void> {
    const run = async (): Promise<void> => {
      if (!this.opts.relaunchHarness || !this.credentials) return;
      const credentials: Record<string, string | undefined> = {};
      for (const provider of LLM_ENV_PROVIDERS) {
        try {
          credentials[provider] = (await this.credentials.get(provider)) ?? undefined;
        } catch {
          /* one unreadable key must not cost the other its delivery */
        }
      }
      try {
        await this.opts.relaunchHarness(credentials);
      } catch {
        /* best-effort by design; the harness's own readiness states the consequence */
      }
    };
    const next = this.harnessEnvWork.then(run, run);
    this.harnessEnvWork = next.catch(() => {});
    this.backgroundWork.add(this.harnessEnvWork);
    void this.harnessEnvWork.finally(() => this.backgroundWork.delete(this.harnessEnvWork));
    return next;
  }

  /** Attach a supervised child and mirror its lifecycle into component health (R-6). */
  superviseAs(component: Exclude<HealthComponent, "coordinator">, supervisor: ChildSupervisor): void {
    this.supervisors.set(component, supervisor);
    supervisor.on("status", ({ status, reason }: { status: SupervisorStatus; reason?: string }) => {
      // A healthy harness process is probed before it counts (SPEC-005 R-2): the adapter asks
      // /doc what the server can do, and an under-capable one stays unavailable with a reason.
      if (component === "harness" && status === "healthy" && this.opts.adapter?.init) {
        const adapter = this.opts.adapter;
        void adapter.init!()
          .then(() => {
            const readiness = adapter.readiness();
            this.emit({
              at: new Date().toISOString(),
              type: "health.changed",
              component,
              status: readiness.ready ? "healthy" : "unavailable",
              ...(readiness.ready
                ? {}
                : { reason: readiness.reason ?? "the harness is missing a required capability" }),
            });
          })
          .catch((err: unknown) => {
            this.emit({
              at: new Date().toISOString(),
              type: "health.changed",
              component,
              status: "unavailable",
              reason: `capability probe failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          });
        return;
      }
      this.emit({
        at: new Date().toISOString(),
        type: "health.changed",
        component,
        status: SUPERVISOR_HEALTH[status].status,
        ...(reason !== undefined ? { reason } : {}),
      });
    });
  }

  async start(port = 0): Promise<{ port: number }> {
    if (this.started) throw new Error("coordinator already started");
    this.started = true;

    // The bible, hand-edited while the app was open (SPEC-022 R-BIBLE-6). No event and no banner:
    // the world simply redraws with what they typed. Without this the store holds the new text
    // and the screen holds the old, which is the most confusing of the three possible states.
    this.opts.provider.onWorldAdopted?.((worldId) => {
      void this.refreshWorldSnapshot(worldId);
    });

    await this.seed();
    await this.seedAppConfig();
    // The engine must be resolved BEFORE queue recovery, not after (SPEC-021 §2.11). Recovery
    // asks the service which engine is configured now, and a null answer means "no engine" —
    // which, run too early, is indistinguishable from "not resolved yet" and fails every
    // in-flight job against a surviving URL engine with "no longer configured". Awaited here
    // and nowhere else: resolution is probing and detection, both bounded; the child process
    // it may spawn is deliberately not awaited (R-6 keeps the app usable while it starts).
    if (this.opts.comfyui && this.appSettings) {
      const settings = await this.appSettings.load();
      await this.opts.comfyui.service.applySettings(settings.comfyui).catch(() => {});
    }
    // Reconcile every non-terminal job before accepting new work (SPEC-009 R-18). The report
    // reaches clients as an event; the folded jobs seed the read model.
    if (this.jobQueue) {
      await this.jobQueue.start();
      this.readModel.seedJobs(this.jobQueue.listJobs());
    }
    this.readModel.setWorlds(await this.opts.provider.listWorlds());

    const boundPort = await this.transport.start(port);
    this.readModel.setHealth("coordinator", { status: "healthy" });

    // The harness adapter's readiness is reflected once at start; a live adapter's own events
    // refine it later (SPEC-005). With no adapter the reason is stated, not silent (R-6).
    if (this.opts.adapter === null && !this.supervisors.has("harness")) {
      this.readModel.setHealth("harness", { status: "unavailable", reason: "OpenCode is not configured" });
    } else if (this.opts.adapter !== null) {
      const readiness = this.opts.adapter.readiness();
      this.readModel.setHealth(
        "harness",
        readiness.ready
          ? { status: "healthy" }
          : { status: "unavailable", reason: readiness.reason ?? "harness not ready" },
      );
    }
    if (!this.supervisors.has("voice")) {
      this.readModel.setHealth("voice", { status: "unavailable", reason: "Voxa is not configured" });
    }

    // First-run environment verification (SPEC-016 R-2, D4): checked once, before any world
    // could be created somewhere it would break, and stated plainly rather than discovered.
    if (this.opts.appRoot) {
      const budget = checkPathBudget(this.opts.appRoot);
      let diskFreeMb: number | null = null;
      try {
        const { statfs } = await import("node:fs/promises");
        const fs = await statfs(this.opts.appRoot);
        diskFreeMb = Math.floor((fs.bavail * fs.bsize) / (1024 * 1024));
      } catch {
        diskFreeMb = null; // unknown, never presented as a failure
      }
      const envCheck = {
        pathBudgetOk: !budget.tight,
        pathBudgetDetail: budget.tight
          ? `the data folder sits ${budget.rootLength} characters deep — worst-case paths reach ${budget.worstCase}, past the classic Windows limit; move it shallower before creating worlds here`
          : null,
        diskFreeMb,
        nativeIndexOk: this.opts.nativeIndex?.ok ?? true,
        nativeIndexDetail:
          this.opts.nativeIndex?.ok === false
            ? (this.opts.nativeIndex.reason ??
              "the native index binding failed to load — search and counts degrade; authoring is unaffected")
            : null,
      };
      // Both: the snapshot so late-joining clients see it at all (the window loads after
      // start() in a packaged build), and the event so an open client updates live.
      this.readModel.setEnv(envCheck);
      this.emit({ at: new Date().toISOString(), type: "env.check", ...envCheck });
    }

    // Local runtimes arrive in the background (R-5 revised): the app is usable throughout, and
    // every component can be skipped. Detection runs first, so a second launch fetches nothing.
    void this.setup?.run();

    // The engine itself resolved before queue recovery (above). What remains is publishing its
    // combined readiness, and keeping it published as the supervised child moves through
    // starting → healthy → failed. Both in the background: the app never waits on an engine.
    if (this.opts.comfyui) {
      this.opts.comfyui.service.subscribe(() => {
        this.trackBackground(this.refreshComfyUi().catch(() => {}));
      });
      this.trackBackground(this.refreshComfyUi().catch(() => {}));
    }

    // The sidecar's four degradation states (SPEC-011 §2.10), polled gently; the app is fully
    // usable in every one of them (R-4).
    if (this.opts.voice?.sidecarHealth) {
      const pollSidecar = async (): Promise<void> => {
        try {
          const status = await this.opts.voice!.sidecarHealth!();
          this.emit({ at: new Date().toISOString(), type: "voice.sidecar", ...status });
        } catch {
          /* the supervisor's own health covers a dead process */
        }
      };
      void pollSidecar();
      const timer = setInterval(() => void pollSidecar(), 20_000);
      timer.unref?.();
    }

    // Stored keys reach the harness child as spawn environment before its first spawn
    // (SPEC-005 D5) — under v2's redirected profile there is no other credential path.
    await this.refreshHarnessEnv();
    for (const supervisor of this.supervisors.values()) {
      void supervisor.start();
    }

    // The permission backstop pump (R-16, R-17): remembered grants answer silently; the rest
    // surface in Studio's language and wait for the user.
    const adapter = this.opts.adapter;
    if (adapter && this.grants) {
      const grants = this.grants;
      void (async () => {
        try {
          for await (const event of adapter.streamEvents()) {
            if (event.type === "permission.requested") {
              this.pendingPermissions.set(event.permissionId, event.actionClass);
              await settlePermission(adapter, grants, (e) => this.emit(e), {
                permissionId: event.permissionId,
                actionClass: event.actionClass,
              });
            }
          }
        } catch {
          /* the pump dies with the adapter; readiness reporting covers it */
        }
      })();
    }

    return { port: boundPort };
  }

  async openWorld(worldId: string): Promise<void> {
    // Captured before the load, because recovery must not run on a world that was already open:
    // it closes any run still marked running, and on the open world that could be a live turn
    // rather than an abandoned one. Held here rather than trusted from the caller — the client
    // does check, but a repair that can destroy live state should not depend on it.
    const wasAlreadyOpen = this.opts.provider.openStore?.()?.worldId === worldId;
    await this.opts.provider.loadWorld(worldId);
    await this.jobQueue?.retryFinalizationsForWorld(worldId);
    const bundle =
      this.opts.provider.openStore?.()?.getBundle() ?? (await this.opts.provider.loadWorld(worldId));
    this.readModel.setWorld(bundle);
    // Before the rows are broadcast, not after: recovery changes what several of them say.
    const store = this.opts.provider.openStore?.();
    if (store && !wasAlreadyOpen) await this.recoverWorldChat(store);
    this.emit({ at: new Date().toISOString(), type: "world.opened", worldId });
    // The bundle itself travels as a fresh snapshot — a world is small enough to re-send (D4).
    this.transport.broadcastSnapshot();
    /*
     * Worlds filed before measuring existed get measured once, here, after the snapshot (issue 283).
     *
     * Deliberately after: opening a world must not wait on a probe per media artifact, and nothing
     * on screen at this moment is waiting for the number. A world opened repeatedly only pays this
     * on the first open that finds something unmeasured, because the pass writes what it learns.
     */
    // `this.stillOpen(store)` as well as identity: two overlapping open-world messages can leave
    // the first holding a store the second has already replaced, and an unconditional abort here
    // would cancel the current world's pass and start one against a store that is already closed
    // (Codex round 1).
    if (store && this.opts.mediaProbe && !this.stopping && this.stillOpen(store) && this.backfillStore !== store) {
      /*
       * One pass per store, and reopening the same world joins the one already running.
       *
       * Aborting and restarting on every open would look free because the signal "cancels" the
       * pass — but it cannot interrupt an ffprobe already in flight, so each reopen would simply
       * add another twenty-second probe alongside the first.
       */
      this.backfillAbort?.abort();
      const abort = new AbortController();
      this.backfillAbort = abort;
      this.backfillStore = store;
      this.startBackfill(store, this.opts.mediaProbe, abort.signal);
    }
  }

  /**
   * Run the measurement pass without anything waiting for it.
   *
   * Deliberately not tracked as background work: `trackBackground` puts a promise in the shutdown
   * drain, and aborting cannot interrupt an ffprobe already in flight — `MediaProbe` has no way to
   * carry a signal — so a slow probe would hold the drain past the desktop's fifteen-second
   * deadline and the last window would not close. This is optional migration work. Its writes are
   * refused once the signal aborts, once the world is no longer open, and by the store itself once
   * that world begins closing; a measurement lost to a shutdown is taken again on the next open.
   */
  private startBackfill(store: WorldStore, probe: MediaProbe, signal: AbortSignal): void {
    void backfillMediaInfo(store, probe, {
      signal,
      stillOpen: () => this.stillOpen(store),
      onMeasured: () => this.refreshIfStillOpen(store),
    })
      .then((result) => {
        /*
         * The attempted marker is kept only when the pass really finished (Codex rounds 3 and 7).
         *
         * Keeping it always meant a world with permanently unreadable media stopped re-running
         * every twenty-second failure on each reopen -- which is why it exists. But a pass that
         * passed over sidecars awaiting reconciliation has not finished: nothing revisits them,
         * and adopting the edit would otherwise leave that media unmeasured for the rest of the
         * session. Deferred work releases the marker so the next open picks it up.
         */
        if (result?.deferred === true && this.backfillStore === store) this.backfillStore = null;
      })
      .catch(() => {
        // A world that cannot be measured is a world that works exactly as it did before.
      });
  }



  /**
   * Put right what a crash left behind, before anything can be done to it (#70 §7.2, phase 1).
   *
   * Two repairs, and both have to happen before the user can reach a control. A run left
   * `running` has no terminal event, so every reader folds it as interrupted for ever and the
   * conversation reports itself in use — it could never be deleted, and no honest reason could be
   * given for that. A wrap-up left mid-flight has the same shape at the other end: proposals may
   * or may not exist under an intent nobody is going to complete.
   *
   * Failure here must not stop a world opening. Neither repair is something the user asked for,
   * and a world they cannot open is a far worse outcome than a conversation still awaiting one.
   */
  private async recoverWorldChat(store: WorldStore): Promise<void> {
    const now = () => new Date().toISOString();
    try {
      const outcome = await recoverConversations(store.dir, now);
      const gate = this.opts.provider.gate?.();
      const wrapUps = gate ? await recoverWrapUps(store, gate, now) : { repaired: [] };
      if (
        outcome.repaired.length > 0 ||
        outcome.sweptTombstones.length > 0 ||
        wrapUps.repaired.length > 0
      ) {
        // Counts only. Conversation identities are operational state and do not enter the log
        // (R-45, §18.2) — what a reader needs from this line is that repair happened at all.
        void this.appLog?.append({
          level: "info",
          event: "world-chat.recovered",
          runs: outcome.repaired.length,
          tombstones: outcome.sweptTombstones.length,
          wrapUps: wrapUps.repaired.length,
        });
      }
      // Repairs are appended events, and nothing else would notice them: `.conversations` is
      // outside the watcher, so the rows the scan produced a moment ago are already stale.
      await this.refreshConversations(store);
    } catch (err) {
      void this.appLog?.append({
        level: "warn",
        event: "world-chat.recovery-failed",
        reason: err instanceof Error ? err.name : "unknown",
      });
    }
  }

  /**
   * Publish the whole tool set, never a patch — the same rule provider.status follows, and for
   * the same reason: a renderer that merges patches can hold a state no coordinator ever had.
   */
  private emitToolStatus(_changed: ProviderToolStatus): void {
    this.emit({
      at: new Date().toISOString(),
      type: "provider.tool-status",
      tools: [...this.providerTools.values()].map((tool) => tool.current()),
    });
  }

  /**
   * A tool's sign-in state decides whether its provider is configured at all, so the two are
   * re-derived together: signing in has to switch the provider on, and a token going stale has
   * to switch it off, without either needing its own button.
   */
  private async revalidateToolProvider(provider: ProviderId): Promise<void> {
    await this.providerService.validate(provider);
    this.emit({
      at: new Date().toISOString(),
      type: "provider.status",
      providers: this.providerService.list(),
    });
  }

  /** Seed the SPEC-008 app-config slice: manifest, provider statuses, routing, spend, drift. */
  private async seedAppConfig(): Promise<void> {
    await this.providerService.init();
    // Discovery before the first paint, so Settings opens on the real answer rather than on
    // "not installed" that corrects itself a moment later.
    for (const [provider, tool] of this.providerTools) {
      await tool.refresh();
      if (tool.current().state === "ready") await this.providerService.validate(provider);
    }
    const manifest = this.opts.manifest ?? null;
    const settings = this.appSettings ? await this.appSettings.load() : null;
    // Read once here so the first session of the run already carries the user's choices —
    // not the second, after something happened to touch settings.
    this.agentOverrides = settings?.agents;
    this.skillFamily = manifest
      ? modelForCapability(manifest, settings?.routing, "video")?.family
      : undefined;
    this.refreshAgents(settings?.agents ?? {});
    const entries = this.ledger ? await this.ledger.readAll() : [];
    this.readModel.seedAppConfig({
      manifest,
      providers: this.providerService.list(),
      providerTools: [...this.providerTools.values()].map((tool) => tool.current()),
      ...(settings && manifest
        ? { routing: { defaults: settings.routing, faults: routingFaults(settings, manifest) } }
        : {}),
      ...(settings ? { models: settings.models } : {}),
      ...(settings ? { presets: settings.presets } : {}),
      ...(settings ? { spend: evaluateSpend(entries, settings.spend, new Date()) } : {}),
      ...(settings ? { backgroundNotifications: settings.backgroundNotifications } : {}),
      ...(settings ? { appearance: settings.appearance } : {}),
      // Without this the narrator was correct on disk and absent from every snapshot, so a
      // restart showed the shipped local voice while a cloud one was actually stored.
      ...(settings ? { narrator: settings.narrator } : {}),
      ...(manifest ? { drift: detectDrift(entries, manifest) } : {}),
      ...(this.opts.harnessInfo ? { harnessInfo: this.opts.harnessInfo } : {}),
    });
  }

  /**
   * The diagnostics bundle (SPEC-008 R-6): app state through the redaction boundary — no key
   * material, no world content. Exposed for the About screen and support flows.
   */
  async diagnostics(): Promise<Record<string, unknown>> {
    return buildDiagnosticsBundle(this.getState(), this.appLog, this.secrets);
  }

  /** A credential failed mid-session: a provider fault naming the provider, never a work failure (R-4). */
  reportProviderFault(provider: ProviderId, message: string): void {
    this.providerService.markFault(provider, message);
    this.emit({
      at: new Date().toISOString(),
      type: "provider.status",
      providers: this.providerService.list(),
    });
  }

  /**
   * Terminal-job follow-ons (SPEC-010): a landed reference tile enters its kit as `generated`
   * (unreviewed — locking is the user's act, R-3); the world snapshot refreshes so the kit
   * surface sees it. Establish candidates just land; the client lists them off the job row.
   */
  private async onJobTerminal(job: Job): Promise<void> {
    if (job.status !== "succeeded") {
      if (job.target.kind === "voice-preview" && typeof job.params["requestId"] === "string") {
        this.emit({
          at: new Date().toISOString(), type: "voice.audio", requestId: job.params["requestId"] as string,
          worldId: job.worldId, sheetId: String(job.params["sheetId"]),
          sheetVersion: Number(job.params["sheetVersion"]),
          purpose: job.params["purpose"] === "sheet-section" ? "sheet-section" : "candidate-preview",
          ...(job.params["sectionHeading"] ? { sectionHeading: String(job.params["sectionHeading"]) } : {}),
          provider: "elevenlabs", model: job.model, voiceId: String(job.params["voiceId"]),
          status: "failed", file: null, cached: false,
          characterCount: Number(job.params["characterCount"] ?? 0),
          estimatedMicroUsd: job.estimatedMicroUsd,
          error: "Voice synthesis failed. Open Activity for details.",
        });
      }
      // A bench take's failure reaches its session log, so the strip says so after a restart
      // without waiting for recovery to notice (issue 305 §6).
      if (job.target.kind === "bench-take") await this.recordBenchTerminal(job).catch(() => {});
      return;
    }
    const finalize = async (store: WorldStore) => {
      if (job.target.kind === "bench-take") {
        const [benchSessionId, benchTakeId] = (job.target.id ?? "").split("/") as [
          SessionId | undefined,
          string | undefined,
        ];
        if (!benchSessionId || !benchTakeId) throw new Error("bench take finalization target is unavailable");
        const landed = job.landedFiles?.[0];
        // Provider success without an artifact is a failed finalization, not an empty take (§6).
        if (landed === undefined) throw new Error("the provider reported success and returned no file");
        const benchStore = new BenchStore(benchSessionDir(store.dir, benchSessionId));
        const session = await benchStore.fold();
        if (!session) throw new Error("the bench session's log is unavailable");
        const take = session.takes.find((t) => t.id === benchTakeId);
        // Replay-safe: a completion already recorded is not recorded again (§6).
        if (take?.media !== undefined) return;
        const bytes = await readFile(toExtendedLength(join(store.dir, landed)));
        const hash = `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
        // Drawn before the take is recorded, so the strip never renders a completed video take
        // in the moment before its picture exists. Best-effort: a poster that could not be made
        // leaves the tile exactly as it was before this existed.
        await writePosterFor(
          toExtendedLength(join(store.dir, landed)),
          this.opts.takePosterMaker,
          (reason) => {
            void this.appLog?.append({ kind: "take.poster-unavailable", jobId: job.id, targetKind: job.target.kind, reason });
          },
        );
        const info = this.opts.mediaProbe
          ? await measureMediaInfo(store, landed, this.opts.mediaProbe).catch(() => null)
          : null;
        const ledgerEntry = this.ledger
          ? (await this.ledger.readAll()).find((entry) => entry.jobId === job.id)
          : undefined;
        await benchStore.append({
          type: "take-completed",
          takeId: benchTakeId as never,
          media: {
            file: basename(landed),
            hash: hash as never,
            ...(info !== null ? { info } : {}),
          },
          cost: {
            estimatedMicroUsd: job.estimatedMicroUsd,
            actualMicroUsd: ledgerEntry?.actualMicroUsd ?? null,
            ...(ledgerEntry?.actualSource !== undefined ? { actualSource: ledgerEntry.actualSource } : {}),
          },
          completedAt: this.nowIso(),
        });
        return;
      }
      if (job.target.kind === "reference-tile" && job.landedFiles?.[0] !== undefined) {
        const [sheetId, angle] = (job.target.id ?? "").split("/") as [string, never];
        const sheet = store.getBundle().sheets.find((s) => s.id === sheetId);
        if (!sheet || !angle) throw new Error("reference tile finalization target is unavailable");
        const withinKit = job.landedFiles[0].replace(`references/${sheetId}/`, "");
        await supersedeTile(store, sheetId, angle, { file: withinKit, sheetVersion: sheet.version });
      }
      // The shared set, not a copy of it. This branch used to carry its own inline list of the
      // four kinds that existed when it was written, while contracts already published the same
      // list as REFERENCE_FINALIZATION_TARGETS. A fifth kind (location-view-candidate) was added
      // to the published set and not to the copy, so its finalization fell straight through,
      // recorded no take, and reported "complete" — the image sat in candidates/ with no way to
      // review it, and the whole accept path was unreachable in a shipped build.
      if (REFERENCE_FINALIZATION_TARGETS.has(job.target.kind)) {
        const ledgerEntry = this.ledger
          ? (await this.ledger.readAll()).find((entry) => entry.jobId === job.id)
          : undefined;
        const take = await recordReferenceTake(store, job, ledgerEntry);
        if (!take) throw new Error("reference take finalization produced no take");
        // The human's own action rule (frames.ts, assign-voice): a composite the user asked for
        // lands designated — there is no review step for the person who pressed the button.
        // Sheet generation has no agent path today; if one arrives, it must stage instead.
        // Failure leaves the take pending, and the review strip still knows how to offer it.
        if (job.target.kind === "character-sheet" && take.media) {
          const sheetId = job.target.id?.split("/")[0];
          const bundle = store.getBundle();
          const sheet = sheetId ? bundle.sheets.find((s) => s.id === sheetId) : undefined;
          const alreadyReviewed = bundle.referenceReviews.some((review) => review.takeId === take.id);
          const frozen = job.params["provenance"] as
            | { sheets?: Record<string, number>; anchorFile?: string }
            | undefined;
          const sheetVersion = sheetId ? frozen?.sheets?.[sheetId] : undefined;
          // Unless the slot was claimed after this job began (PR review). A sheet uploaded while
          // the generation was in flight is the later decision of the two, and it was made by a
          // person; landing on top of it would undo a deliberate choice with no word said. The
          // take is still recorded, so nothing is lost — it waits in the review strip like any
          // other, and accepting it is one press away for whoever wants it.
          const designatedSince = sheetId
            ? ((await readKit(store, sheetId).catch(() => null))?.kit ?? null)
            : null;
          const claimed = designatedSince ? designatedCompilation(designatedSince) : null;
          const outranked = claimed !== null && claimed.compiledAt > job.createdAt;
          if (sheet && sheetId && !alreadyReviewed && !outranked && frozen?.anchorFile && sheetVersion !== undefined) {
            const review = referenceReviewDecision(store.now(), take, "accept");
            await acceptCharacterSheet(store, sheet, {
              file: `takes/${take.id}/${take.media}`,
              takeId: take.id,
              sheetVersion,
              anchorFile: frozen.anchorFile,
              artDirectionVersion: take.provenance.artDirectionVersion ?? bundle.artDirection.version,
              review,
            }).catch(() => {});
          }
        }
      }
      if (
        (job.target.kind === "shot" ||
          job.target.kind === "scene-pass" ||
          job.target.kind === "voice-line") &&
        job.landedFiles?.[0] !== undefined &&
        job.productionId !== undefined
      ) {
        // SPEC-013: the landed media becomes an immutable take (plus segments for a pass).
        const ledgerEntry = this.ledger
          ? (await this.ledger.readAll()).find((e) => e.jobId === job.id)
          : undefined;
        const takes = await recordTakesFromJob(
          store,
          job,
          ledgerEntry?.actualMicroUsd ?? null,
          {
            ...(this.opts.takeQcAnalyzer !== undefined ? { analyzer: this.opts.takeQcAnalyzer } : {}),
            ...(this.opts.takePosterMaker !== undefined ? { poster: this.opts.takePosterMaker } : {}),
            onPosterUnavailable: (reason) => {
              void this.appLog?.append({ kind: "take.poster-unavailable", jobId: job.id, targetKind: job.target.kind, reason });
            },
            // Why a measurement is missing, and nothing else: no media path, no prompt, no world
            // prose, no provider payload. A diagnostic about a clip is not a place to leak one.
            onQcUnavailable: (reason) => {
              void this.appLog?.append({
                kind: "take.qc-unavailable",
                jobId: job.id,
                targetKind: job.target.kind,
                reason,
              });
            },
          },
          // The take agrees with its ledger row about where the figure came from (SPEC-021
          // §2.9): a local job's takes carry local-zero, not manifest-derived.
          ledgerEntry?.actualSource ?? "manifest-derived",
        );
        if (takes.length === 0) throw new Error("production take finalization produced no take");
        for (const take of takes) {
          this.emit({
            at: new Date().toISOString(),
            type: "take.recorded",
            worldId: job.worldId,
            productionId: job.productionId,
            take,
          });
        }
      }
      if (job.target.kind === "voice-preview" && job.landedFiles?.[0] !== undefined) {
        // The audition is ready; the landed file IS the cache entry (R-10).
        const [sheetId, provider, voiceId] = (job.target.id ?? "").split("/");
        if (!sheetId || !provider || !voiceId)
          throw new Error("voice preview finalization target is unavailable");
        this.emit({
          at: new Date().toISOString(),
          type: "voice.preview",
          worldId: job.worldId,
          sheetId,
          provider,
          voiceId,
          file: job.landedFiles[0],
          error: null,
        });
        if (typeof job.params["requestId"] === "string") {
          this.emit({
            at: new Date().toISOString(), type: "voice.audio", requestId: job.params["requestId"] as string,
            worldId: job.worldId, sheetId: String(job.params["sheetId"]),
            sheetVersion: Number(job.params["sheetVersion"]),
            purpose: job.params["purpose"] === "sheet-section" ? "sheet-section" : "candidate-preview",
            ...(job.params["sectionHeading"] ? { sectionHeading: String(job.params["sectionHeading"]) } : {}),
            provider: "elevenlabs", model: job.model, voiceId,
            status: "ready", file: job.landedFiles[0], cached: false,
            characterCount: Number(job.params["characterCount"] ?? 0),
            estimatedMicroUsd: job.estimatedMicroUsd,
          });
        }
      }
    };
    if (this.opts.provider.withWorldStore) {
      await this.opts.provider.withWorldStore(job.worldId, finalize);
    } else {
      const store = this.opts.provider.openStore?.();
      if (!store || store.worldId !== job.worldId) return;
      await finalize(store);
    }
    if (this.opts.provider.openStore?.()?.worldId === job.worldId) {
      await this.refreshWorldSnapshot(job.worldId).catch(() => {});
      // A landed bench take reaches the open workspace without waiting for a reopen.
      if (job.target.kind === "bench-take") {
        const benchSessionId = job.target.id?.split("/")[0] as SessionId | undefined;
        if (benchSessionId) await this.refreshBench(job.worldId, benchSessionId).catch(() => {});
      }
    }
  }

  /** Patch the comfyui settings block, re-apply to the engine service, and republish. */
  private async applyComfyUiPatch(
    patch: Partial<import("@arke-studio/contracts").ComfyUiSettings>,
  ): Promise<void> {
    if (!this.appSettings || !this.opts.comfyui) return;
    const settings = await this.appSettings.setComfyUi(patch);
    await this.opts.comfyui.service.applySettings(settings.comfyui).catch(() => {});
    // Work in flight against the engine that just stopped being the configured one is failed
    // here, with the reason (SPEC-021 §2.11). Without this the poll loop keeps asking the NEW
    // engine about a prompt id only the OLD one ever issued — which reads as "the engine no
    // longer knows this prompt" and looks like the engine lost the job.
    const now = this.opts.comfyui.service.instanceId();
    await this.jobQueue
      ?.failJobsForRetiredEngine(
        "comfyui",
        (job) => job.engine === undefined || job.engine.instanceId === now,
        "the engine this job ran on is no longer configured — it was not resumed against the new one",
      )
      .catch(() => []);
    await this.setup?.detect().catch(() => {});
    await this.refreshComfyUi();
  }

  /** Publish the combined engine + recipe readiness (SPEC-021 §2.12), whole each time. */
  private async refreshComfyUi(): Promise<void> {
    const service = this.opts.comfyui?.service;
    if (!service) return;
    const probes = this.readModel.getState().app.runtime?.probes ?? null;
    const status = await service.status(probes);
    this.emit({ at: new Date().toISOString(), type: "comfyui.status", comfyui: status });
  }

  /**
   * Enqueue a fully-formed dispatch (SPEC-009 §1.2): callers hand over model, params and
   * estimate; the queue owns durability, reconciliation and the ledger. SPEC-012/013 compose
   * the requests; nothing renderer-side may enqueue arbitrary spend.
   */
  async enqueueJob(input: EnqueueInput): Promise<Job> {
    if (!this.jobQueue) throw new Error("dispatch is not configured (no app root or provider clients)");
    return this.jobQueue.enqueue(this.freezeLocalIdentity(input));
  }

  /**
   * Freeze recipe and engine identity onto a local-recipe dispatch before it is journalled
   * (SPEC-021 §2.11, R-15). Cloud inputs pass through untouched; a comfyui input for a model
   * the catalogue does not carry passes through too — admission refuses it with the reason,
   * which beats inventing identity for work that cannot run.
   */
  private freezeLocalIdentity(input: EnqueueInput): EnqueueInput {
    if (input.provider !== "comfyui" || input.recipe !== undefined) return input;
    const identity = this.opts.comfyui?.service.identityFor(input.model);
    if (!identity) return input;
    return {
      ...input,
      recipe: identity.recipe,
      ...(identity.engine !== null ? { engine: identity.engine } : {}),
    };
  }

  private emitEnqueueResult(
    requestId: string,
    command: QueueCommand,
    requestedCount: number,
    acceptedJobIds: Job["id"][],
    failures: Array<{ index: number; reason: string }>,
    notQueued = false,
  ): void {
    const disposition = notQueued
      ? "not-queued"
      : acceptedJobIds.length === 0
        ? "rejected"
        : failures.length > 0
          ? "partial"
          : "accepted";
    this.emit({
      at: new Date().toISOString(),
      type: "queue.enqueue-result",
      requestId,
      command,
      disposition,
      requestedCount,
      acceptedJobIds,
      failures,
    });
  }

  private rejectEnqueue(requestId: string, command: QueueCommand, reason: string): void {
    this.emitEnqueueResult(requestId, command, 1, [], [{ index: 0, reason }]);
  }

  private async enqueueBatch(
    requestId: string,
    command: QueueCommand,
    inputs: readonly EnqueueInput[],
  ): Promise<{ accepted: boolean; reason?: string }> {
    if (!this.jobQueue) {
      this.rejectEnqueue(
        requestId,
        command,
        "The job queue is unavailable. Try again after restarting the studio.",
      );
      return { accepted: false, reason: "The job queue is unavailable. Try again after restarting the studio." };
    }
    if (inputs.length === 0) {
      this.emitEnqueueResult(requestId, command, 0, [], [], true);
      return { accepted: true };
    }
    const outcome = await enqueueInputs(inputs, (input) => this.jobQueue!.enqueue(this.freezeLocalIdentity(input)));
    this.emitEnqueueResult(
      requestId,
      command,
      outcome.requestedCount,
      outcome.acceptedJobIds,
      outcome.failures,
    );
    return { accepted: outcome.acceptedJobIds.length > 0, ...(outcome.failures[0]?.reason ? { reason: outcome.failures[0].reason } : {}) };
  }

  /**
   * Record a terminal job outcome (SPEC-008 R-16): append to the ledger, mirror to the app
   * index via the event fold, re-evaluate the rolling threshold (R-19) and drift (R-13).
   * SPEC-009's dispatcher calls this; fixtures and tests call it directly.
   */
  async recordLedger(entry: LedgerEntry): Promise<void> {
    if (this.ledger) await this.ledger.append(entry);
    this.emit({ at: new Date().toISOString(), type: "ledger.appended", entry });
    const settings = this.appSettings ? await this.appSettings.load() : null;
    if (!settings) return;
    const entries = this.ledger ? await this.ledger.readAll() : this.getState().app.ledger;
    const spend = evaluateSpend(entries, settings.spend, new Date());
    const wasAlerted = this.getState().app.spend?.alerted ?? false;
    this.emit({ at: new Date().toISOString(), type: "spend.status", spend });
    if (spend.alerted && !wasAlerted) {
      void this.appLog?.append({
        kind: "spend.alert",
        rollingMicroUsd: spend.rollingMicroUsd,
        settings: settings.spend,
      });
    }
    if (this.opts.manifest) {
      const drift = detectDrift(entries, this.opts.manifest);
      if (JSON.stringify(drift) !== JSON.stringify(this.getState().app.drift)) {
        this.emit({ at: new Date().toISOString(), type: "manifest.drift", reports: drift });
      }
    }
  }

  private async handleClientMessage(msg: ClientMessage): Promise<void> {
    if (this.stopping) return;
    switch (msg.kind) {
      case "hello":
        return; // handled inside the transport
      case "open-world":
        try {
          await this.openWorld(msg.worldId);
        } catch {
          // An unknown world id is a stale client; the next snapshot corrects it.
        }
        return;
      case "create-world": {
        const create = this.opts.provider.createWorld?.bind(this.opts.provider);
        if (!create) return;
        try {
          const { worldId } = await create({
            name: msg.name,
            ...(msg.logline !== undefined ? { logline: msg.logline } : {}),
            ...(msg.tone !== undefined ? { tone: msg.tone } : {}),
            ...(msg.genre !== undefined ? { genre: msg.genre } : {}),
            ...(msg.artDirection !== undefined ? { artDirection: msg.artDirection } : {}),
          });
          this.readModel.setWorlds(await this.opts.provider.listWorlds());
          await this.openWorld(worldId);
          // After the world is open, so filing has a store to commit into. Whatever was handed
          // to the conversation is now an artifact like any other.
          const genesisId = msg.genesisId;
          if (genesisId !== undefined) {
            // Held so a discard cannot delete the sandbox out from under the copy. The screen
            // discards as soon as the world opens, which is while this is still running.
            const carry = this.carryGenesisAttachments(genesisId, worldId);
            this.carrying.set(genesisId, carry);
            await carry.finally(() => this.carrying.delete(genesisId));
          }
        } catch {
          this.transport.broadcastSnapshot(); // surface whatever state we do have
        }
        return;
      }
      case "archive-world": {
        // Anything not in this set is still going somewhere, so the world stays put.
        const TERMINAL_JOB_STATUS = new Set(["succeeded", "failed", "cancelled"]);
        const archive = this.opts.provider.archiveWorld?.bind(this.opts.provider);
        if (!archive) return;

        const summary = this.readModel.getState().worlds.find((w) => w.worldId === msg.worldId);
        const refuse = (reason: string) =>
          this.emit({
            at: new Date().toISOString(),
            type: "world.archive-refused",
            worldId: msg.worldId,
            reason,
          });
        // Work in flight keeps its world. Moving the folder under a running job turns a job
        // that would have finished into one that fails writing its result somewhere gone.
        const inFlight = this.readModel
          .getState()
          .app.jobs.filter((j) => j.worldId === msg.worldId && !TERMINAL_JOB_STATUS.has(j.status));
        if (inFlight.length > 0) {
          refuse(
            `${inFlight.length} job${inFlight.length === 1 ? " is" : "s are"} still running for this world — let them finish or cancel them first`,
          );
          return;
        }
        try {
          const { folder } = await archive(msg.worldId);
          if (this.readModel.getState().world?.meta.worldId === msg.worldId) this.readModel.setWorld(null);
          this.readModel.setWorlds(await this.opts.provider.listWorlds());
          this.emit({
            at: new Date().toISOString(),
            type: "world.archived",
            worldId: msg.worldId,
            name: summary?.name ?? "that world",
            folder: basename(folder),
          });
        } catch (err) {
          refuse(err instanceof Error ? err.message : String(err));
        }
        this.transport.broadcastSnapshot();
        return;
      }
      case "install-sample-world": {
        const install = this.opts.provider.installSampleWorld?.bind(this.opts.provider);
        const source = this.opts.sampleWorldPath ?? null;
        const refuse = (reason: string) => {
          this.readModel.setSampleWorld({ installing: false, note: { text: reason, refused: true } });
          this.emit({ at: new Date().toISOString(), type: "sample-world.refused", reason });
        };
        if (!install || source === null) {
          refuse("this build does not carry the sample world");
          this.transport.broadcastSnapshot();
          return;
        }
        // Megabytes of art take a moment to copy. The flag is what stops a second click
        // starting a second copy while the first is still being written.
        this.readModel.setSampleWorld({ installing: true, note: null });
        this.transport.broadcastSnapshot();
        try {
          const { worldId, slug, name } = await install(source);
          this.readModel.setWorlds(await this.opts.provider.listWorlds());
          this.readModel.setSampleWorld({
            installing: false,
            note: { text: `${name} is in your library.`, refused: false },
          });
          this.emit({ at: new Date().toISOString(), type: "sample-world.installed", worldId, slug, name });
        } catch (err) {
          refuse(err instanceof Error ? err.message : String(err));
        }
        this.transport.broadcastSnapshot();
        return;
      }
      case "reconcile-external-edit": {
        const reconcile = this.opts.provider.reconcileExternalEdit?.bind(this.opts.provider);
        if (!reconcile) return;
        try {
          this.readModel.setWorld(await reconcile(msg.worldId, msg.path));
        } catch {
          /* refusal shows up as the edit still listed */
        }
        this.transport.broadcastSnapshot();
        return;
      }
      case "stage-sheet-edit": {
        const gate = this.opts.provider.gate?.();
        if (!gate) return;
        try {
          const proposal = await gate.stageSheetEdit(msg.path, msg.summary, msg.sections, "form", msg.role);
          this.emit({
            at: new Date().toISOString(),
            type: "proposal.staged",
            worldId: msg.worldId,
            proposalId: proposal.id,
          });
        } catch {
          /* the snapshot below carries whatever state resulted */
        }
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "stage-art-direction-change": {
        const gate = this.opts.provider.gate?.();
        if (!gate) return;
        try {
          const proposal = await gate.stageArtDirectionChange(msg.description, msg.masterLook);
          this.emit({
            at: new Date().toISOString(),
            type: "proposal.staged",
            worldId: msg.worldId,
            proposalId: proposal.id,
          });
        } catch {
          /* the refreshed snapshot is authoritative */
        }
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "set-art-direction": {
        // The human's own action (the assign-voice rule): stage and accept in one motion, so
        // the history and ripples are identical to a reviewed change — the only thing removed
        // is the proposal waiting on the person who just typed it. If the accept refuses, the
        // staged proposal is left standing rather than the work lost.
        const gate = this.opts.provider.gate?.();
        if (!gate) return;
        try {
          const proposal = await gate.stageArtDirectionChange(msg.description, msg.masterLook);
          await gate.accept(proposal.id, {});
        } catch {
          /* the refreshed snapshot is authoritative */
        }
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "proposal-accept": {
        const gate = this.opts.provider.gate?.();
        if (!gate) return;
        // A proposal being written into is not a proposal to commit (issue 239). The client hides
        // Accept while a run is live, but it learns that from a snapshot it may have taken a
        // moment ago, and the run is here — so the refusal is made where the answer is known.
        if (this.refuseWhileDrafting(msg.worldId, msg.proposalId)) return;
        // Read before accepting: acceptance rewrites the manifest, and the origin is needed to
        // tell the conversation what became of its propositions.
        const acceptedFrom = await gate.readManifest(msg.proposalId).catch(() => null);
        try {
          const outcome = await gate.accept(
            msg.proposalId,
            msg.confirmRipples === undefined ? {} : { confirmRipples: msg.confirmRipples },
          );
          const at = new Date().toISOString();
          if (outcome.status === "accepted") {
            this.authoring?.release(msg.proposalId);
            const store = this.opts.provider.openStore?.();
            if (store && acceptedFrom) {
              await recordResolution(store, acceptedFrom, "accepted", () => at);
            }
            this.emit({
              at,
              type: "proposal.resolved",
              worldId: msg.worldId,
              proposalId: msg.proposalId,
              outcome: "accepted",
            });
          } else {
            this.emit({
              at,
              type: "proposal.blocked",
              worldId: msg.worldId,
              proposalId: msg.proposalId,
              reason:
                outcome.status === "needs-reconfirm"
                  ? "needs-reconfirm"
                  : outcome.status === "no-op"
                    ? "no-op"
                    : outcome.status === "stale"
                      ? "stale"
                      : outcome.status === "pending-review"
                        ? "pending-review"
                        : outcome.status === "unresolved-conflicts"
                          ? "unresolved-conflicts"
                          : outcome.status === "invalid"
                            ? "invalid"
                            : outcome.status === "draft-unresolved"
                              ? "draft-unresolved"
                              : "target-retired",
              detail:
                outcome.status === "stale"
                  ? `moved since drafting: ${outcome.stalePaths.join(", ")}`
                  : outcome.status === "no-op"
                    ? "the proposal is identical to the live world — nothing to commit"
                    : outcome.status === "unresolved-conflicts"
                      ? `${outcome.count} conflicted field${outcome.count === 1 ? "" : "s"} await a choice`
                      : outcome.status === "target-retired"
                        ? `retired: ${outcome.paths.join(", ")}`
                        : outcome.status === "invalid"
                          ? outcome.problems.map((p) => `${p.path}: ${p.message}`).join("; ")
                          : outcome.status === "draft-unresolved"
                            ? "an earlier edit to this proposal did not finish, and what its files now say is unknown"
                            : undefined,
              ...(outcome.status === "needs-reconfirm" ? { authoritativeSignature: outcome.signature } : {}),
            });
          }
        } catch {
          /* surfaced only through the refreshed snapshot */
        }
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "proposal-discard": {
        const gate = this.opts.provider.gate?.();
        if (!gate) return;
        // Discarding mid-run would delete the directory the agent is writing into (issue 239).
        // Cancel is the way to stop a run, and it leaves the proposal to be discarded after.
        if (this.refuseWhileDrafting(msg.worldId, msg.proposalId)) return;
        const discardedFrom = await gate.readManifest(msg.proposalId).catch(() => null);
        try {
          await gate.discard(msg.proposalId);
          const store = this.opts.provider.openStore?.();
          if (store && discardedFrom) {
            await recordResolution(store, discardedFrom, "discarded", () => new Date().toISOString());
          }
          this.emit({
            at: new Date().toISOString(),
            type: "proposal.resolved",
            worldId: msg.worldId,
            proposalId: msg.proposalId,
            outcome: "discarded",
          });
          this.authoring?.release(msg.proposalId);
        } catch {
          /* snapshot below */
        }
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "proposal-rebase": {
        const gate = this.opts.provider.gate?.();
        if (!gate) return;
        // Rebasing rewrites the captured base under files the agent has open (issue 239).
        if (this.refuseWhileDrafting(msg.worldId, msg.proposalId)) return;
        await gate.rebase(msg.proposalId).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "proposal-resolve-conflict": {
        const gate = this.opts.provider.gate?.();
        if (!gate) return;
        // A choice written into a file the agent is still writing is a choice about to be lost.
        if (this.refuseWhileDrafting(msg.worldId, msg.proposalId)) return;
        await gate.resolveConflict(msg.proposalId, msg.path, msg.field, msg.choice).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "proposal-mark-seen": {
        const gate = this.opts.provider.gate?.();
        if (!gate) return;
        await gate.markSeen(msg.proposalId).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "proposal-update-field": {
        const gate = this.opts.provider.gate?.();
        if (!gate) return;
        // The journal's revision check cannot see the agent, which does not write through it —
        // so an edit landing mid-run is the interleaving it exists to refuse, unnoticed.
        if (this.refuseWhileDrafting(msg.worldId, msg.proposalId)) return;
        const outcome = await gate
          .updateField({
            proposalId: msg.proposalId,
            requestId: msg.requestId,
            path: msg.path,
            field: msg.field,
            value: msg.value,
            expectedDraftRevision: msg.expectedDraftRevision,
          })
          .catch(() => null);
        // A refusal is said out loud. The screen is showing a value the person just typed, and
        // silently reverting it on the next snapshot would read as the app losing their work
        // rather than as somebody else having changed it first.
        if (outcome && outcome.status !== "updated") {
          this.emit({
            at: new Date().toISOString(),
            type: "proposal.blocked",
            worldId: msg.worldId,
            proposalId: msg.proposalId,
            reason:
              outcome.status === "stale"
                ? "stale"
                : outcome.status === "draft-unresolved"
                  ? "draft-unresolved"
                  : "invalid",
            detail:
              outcome.status === "stale"
                ? "somebody changed this proposal while you were editing — it has been reloaded"
                : outcome.status === "rejected"
                  ? outcome.message
                  : outcome.status === "unknown-target"
                    ? "that file is not part of this proposal"
                    : "an earlier edit to this proposal did not finish, and what its files now say is unknown",
          });
        }
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "world-chat-open": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        if (msg.conversationId === null) {
          this.readModel.setWorldChat(null);
          this.transport.broadcastSnapshot();
          return;
        }
        await this.openWorldChat(store, msg.conversationId);
        return;
      }
      case "world-chat-send": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const service = new WorldChatService(store.dir);
        const log = new WorldChatStore(conversationDir(store.dir, msg.conversationId));
        if (!(await log.readMeta())) return;

        /**
         * A conversation is named by the first thing said in it.
         *
         * It is created before anyone knows what it is about, so it starts as "New conversation";
         * leaving it there would give somebody a list of identical rows. The opening sentence is
         * what they would have called it anyway.
         */
        const before = await log.read();
        const isFirst = !before.events.some((e) => e.event.type === "turn.started");
        if (isFirst) {
          await service.rename(msg.conversationId, titleFrom(msg.text)).catch(() => {});
        }

        const runner = this.worldChatRunner(store, msg.conversationId);
        // The screen shows the message and the spinner as soon as the turn starts, so the
        // snapshot is pushed before the model is waited on rather than after.
        const inFlight = runner.send(log, msg.conversationId, msg.text, msg.attachmentIds);
        // The title may have just changed, and the screen shows the message immediately.
        await this.refreshConversations(store);
        await this.openWorldChat(store, msg.conversationId);
        await inFlight;
        await this.refreshWorldSnapshot(msg.worldId);
        await this.refreshConversations(store);
        await this.openWorldChat(store, msg.conversationId);
        void service;
        return;
      }
      case "world-chat-retry-turn": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const log = new WorldChatStore(conversationDir(store.dir, msg.conversationId));
        if (!(await log.readMeta())) return;

        const runner = this.worldChatRunner(store, msg.conversationId);
        const inFlight = runner.retry(log, msg.conversationId, msg.turnId);
        // The spinner replaces the failure notice immediately, so pressing it looks like it worked.
        await this.openWorldChat(store, msg.conversationId);
        await inFlight;
        await this.refreshWorldSnapshot(msg.worldId);
        await this.refreshConversations(store);
        await this.openWorldChat(store, msg.conversationId);
        return;
      }
      case "world-chat-save-point": {
        const store = this.opts.provider.openStore?.();
        const gate = this.opts.provider.gate?.();
        if (!store || !gate) return;
        try {
          /*
           * Staged and accepted in one motion — the assign-voice rule, which the art-direction
           * form already follows: being asked to approve a change you just approved is two steps
           * for one decision. The gate still does the whole job, so the history, the ripples and
           * the change log are identical to a proposal reviewed on the approvals screen; the only
           * thing removed is the screen.
           */
          const saved = await savePoint({
            store,
            gate,
            conversationId: msg.conversationId,
            requestId: msg.requestId,
            candidateId: msg.candidateId,
            expectedCandidateRevision: msg.expectedCandidateRevision,
            ...(msg.expectedGroupRevisions ? { expectedGroupRevisions: msg.expectedGroupRevisions } : {}),
            now: () => new Date().toISOString(),
          });
          for (const proposalId of saved.proposalIds) {
            const staged = await gate.readManifest(proposalId).catch(() => null);
            /*
             * A proposal asking a question is never answered by a press.
             *
             * "This looks close to Bray Half-Hitch — is it a new rule, or a change to that one?"
             * has exactly one person who can answer it, and accepting past it would pick the
             * create silently and put a duplicate in the world. It stays a proposal, which is
             * where that question can be put.
             */
            if (staged?.openChoices?.length) {
              /*
               * Said, not swallowed. The rail promised Save would write this, and instead it has
               * become a question — the point leaves the rail either way, so without this it
               * simply disappears and the promise is what the person remembers.
               */
              this.emit({
                at: new Date().toISOString(),
                type: "world-chat.wrap-up-refused",
                conversationId: msg.conversationId,
                requestId: msg.requestId,
                reason: "unknown",
                detail: refusalDetail(`${staged.openChoices[0]!.question} It is waiting on the proposals screen, where you can answer it.`),
              });
              continue;
            }
            const outcome = await acceptDecided(gate, proposalId);
            const at = new Date().toISOString();
            if (outcome.status === "accepted" && staged) {
              // The conversation's own account of what became of its propositions (§6.5).
              await recordResolution(store, staged, "accepted", () => at);
              this.emit({ at, type: "proposal.resolved", worldId: msg.worldId, proposalId, outcome: "accepted" });
            } else if (outcome.status !== "accepted") {
              /*
               * Not written, so not left proposed either — the same taking-back Accept all does.
               *
               * This used to leave the proposal standing, on the reasoning that a waiting proposal
               * is a state a person can finish. What that missed is that staging had already
               * marked the proposition `proposed`: the point left the rail, the conversation had
               * nothing left to correct it from, and the change surfaced on the Cast and approvals
               * screens as a draft that could not be accepted — while the rail said only that the
               * gate had answered a word. Back on the rail it can be talked about, which for every
               * refusal the gate raises is the repair.
               */
              if (staged) {
                await returnToRail(
                  new WorldChatStore(conversationDir(store.dir, msg.conversationId)),
                  gate,
                  staged,
                  () => new Date().toISOString(),
                );
              }
              this.emit({
                at,
                type: "world-chat.wrap-up-refused",
                conversationId: msg.conversationId,
                requestId: msg.requestId,
                reason: "unknown",
                detail: refusalDetail(`This could not be written, so it is back above: ${explainAcceptRefusal(outcome)}.`),
              });
            }
          }
        } catch (err) {
          const reason = err instanceof WrapUpError ? err.reason : "unknown";
          void this.appLog?.append({ level: "warn", event: "world-chat.save-point-refused", reason });
          this.emit({
            at: new Date().toISOString(),
            type: "world-chat.wrap-up-refused",
            conversationId: msg.conversationId,
            requestId: msg.requestId,
            reason,
            detail:
              refusalDetail(err instanceof WrapUpError ? err.message : "This could not be written, so nothing was."),
          });
        }
        await this.refreshWorldSnapshot(msg.worldId);
        await this.refreshConversations(store);
        await this.openWorldChat(store, msg.conversationId);
        return;
      }
      case "world-chat-reject-point": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        try {
          await rejectPoint({
            store,
            conversationId: msg.conversationId,
            candidateId: msg.candidateId,
            expectedCandidateRevision: msg.expectedCandidateRevision,
            ...(msg.expectedGroupRevisions ? { expectedGroupRevisions: msg.expectedGroupRevisions } : {}),
            now: () => new Date().toISOString(),
          });
        } catch (err) {
          this.emit({
            at: new Date().toISOString(),
            type: "world-chat.wrap-up-refused",
            conversationId: msg.conversationId,
            requestId: msg.requestId,
            reason: err instanceof WrapUpError ? err.reason : "unknown",
            detail:
              refusalDetail(err instanceof WrapUpError ? err.message : "That point could not be dropped, so it was left alone."),
          });
        }
        // The list counts live points and orders by what is waiting, so it moves when one goes.
        await this.refreshConversations(store);
        await this.openWorldChat(store, msg.conversationId);
        return;
      }
      case "world-chat-wrap-up": {
        const store = this.opts.provider.openStore?.();
        const gate = this.opts.provider.gate?.();
        if (!store || !gate) return;
        try {
          await wrapUp({
            store,
            gate,
            conversationId: msg.conversationId,
            requestId: msg.requestId,
            expectedConversationSeq: msg.expectedConversationSeq,
            now: () => new Date().toISOString(),
            /*
             * Accept all writes; it does not stage for a screen the person then has to visit.
             *
             * The conversation is where the deciding happens now, and pressing a button labelled
             * Accept and being taken somewhere else to accept again was the two-step this design
             * removed. Each still goes through the gate, so what lands is identical to a reviewed
             * proposal — only the review is the press that just happened. Handed to wrap-up rather
             * than run after it, because a proposal that will not land has to keep the
             * conversation open, and only wrap-up can still decide not to close.
             *
             * A proposal carrying an open choice is left standing and counted as landed: it is
             * asking a question only the person can answer, so it is not a failure to write — it
             * is the one thing this press was never allowed to decide.
             */
            writeThrough: async (proposalId) => {
              const staged = await gate.readManifest(proposalId).catch(() => null);
              if (staged?.openChoices?.length) return null;
              const outcome = await acceptDecided(gate, proposalId);
              const at = new Date().toISOString();
              // The gate's own words, carried out to the rail. Discarding them left the person
              // with a count and no cause, and left this path undiagnosable from a log.
              if (outcome.status !== "accepted") return explainAcceptRefusal(outcome);
              if (staged) {
                await recordResolution(store, staged, "accepted", () => at);
                this.emit({ at, type: "proposal.resolved", worldId: msg.worldId, proposalId, outcome: "accepted" });
              }
              return null;
            },
          });
        } catch (err) {
          // A refusal is the answer: nothing was written, and the conversation is still open and
          // still says what it understood. It is said to the screen as well as to the log, because
          // the person is standing in front of the button that did nothing, and a reason only the
          // log can see is not a reason they were given.
          //
          // Only a WrapUpError carries that promise. Wrap-up is a recoverable saga, not one
          // transaction, so anything else — an I/O failure part-way through staging — may have
          // left proposals behind, and saying "nothing was written" there would be a guess
          // presented as a fact. That case says what is known and where to look instead.
          const reason = err instanceof WrapUpError ? err.reason : "unknown";
          void this.appLog?.append({ level: "warn", event: "world-chat.wrap-up-refused", reason });
          this.emit({
            at: new Date().toISOString(),
            type: "world-chat.wrap-up-refused",
            conversationId: msg.conversationId,
            // Named, because this goes to every client: without it a second window's refusal
            // would settle the first window's wrap-up while its proposals were still being made.
            requestId: msg.requestId,
            reason,
            // Every WrapUpError message is already written for a person to read; anything else is
            // ours to explain and not theirs to decode.
            detail:
              refusalDetail(err instanceof WrapUpError
                ? err.message
                : "This did not finish. Check the proposals before trying again — some of them may already be there."),
          });
        }
        await this.refreshWorldSnapshot(msg.worldId);
        await this.refreshConversations(store);
        await this.openWorldChat(store, msg.conversationId);
        return;
      }
      case "proposal-send-back": {
        const store = this.opts.provider.openStore?.();
        const gate = this.opts.provider.gate?.();
        if (!store || !gate) return;
        const proposal = await gate.readManifest(msg.proposalId).catch(() => null);
        if (!proposal) return;
        const conversationId = await sendBack(store, gate, proposal, () => new Date().toISOString()).catch(
          () => null,
        );
        await this.refreshWorldSnapshot(msg.worldId);
        await this.refreshConversations(store);
        if (conversationId) await this.openWorldChat(store, conversationId);
        return;
      }
      case "world-chat-cancel": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        this.worldChatRunner(store, msg.conversationId).cancel(msg.conversationId);
        return;
      }
      case "world-chat-create": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        // The first conversation crosses the schema boundary (#70 §4.1, issue #403): older
        // builds must refuse this world rather than export `.conversations` they do not know
        // to exclude. The raise is durable before the conversation directory exists.
        await store.ensureSchemaVersion(2, "world-chat");
        const service = new WorldChatService(store.dir);
        const row = await service.create({
          title: msg.title,
          requestId: msg.requestId,
          ...(msg.entryContext ? { entryContext: msg.entryContext } : {}),
        });
        await this.refreshConversations(store);
        await this.openWorldChat(store, row.id);
        return;
      }
      case "world-chat-delete": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        try {
          await new WorldChatService(store.dir).delete(msg.conversationId, msg.requestId);
        } catch (err) {
          // A refusal is an answer, not a failure: the conversation is untouched and the row
          // still says which dependency is holding it. Rechecked here rather than trusted from
          // the row, because a turn may have started since that row was drawn.
          void this.appLog?.append({
            level: "warn",
            event: "world-chat.delete-refused",
            reason: err instanceof ConversationInUseError ? err.reason : "unknown",
          });
          await this.refreshConversations(store);
          this.transport.broadcastSnapshot();
          return;
        }
        // The screen the user is standing on may be the one just deleted. Releasing it here means
        // they land on "that conversation is not here" rather than a transcript with no file.
        if (this.readModel.getState().worldChat?.conversationId === msg.conversationId) {
          this.readModel.setWorldChat(null);
        }
        await this.refreshConversations(store);
        this.transport.broadcastSnapshot();
        return;
      }
      case "world-chat-attach": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await this.attachToWorldChat(store, msg.conversationId, msg.sourcePath);
        await this.openWorldChat(store, msg.conversationId);
        return;
      }
      case "world-chat-attach-files": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const pick = this.opts.pickFiles;
        if (!pick) {
          this.emit({
            at: new Date().toISOString(),
            type: "world-chat.attachment-refused",
            conversationId: msg.conversationId,
            name: "attaching",
            reason: "this needs the desktop app — a browser session cannot open the file picker",
          });
          return;
        }
        // Only what a conversation can actually read is offered (§13.2). Cancelling the dialog
        // is an answer: nothing is said and nothing happens.
        const paths = await pick({ accept: CHAT_DOCUMENT_EXTENSIONS }).catch(() => [] as readonly string[]);
        for (const sourcePath of paths) {
          await this.attachToWorldChat(store, msg.conversationId, sourcePath);
        }
        await this.openWorldChat(store, msg.conversationId);
        return;
      }
      case "world-chat-set-initiative": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await new WorldChatService(store.dir).setInitiative(msg.conversationId, msg.initiative);
        await this.refreshConversations(store);
        if (this.readModel.getState().worldChat?.conversationId === msg.conversationId) {
          await this.openWorldChat(store, msg.conversationId);
        } else {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "world-chat-archive":
      case "world-chat-unarchive": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const service = new WorldChatService(store.dir);
        if (msg.kind === "world-chat-archive") await service.archive(msg.conversationId);
        else await service.unarchive(msg.conversationId);
        await this.refreshConversations(store);
        // Archiving loses nothing, so an open transcript stays open and simply reads as archived.
        if (this.readModel.getState().worldChat?.conversationId === msg.conversationId) {
          await this.openWorldChat(store, msg.conversationId);
        } else {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "draft-with-studio": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store || !this.authoring) return;
        try {
          // A proposalId continues that proposal's conversation — same session, same agent
          // context; without one, a fresh proposal is staged and the conversation begins.
          let proposalId = msg.proposalId ?? null;
          if (proposalId === null) {
            const proposal = await gate.stage({
              kind: "sheet-edit",
              summary: msg.summary,
              source: "chat:studio",
              targets: [{ path: msg.path }],
            });
            proposalId = proposal.id;
            this.emit({
              at: new Date().toISOString(),
              type: "proposal.staged",
              worldId: msg.worldId,
              proposalId: proposal.id,
            });
            await this.refreshWorldSnapshot(msg.worldId);
          }
          const worldQueryUrl = await this.worldQuery.start();
          // Fire and watch: progress and the final status arrive as events (R-13).
          this.trackBackground(this.authoring
            .run(
              store,
              gate,
              {
                worldId: msg.worldId,
                proposalId,
                purpose: "authoring",
                instruction: msg.instruction,
              },
              worldQueryUrl,
            )
            .then(() => this.refreshWorldSnapshot(msg.worldId)));
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "genesis-chat": {
        const failed = (detail: string) =>
          this.emit({
            at: new Date().toISOString(),
            type: "genesis.status",
            genesisId: msg.genesisId,
            status: "failed",
            detail,
          });
        if (!this.genesis || !this.opts.provider.genesisDir) {
          failed("authoring is not configured");
          return;
        }
        try {
          const dir = await this.opts.provider.genesisDir(msg.genesisId);
          // Fire and watch: turns, the draft and the final status arrive as events.
          this.trackBackground(this.genesis.run(dir, msg.genesisId, msg.text));
        } catch (err) {
          failed(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      case "setup-skip": {
        this.setup?.skip(msg.componentId);
        return;
      }
      case "setup-retry": {
        this.setup?.retry(msg.componentId);
        return;
      }
      case "setup-cancel": {
        this.setup?.cancel();
        return;
      }
      case "genesis-discard": {
        this.genesis?.release(msg.genesisId);
        // Anything still being carried into the new world finishes first — otherwise Begin
        // races the sweep and the files handed over are the ones that vanish.
        await this.carrying.get(msg.genesisId)?.catch(() => {});
        await this.opts.provider.discardGenesis?.(msg.genesisId)?.catch(() => {});
        return;
      }
      case "authoring-cancel": {
        await this.authoring?.cancel(msg.proposalId);
        return;
      }
      case "canon-ask": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        // Fire and watch: the result arrives as one canon.answer event, refusals included.
        this.trackBackground((async () => {
          const worldQueryUrl =
            this.askService && this.opts.adapter ? await this.worldQuery.start() : undefined;
          const fallback: import("@arke-studio/contracts").AskResult = {
            outcome: "unavailable",
            reason: "authoring is not configured",
            searched: 0,
            closest: [],
          };
          const result = this.askService
            ? await this.askService.ask(store, msg.question, worldQueryUrl)
            : fallback;
          this.emit({
            at: new Date().toISOString(),
            type: "canon.answer",
            worldId: msg.worldId,
            askId: msg.askId,
            result,
          });
        })());
        return;
      }
      case "canon-search": {
        const index = this.opts.provider.openStore?.()?.getIndex();
        if (!index) return;
        const result = searchCanon(index.db, msg.query, { limit: 12 });
        this.emit({
          at: new Date().toISOString(),
          type: "canon.search",
          worldId: msg.worldId,
          searchId: msg.searchId,
          searched: result.searched,
          floorCleared: result.floorCleared,
          candidates: result.candidates.map((c) => ({ entryId: c.entryId, title: c.title, score: c.score })),
        });
        return;
      }
      case "canon-refs": {
        const store = this.opts.provider.openStore?.();
        const index = store?.getIndex();
        if (!store || !index) return;
        const entry = store.getBundle().canon.find((c) => c.id === msg.entryId);
        const refs = refsForCanon(index.db, msg.entryId);
        const ripples = entry
          ? ripplesForCanonEntry(index.db, { entryId: entry.id, title: entry.title, statement: entry.body })
          : [];
        this.emit({
          at: new Date().toISOString(),
          type: "canon.refs",
          worldId: msg.worldId,
          entryId: msg.entryId,
          citedBy: { sheets: refs.sheets, entries: refs.entries, productions: refs.productions },
          ripples: ripples.map((r) => ({ kind: r.kind, summary: r.summary, targets: r.targets })),
        });
        return;
      }
      case "stage-canon-entry": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        try {
          const proposal = await stageCanonEntry(store, gate, {
            entryType: msg.entryType,
            title: msg.title,
            statement: msg.statement,
          });
          this.emit({
            at: new Date().toISOString(),
            type: "proposal.staged",
            worldId: msg.worldId,
            proposalId: proposal.id,
          });
        } catch {
          /* the refreshed snapshot carries whatever resulted */
        }
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "stage-canon-amendment": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        await stageCanonAmendment(store, gate, { entryId: msg.entryId, statement: msg.statement }).catch(
          () => {},
        );
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "open-thread": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        await openThread(store, gate, {
          title: msg.title,
          question: msg.question,
          candidates: msg.candidates,
        }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "settle-thread": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        await stageThreadSettlement(store, gate, {
          entryId: msg.entryId,
          resolvedType: msg.resolvedType,
          statement: msg.statement,
        }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "rename-world": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await store.renameWorld(msg.name).catch((err: unknown) => {
          void this.appLog?.append({
            kind: "world.rename-refused",
            message: err instanceof Error ? err.message : "the world could not be renamed",
          });
        });
        await this.refreshWorldSnapshot(msg.worldId);
        await this.refreshWorldList();
        return;
      }
      case "retire-entity": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await store.retire(msg.path, "form").catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "create-sheet-from-sentence": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        try {
          const draft = await createSheetFromSentence(store, gate, {
            sheetType: msg.sheetType,
            name: msg.name,
            sentence: msg.sentence,
            ...(msg.production !== undefined ? { production: msg.production } : {}),
          });
          this.emit({
            at: new Date().toISOString(),
            type: "proposal.staged",
            worldId: msg.worldId,
            proposalId: draft.proposal.id,
          });
          await this.refreshWorldSnapshot(msg.worldId);
          // Settling a sketch nobody asked to review. Beginning a world stages one of these per
          // character and per place, and every one arrived in Needs you wanting a decision that
          // had already been made by pressing Begin. A refusal here is not fatal: the proposal
          // stays staged and the author can settle it themselves.
          const settle = async () => {
            if (msg.settle !== true) return;
            const outcome = await gate.accept(draft.proposal.id).catch(() => null);
            if (outcome === null || outcome.status !== "accepted") {
              void this.appLog?.append({
                kind: "sheet.settle-refused",
                proposalId: draft.proposal.id,
                status: outcome?.status ?? "threw",
              });
            }
            await this.refreshWorldSnapshot(msg.worldId);
          };
          // When the harness is up, the sheet-editor drafts the full sketch inside the
          // proposal; without it, the skeleton with the author's sentence still stands.
          if (this.authoring && this.opts.adapter?.readiness().ready) {
            const worldQueryUrl = await this.worldQuery.start();
            this.trackBackground(this.authoring
              .run(
                store,
                gate,
                {
                  worldId: msg.worldId,
                  proposalId: draft.proposal.id,
                  purpose: "authoring",
                  instruction: `${draft.scope}\n\nDraft the full ${msg.sheetType} sheet in ${draft.path} from this seed: "${msg.sentence}". Fill every section the file already has headings for; keep the name "${msg.name}"; leave canonRules and links as they are.`,
                },
                worldQueryUrl,
              )
              // Settled after the draft lands, so what is settled is the written sheet and not
              // the empty skeleton it started as.
              .then(() => settle())
              .then(() => this.refreshWorldSnapshot(msg.worldId)));
          } else {
            await settle();
          }
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "duplicate-sheet": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        await duplicateSheet(store, gate, { path: msg.path, newName: msg.newName }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "set-sheet-status": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        await stageSheetStatus(store, gate, { path: msg.path, status: msg.status }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "rename-sheet": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        await stageSheetRename(store, gate, { path: msg.path, name: msg.name }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "promote-guest": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        await stageGuestPromotion(store, gate, { path: msg.path }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "assign-voice": {
        // A human's direct action, not a draft: the person clicking Assign is the approval, so
        // this commits straight through rather than staging a proposal for them to re-accept.
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        if (msg.voice) {
          const available = (await this.voiceService?.catalogue().catch(() => [])) ?? [];
          if (!available.some((voice) => voice.provider === msg.voice!.provider && voice.voiceId === msg.voice!.voiceId)) return;
        }
        await applyVoiceAssignment(store, { path: msg.path, voice: msg.voice }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "sheet-refs": {
        const store = this.opts.provider.openStore?.();
        const index = store?.getIndex();
        if (!store || !index) return;
        const refs = refsForSheet(index.db, msg.sheetId);
        const incoming = index.db
          .prepare(
            "SELECT DISTINCT source_id AS id FROM citations WHERE target_id = ? AND relation = 'sheet-link' ORDER BY id",
          )
          .all(msg.sheetId) as Array<{ id: string }>;
        this.emit({
          at: new Date().toISOString(),
          type: "sheet.refs",
          worldId: msg.worldId,
          sheetId: msg.sheetId,
          tiles: refs.tiles,
          productions: refs.productions,
          artifacts: refs.artifacts,
          scenes: refs.scenes,
          takesByVersion: Object.fromEntries(
            Object.entries(refs.takesByVersion).map(([v, n]) => [String(v), n]),
          ),
          incomingLinks: incoming.map((r) => r.id),
        });
        return;
      }
      case "set-credential": {
        // Write-only (R-5, R-8): the plaintext is registered with the redaction boundary,
        // encrypted, stored under a user-only ACL, and never travels back in any frame.
        //
        // A write that does not land says so (R-6, issue #227). This used to return early with
        // no error, no event and no log line whenever the coordinator had been built without a
        // store: Settings accepted the key, every generation surface went on reporting "no
        // provider with a key", and nothing on screen connected the two. Dropping a write the
        // user just performed, in silence, is the worst of the available behaviours — it is
        // indistinguishable from a rejected key, a typo, or a broken provider.
        if (!this.credentials) {
          const reason = this.opts.appRoot
            ? "this build has no credential storage, so the key was not saved"
            : "this session has no app root, so there is nowhere to save a key";
          // reportProviderFault logs it too — one line, not two.
          this.reportProviderFault(msg.provider, reason);
          return;
        }
        try {
          await this.credentials.set(msg.provider, msg.key);
          this.providerService.setConfigured(msg.provider, true);
          // An LLM key change re-delivers the spawn environment, which restarts the harness
          // — the honest cost of rotation (SPEC-005 D5). Media/voice keys leave it alone.
          if ((LLM_ENV_PROVIDERS as readonly string[]).includes(msg.provider)) {
            void this.refreshHarnessEnv();
          }
          this.emit({
            at: new Date().toISOString(),
            type: "provider.status",
            providers: this.providerService.list(),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          void this.appLog?.append({ kind: "credential.store-failed", provider: msg.provider, message });
          // The log alone left the same silence on screen: the store threw, the key was not
          // written, and Settings showed exactly what it had shown a moment earlier.
          this.reportProviderFault(msg.provider, `the key was not saved — ${message}`);
        }
        return;
      }
      case "clear-credential": {
        if (!this.credentials) return;
        await this.credentials.clear(msg.provider).catch(() => {});
        this.providerService.setConfigured(msg.provider, false);
        if ((LLM_ENV_PROVIDERS as readonly string[]).includes(msg.provider)) {
          void this.refreshHarnessEnv();
        }
        this.emit({
          at: new Date().toISOString(),
          type: "provider.status",
          providers: this.providerService.list(),
        });
        return;
      }
      case "validate-provider": {
        // Probes per capability (R-3): the emitted statuses carry what the key unlocks.
        this.emit({
          at: new Date().toISOString(),
          type: "provider.status",
          providers: this.providerService.list(),
        });
        await this.providerService.validate(msg.provider);
        this.emit({
          at: new Date().toISOString(),
          type: "provider.status",
          providers: this.providerService.list(),
        });
        return;
      }
      case "refresh-provider-tool": {
        const tool = this.providerTools.get(msg.provider);
        if (!tool) return;
        await tool.refresh();
        await this.revalidateToolProvider(msg.provider);
        return;
      }
      case "sign-in-provider-tool": {
        const tool = this.providerTools.get(msg.provider);
        if (!tool) return;
        // The service publishes each state change through its own callback, so the browser
        // window and its outcome both reach the renderer without this awaiting anything the
        // user is still standing in front of.
        await tool.signIn();
        await this.revalidateToolProvider(msg.provider);
        return;
      }
      case "select-provider-workspace": {
        const tool = this.providerTools.get(msg.provider);
        if (!tool) return;
        await tool.selectWorkspace(msg.workspaceId);
        return;
      }
      case "cancel-provider-tool-sign-in": {
        this.providerTools.get(msg.provider)?.cancelSignIn();
        return;
      }
      case "set-routing-default": {
        if (!this.appSettings || !this.opts.manifest) return;
        const result = await this.appSettings.setRoutingDefault(
          msg.capability,
          msg.modelId,
          this.opts.manifest,
        );
        if (!result.ok) {
          void this.appLog?.append({
            kind: "routing.refused",
            capability: msg.capability,
            reason: result.reason,
          });
        }
        const settings = await this.appSettings.load();
        // The family the next authoring session drafts for follows the routed model (R-16).
        this.skillFamily = this.opts.manifest
          ? modelForCapability(this.opts.manifest, settings.routing, "video")?.family
          : undefined;
        this.emit({
          at: new Date().toISOString(),
          type: "routing.changed",
          routing: settings.routing,
          faults: routingFaults(settings, this.opts.manifest),
        });
        return;
      }
      case "set-model-enabled": {
        if (!this.appSettings || !this.opts.manifest) return;
        const settings = await this.appSettings.setModelEnabled(msg.modelId, msg.enabled);
        // Faults ride along: switching a model off can strand a default, and the client shows
        // the two together rather than discovering the second on the next read.
        this.emit({
          at: new Date().toISOString(),
          type: "models.changed",
          models: settings.models,
          faults: routingFaults(settings, this.opts.manifest),
        });
        return;
      }
      case "set-agent-config": {
        if (!this.appSettings) return;
        const settings = await this.appSettings.setAgent(msg.agent, {
          ...(msg.model !== undefined ? { model: msg.model } : {}),
          ...(msg.brief !== undefined ? { brief: msg.brief } : {}),
        });
        this.agentOverrides = settings.agents;
        // Sessions already open keep the config they were started with; the next one picks
        // this up. Said plainly in the UI rather than pretended away.
        this.refreshAgents(settings.agents);
        this.transport.broadcastSnapshot();
        return;
      }
      case "list-harness-models": {
        const list = this.opts.adapter?.listModels;
        if (!list) return;
        const models = await list.call(this.opts.adapter).catch(() => []);
        this.readModel.setHarnessModels(
          models.map((m) => ({
            id: m.id,
            provider: m.provider,
            ...(m.displayName ? { displayName: m.displayName } : {}),
            ...(m.isDefault ? { isDefault: true } : {}),
          })),
        );
        this.transport.broadcastSnapshot();
        return;
      }
      case "set-spend-threshold": {
        if (!this.appSettings) return;
        const settings = await this.appSettings.setSpend(msg.thresholdMicroUsd, msg.periodDays);
        const entries = this.ledger ? await this.ledger.readAll() : this.getState().app.ledger;
        this.emit({
          at: new Date().toISOString(),
          type: "spend.status",
          spend: evaluateSpend(entries, settings.spend, new Date()),
        });
        return;
      }
      case "set-background-notifications": {
        if (!this.appSettings) return;
        const settings = await this.appSettings.setBackgroundNotifications(msg.preference);
        this.emit({
          at: new Date().toISOString(),
          type: "background-notifications.changed",
          preference: settings.backgroundNotifications,
        });
        return;
      }
      case "set-narrator": {
        // Who reads the app's prose aloud. Null returns to the shipped local voice, which is
        // the whole point of a default: pressing "read aloud" must never spend by accident.
        if (!this.appSettings) return;
        const saved = await this.appSettings.setNarrator(msg.voice);
        this.emit({ at: new Date().toISOString(), type: "narrator.changed", voice: saved.narrator });
        return;
      }
      case "set-appearance-theme": {
        if (!this.appSettings) return;
        this.appearanceWrite = this.appearanceWrite.catch(() => {}).then(async () => {
          const settings = await this.appSettings!.setAppearanceTheme(msg.preference);
          this.emit({
            at: new Date().toISOString(),
            type: "appearance.changed",
            preference: settings.appearance.theme,
          });
        });
        await this.appearanceWrite;
        return;
      }
      case "choose-voxa-executable": {
        if (!this.appSettings || !this.opts.voice?.chooseExecutable || !this.opts.voice.applySettings) return;
        const executablePath = await this.opts.voice.chooseExecutable().catch(() => null);
        if (executablePath === null) return;
        const settings = await this.appSettings.setVoxa({ executablePath });
        await this.opts.voice.applySettings(settings.voxa).catch(() => {});
        return;
      }
      case "clear-voxa-executable":
      case "use-bundled-voxa": {
        if (!this.appSettings || !this.opts.voice?.applySettings) return;
        const settings = await this.appSettings.setVoxa({ executablePath: null });
        await this.opts.voice.applySettings(settings.voxa).catch(() => {});
        return;
      }
      case "restart-voxa": {
        await this.opts.voice?.restart?.().catch(() => {});
        return;
      }
      case "choose-comfyui-path": {
        if (!this.appSettings || !this.opts.comfyui?.choosePath) return;
        const enginePath = await this.opts.comfyui.choosePath().catch(() => null);
        if (enginePath === null) return;
        await this.applyComfyUiPatch({ enginePath, engineUrl: null });
        return;
      }
      case "choose-comfyui-models-dir": {
        if (!this.appSettings || !this.opts.comfyui?.chooseModelsDir) return;
        const modelsDir = await this.opts.comfyui.chooseModelsDir().catch(() => null);
        if (modelsDir === null) return;
        await this.applyComfyUiPatch({ modelsDir });
        return;
      }
      case "clear-comfyui-models-dir": {
        await this.applyComfyUiPatch({ modelsDir: null });
        return;
      }
      case "set-comfyui-url": {
        // A URL is user-typed data, not a filesystem path; loopback and LAN engines only would
        // be a lie — the spec allows anywhere reachable (§1.2) — but it must at least parse.
        let parsed: URL;
        try {
          parsed = new URL(msg.url);
        } catch {
          return;
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
        await this.applyComfyUiPatch({ engineUrl: msg.url, enginePath: null });
        return;
      }
      case "clear-comfyui-engine": {
        await this.applyComfyUiPatch({ enginePath: null, engineUrl: null });
        return;
      }
      case "use-detected-comfyui": {
        // Only a location the host itself just discovered and published (SPEC-021 D10): the
        // renderer selects among offers, it does not originate paths.
        const service = this.opts.comfyui?.service;
        if (!service) return;
        const offered = service.engineStatus().detected.find((d) => d.location === msg.location);
        if (!offered) return;
        const isUrl = /^https?:\/\//i.test(offered.location);
        await this.applyComfyUiPatch(
          isUrl ? { engineUrl: offered.location, enginePath: null } : { enginePath: offered.location, engineUrl: null },
        );
        return;
      }
      case "comfyui-refresh": {
        if (!this.appSettings || !this.opts.comfyui) return;
        const settings = await this.appSettings.load();
        await this.opts.comfyui.service.applySettings(settings.comfyui).catch(() => {});
        await this.setup?.detect().catch(() => {});
        await this.refreshComfyUi();
        return;
      }
      case "comfyui-verify-recipe": {
        const service = this.opts.comfyui?.service;
        if (!service) return;
        await service.preflight(msg.recipeId).catch(() => {});
        await this.refreshComfyUi();
        return;
      }
      case "repair-voice-models": {
        await this.setup?.repair("kokoro-82m");
        await this.setup?.repair("whisper-base-en");
        await this.setup?.run();
        return;
      }
      case "open-model-folder": {
        if (this.opts.appRoot) this.opts.openPath?.(join(this.opts.appRoot, "models"));
        return;
      }
      case "test-local-voice": {
        const base = { at: new Date().toISOString(), type: "voice.runtime-test" as const, requestId: msg.requestId };
        this.emit({ ...base, status: "testing", detail: "Testing Voxa voice synthesis", audioBase64: null });
        try {
          const sidecar = this.opts.voice?.sidecar;
          if (!sidecar) throw new Error("Voxa is unavailable");
          const voices = await sidecar.listVoices();
          const voice = voices[0];
          if (!voice) throw new Error("Voxa returned no compatible voices");
          const audio = await sidecar.synthesize({
            voiceId: voice.id,
            text: "The harbour remembers.",
          });
          if (audio.byteLength < 44) throw new Error("Voxa returned invalid audio");
          this.emit({
            ...base,
            status: "ready",
            detail: "Local voice is ready",
            audioBase64: Buffer.from(audio).toString("base64"),
          });
        } catch {
          this.emit({
            ...base,
            status: "failed",
            detail: "Local voice test failed. Check the runtime and model states below.",
            audioBase64: null,
          });
        }
        return;
      }
      case "create-production": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const requestId = msg.requestId;
        const answer = (result: { disposition: "created"; slug: string } | { disposition: "failed"; reason: string }) => {
          // Only a correlated request gets a correlated answer; a legacy frame keeps the old
          // snapshot-only contract.
          if (!requestId) return;
          this.emit({
            at: new Date().toISOString(),
            type: "production.create-result",
            requestId,
            worldId: msg.worldId,
            ...result,
          });
        };
        // The frame names a medium or the legacy format (SPEC-023 R-1); one that names neither
        // is malformed — refused with its correlated answer, never dropped into a dialog that
        // waits forever.
        if (msg.medium === undefined && msg.format === undefined) {
          answer({ disposition: "failed", reason: "the request names neither a medium nor a format" });
          return;
        }
        if (requestId) {
          // Redelivery of a request that is still running: its result will broadcast once.
          // Marked BEFORE any await — frames are handled concurrently, and a check-then-add
          // across the change-log read let two deliveries of one requestId both create.
          if (this.creatingProductions.has(requestId)) return;
          this.creatingProductions.add(requestId);
          // Redelivery of a request whose commit already landed: same slug, no second
          // production, no title-2 (#384). The whole change log is consulted, not the
          // bundle's windowed tail, so the answer survives restart and later work.
          const prior = await productionCreatedBy(store.dir, requestId).catch(() => null);
          if (prior) {
            this.creatingProductions.delete(requestId);
            answer({ disposition: "created", slug: prior });
            return;
          }
        }
        try {
          const slug = await createProduction(store, {
            title: msg.title,
            ...(msg.format !== undefined ? { format: msg.format } : {}),
            ...(msg.medium !== undefined ? { medium: msg.medium } : {}),
            ...(msg.productionKind !== undefined ? { productionKind: msg.productionKind } : {}),
            ...(msg.seriesTitle !== undefined ? { seriesTitle: msg.seriesTitle } : {}),
            ...(msg.aspect !== undefined ? { aspect: msg.aspect } : {}),
            ...(msg.defaults !== undefined ? { defaults: msg.defaults } : {}),
            ...(msg.logline !== undefined ? { logline: msg.logline } : {}),
            ...(requestId !== undefined ? { requestId } : {}),
          });
          await this.refreshWorldSnapshot(msg.worldId);
          // Acknowledged only after the commit is durable and the snapshot carries it.
          answer({ disposition: "created", slug });
        } catch (err) {
          this.transport.broadcastSnapshot();
          answer({
            disposition: "failed",
            reason: err instanceof Error ? err.message.slice(0, 300) : "the production could not be created",
          });
        } finally {
          if (requestId) this.creatingProductions.delete(requestId);
        }
        return;
      }
      case "draft-scene": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        try {
          const draft = await draftSceneSkeleton(store, gate, {
            productionId: msg.productionId,
            brief: msg.brief,
            // Shots are drafted for the model that will shoot them (SPEC-019 R-16). The routed
            // video model names its family; a family with no skill drafts under general
            // guidance, and the scope line says which happened (R-20).
            skill: await this.skillForPurpose("scene-drafting", "video"),
          });
          this.emit({
            at: new Date().toISOString(),
            type: "proposal.staged",
            worldId: msg.worldId,
            proposalId: draft.proposalId,
          });
          await this.refreshWorldSnapshot(msg.worldId);
          if (this.authoring && this.opts.adapter?.readiness().ready) {
            const worldQueryUrl = await this.worldQuery.start();
            this.trackBackground(this.authoring
              .run(
                store,
                gate,
                {
                  worldId: msg.worldId,
                  proposalId: draft.proposalId,
                  purpose: "authoring",
                  instruction: draft.instruction,
                },
                worldQueryUrl,
              )
              .then(() => this.refreshWorldSnapshot(msg.worldId)));
          }
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "stage-scene-edit": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        try {
          const scene = SceneSchema.parse(msg.scene);
          await gate.stage({
            kind: "scene-edit",
            summary: msg.summary,
            source: "form",
            targets: [
              {
                path: `productions/${msg.productionId}/scenes/${msg.sceneFile}.json`,
                content: JSON.stringify(scene, null, 2) + "\n",
              },
            ],
          });
          await this.refreshWorldSnapshot(msg.worldId);
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "save-scene": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        /*
         * A refusal is said, not swallowed (review 2026-08-22). The bible's editor keeps its
         * text on a refused save; the storyboard's editors are uncontrolled and repaint from
         * the snapshot, so a swallowed refusal threw the typed text away with nothing said.
         */
        await saveScene(store, {
          productionId: msg.productionId,
          sceneFile: msg.sceneFile,
          scene: msg.scene,
          ...(msg.baseVersion !== undefined ? { baseVersion: msg.baseVersion } : {}),
        }).catch((err: unknown) => {
          this.emit({
            at: new Date().toISOString(),
            type: "scene.write-refused",
            worldId: msg.worldId,
            productionId: msg.productionId,
            sceneFile: msg.sceneFile,
            reason: err instanceof Error ? err.message : "the save could not be applied",
          });
        });
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "restore-scene": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await restoreScene(store, {
          productionId: msg.productionId,
          sceneFile: msg.sceneFile,
          version: msg.version,
        }).catch((err: unknown) => {
          // Same surface: "Restore v1" over a scene with no v1 snapshot was a silent no-op.
          this.emit({
            at: new Date().toISOString(),
            type: "scene.write-refused",
            worldId: msg.worldId,
            productionId: msg.productionId,
            sceneFile: msg.sceneFile,
            reason: err instanceof Error ? err.message : "the restore could not be applied",
          });
        });
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "delete-scene": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await deleteScene(store, { productionId: msg.productionId, sceneFile: msg.sceneFile }).catch(
          (err: unknown) => {
            // The refusal carries what stands in the way, which is the whole value of refusing.
            this.emit({
              at: new Date().toISOString(),
              type: "scene.write-refused",
              worldId: msg.worldId,
              productionId: msg.productionId,
              sceneFile: msg.sceneFile,
              reason: err instanceof Error ? err.message : "the scene could not be deleted",
            });
          },
        );
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "create-chapter": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await createChapter(store, msg.productionId, { title: msg.title, order: msg.order }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "save-chapter": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await saveChapter(store, msg.productionId, msg.chapterFile, msg.body).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "save-bible": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        // Swallowed like every other direct-authoring save: a rejected save leaves the editor's
        // text where it is, and the refreshed snapshot below is what tells it the version moved.
        await saveBible(store, msg.text, {
          source: "editor",
          ...(msg.baseVersion !== undefined ? { baseVersion: msg.baseVersion } : {}),
        }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "restore-bible": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await restoreBible(store, msg.version, "editor").catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "propose-story-overview": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        try {
          const { proposalId } = await proposeStoryOverview(store, gate, {
            productionId: msg.productionId,
            source: "form",
            overview: {
              ...(msg.logline !== undefined ? { logline: msg.logline } : {}),
              ...(msg.spine !== undefined ? { spine: msg.spine } : {}),
              ...(msg.targetLength !== undefined ? { targetLength: msg.targetLength } : {}),
              ...(msg.acts !== undefined ? { acts: msg.acts } : {}),
            },
          });
          this.emit({
            at: new Date().toISOString(),
            type: "proposal.staged",
            worldId: msg.worldId,
            proposalId,
          });
          await this.refreshWorldSnapshot(msg.worldId);
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "propose-season": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        try {
          const { proposalId } = await proposeSeason(store, gate, {
            productionId: msg.productionId,
            source: "form",
            season: {
              ...(msg.question !== undefined ? { question: msg.question } : {}),
              ...(msg.ending !== undefined ? { ending: msg.ending } : {}),
              ...(msg.direction !== undefined ? { direction: msg.direction } : {}),
              ...(msg.arcs !== undefined ? { arcs: msg.arcs } : {}),
            },
          });
          this.emit({ at: new Date().toISOString(), type: "proposal.staged", worldId: msg.worldId, proposalId });
          await this.refreshWorldSnapshot(msg.worldId);
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "propose-episode": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        try {
          const { proposalId } = await proposeEpisode(store, gate, {
            productionId: msg.productionId,
            source: "form",
            ...(msg.episodeId !== undefined ? { episodeId: msg.episodeId } : {}),
            episode: {
              ...(msg.title !== undefined ? { title: msg.title } : {}),
              ...(msg.order !== undefined ? { order: msg.order } : {}),
              ...(msg.promise !== undefined ? { promise: msg.promise } : {}),
              ...(msg.scenes !== undefined ? { scenes: msg.scenes } : {}),
            },
          });
          this.emit({ at: new Date().toISOString(), type: "proposal.staged", worldId: msg.worldId, proposalId });
          await this.refreshWorldSnapshot(msg.worldId);
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "reorder-episodes": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await reorderEpisodes(store, msg.productionId, msg.orderedIds).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "draft-story-overview": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store || !this.authoring || !this.opts.adapter?.readiness().ready) return;
        try {
          const production = store.getBundle().productions.find((p) => p.meta.id === msg.productionId);
          const { proposalId, path } = await proposeStoryOverview(store, gate, {
            productionId: msg.productionId,
            source: "chat:studio",
            // The agent drafts over the live overview (or a bare one); nothing writes live.
            overview: production?.story ? { ...production.story } : {},
          });
          this.emit({
            at: new Date().toISOString(),
            type: "proposal.staged",
            worldId: msg.worldId,
            proposalId,
          });
          await this.refreshWorldSnapshot(msg.worldId);
          const worldQueryUrl = await this.worldQuery.start();
          this.trackBackground(
            this.authoring
              .run(
                store,
                gate,
                {
                  worldId: msg.worldId,
                  proposalId,
                  purpose: "drafting",
                  instruction: `Write the story overview in ${path}. ${msg.instruction}. The file is one JSON document: keep the version field untouched and fill logline (one sentence), spine (the shape of the whole story), acts (an array of { title, summary }), and targetLength. Anything the overview implies about the world — a new name, a rule, a place — must NOT be written into world files; note such facts in the spine text as open questions for separate proposal. Do not touch any other file.`,
                },
                worldQueryUrl,
              )
              .then(() => this.refreshWorldSnapshot(msg.worldId)),
          );
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "draft-chapter": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store || !this.authoring || !this.opts.adapter?.readiness().ready) return;
        try {
          const path = `productions/${msg.productionId}/chapters/${msg.chapterFile}.md`;
          const staged = await gate.stage({
            kind: "chapter-draft",
            summary: `Draft: ${msg.chapterFile}`,
            source: "chat:studio",
            targets: [{ path }],
          });
          this.emit({
            at: new Date().toISOString(),
            type: "proposal.staged",
            worldId: msg.worldId,
            proposalId: staged.id,
          });
          const worldQueryUrl = await this.worldQuery.start();
          this.trackBackground(this.authoring
            .run(
              store,
              gate,
              {
                worldId: msg.worldId,
                proposalId: staged.id,
                purpose: "drafting",
                instruction: `Draft the chapter prose in ${path}. ${msg.instruction}.${overviewSteer(
                  store.getBundle().productions.find((p) => p.meta.id === msg.productionId)?.story,
                )} Anything the prose implies about the world — a new name, a rule, a place — must NOT be written into world files; list such facts at the end of the chapter under a "## Surfaced facts" heading for separate proposal.`,
              },
              worldQueryUrl,
            )
            .then(() => this.refreshWorldSnapshot(msg.worldId)));
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "reorder-chapters": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await reorderChapters(store, msg.productionId, msg.orderedFiles).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "reorder-scenes": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await reorderScenes(store, msg.productionId, msg.orderedIds).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "dispatch-scene-planned": {
        const fail = (reason: string): void =>
          this.emit({
            at: new Date().toISOString(),
            type: "production.plan-result",
            requestId: msg.requestId,
            worldId: msg.worldId,
            productionId: msg.productionId,
            disposition: "failed",
            reason,
          });
        const store = this.opts.provider.openStore?.();
        if (!store || !this.opts.manifest) {
          fail("The scene could not be prepared for a plan.");
          return;
        }
        const bundle = store.getBundle();
        const production = bundle.productions.find((p) => p.meta.id === msg.productionId);
        const scene = production?.scenes.find((s) => production.sceneFiles[s.id] === msg.sceneFile);
        const model = this.opts.manifest.models.find((m) => m.id === msg.modelId);
        if (!production || !scene || !model) {
          fail("The scene or selected model is no longer available.");
          return;
        }
        const audioDesign = await audioDesignFor(store, production.meta.id);
        // The same plan the dialog reviewed, recomputed server-side — then compiled and made
        // durable BEFORE any pass may reach a provider (SPEC-024 R-12).
        const scenePlan = planScene(
          {
            world: bundle.meta,
            artDirection: bundle.artDirection,
            productionId: production.meta.id,
            production: {
              ...(production.meta.musicPolicy !== undefined ? { musicPolicy: production.meta.musicPolicy } : {}),
              failureModes: production.meta.failureModes,
            },
            sheets: bundle.sheets,
            kits: bundle.referenceKits,
            scene,
            selections: production.selections,
            model,
            audioDesign,
            artifacts: bundle.artifacts,
            ...(production.meta.aspect !== undefined ? { aspect: production.meta.aspect } : {}),
            ...(msg.resolution !== undefined ? { resolution: msg.resolution } : {}),
            ...(msg.tier !== undefined ? { tier: msg.tier } : {}),
          },
          msg.mode,
        );
        // In-flight guard, marked before any await (#384's lesson): frames are handled
        // concurrently, and a redelivered requestId racing the directory-scan idempotency check
        // in createDispatchPlan would authorize the same scene twice.
        if (this.creatingPlans.has(msg.requestId)) return;
        this.creatingPlans.add(msg.requestId);
        try {
          const aggregate = await createDispatchPlan(store, {
            worldId: msg.worldId,
            productionId: production.meta.id,
            scene,
            plan: scenePlan,
            model,
            world: bundle,
            policy: msg.policy,
            requestId: msg.requestId,
            clock: () => new Date().toISOString(),
          });
          this.emit({
            at: new Date().toISOString(),
            type: "production.plan-result",
            requestId: msg.requestId,
            worldId: msg.worldId,
            productionId: production.meta.id,
            disposition: "created",
            planId: aggregate.planId,
          });
          // The plan is durably created — a hiccup advancing it is a log line and a later
          // trigger's job, never a second, contradictory result for the same requestId.
          try {
            await advancePlan(store, production, bundle, aggregate, this.planDriverDeps());
            await this.emitPlanStates(store, msg.worldId, production.meta.id);
          } catch (err) {
            void this.appLog?.append({
              kind: "plan.advance-failed",
              planId: aggregate.planId,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        } finally {
          this.creatingPlans.delete(msg.requestId);
        }
        return;
      }
      case "plan-continue":
      case "plan-reconfirm": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const bundle = store.getBundle();
        const production = bundle.productions.find((p) => p.meta.id === msg.productionId);
        const plan = (await listPlans(store, msg.productionId)).find((p) => p.planId === msg.planId);
        if (!production || !plan) return;
        // The visible act, recorded before anything moves (SPEC-024 R-16/R-17). Appending twice
        // is harmless — the fold reads presence, not count.
        await appendPlanEvents(store, msg.productionId, msg.planId, [
          {
            kind: msg.kind === "plan-continue" ? "continue-approved" : "reconfirmed",
            ts: new Date().toISOString(),
            planId: msg.planId,
            passIndex: msg.passIndex,
          },
        ]);
        await advancePlan(store, production, bundle, plan, this.planDriverDeps()).catch(() => {});
        await this.emitPlanStates(store, msg.worldId, msg.productionId);
        return;
      }
      case "plan-cancel": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const plan = (await listPlans(store, msg.productionId)).find((p) => p.planId === msg.planId);
        if (!plan) return;
        // The mark first, durably — then the fold: cancelling from a pre-cancel snapshot missed
        // any job a racing advance enqueued in the gap, and every non-terminal job deserves the
        // ask, waiting-reconciliation included.
        await appendPlanEvents(store, msg.productionId, msg.planId, [
          { kind: "cancelled", ts: new Date().toISOString(), planId: msg.planId },
        ]);
        const state = await planState(store, plan, this.planDriverDeps());
        // Future spend stops here; in-flight jobs are asked to stop through SPEC-009, which
        // owes no promise about work already running at a provider (R-25).
        for (const pass of state.passes) {
          if (pass.jobId !== undefined && pass.state !== "succeeded" && pass.state !== "failed") {
            await this.jobQueue?.cancel(pass.jobId).catch(() => {});
          }
        }
        await this.emitPlanStates(store, msg.worldId, msg.productionId);
        return;
      }
      case "list-plans": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const bundle = store.getBundle();
        const production = bundle.productions.find((p) => p.meta.id === msg.productionId);
        if (!production) return;
        // Recovery on request (T-19): advancing is a fold plus at most one durable act per pass,
        // so the first screen that asks after a restart is the reconciliation.
        await advanceAllPlans(store, production, bundle, this.planDriverDeps()).catch(() => {});
        await this.emitPlanStates(store, msg.worldId, msg.productionId);
        return;
      }
      case "save-routing": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        try {
          // The strict parse IS the no-state import gate (brief §1): a condition key fails here
          // with the key named, before anything touches disk.
          await saveRouting(store, msg.productionId, msg.routing);
          await this.refreshWorldSnapshot(msg.worldId);
          await this.emitRoutingFindings(store, msg.worldId, msg.productionId);
        } catch (err) {
          void this.appLog?.append({
            kind: "routing.refused",
            reason: err instanceof Error ? err.message : String(err),
            detail: { productionId: msg.productionId },
          });
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "record-traversal": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const production = store.getBundle().productions.find((p) => p.meta.id === msg.productionId);
        if (!production || production.routing === null) return;
        await appendTraversal(store, msg.productionId, {
          ts: new Date().toISOString(),
          routingVersion: production.routing.version,
          choiceId: msg.choiceId,
          from: msg.from,
          to: msg.to,
          route: msg.route,
        }).catch(() => {});
        await this.emitRoutingFindings(store, msg.worldId, msg.productionId);
        return;
      }
      case "list-routing-findings": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await this.emitRoutingFindings(store, msg.worldId, msg.productionId);
        return;
      }
      case "propose-branch-canon": {
        const store = this.opts.provider.openStore?.();
        const gate = this.opts.provider.gate?.();
        if (!store || !gate) return;
        try {
          await proposeBranchCanon(store, gate, {
            productionId: msg.productionId,
            sceneId: msg.sceneId,
            route: msg.route,
            title: msg.title,
            body: msg.body,
          });
          await this.refreshWorldSnapshot(msg.worldId);
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "export-interactive": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const production = store.getBundle().productions.find((p) => p.meta.id === msg.productionId);
        if (!production) return;
        const result = await exportInteractive(store, production, () => new Date().toISOString()).catch(
          (err): InteractiveExportResult => ({
            ok: false,
            blockers: [err instanceof Error ? err.message : String(err)],
          }),
        );
        this.emit({
          at: new Date().toISOString(),
          type: "production.interactive-export-result",
          worldId: msg.worldId,
          productionId: msg.productionId,
          disposition: result.ok ? "exported" : "refused",
          ...(result.ok ? { dir: result.dir } : { blockers: result.blockers }),
        });
        return;
      }
      case "set-production-aspect": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        try {
          await setProductionAspect(store, msg.productionId, msg.aspect);
        } catch (err) {
          // A malformed shape is refused by name (issue 389) — logged rather than stored, and
          // the snapshot below shows the production unchanged.
          void this.appLog?.append({
            kind: "production-edit.refused",
            reason: err instanceof Error ? err.message : String(err),
            detail: { productionId: msg.productionId, aspect: msg.aspect },
          });
        }
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "set-prompt-override": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await setPromptOverride(store, store.getBundle(), {
          productionId: msg.productionId,
          sceneFile: msg.sceneFile,
          shotId: msg.shotId,
          text: msg.text,
        }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "compile-scene-board":
      case "export-scene-board": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const bundle = store.getBundle();
        const production = bundle.productions.find((p) => p.meta.id === msg.productionId);
        // The stem captured at scan is the address (issue #387) — never a reconstruction, so a
        // file named off-pattern stays reachable.
        const scene = production?.scenes.find((s) => production.sceneFiles[s.id] === msg.sceneFile);
        if (!production || !scene) return;
        try {
          const png = await compileBoard(store, production, scene, bundle.artifacts);
          if (msg.kind === "compile-scene-board") {
            await landBoard(store, msg.productionId, msg.sceneFile, png, () => new Date().toISOString());
          } else {
            await exportBoard(store, msg.productionId, scene, png, () => new Date().toISOString());
          }
          await this.refreshWorldSnapshot(msg.worldId);
        } catch (err) {
          void this.appLog?.append({
            kind: "board.failed",
            sceneFile: msg.sceneFile,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "dispatch-scene": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.opts.manifest) {
          this.rejectEnqueue(msg.requestId, msg.kind, "The scene could not be prepared for Activity.");
          return;
        }
        const bundle = store.getBundle();
        const production = bundle.productions.find((p) => p.meta.id === msg.productionId);
        const scene = production?.scenes.find((s) => production.sceneFiles[s.id] === msg.sceneFile);
        const model = this.opts.manifest.models.find((m) => m.id === msg.modelId);
        if (!production || !scene || !model) {
          this.rejectEnqueue(msg.requestId, msg.kind, "The scene or selected model is no longer available.");
          return;
        }
        // The negatives derive from the production's audio design (SPEC-019 R-9, R-11): a cut
        // that composes its own score means the model must not lay music under every clip.
        const audioDesign = await audioDesignFor(store, production.meta.id);
        // Recompute the plan server-side — the request the dialog showed is the one executed.
        const plan = planScene(
          {
            world: bundle.meta,
            artDirection: bundle.artDirection,
            productionId: production.meta.id,
            // The production's own standing constraints, merged with the world's inside planning
            // (#244). Passed as the record rather than looked up there, because planning is pure.
            production: {
              ...(production.meta.musicPolicy !== undefined ? { musicPolicy: production.meta.musicPolicy } : {}),
              failureModes: production.meta.failureModes,
            },
            sheets: bundle.sheets,
            kits: bundle.referenceKits,
            scene,
            selections: production.selections,
            model,
            audioDesign,
            // The world's shelf, for resolving durable boundary frames (issue 154).
            artifacts: bundle.artifacts,
            // The production's delivery aspect (issue 389): stills shape to it, video routes
            // receive it, and an impossible shape is refused by composition below.
            ...(production.meta.aspect !== undefined ? { aspect: production.meta.aspect } : {}),
            ...(msg.resolution !== undefined ? { resolution: msg.resolution } : {}),
            ...(msg.tier !== undefined ? { tier: msg.tier } : {}),
          },
          msg.mode,
        );
        if (msg.mode === "whole-scene" && !plan.pack.ok) {
          void this.appLog?.append({ kind: "dispatch.refused", reason: "oversize shot", detail: plan.pack });
          this.rejectEnqueue(
            msg.requestId,
            msg.kind,
            "Whole-scene dispatch is unavailable because one shot exceeds the model limit.",
          );
          return;
        }
        // Composition refuses work it cannot honour — a shot longer than the model can make, a
        // pass over its reference limit. Those refusals are the point of recomputing the plan
        // here rather than trusting the dialog, so they have to come back as a refusal. Thrown
        // out of this handler they became an unhandled rejection: nothing answered the request,
        // the dialog waited for a job that never arrived, and the process was entitled to exit.
        let dispatches;
        try {
          dispatches = composeDispatches(msg.worldId, msg.productionId, scene, plan, model, bundle);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          void this.appLog?.append({ kind: "dispatch.refused", reason, detail: { sceneFile: msg.sceneFile } });
          this.rejectEnqueue(msg.requestId, msg.kind, reason);
          return;
        }
        await this.enqueueBatch(msg.requestId, msg.kind, dispatches);
        return;
      }
      case "accept-take": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const production = store.getBundle().productions.find((p) => p.meta.id === msg.productionId);
        if (!production) return;
        try {
          const decision = await acceptTake(store, production, {
            takeId: msg.takeId,
            shotId: msg.shotId,
            by: "user",
          });
          this.emit({
            at: new Date().toISOString(),
            type: "review.recorded",
            worldId: msg.worldId,
            productionId: msg.productionId,
            review: decision,
          });
          this.emit({
            at: new Date().toISOString(),
            type: "selection.changed",
            worldId: msg.worldId,
            productionId: msg.productionId,
            shotId: msg.shotId,
            // The committed selection, not a guess at it (Codex round 2). Re-accepting the same take
            // preserves its trim on disk, and both read models replace the whole selection with
            // this payload — so a hard-coded zero made every observer contradict the file until
            // the next snapshot, and left an inaccurate line in the durable audit log.
            selection: store.getBundle().productions.find((p) => p.meta.id === msg.productionId)
              ?.selections[msg.shotId] ?? { acceptedTakeId: msg.takeId as never, trimInSec: 0 },
          });
          // Continuity's durable half (issue 154): the accept promised the following shot a
          // start frame — cut the actual picture, file it with provenance, and point the
          // selection at it. Total and best-effort: a build without ffmpeg logs why and the
          // accept stands exactly as it did before boundary frames existed.
          const fresh = store.getBundle().productions.find((p) => p.meta.id === msg.productionId);
          const acceptedTake = fresh?.takes.find((t) => t.id === msg.takeId);
          if (fresh !== undefined && acceptedTake !== undefined) {
            const ordered = sortScenes(fresh.scenes).flatMap((s) => s.shots);
            const index = ordered.findIndex((s) => s.id === msg.shotId);
            const following = index >= 0 ? ordered[index + 1] : undefined;
            if (following !== undefined) {
              const chained = await chainBoundaryFrame(store, fresh, {
                take: acceptedTake,
                followingShotId: following.id,
                maker: this.opts.boundaryFrameMaker,
                clock: () => new Date().toISOString(),
              });
              if (!chained.ok) {
                void this.appLog?.append({
                  kind: "boundary-frame.unavailable",
                  reason: chained.reason,
                  detail: { takeId: msg.takeId, shotId: following.id },
                });
              }
            }
          }
          await this.refreshWorldSnapshot(msg.worldId);
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "reject-take": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const production = store.getBundle().productions.find((p) => p.meta.id === msg.productionId);
        if (!production) return;
        try {
          const decision = await rejectTake(store, production, {
            takeId: msg.takeId,
            ...(msg.shotId !== undefined ? { shotId: msg.shotId } : {}),
            by: "user",
            citation: msg.citation,
          });
          this.emit({
            at: new Date().toISOString(),
            type: "review.recorded",
            worldId: msg.worldId,
            productionId: msg.productionId,
            review: decision,
          });
          await this.refreshWorldSnapshot(msg.worldId);
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "set-trim": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const production = store.getBundle().productions.find((p) => p.meta.id === msg.productionId);
        if (!production) return;
        try {
          await setTrim(store, production, { shotId: msg.shotId, trimInSec: msg.trimInSec });
          this.emit({
            at: new Date().toISOString(),
            type: "selection.changed",
            worldId: msg.worldId,
            productionId: msg.productionId,
            shotId: msg.shotId,
            // Read back rather than assembled here, for the same reason accept-take reads it
            // back: both read models replace the whole selection with this payload, so a value
            // guessed at here would contradict the file until the next snapshot.
            selection: store.getBundle().productions.find((p) => p.meta.id === msg.productionId)
              ?.selections[msg.shotId] ?? { acceptedTakeId: null, trimInSec: msg.trimInSec },
          });
          await this.refreshWorldSnapshot(msg.worldId);
        } catch (err) {
          // A refused trim is the one thing a screen owes an explanation for, and swallowing it
          // whole leaves the control looking broken. The cause goes where turn failures go.
          const reason = err instanceof Error ? err.message : String(err);
          void this.appLog?.append({
            kind: "trim.refused",
            reason,
            detail: { productionId: msg.productionId, shotId: msg.shotId, trimInSec: msg.trimInSec },
          });
          this.transport.broadcastSnapshot();
        }
        return;
      }
      /*
       * Overlays (82a). One handler for three verbs because they are one act — where a thing sits
       * — and the refusals are identical. A refused placement says why in the app log for the same
       * reason a refused trim does: it is the one thing a screen owes an explanation for.
       */
      case "place-overlay":
      case "move-overlay":
      case "remove-overlay": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const production = store.getBundle().productions.find((p) => p.meta.id === msg.productionId);
        if (!production) return;
        try {
          if (msg.kind === "place-overlay") {
            await placeOverlay(store, msg.productionId, {
              artifactId: msg.artifactId,
              startSec: msg.startSec,
              endSec: msg.endSec,
            });
          } else if (msg.kind === "move-overlay") {
            await moveOverlay(store, msg.productionId, {
              overlayId: msg.overlayId,
              startSec: msg.startSec,
              endSec: msg.endSec,
            });
          } else {
            await removeOverlay(store, msg.productionId, msg.overlayId);
          }
          await this.refreshWorldSnapshot(msg.worldId);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          void this.appLog?.append({
            kind: "overlay.refused",
            reason,
            detail: { productionId: msg.productionId, verb: msg.kind },
          });
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "save-audio-tracks": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        try {
          const cut = CutFileSchema.parse(msg.cut);
          await saveAudioTracks(store, msg.productionId, JSON.stringify(cut, null, 2) + "\n");
          await this.refreshWorldSnapshot(msg.worldId);
        } catch {
          this.transport.broadcastSnapshot();
        }
        return;
      }
      case "export-cut": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const production = store.getBundle().productions.find((p) => p.meta.id === msg.productionId);
        if (!production) return;
        /*
         * One export per production at a time (Codex round 3).
         *
         * Measuring the master happens before runExport hands back an id, and ffprobe waits up
         * to twenty seconds on a file it cannot read. In that window the client has no export to
         * cancel and every further click starts another probe, each of which goes on to launch
         * its own encode. The claim is taken before the first await and released on every exit.
         */
        // Keyed by world too: a production id is a slug inside its world, not a global name, so
        // two worlds with the same directory slug would have shared one lock and the second
        // world's export would have been dropped as a duplicate (Codex round 4). Keyed by
        // episode as well (issue #396): seven episodes are seven deliverables, and a season
        // batch encodes them side by side — one episode's claim must not drop its neighbour's.
        const exportKey = `${msg.worldId}:${msg.productionId}:${msg.episodeId ?? "production"}`;
        if (this.exportsInFlight.has(exportKey)) return;
        this.exportsInFlight.add(exportKey);
        let started = false;
        try {
        const runner = this.opts.ffmpeg;
        const emitProgress = (
          exportId: string,
          status: "running" | "done" | "cancelled" | "failed",
          percent: number,
          output: string | null,
          error: string | null,
        ) =>
          this.emit({
            at: new Date().toISOString(),
            type: "export.progress",
            worldId: msg.worldId,
            productionId: msg.productionId,
            ...(msg.episodeId !== undefined ? { episodeId: msg.episodeId } : {}),
            exportId,
            status,
            percent,
            output,
            error,
          });
        if (!runner) {
          emitProgress(
            "ex_none",
            "failed",
            0,
            null,
            "export needs ffmpeg — bundled in packaged builds (SPEC-016); set ARKE_FFMPEG to use one now",
          );
          return;
        }
        /*
         * A production cut to a track renders against the song, not against scene order (#253).
         *
         * The spine assembly existed and nothing called it, so exporting a spine production
         * still produced the scene-order cut with no master under it -- a renderer that was
         * unreachable from the product it was written for (Codex round 1). The old path stays
         * exactly as it was for everything else, which is most productions.
         */
        const spine = production.spine;
        const trackArtifact = spine
          ? store.getBundle().artifacts.find((a) => a.id === spine.trackArtifactId)
          : undefined;
        const trackFile = trackArtifact?.file;

        /*
         * The measurement recorded when the track was assigned, before asking ffprobe again.
         *
         * Artifacts are immutable and travel with the world, so their mediaInfo is as true on the
         * machine that opens the folder as on the one that filed it. Requiring a probe anyway
         * refused every spine export on a machine with ffmpeg but no ffprobe -- a world that
         * already knows how long its song is, declining to export because it could not re-measure
         * something that cannot have changed (Codex round 4).
         */
        const trackPath =
          trackFile !== undefined ? toExtendedLength(join(store.dir, "artifacts", fromPortable(trackFile))) : null;
        // The id is allocated before the first thing that can fail. A probe that throws on the
        // way to ffprobe used to escape the handler with no export event at all, so the user's
        // click did nothing visible and only the transport backstop logged it (Codex round 6).
        const attemptId = `ex_${ulid()}`;
        const probed =
          trackArtifact?.mediaInfo === undefined && trackPath !== null && this.opts.mediaProbe?.info
            ? await this.opts.mediaProbe.info(trackPath).catch(() => null)
            : null;
        /*
         * A spine export takes the whole measurement or none of it (Codex round 5).
         *
         * The duration-only fallback that used to sit here supplied a length while leaving audio
         * presence unknown, which walked straight past the silent-master guard below and put the
         * missing stream back in front of ffmpeg -- reintroducing, one round later, exactly the
         * state the previous round had refused. A length is not a measurement when what the graph
         * needs to know is whether there is a track to mix.
         */
        const trackInfo = trackArtifact?.mediaInfo ?? probed;
        const trackDurationSec = trackInfo?.durationSec ?? null;

        // A refusal is an attempt with an outcome, so it gets an id of its own. Reporting every
        // one as "ex_none" let a second production's failure overwrite the first in the client's
        // export map, and the first screen then showed no failed attempt at all (Codex round 4).
        if (spine && trackFile !== undefined && trackInfo === null) {
          emitProgress(
            attemptId,
            "failed",
            0,
            null,
            "export needs the master track measured — no stored measurement and ffprobe could not make one (SPEC-016)",
          );
          return;
        }
        if (spine && trackInfo !== null && !trackInfo.hasAudio) {
          emitProgress(attemptId, "failed", 0, null, "the master track has no audio stream — assign a track that does");
          return;
        }

        /*
         * One episode's deliverable (SPEC-023 R-24, issue #396): the refusal is said before the
         * encode, by name — an empty episode, a contradictory membership, or a spine production
         * (which is cut against its track, and no episode-to-spine range authority exists yet).
         * Gaps do not refuse: they become labelled slates, exactly as the production-wide cut
         * treats them, so one episode's gaps never misreport another's.
         */
        if (msg.episodeId !== undefined) {
          const refusal = episodeExportRefusals(production, msg.episodeId);
          if (refusal) {
            emitProgress(attemptId, "failed", 0, null, `episode export refused: ${refusal.detail}`);
            return;
          }
          const episode = production.episodes.find((e) => e.id === msg.episodeId)!;
          const plan = buildExportPlan(deriveEpisodeCut(production, msg.episodeId), msg.preset);
          const stamp = new Date()
            .toISOString()
            .replace(/[-:TZ.]/g, "")
            .slice(0, 14);
          const stem = production.episodeFiles[episode.id] ?? episode.id;
          const handle = runExport(
            store.dir,
            (stage) => buildFfmpegArgs(plan, store.dir, stage),
            // The episode stem keeps filenames collision-free across episodes; the stamp keeps
            // retries from overwriting what a person may already have sent on.
            `${msg.productionId}-${stem}-${msg.preset}-${stamp}.mp4`,
            runner,
            (percent) => emitProgress(handle.id, "running", percent, null, null),
          );
          this.exports.set(handle.id, handle);
          emitProgress(handle.id, "running", 0, null, null);
          started = true;
          this.trackBackground(
            handle.done.then((result) => {
              this.exports.delete(handle.id);
              this.exportsInFlight.delete(exportKey);
              if (result.status === "done") emitProgress(handle.id, "done", 100, result.output, null);
              else if (result.status === "cancelled") emitProgress(handle.id, "cancelled", 0, null, null);
              else emitProgress(handle.id, "failed", 0, null, result.error);
            }),
          );
          return;
        }

        let buildArgs: (stage: string) => string[];
        if (spine && trackFile !== undefined && trackDurationSec !== null) {
          const spineCut = deriveSpineCut(production, spine, trackDurationSec);
          const refusal = spineExportRefusals(spineCut, msg.preset);
          if (refusal) {
            // Said before the encode rather than after somebody has sent the file on.
            emitProgress(attemptId, "failed", 0, null, `cut is not ready for ${msg.preset}: ${refusal.detail}`);
            return;
          }
          const spinePlan = buildSpineExportPlan(spineCut, msg.preset, `artifacts/${trackFile}`);
          buildArgs = (stage) => buildSpineFfmpegArgs(spinePlan, store.dir, stage);
        } else {
          if (spine && trackDurationSec === null) {
            // Falling through silently would export a spine production as though it had none.
            emitProgress(
              attemptId,
              "failed",
              0,
              null,
              "export needs the master track measured — ffprobe could not read it (SPEC-016)",
            );
            return;
          }
          // Overlays reach the export or they are decoration (82a binding 4). Resolved against
          // the world's artifacts, so one citing something filed since — or something that is not
          // picture at all — is dropped rather than rendered as an absence.
          const overlays = exportOverlays(production.cut.overlays, store.getBundle().artifacts);
          const plan = buildExportPlan(deriveCut(production), msg.preset, overlays);
          buildArgs = (stage) => buildFfmpegArgs(plan, store.dir, stage);
        }
        const stamp = new Date()
          .toISOString()
          .replace(/[-:TZ.]/g, "")
          .slice(0, 14);
        const handle = runExport(
          store.dir,
          buildArgs,
          `${msg.productionId}-${msg.preset}-${stamp}.mp4`,
          runner,
          (percent) => emitProgress(handle.id, "running", percent, null, null),
        );
        this.exports.set(handle.id, handle);
        emitProgress(handle.id, "running", 0, null, null);
        started = true;
        this.trackBackground(handle.done.then((result) => {
          this.exports.delete(handle.id);
          // Released when the encode ends, not when this handler returns: the claim covers the
          // running export too, or a second click during it launches a duplicate.
          this.exportsInFlight.delete(exportKey);
          if (result.status === "done") emitProgress(handle.id, "done", 100, result.output, null);
          else if (result.status === "cancelled") emitProgress(handle.id, "cancelled", 0, null, null);
          else emitProgress(handle.id, "failed", 0, null, result.error);
        }));
        } finally {
          if (!started) this.exportsInFlight.delete(exportKey);
        }
        return;
      }
      case "cancel-export": {
        this.exports.get(msg.exportId)?.cancel();
        return;
      }
      case "export-world": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.opts.appRoot) return;
        const stamp = new Date()
          .toISOString()
          .replace(/[-:TZ.]/g, "")
          .slice(0, 14);
        const target = join(this.opts.appRoot, "exports", `${store.getBundle().meta.slug}-${stamp}`);
        await exportWorld(store.dir, target).catch((err) => {
          void this.appLog?.append({
            kind: "world-export.failed",
            message: err instanceof Error ? err.message : String(err),
          });
        });
        void this.appLog?.append({ kind: "world-export.done", target });
        return;
      }
      // ---- the bench (issue 305) ------------------------------------------
      case "bench-open": {
        const store = this.opts.provider.openStore?.();
        if (!store || store.worldId !== msg.worldId) return;
        await this.openBenchWorkspace(store, msg.sessionId);
        return;
      }
      case "bench-new-session": {
        const store = this.opts.provider.openStore?.();
        if (!store || store.worldId !== msg.worldId) return;
        await this.openBenchWorkspace(store, undefined, true);
        return;
      }
      case "bench-close": {
        this.readModel.setBench(null);
        this.transport.broadcastSnapshot();
        return;
      }
      case "bench-set-title": {
        const bench = await this.benchFor(msg.worldId, msg.sessionId);
        if (!bench) return;
        await bench.store.append({ type: "title-set", title: msg.title }, { at: this.nowIso(), requestId: msg.requestId });
        await this.refreshBench(msg.worldId, msg.sessionId);
        return;
      }
      case "bench-compose": {
        const bench = await this.benchFor(msg.worldId, msg.sessionId);
        if (!bench) return;
        await bench.store.append(
          {
            type: "composer-set",
            mode: msg.mode,
            provider: msg.provider,
            model: msg.model,
            params: msg.params,
            brief: msg.brief,
          },
          { at: this.nowIso(), requestId: msg.requestId },
        );
        await this.refreshBench(msg.worldId, msg.sessionId);
        return;
      }
      case "bench-add-reference": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const manifest = this.opts.manifest ?? null;
        // In order, re-folding between picks so each allocation and admission sees the pick
        // before it — the same shape bench-upload-references attaches with. The batch arrives
        // as ONE message because token numbering lives outside the append queue: two handlers
        // folding the same log would hand two sources one token, and an append-only log has
        // no way to take that back.
        for (const [index, pick] of msg.picks.entries()) {
          const bench = await this.benchFor(msg.worldId, msg.sessionId);
          if (!bench) break;
          const model =
            manifest?.models.find(
              (m) => m.id === bench.session.composer.model && m.provider === bench.session.composer.provider,
            ) ?? null;
          const outcome = await addBenchReference(bench, store.getBundle(), model, {
            source: pick.source,
            replace: pick.replace,
            lane: msg.lane,
            worldFile: worldFileReader(store.dir),
            requestId: `${msg.requestId}/${index}`,
            at: this.nowIso(),
          });
          // The tile predicted this refusal with the same shared functions; landing here means
          // a racing client. The refreshed workspace shows what held — recorded, not silent.
          if (outcome.outcome === "refused") {
            void this.appLog?.append({ kind: "bench.reference-refused", worldId: msg.worldId, reason: outcome.reason });
          }
        }
        await this.refreshBench(msg.worldId, msg.sessionId);
        return;
      }
      case "bench-remove-reference": {
        const bench = await this.benchFor(msg.worldId, msg.sessionId);
        if (!bench) return;
        const lane = msg.lane ?? "reference";
        const held =
          lane === "keyframe"
            ? bench.session.composer.keyframeTokens.includes(msg.token)
            : bench.session.composer.activeTokens.includes(msg.token);
        if (held) {
          await bench.store.append(
            { type: "reference-removed", token: msg.token, ...(lane === "keyframe" ? { lane } : {}) },
            { at: this.nowIso(), requestId: msg.requestId },
          );
        }
        await this.refreshBench(msg.worldId, msg.sessionId);
        return;
      }
      case "bench-upload-references": {
        const store = this.opts.provider.openStore?.();
        const bench = await this.benchFor(msg.worldId, msg.sessionId);
        const pick = this.opts.pickFiles;
        if (!store || !bench || !pick) return;
        const lane = msg.lane ?? "reference";
        const paths = await pick({
          accept: lane === "keyframe" ? [...ATTACHABLE_IMAGE_EXTENSIONS] : [...ATTACHABLE_EXTENSIONS],
        }).catch(() => [] as readonly string[]);
        const artifactIds: Array<string | null> = [];
        for (const sourcePath of paths) {
          artifactIds.push(await this.fileOne(msg.worldId, sourcePath, { allowLarge: msg.allowLarge ?? false }));
        }
        // The answer carries ordered ids whatever happens next: filing survives a cancelled
        // picker, and attaching is a separate act the budget may refuse per item.
        this.emit({
          at: this.nowIso(),
          type: "artifact.filed-batch",
          worldId: msg.worldId,
          requestId: msg.requestId,
          artifactIds,
        });
        const manifest = this.opts.manifest ?? null;
        for (const [index, artifactId] of artifactIds.entries()) {
          if (artifactId === null) continue;
          const fresh = await this.benchFor(msg.worldId, msg.sessionId);
          if (!fresh) break;
          const model =
            manifest?.models.find(
              (m) => m.id === fresh.session.composer.model && m.provider === fresh.session.composer.provider,
            ) ?? null;
          const outcome = await addBenchReference(fresh, store.getBundle(), model, {
            source: { source: "artifact", artifactId },
            lane: msg.lane,
            requestId: `${msg.requestId}/attach/${index}`,
            at: this.nowIso(),
          });
          // Filed but not attached is a real outcome — recorded, never swallowed.
          if (outcome.outcome === "refused") {
            void this.appLog?.append({ kind: "bench.reference-refused", worldId: msg.worldId, reason: outcome.reason });
          }
        }
        await this.refreshBench(msg.worldId, msg.sessionId);
        return;
      }
      case "bench-dispatch":
      case "bench-rerun": {
        const store = this.opts.provider.openStore?.();
        const bench = await this.benchFor(msg.worldId, msg.sessionId);
        if (!store || !bench) {
          this.rejectEnqueue(msg.requestId, msg.kind, "The bench is unavailable. Reopen the world and try again.");
          return;
        }
        const fromTake =
          msg.kind === "bench-rerun" ? bench.session.takes.find((t) => t.id === msg.takeId) : undefined;
        if (msg.kind === "bench-rerun" && !fromTake) {
          this.rejectEnqueue(msg.requestId, msg.kind, "That take is no longer in this session.");
          return;
        }
        const plan = planBenchDispatch(bench.session, store.getBundle(), this.opts.manifest ?? null, {
          worldId: msg.worldId,
          requestId: msg.requestId,
          at: this.nowIso(),
          fromTake,
          // A bench take of a local recipe records which version made it (R-13), and the
          // filed-artifact sidecar inherits it from this same snapshot.
          recipeVersionOf: (modelId) => this.opts.comfyui?.service.identityFor(modelId)?.recipe.version,
        });
        if (!plan.ok) {
          this.rejectEnqueue(msg.requestId, msg.kind, plan.reason);
          return;
        }
        // The reservation is fsynced BEFORE any job exists — the record that authorizes spend.
        // A resent command finds its requestId already in the log and must not enqueue twice.
        const reservation = await bench.store.append(
          { type: "takes-reserved", takes: plan.reserved },
          { at: this.nowIso(), requestId: msg.requestId },
        );
        if (reservation.deduplicated) {
          this.emitEnqueueResult(msg.requestId, msg.kind, 0, [], [], true);
          await this.refreshBench(msg.worldId, msg.sessionId);
          return;
        }
        const outcome = await enqueueInputs(plan.inputs, (input) => {
          if (!this.jobQueue) throw new Error("the job queue is unavailable");
          return this.jobQueue.enqueue(this.freezeLocalIdentity(input));
        });
        // Jobs join their reserved takes in order: a failure keeps its number and says why.
        const failed = new Map(outcome.failures.map((f) => [f.index, f.reason]));
        let accepted = 0;
        for (const [index, reserved] of plan.reserved.entries()) {
          const reason = failed.get(index);
          if (reason !== undefined) {
            await bench.store.append(
              { type: "take-status", takeId: reserved.id, status: "failed", error: reason },
              { at: this.nowIso() },
            );
            continue;
          }
          const jobId = outcome.acceptedJobIds[accepted++];
          if (jobId !== undefined) {
            await bench.store.append({ type: "take-job", takeId: reserved.id, jobId }, { at: this.nowIso() });
          }
        }
        this.emitEnqueueResult(msg.requestId, msg.kind, outcome.requestedCount, outcome.acceptedJobIds, outcome.failures);
        await this.refreshBench(msg.worldId, msg.sessionId);
        return;
      }
      case "bench-keep": {
        const store = this.opts.provider.openStore?.();
        const bench = await this.benchFor(msg.worldId, msg.sessionId);
        if (!store || !bench) return;
        const take = bench.session.takes.find((t) => t.id === msg.takeId);
        if (!take || !take.media) return;
        // Idempotent by take id: a filed take answers with the artifact it already made.
        if (take.disposition === "filed" && take.keptArtifactId !== undefined) {
          await this.refreshBench(msg.worldId, msg.sessionId);
          return;
        }
        const generation: ArtifactGeneration = {
          sessionId: bench.session.id,
          takeId: take.id,
          takeNumber: take.n,
          brief: take.request.brief,
          references: take.request.references,
          keyframes: take.request.keyframes,
          provider: take.request.provider,
          model: take.request.model,
          params: take.request.params,
          // How the bytes were made includes which recipe version made them (SPEC-021 R-13).
          ...(take.request.recipeVersion !== undefined ? { recipeVersion: take.request.recipeVersion } : {}),
          ...(take.request.requestedSeed !== undefined ? { requestedSeed: take.request.requestedSeed } : {}),
          costMicroUsd: take.cost?.actualMicroUsd ?? null,
        };
        const sourcePath = join(store.dir, ".sessions", bench.session.id, "media", take.id, take.media.file);
        try {
          const artifact = await fileGeneratedArtifact(store, {
            sourcePath,
            generation,
            ...(this.opts.mediaProbe !== undefined ? { mediaProbe: this.opts.mediaProbe } : {}),
            abandoned: () => !this.stillOpen(store) || this.stopping,
          });
          await bench.store.append(
            { type: "take-filed", takeId: take.id, artifactId: artifact.id },
            { at: this.nowIso(), requestId: msg.requestId },
          );
        } catch (err) {
          void this.appLog?.append({
            kind: "bench.keep-failed",
            worldId: msg.worldId,
            takeId: take.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // Keeping changed the world's artifacts, so the whole snapshot refreshes, not just the bench.
        await this.refreshWorldSnapshot(msg.worldId);
        await this.refreshBench(msg.worldId, msg.sessionId);
        return;
      }
      case "bench-discard": {
        const bench = await this.benchFor(msg.worldId, msg.sessionId);
        if (!bench) return;
        if (bench.session.takes.some((t) => t.id === msg.takeId && t.disposition === "open")) {
          await bench.store.append({ type: "take-discarded", takeId: msg.takeId }, { at: this.nowIso(), requestId: msg.requestId });
        }
        await this.refreshBench(msg.worldId, msg.sessionId);
        return;
      }
      case "bench-clear-view": {
        const bench = await this.benchFor(msg.worldId, msg.sessionId);
        if (!bench) return;
        await bench.store.append({ type: "take-cleared", takeId: msg.takeId }, { at: this.nowIso(), requestId: msg.requestId });
        await this.refreshBench(msg.worldId, msg.sessionId);
        return;
      }
      case "bench-enhance-brief": {
        // The same art-director machinery the world image trusts (references/art-director.ts):
        // one harness turn, JSON or nothing — and the answer is an EVENT, because the words
        // land in the composer only by the author's hand.
        const answer = (prompt: string | null, reason?: string) =>
          this.emit({
            at: this.nowIso(),
            type: "bench.brief-enhanced",
            worldId: msg.worldId,
            sessionId: msg.sessionId,
            requestId: msg.requestId,
            prompt,
            ...(reason !== undefined ? { reason } : {}),
          });
        const store = this.opts.provider.openStore?.();
        if (!store || store.worldId !== msg.worldId) return answer(null, "that world is not open");
        const model =
          this.opts.manifest?.models.find((m) => m.id === msg.model && m.provider === msg.provider) ?? null;
        if (!model) return answer(null, "that model is no longer offered");
        if (!this.opts.adapter?.readiness().ready) {
          return answer(null, "the writing harness is not running");
        }
        const director = makeArtDirector(
          this.opts.adapter,
          this.sessionInput,
          this.opts.appRoot ? join(this.opts.appRoot, ".art") : `${this.opts.changeLogPath}.art`,
          { agent: "prompt-enhancer", maxChars: model.limits.maxPromptChars ?? 4000 },
        );
        const prompt = await director(enhancerBrief(store.getBundle(), model, msg.brief)).catch(() => null);
        void this.appLog?.append({
          kind: prompt ? "bench.brief-enhanced" : "bench.brief-enhance-unavailable",
          worldId: msg.worldId,
        });
        return answer(prompt, prompt === null ? "the art director had no answer this time" : undefined);
      }
      case "bench-draft-lyrics": {
        // The same one-turn harness call the enhancer makes, and the same discipline: the
        // answer is an EVENT, because a draft reaches the song only when the author presses
        // Use these words (design turn 73). Nothing here writes into the composer.
        const answer = (lyrics: string | null, reason?: string) =>
          this.emit({
            at: this.nowIso(),
            type: "bench.lyrics-drafted",
            worldId: msg.worldId,
            sessionId: msg.sessionId,
            requestId: msg.requestId,
            lyrics,
            ...(reason !== undefined ? { reason } : {}),
          });
        const store = this.opts.provider.openStore?.();
        if (!store || store.worldId !== msg.worldId) return answer(null, "that world is not open");
        if (!this.opts.adapter?.readiness().ready) {
          return answer(null, "the writing harness is not running");
        }
        const lyricist = makeArtDirector(
          this.opts.adapter,
          this.sessionInput,
          this.opts.appRoot ? join(this.opts.appRoot, ".art") : `${this.opts.changeLogPath}.art`,
          { agent: "lyricist", answerKey: "lyrics", maxChars: LYRICS_MAX_CHARS },
        );
        const drafted = await lyricist(
          lyricistBrief({ description: msg.description, ...(msg.style !== undefined ? { style: msg.style } : {}) }),
        ).catch(() => null);
        void this.appLog?.append({
          kind: drafted ? "bench.lyrics-drafted" : "bench.lyrics-unavailable",
          worldId: msg.worldId,
        });
        return answer(drafted, drafted === null ? "the lyricist had no answer this time" : undefined);
      }
      case "bench-preset-save": {
        if (!this.appSettings || !this.opts.manifest) return;
        const outcome = await this.appSettings.savePreset(
          {
            name: msg.name,
            mode: msg.mode,
            provider: msg.provider,
            model: msg.model,
            params: msg.params,
            ...(msg.brief !== undefined ? { brief: msg.brief } : {}),
          },
          this.opts.manifest,
          this.nowIso(),
        );
        // The composer can only offer models the manifest carries, so landing here means a
        // racing manifest change — recorded, not silent.
        if (!outcome.ok) {
          void this.appLog?.append({ kind: "bench.preset-refused", reason: outcome.reason });
          return;
        }
        this.emit({ at: this.nowIso(), type: "presets.changed", presets: outcome.settings.presets });
        return;
      }
      case "bench-preset-delete": {
        if (!this.appSettings) return;
        const settings = await this.appSettings.deletePreset(msg.presetId);
        this.emit({ at: this.nowIso(), type: "presets.changed", presets: settings.presets });
        return;
      }
      case "bench-select-take": {
        const bench = await this.benchFor(msg.worldId, msg.sessionId);
        if (!bench) return;
        if (bench.session.takes.some((t) => t.id === msg.takeId)) {
          await bench.store.append({ type: "take-selected", takeId: msg.takeId }, { at: this.nowIso(), requestId: msg.requestId });
        }
        await this.refreshBench(msg.worldId, msg.sessionId);
        return;
      }
      case "stage-artifact-reference": {
        const store = this.opts.provider.openStore?.();
        if (!store || store.worldId !== msg.worldId) return;
        const artifact = store.getBundle().artifacts.find((a) => a.id === msg.artifactId);
        if (!artifact || (artifact.kind !== "image" && artifact.kind !== "board")) return;
        // A pointer, not a copy (issue 305 §4): the staged path IS the artifact's own file, so
        // clearing the slot later deletes the pointer and the artifact stays where it was.
        const landed = await store
          .gateOp(async () => {
            await rm(toExtendedLength(join(store.dir, stagedReferenceDir(msg.key))), { recursive: true, force: true });
            await atomicWriteFile(
              join(store.dir, stagedReferenceDir(msg.key), "artifact.json"),
              Buffer.from(JSON.stringify({ file: artifact.file }), "utf8"),
            );
          })
          .then(
            () => true,
            () => false,
          );
        if (landed) await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "attach-files-correlated": {
        const pick = this.opts.pickFiles;
        if (!pick) {
          this.emit({
            at: this.nowIso(),
            type: "artifact.filed-batch",
            worldId: msg.worldId,
            requestId: msg.requestId,
            artifactIds: [],
          });
          return;
        }
        const paths = await pick({ accept: [...ATTACHABLE_EXTENSIONS] }).catch(() => [] as readonly string[]);
        const artifactIds: Array<string | null> = [];
        for (const sourcePath of paths) {
          artifactIds.push(
            await this.fileOne(msg.worldId, sourcePath, {
              ...(msg.links !== undefined ? { links: msg.links } : {}),
              ...(msg.allowLarge !== undefined ? { allowLarge: msg.allowLarge } : {}),
            }),
          );
        }
        this.emit({
          at: this.nowIso(),
          type: "artifact.filed-batch",
          worldId: msg.worldId,
          requestId: msg.requestId,
          artifactIds,
        });
        return;
      }
      case "check-updates": {
        if (!this.opts.updates) {
          this.emit({
            at: new Date().toISOString(),
            type: "update.status",
            update: {
              status: "externally-managed",
              targetVersion: null,
              progressPercent: null,
              flow: null,
              detail: "Updates are managed outside this build.",
            },
          });
          return;
        }
        await this.opts.updates.check();
        return;
      }
      case "download-update": {
        if (!this.opts.updates) return;
        await this.opts.updates.download();
        return;
      }
      case "install-update-and-restart": {
        await this.opts.updates?.installAndRestart();
        return;
      }
      case "install-update-on-close": {
        await this.opts.updates?.installOnClose();
        return;
      }
      case "acknowledge-update": {
        this.opts.updates?.acknowledge();
        return;
      }
      case "generate-diagnostics": {
        const bundle = await this.diagnostics();
        this.emit({
          at: new Date().toISOString(),
          type: "diagnostics.ready",
          bundle: JSON.stringify(bundle, null, 2),
        });
        return;
      }
      case "list-provider-calls": {
        const calls =
          (await (msg.jobId === null
            ? this.opts.providerCalls?.listRecent()
            : this.opts.providerCalls?.listForJob(msg.jobId))) ?? [];
        // Full payloads are transient: never duplicate them into coordinator.jsonl or support diagnostics.
        this.transport.broadcast(
          DomainEventSchema.parse({
            at: new Date().toISOString(),
            type: "provider-calls.ready",
            jobId: msg.jobId,
            calls,
          }),
        );
        return;
      }
      case "open-data-folder": {
        if (this.opts.appRoot) this.opts.openPath?.(this.opts.appRoot);
        return;
      }
      case "stage-voice-clip": {
        // 74c refuses a clip while it is still the only thing on screen, so everything that can
        // be known about the bytes is settled here rather than at Save — where a refusal would
        // cost the name and description already typed.
        const refuse = (reason: string): void =>
          this.emit({
            at: this.nowIso(),
            type: "voice.clip-staged",
            worldId: msg.worldId,
            requestId: msg.requestId,
            clipId: null,
            fileName: null,
            seconds: null,
            reason,
          });
        let bytes: Uint8Array;
        let fileName: string;
        if (msg.source.from === "recorded") {
          bytes = Uint8Array.from(Buffer.from(msg.source.audioBase64, "base64"));
          // The renderer encodes to WAV before sending precisely so this holds; anything else
          // reaching here is a bug there, and is named rather than written out and refused later.
          if (!/^audio\/(wav|x-wav|wave)$/.test(msg.source.contentType)) {
            refuse(`a recording arrived as ${msg.source.contentType}, which is not audio this can clone`);
            return;
          }
          fileName = "recording.wav";
        } else {
          const pick = this.opts.pickFiles;
          if (!pick) {
            refuse("choosing a file needs the desktop app — a browser session cannot open the file picker");
            return;
          }
          const paths = await pick({ accept: [...CLONEABLE_AUDIO_EXTENSIONS] }).catch(() => [] as readonly string[]);
          const chosen = paths[0];
          // Cancelling the host dialog is not a refusal to report: the dialog is simply still
          // sitting on 74c with nothing chosen, which is where it already was.
          if (chosen === undefined) {
            this.emit({
              at: this.nowIso(), type: "voice.clip-staged", worldId: msg.worldId, requestId: msg.requestId,
              clipId: null, fileName: null, seconds: null, reason: null,
            });
            return;
          }
          fileName = basename(chosen);
          try {
            bytes = await readFile(chosen);
          } catch {
            refuse("that file could not be read");
            return;
          }
        }
        const extension = extname(fileName).slice(1).toLowerCase();
        const staged = await this.stageClip(bytes, fileName, extension);
        if (!staged.ok) {
          refuse(staged.reason);
          return;
        }
        this.emit({
          at: this.nowIso(),
          type: "voice.clip-staged",
          worldId: msg.worldId,
          requestId: msg.requestId,
          clipId: staged.clipId,
          fileName,
          seconds: staged.seconds,
          reason: null,
        });
        return;
      }
      case "discard-voice-clip": {
        await this.dropStagedClip(msg.clipId);
        return;
      }
      case "clone-voice": {
        // The clip becomes a voice, or the reason it did not. Both are events rather than a
        // throw: the clone dialog states the refusal in the words newClonedVoice chose, and the
        // rules live in one place rather than being re-stated here (SPEC-022 §2.3, D3).
        const store = this.opts.provider.openStore?.();
        if (!store) {
          this.emit({
            at: new Date().toISOString(),
            type: "voice.cloned",
            worldId: msg.worldId,
            voiceId: null,
            label: null,
            reason: "Open the world first.",
          });
          return;
        }
        const clip = this.stagedClips.get(msg.clipId);
        if (!clip) {
          this.emit({
            at: new Date().toISOString(),
            type: "voice.cloned",
            worldId: msg.worldId,
            voiceId: null,
            label: null,
            reason: "That recording is no longer staged — choose it again.",
          });
          return;
        }
        const made = await cloneVoice(store, store.getBundle().clonedVoices, {
          sourcePath: clip.path,
          name: msg.name,
          description: msg.description,
          consent: msg.consent,
          ...(msg.sheetId !== undefined ? { sheetId: msg.sheetId } : {}),
        });
        this.emit({
          at: new Date().toISOString(),
          type: "voice.cloned",
          worldId: msg.worldId,
          voiceId: made.ok ? made.voice.id : null,
          label: made.ok ? made.voice.name : null,
          reason: made.ok ? null : made.reason,
        });
        // Released either way: the clip is inside the world now, and a refused clone gets a fresh
        // staging rather than a second attempt against a temp file that may since have gone.
        await this.dropStagedClip(msg.clipId);
        // The library is in the bundle, so the picker sees the new voice on the next snapshot.
        if (made.ok) await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "file-artifact": {
        await this.fileOne(msg.worldId, msg.sourcePath, {
          ...(msg.links !== undefined ? { links: msg.links } : {}),
          ...(msg.allowLarge !== undefined ? { allowLarge: msg.allowLarge } : {}),
          ...(msg.supersedes !== undefined ? { supersedes: msg.supersedes } : {}),
          // Forwarded including an explicit null: filing from a world surface says "the world's"
          // and that is what re-homes a scoped artifact on dedup (SPEC-020 §2.5).
          ...(msg.production !== undefined ? { production: msg.production } : {}),
        });
        return;
      }
      case "attach-files": {
        // The dialog is the host's, and so is the path it returns. The renderer asked to attach
        // something; what it gets back is artifacts in the snapshot, never a path.
        const pick = this.opts.pickFiles;
        if (!pick) {
          this.emit({
            at: new Date().toISOString(),
            type: "artifact.notice",
            worldId: msg.worldId,
            sourcePath: "",
            outcome: "refused",
            reason: "attaching needs the desktop app — a browser session cannot open the file picker",
            sizeBytes: null,
          });
          return;
        }
        const paths = await pick({ accept: ATTACHABLE_EXTENSIONS }).catch(() => [] as readonly string[]);
        // Cancelling the dialog is an answer, not an error: nothing is said and nothing happens.
        for (const sourcePath of paths) {
          await this.fileOne(msg.worldId, sourcePath, {
            ...(msg.links !== undefined ? { links: msg.links } : {}),
            ...(msg.production !== undefined ? { production: msg.production } : {}),
          });
        }
        return;
      }
      case "genesis-attach-files": {
        const pick = this.opts.pickFiles;
        if (!pick) {
          this.emit({
            at: new Date().toISOString(),
            type: "genesis.attachment",
            genesisId: msg.genesisId,
            // No file was ever chosen, so there is no name to carry — the chip names the act.
            name: "attaching",
            kind: "other",
            outcome: "refused",
            reason: "this needs the desktop app — a browser session cannot open the file picker",
          });
          return;
        }
        const paths = await pick({ accept: ATTACHABLE_EXTENSIONS }).catch(() => [] as readonly string[]);
        for (const sourcePath of paths) await this.attachToGenesis(msg.genesisId, sourcePath);
        return;
      }
      case "genesis-attach": {
        await this.attachToGenesis(msg.genesisId, msg.sourcePath);
        return;
      }
      case "import-folder": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const report = await importFolder(store, msg.sourcePath, this.opts.mediaProbe, () => !this.stillOpen(store) || this.stopping).catch(
          () => null,
        );
        if (report) {
          this.emit({ at: new Date().toISOString(), type: "import.report", worldId: msg.worldId, ...report });
          await this.refreshWorldSnapshot(msg.worldId);
        }
        return;
      }
      case "stop-extraction": {
        this.reading.get(msg.artifactId)?.abort();
        return;
      }
      case "extract-artifact": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const artifact = store.getBundle().artifacts.find((a) => a.id === msg.artifactId);
        if (!artifact) return;
        // Asking twice while it is already reading is a double-click, not a second reading.
        if (this.reading.has(msg.artifactId)) return;
        const control = new AbortController();
        this.reading.set(msg.artifactId, control);
        const finished = (
          outcome: "found" | "nothing" | "no-text" | "stopped" | "unavailable" | "failed",
          found: number,
          dropped: number,
          reason?: string,
        ) =>
          this.emit({
            at: new Date().toISOString(),
            type: "extraction.finished",
            worldId: msg.worldId,
            artifactId: msg.artifactId,
            file: artifact.file,
            outcome,
            found,
            dropped,
            ...(reason !== undefined ? { reason } : {}),
          });
        this.emit({
          at: new Date().toISOString(),
          type: "extraction.started",
          worldId: msg.worldId,
          artifactId: msg.artifactId,
          file: artifact.file,
        });
        try {
          const text = await extractText(store, artifact);
          if (text === null) {
            void this.appLog?.append({ kind: "extraction.no-text", artifact: artifact.file });
            finished("no-text", 0, 0, "there is no text in this one we can read");
            return;
          }
          // The seam wins; else the built-in adapter runner when the harness is up (SPEC-016).
          let extractor = this.opts.extractor ?? null;
          if (!extractor && this.opts.adapter?.readiness().ready && this.opts.authoring) {
            extractor = makeAdapterExtractor(
              this.opts.adapter,
              this.sessionInput,
              this.opts.appRoot ? join(this.opts.appRoot, ".extract") : `${this.opts.changeLogPath}.extract`,
            );
          }
          if (!extractor) {
            // Filing already succeeded and is untouched (D1); the model wiring is stated, not silent.
            void this.appLog?.append({
              kind: "extraction.unavailable",
              artifact: artifact.file,
              reason: "extraction needs the authoring harness running — filing is complete either way",
            });
            finished(
              "unavailable",
              0,
              0,
              "reading needs the writing service running — the file is filed either way",
            );
            return;
          }
          const raw = await extractor(text, artifact.file, control.signal);
          const batch = verifyCandidates(raw, text, artifact.extraction?.decided ?? [], artifact.production);
          await storeBatch(store, artifact, batch);
          await this.refreshWorldSnapshot(msg.worldId);
          // Nothing found is an answer, not a failure — and it is the answer whenever the
          // document only repeats what the canon already says (R-17: decided is never re-offered).
          finished(
            batch.verified.length > 0 ? "found" : "nothing",
            batch.verified.length,
            batch.droppedCount,
          );
        } catch (err) {
          if (control.signal.aborted) {
            finished("stopped", 0, 0);
            return;
          }
          void this.appLog?.append({
            kind: "extraction.failed",
            artifact: artifact.file,
            message: err instanceof Error ? err.message : String(err),
          });
          finished("failed", 0, 0, err instanceof Error ? err.message.slice(0, 200) : String(err));
        } finally {
          this.reading.delete(msg.artifactId);
        }
        return;
      }
      case "resolve-extraction": {
        const gate = this.opts.provider.gate?.();
        const store = this.opts.provider.openStore?.();
        if (!gate || !store) return;
        const artifact = store.getBundle().artifacts.find((a) => a.id === msg.artifactId);
        if (!artifact) return;
        await resolveCandidate(store, gate, artifact, msg.candidateHash, msg.decision).catch((err) => {
          void this.appLog?.append({
            kind: "extraction.resolve-failed",
            message: err instanceof Error ? err.message : String(err),
          });
        });
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "record-review": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const review = {
          ts: new Date().toISOString(),
          takeId: msg.takeId,
          ...(msg.shotId !== undefined ? { shotId: msg.shotId } : {}),
          decision: msg.decision,
          by: "user",
          ...(msg.citation !== undefined ? { citation: msg.citation } : {}),
        };
        await store
          .gateOp(async () => {
            const path = join(store.dir, "productions", msg.productionId, "reviews.jsonl");
            const { appendFile } = await import("node:fs/promises");
            await appendFile(toExtendedLength(path), JSON.stringify(review) + "\n", "utf8");
          })
          .catch(() => {});
        this.emit({
          at: new Date().toISOString(),
          type: "review.recorded",
          worldId: msg.worldId,
          productionId: msg.productionId,
          review: review as never,
        });
        return;
      }
      case "voice-catalogue": {
        // The plain list, for a voice that is only reading (design 70). `usedBy` comes from the
        // sheets themselves, so the picker can say a character already uses a voice without
        // that meaning anything about the pick.
        if (!this.voiceService) return;
        const store = this.opts.provider.openStore?.();
        const bundle = store?.getBundle();
        const voices = await this.voiceService.catalogue(bundle?.clonedVoices ?? []).catch(() => []);
        const sheets = bundle?.sheets ?? [];
        this.emit({
          at: new Date().toISOString(),
          type: "voice.catalogue",
          ...(msg.worldId !== undefined ? { worldId: msg.worldId } : {}),
          voices: voices.map((v) => ({
            ...v,
            usedBy: sheets
              .filter((sheet) => sheet.voice?.provider === v.provider && sheet.voice?.voiceId === v.voiceId)
              .map((sheet) => sheet.name),
          })),
        });
        return;
      }
      case "voice-line": {
        // Speak a shot's line in its character's own voice (SPEC-011 R-14). The voice is not a
        // parameter of this message: it is read from the speaker's sheet here, so a retake
        // keeps it by construction and only the delivery can differ.
        const store = this.opts.provider.openStore?.();
        if (!store || !this.voiceService) {
          this.rejectEnqueue(msg.requestId, msg.kind, "Voice generation is unavailable.");
          return;
        }
        const bundle = store.getBundle();
        const production = bundle.productions.find((p) => p.meta.id === msg.productionId);
        const shot = production?.scenes.flatMap((scene) => scene.shots).find((s) => s.id === msg.shotId);
        if (!shot?.audio?.line) {
          this.rejectEnqueue(msg.requestId, msg.kind, "That shot has no spoken line.");
          return;
        }
        const sheet = shot.audio.speaker ? bundle.sheets.find((c) => c.id === shot.audio!.speaker) : undefined;
        if (!sheet) {
          this.rejectEnqueue(msg.requestId, msg.kind, "The speaker is no longer in the cast.");
          return;
        }
        const voice = sheet.voice;
        if (!voice) {
          // The sheet is where a voice is given, and saying so names the place to go.
          this.rejectEnqueue(msg.requestId, msg.kind, `${sheet.name} has no assigned voice — choose one on their sheet.`);
          return;
        }
        const model = this.opts.manifest?.models.find(
          (m) => m.provider === voice.provider && m.capability === "voice-tts",
        );
        if (!model) {
          this.rejectEnqueue(msg.requestId, msg.kind, `No ${voice.provider} voice model is available.`);
          return;
        }
        // A delivery this provider cannot express is stated and travels with the job rather
        // than being dropped into a read that quietly ignores it (R-15).
        let deliveryParams: Record<string, number> | null = null;
        let deliveryNotice: string | null = null;
        if (msg.delivery !== undefined) {
          const mapped = mapDelivery(voice.provider, msg.delivery as Delivery);
          if (mapped.ok) deliveryParams = mapped.params;
          else deliveryNotice = mapped.reason;
        }
        let input;
        try {
          input = voiceLineRequest({
            worldId: msg.worldId,
            productionId: msg.productionId,
            shotId: msg.shotId,
            sheet,
            text: shot.audio.line,
            deliveryParams,
            deliveryNotice,
            model,
          });
        } catch (err) {
          this.rejectEnqueue(msg.requestId, msg.kind, err instanceof Error ? err.message : "The line could not be prepared.");
          return;
        }
        await this.enqueueBatch(msg.requestId, msg.kind, [input]);
        return;
      }
      case "voice-candidates": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.voiceService) return;
        const sheet = store.getBundle().sheets.find((s) => s.id === msg.sheetId);
        if (!sheet) return;
        await this.voiceService
          .candidates(msg.worldId, store.getBundle(), sheet, this.opts.manifest ?? null)
          .catch(() => {});
        return;
      }
      case "voice-preview": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.voiceService) {
          this.rejectEnqueue(msg.requestId, msg.kind, "Voice preview is unavailable.");
          return;
        }
        const bundle = store.getBundle();
        const sheet = bundle.sheets.find((s) => s.id === msg.sheetId);
        if (!sheet) {
          this.rejectEnqueue(msg.requestId, msg.kind, "The character is no longer available.");
          return;
        }
        const line = previewLineFor(sheet, bundle.productions);
        const candidate = (await this.voiceService.catalogue(bundle.clonedVoices)).find(
          (entry) => entry.provider === msg.provider && entry.voiceId === msg.voiceId,
        );
        if (!candidate) {
          this.rejectEnqueue(msg.requestId, msg.kind, "Choose an available voice again.");
          return;
        }
        // kokoro answers synchronously off the sidecar; everything else — cloud or a local recipe —
        // goes through the queue below.
        if (msg.provider !== "kokoro" && msg.provider !== "elevenlabs" && msg.provider !== "comfyui") {
          this.rejectEnqueue(msg.requestId, msg.kind, "Choose an available voice again.");
          return;
        }
        if (msg.provider === "kokoro") {
          // Local: sidecar synthesis, no queue, no ledger, zero cost (R-2).
          try {
            const result = await this.voiceService.localSpeech(store, msg.voiceId, line.text);
            this.emit({
              at: new Date().toISOString(),
              type: "voice.audio",
              requestId: msg.requestId,
              worldId: msg.worldId,
              sheetId: msg.sheetId,
              sheetVersion: sheet.version,
              purpose: "candidate-preview",
              provider: msg.provider,
              model: "kokoro-82m",
              voiceId: msg.voiceId,
              status: "ready",
              file: result.file,
              cached: result.cached,
              characterCount: normalizeSpeechText(line.text).length,
              estimatedMicroUsd: 0,
            });
            await this.refreshWorldSnapshot(msg.worldId);
          } catch (err) {
            this.emit({
              at: new Date().toISOString(),
              type: "voice.audio",
              requestId: msg.requestId,
              worldId: msg.worldId,
              sheetId: msg.sheetId,
              sheetVersion: sheet.version,
              purpose: "candidate-preview",
              provider: "kokoro",
              model: "kokoro-82m",
              voiceId: msg.voiceId,
              status: "failed",
              file: null,
              cached: false,
              characterCount: normalizeSpeechText(line.text).length,
              estimatedMicroUsd: 0,
              error: err instanceof Error ? err.message : "Local voice failed.",
            });
          }
          this.emitEnqueueResult(msg.requestId, msg.kind, 0, [], [], true);
          return;
        }
        // Cloud: cache hit replays free; a miss dispatches through the queue (R-2, R-10).
        const cached = previewCacheFile(msg.provider, msg.voiceId, line.text, "mp3");
        try {
          const bytes = await readFile(toExtendedLength(join(store.dir, fromPortable(cached))));
          const mp3 = bytes.subarray(0, 3).toString("ascii") === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
          if (!mp3) throw new Error("invalid cache");
          this.emit({
            at: new Date().toISOString(),
            type: "voice.audio",
            requestId: msg.requestId,
            worldId: msg.worldId,
            sheetId: msg.sheetId,
            sheetVersion: sheet.version,
            purpose: "candidate-preview",
            provider: "elevenlabs",
            model: "eleven_multilingual_v2",
            voiceId: msg.voiceId,
            status: "ready",
            file: cached,
            cached: true,
            characterCount: normalizeSpeechText(line.text).length,
            estimatedMicroUsd: 0,
          });
          this.emitEnqueueResult(msg.requestId, msg.kind, 0, [], [], true);
          return;
        } catch {
          /* miss → enqueue */
        }
        const model = this.opts.manifest?.models.find(
          (m) => m.provider === msg.provider && m.capability === "voice-tts",
        );
        if (!model) {
          this.rejectEnqueue(msg.requestId, msg.kind, "No cloud voice model is available for this provider.");
          return;
        }
        // A cloned voice speaks from a clip, so the clip has to exist before a job is enqueued.
        // Missing means the recording was deleted from under the library: reported with the reason
        // rather than dispatched into a take that cannot finish (SPEC-022 §1.3).
        let speakerFile: string | undefined;
        if (msg.provider === "comfyui") {
          const voice = bundle.clonedVoices.find((v) => v.id === msg.voiceId);
          const clip = voice ? await clipFor(store, voice) : null;
          if (clip === null) {
            this.rejectEnqueue(
              msg.requestId,
              msg.kind,
              "That voice's recording is missing — re-clone it, or choose another voice.",
            );
            return;
          }
          speakerFile = clip;
        }
        const request = this.voiceService.queuedPreviewRequest({
          worldId: msg.worldId,
          sheet,
          provider: msg.provider,
          voiceId: msg.voiceId,
          line,
          model,
          ...(speakerFile !== undefined ? { speakerFile } : {}),
        });
        request.input.params = {
          ...request.input.params,
          requestId: msg.requestId,
          purpose: "candidate-preview",
          sheetId: sheet.id,
          sheetVersion: sheet.version,
          characterCount: normalizeSpeechText(line.text).length,
        };
        const queued = await this.enqueueBatch(msg.requestId, msg.kind, [request.input]);
        if (!queued.accepted) {
          this.emit({ at: new Date().toISOString(), type: "voice.audio", requestId: msg.requestId,
            worldId: msg.worldId, sheetId: sheet.id, sheetVersion: sheet.version, purpose: "candidate-preview",
            provider: "elevenlabs", model: model.id, voiceId: msg.voiceId, status: "failed", file: null,
            cached: false, characterCount: normalizeSpeechText(line.text).length, estimatedMicroUsd: request.input.estimatedMicroUsd,
            error: queued.reason ?? "Voice preview could not be queued." });
        }
        return;
      }
      case "read-sheet-section": {
        const store = this.opts.provider.openStore?.();
        if (!store || store.worldId !== msg.worldId || !this.voiceService) return;
        const sheet = store.getBundle().sheets.find((candidate) => candidate.id === msg.sheetId);
        let resolved: ReturnType<typeof authoritativeSheetSpeech> | null = null;
        try { if (sheet) resolved = authoritativeSheetSpeech(sheet, msg.sectionHeading); } catch { /* emitted below */ }
        const text = resolved?.text ?? "";
        const fail = (error: string) => this.emit({
          at: new Date().toISOString(), type: "voice.audio", requestId: msg.requestId,
          worldId: msg.worldId, sheetId: msg.sheetId, sheetVersion: sheet?.version ?? 1,
          purpose: "sheet-section", sectionHeading: msg.sectionHeading,
          provider: sheet?.voice?.provider === "elevenlabs" ? "elevenlabs" : "kokoro",
          model: sheet?.voice?.provider === "elevenlabs" ? "eleven_multilingual_v2" : "kokoro-82m",
          voiceId: sheet?.voice?.voiceId ?? "unassigned", status: "failed", file: null,
          cached: false, characterCount: text.length, estimatedMicroUsd: 0, error,
        } as DomainEvent);
        if (!sheet) { fail("The character is no longer available."); return; }
        try { resolved = authoritativeSheetSpeech(sheet, msg.sectionHeading); }
        catch (error) { fail(error instanceof Error ? error.message : "Read aloud is unavailable."); return; }
        // Who narrates is the app's preference, not the character's. Reading prose ABOUT
        // somebody in their own voice was the old behaviour, and it refused entirely for the
        // many characters who have no voice assigned.
        const narratorSettings = this.appSettings ? await this.appSettings.load() : null;
        const narratorVoices = this.opts.provider.openStore?.()?.getBundle().clonedVoices ?? [];
        const narrator = narratorFor(
          narratorSettings?.narrator ?? null,
          await this.voiceService.catalogue(narratorVoices),
        );
        if (narrator.provider !== "kokoro" && narrator.provider !== "elevenlabs") {
          fail("The narrator's voice is not available — choose another in Settings.");
          return;
        }
        const speaking = { provider: narrator.provider, voiceId: narrator.voiceId };
        if (speaking.provider === "kokoro") {
          try {
            const result = await this.voiceService.localSpeech(store, speaking.voiceId, text);
            this.emit({ at: new Date().toISOString(), type: "voice.audio", requestId: msg.requestId,
              worldId: msg.worldId, sheetId: sheet.id, sheetVersion: sheet.version, purpose: "sheet-section",
              sectionHeading: msg.sectionHeading, provider: "kokoro", model: "kokoro-82m",
              voiceId: speaking.voiceId, status: "ready", file: result.file, cached: result.cached,
              characterCount: text.length, estimatedMicroUsd: 0 });
          } catch (error) { fail(error instanceof Error ? error.message : "Local voice failed."); }
          return;
        }
        const model = this.opts.manifest?.models.find((candidate) => candidate.provider === "elevenlabs" && candidate.capability === "voice-tts");
        if (!model) { fail("ElevenLabs voice is unavailable."); return; }
        const file = speechCacheFile({ provider: "elevenlabs", model: model.id, voiceId: speaking.voiceId, text, format: "mp3" });
        try {
          const bytes = await readFile(toExtendedLength(join(store.dir, fromPortable(file))));
          const mp3 = bytes.subarray(0, 3).toString("ascii") === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
          if (!mp3) throw new Error("invalid cache");
          this.emit({ at: new Date().toISOString(), type: "voice.audio", requestId: msg.requestId,
            worldId: msg.worldId, sheetId: sheet.id, sheetVersion: sheet.version, purpose: "sheet-section",
            sectionHeading: msg.sectionHeading, provider: "elevenlabs", model: model.id, voiceId: speaking.voiceId,
            status: "ready", file, cached: true, characterCount: text.length, estimatedMicroUsd: 0 });
          return;
        } catch { /* confirmation required */ }
        const estimate = estimateMicroUsd(model, { characters: text.length });
        const token = createHash("sha256").update(`${sheet.id}\n${sheet.version}\n${file}`).digest("hex");
        const input: EnqueueInput = { worldId: msg.worldId, target: { kind: "voice-preview", id: `${sheet.id}/elevenlabs/${speaking.voiceId}` },
          capability: "voice-tts", provider: "elevenlabs", model: model.id,
          params: { voiceId: speaking.voiceId, text, requestId: msg.requestId, purpose: "sheet-section",
            sheetId: sheet.id, sheetVersion: sheet.version, sectionHeading: msg.sectionHeading, characterCount: text.length },
          estimatedMicroUsd: estimate, landing: { dir: ".cache/voice-previews", name: file.split("/").pop()! } };
        if (msg.confirmationToken !== token) {
          this.pendingVoiceReads.set(msg.requestId, { token, input });
          this.emit({ at: new Date().toISOString(), type: "voice.audio", requestId: msg.requestId,
            worldId: msg.worldId, sheetId: sheet.id, sheetVersion: sheet.version, purpose: "sheet-section",
            sectionHeading: msg.sectionHeading, provider: "elevenlabs", model: model.id, voiceId: speaking.voiceId,
            status: "confirmation-required", file: null, cached: false, characterCount: text.length,
            estimatedMicroUsd: estimate, confirmationToken: token });
          return;
        }
        const pending = this.pendingVoiceReads.get(msg.requestId);
        if (!pending || pending.token !== token) { fail("The read request changed; review it again."); return; }
        this.pendingVoiceReads.delete(msg.requestId);
        const queued = await this.enqueueBatch(msg.requestId, msg.kind, [pending.input]);
        if (!queued.accepted) fail(queued.reason ?? "Voice synthesis could not be queued.");
        return;
      }
      case "transcribe-dictation": {
        if (!this.voiceService) return;
        await this.voiceService.dictate(
          msg.requestId,
          Uint8Array.from(Buffer.from(msg.audioBase64, "base64")),
          msg.contentType,
        );
        return;
      }
      case "generate-world-image": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.opts.manifest) {
          this.rejectEnqueue(msg.requestId, msg.kind, "World key art is unavailable.");
          return;
        }
        const model = imageModelFor(
          this.appSettings ? await this.appSettings.load() : null,
          this.opts.manifest,
          "modelId" in msg ? msg.modelId : undefined,
        );
        // The screen disables the button without a usable image model and says why; this is the
        // backstop for a frame that arrives anyway.
        if (!model) {
          this.rejectEnqueue(
            msg.requestId,
            msg.kind,
            "No image model is available. Check provider settings.",
          );
          return;
        }
        const bundle = store.getBundle();
        // Ask the harness to write the prompt, and carry on without it if it cannot. A writing
        // model turns "a drowned god still sings" into light, material and lens; the plain
        // assembly is a weaker prompt, but it is a prompt, and a picture still gets made.
        //
        // Unless the author wrote it themselves (design 64), in which case neither runs: the box
        // on the art-direction page opens as the words this would otherwise compose, so an edit
        // to it is a decision about this picture, and rewriting it would discard that decision.
        const authored = "prompt" in msg ? msg.prompt?.trim() : undefined;
        let prompt: string | null = null;
        if (authored === undefined && this.opts.adapter?.readiness().ready) {
          const director = makeArtDirector(
            this.opts.adapter,
            this.sessionInput,
            this.opts.appRoot ? join(this.opts.appRoot, ".art") : `${this.opts.changeLogPath}.art`,
          );
          // The most-cited canon first: what the world has settled about itself is what an
          // establishing image should be true to.
          const canonLines = bundle.canon
            .filter((c) => c.status !== "open")
            .slice(0, 6)
            .map((c) => c.title);
          prompt = await director(worldBrief(bundle.meta, canonLines)).catch(() => null);
          void this.appLog?.append({
            kind: prompt ? "world-image.prompt-written" : "world-image.prompt-unavailable",
            worldId: msg.worldId,
            ...(prompt ? { prompt } : {}),
          });
        }
        // One job per preview asked for, each landing under its own name (design 65). Four jobs
        // sharing one landing name would be four charges and one file — the defect the character
        // candidates were numbered to fix, and there is no reason for this path to relearn it.
        const count = ("count" in msg ? msg.count : undefined) ?? 1;
        // A world has no reference kit, so a staged image is the only reference key art can ever
        // carry — and it goes in only when there is one, because an empty references field is one
        // more thing a provider has to know to ignore, and OpenAI answers unknown fields with 400.
        const stagedKeyArt = stagedFor(bundle, stagedReferenceKey("world-image"), model);
        const requests = Array.from({ length: count }, (_, index) =>
          worldImageRequest(bundle.meta, model, bundle.artDirection, { index, count }, stagedKeyArt),
        );
        // The suffix survives every branch (#244, round 3): composing constraints upstream in
        // worldImageRequest bound only the fallback, so the directed path — the normal one —
        // quietly dropped them until the precedence moved into one place.
        const words = keyArtPrompt({
          composed: String(requests[0]!.params["prompt"]),
          description: bundle.artDirection.description,
          suffix: imageConstraintSuffix(bundle.artDirection),
          ...(authored !== undefined ? { authored } : {}),
          directed: prompt,
        });
        // Every candidate is asked for from the same words. They differ because the model is
        // sampled afresh, not because we quietly reword the brief per slot — the author wrote
        // one description of one picture and asked to see it several times.
        await this.enqueueBatch(
          msg.requestId,
          msg.kind,
          requests.map((request) => ({ ...request, params: { ...request.params, prompt: words } })),
        );
        return;
      }
      /*
       * Artifacts, from the panel beside the cut (82a).
       *
       * `fileArtifact` already owns everything hard about this — dedup by hash, the large-file
       * consent gate, the sidecar, and measuring audio and video as the bytes are copied — so this
       * picks files and reports what happened to each. Nothing is placed: a placement needs a time
       * and only the lane knows one.
       */
      case "upload-artifacts": {
        const store = this.opts.provider.openStore?.();
        const pick = this.opts.pickFiles;
        if (!store || store.worldId !== msg.worldId || !pick) {
          this.rejectEnqueue(msg.requestId, msg.kind, "Filing artifacts is unavailable.");
          return;
        }
        const chosen = await pick({ accept: [...ATTACHABLE_EXTENSIONS] }).catch(() => []);
        // A closed dialog is not a failure. Nothing was filed and nothing is said.
        if (chosen.length === 0) {
          this.emitEnqueueResult(msg.requestId, msg.kind, 0, [], [], true);
          return;
        }
        const failures: Array<{ index: number; reason: string }> = [];
        let filed = 0;
        for (const [index, sourcePath] of chosen.entries()) {
          if (!this.stillOpen(store)) return;
          const outcome = await fileArtifact(store, {
            sourcePath,
            // Measured as it is filed (#283): an artifact is immutable, so its length and whether
            // it carries audio are true once and true forever.
            ...(this.opts.mediaProbe !== undefined ? { mediaProbe: this.opts.mediaProbe } : {}),
            abandoned: () => !this.stillOpen(store) || this.stopping,
            // The world's shelf, explicitly. An artifact laid over one production's cut is still
            // the world's, which is what the panel beside the cut is showing.
            production: null,
          }).catch((err: unknown) => ({
            outcome: "refused" as const,
            reason: err instanceof Error ? err.message : String(err),
          }));
          if (outcome.outcome === "filed" || outcome.outcome === "deduplicated") filed += 1;
          else if (outcome.outcome === "needs-consent") {
            failures.push({ index, reason: `${sourcePath}: ${outcome.reason}` });
          } else failures.push({ index, reason: `${sourcePath}: ${outcome.reason}` });
        }
        this.emitEnqueueResult(msg.requestId, msg.kind, chosen.length, [], failures, filed === 0);
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "upload-world-image": {
        const store = this.opts.provider.openStore?.();
        const pick = this.opts.pickFiles;
        if (!store || store.worldId !== msg.worldId || !pick) {
          this.rejectEnqueue(msg.requestId, msg.kind, "Key art upload is unavailable.");
          return;
        }
        const chosen = await pick({ accept: [...IMPORTABLE_IMAGES] }).catch(() => []);
        const [source] = chosen;
        // A closed dialog is not a failure. Nothing was queued and nothing is said.
        if (!source) {
          this.emitEnqueueResult(msg.requestId, msg.kind, 0, [], [], true);
          return;
        }
        if (chosen.length > 1) {
          this.rejectEnqueue(msg.requestId, msg.kind, ONE_IMAGE_ONLY);
          return;
        }
        if (!this.stillOpen(store)) return;
        const picked = await readPickedImage(source);
        if (!this.stillOpen(store)) return;
        if ("error" in picked) {
          this.rejectEnqueue(msg.requestId, msg.kind, picked.error);
          return;
        }
        const landed = await store
          .gateOp(async () => {
            // One candidate at a time, and the extension follows the bytes — so replacing a PNG
            // with a JPEG must not leave the PNG behind for the scan to find first.
            await rm(toExtendedLength(join(store.dir, WORLD_IMAGE_DIR)), { recursive: true, force: true });
            await atomicWriteFile(
              join(store.dir, WORLD_IMAGE_DIR, `candidate${picked.extension}`),
              picked.data,
            );
          })
          .then(
            () => true,
            () => false,
          );
        if (!landed) {
          this.rejectEnqueue(msg.requestId, msg.kind, "That image could not be copied into the world.");
          return;
        }
        this.emitEnqueueResult(msg.requestId, msg.kind, 0, [], [], true);
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "use-world-image": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        // Which one, of however many are waiting (design 65). A named file must be one of them:
        // the message arrives from the renderer, and copying an arbitrary world-relative path
        // onto the world's key art on request is not a thing this handler should be able to do.
        const waiting = store.getBundle().keyArtCandidates;
        const named = "file" in msg ? msg.file : undefined;
        const candidate = named === undefined ? waiting[0] : waiting.find((path) => path === named);
        if (candidate === undefined) return;
        /*
         * The accepted file keeps the format its bytes carry.
         *
         * This used to copy a fixed `candidate.png` onto a fixed `world-art.png`, which was true
         * while the only way to get one was to generate it. An uploaded JPEG written under a
         * `.png` name would be served as `image/png` by a media route that reads the extension —
         * and naming a file for a format it is not is the one thing every other import refuses.
         */
        const extension = extname(candidate).toLowerCase() || ".png";
        await store
          .gateOp(async () => {
            await copyFile(
              toExtendedLength(join(store.dir, fromPortable(candidate))),
              toExtendedLength(join(store.dir, `${WORLD_IMAGE_STEM}${extension}`)),
            );
            // The world has one key art, so a previous one in a different format goes with it.
            // Two would leave the scan choosing between them by sort order.
            for (const stale of KEY_ART_EXTENSIONS.filter((other) => other !== extension)) {
              await rm(toExtendedLength(join(store.dir, `${WORLD_IMAGE_STEM}${stale}`)), { force: true });
            }
            await rm(toExtendedLength(join(store.dir, WORLD_IMAGE_DIR)), { recursive: true, force: true });
          })
          .catch(() => {});
        await this.dropStagedReference(store, stagedReferenceKey("world-image"));
        await this.refreshWorldSnapshot(msg.worldId);
        // The picker reads the registry, not the open world's bundle, so the card that sent you
        // here goes on showing the old image until the list is asked for again.
        await this.refreshWorldList();
        return;
      }
      case "discard-world-image": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await store
          .gateOp(async () => rm(toExtendedLength(join(store.dir, WORLD_IMAGE_DIR)), { recursive: true, force: true }))
          .catch(() => {});
        await this.dropStagedReference(store, stagedReferenceKey("world-image"));
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "generate-master-look": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.opts.manifest) {
          this.rejectEnqueue(msg.requestId, msg.kind, "Master look generation is unavailable.");
          return;
        }
        const model = imageModelFor(
          this.appSettings ? await this.appSettings.load() : null,
          this.opts.manifest,
          msg.modelId,
        );
        if (!model) {
          this.rejectEnqueue(
            msg.requestId,
            msg.kind,
            "No image model is available. Check provider settings.",
          );
          return;
        }
        const bundle = store.getBundle();
        // No art-director rewrite here, unlike key art. Key art is an image *of the world* and
        // benefits from a writing model turning a logline into light and lens; this is an image
        // *of the look*, and the look is already the words every generation receives. A prompt
        // typed in the dialog replaces those words for this one image and is sent as written.
        //
        // The staged reference rides along only where the model can take one. Sending it to a
        // model that declares no reference slots would not be refused by the provider — it would
        // be quietly dropped, and the estimate would have charged for it.
        const references = stagedFor(bundle, stagedReferenceKey("master-look"), model);
        // One job per preview, each under its own landing name (design 65).
        const wanted = msg.count ?? 1;
        await this.enqueueBatch(
          msg.requestId,
          msg.kind,
          Array.from({ length: wanted }, (_, index) =>
            masterLookRequest(bundle.meta, model, bundle.artDirection, {
              ...(msg.prompt !== undefined ? { prompt: msg.prompt } : {}),
              ...(msg.tier !== undefined ? { tier: msg.tier } : {}),
              ...(msg.aspect !== undefined ? { aspect: msg.aspect } : {}),
              references,
              slot: { index, count: wanted },
            }),
          ),
        );
        return;
      }
      case "pick-staged-reference": {
        const store = this.opts.provider.openStore?.();
        const pick = this.opts.pickFiles;
        if (!store || store.worldId !== msg.worldId || !pick) {
          this.rejectEnqueue(msg.requestId, msg.kind, "Reference images are unavailable.");
          return;
        }
        const chosen = await pick({ accept: [...IMPORTABLE_IMAGES] }).catch(() => []);
        const [source] = chosen;
        // A closed dialog is not a failure, here as everywhere else the host picker is opened.
        if (!source) {
          this.emitEnqueueResult(msg.requestId, msg.kind, 0, [], [], true);
          return;
        }
        if (chosen.length > 1) {
          this.rejectEnqueue(msg.requestId, msg.kind, ONE_IMAGE_ONLY);
          return;
        }
        if (!this.stillOpen(store)) return;
        const picked = await readPickedImage(source);
        if (!this.stillOpen(store)) return;
        if ("error" in picked) {
          this.rejectEnqueue(msg.requestId, msg.kind, picked.error);
          return;
        }
        const landed = await store
          .gateOp(async () => {
            // One reference at a time, and the extension follows the bytes — the same rule the
            // candidate follows, for the same reason: a stale PNG beside a new JPEG is what the
            // scan would find first.
            await rm(toExtendedLength(join(store.dir, stagedReferenceDir(msg.key))), {
              recursive: true,
              force: true,
            });
            await atomicWriteFile(
              join(store.dir, stagedReferenceDir(msg.key), `reference${picked.extension}`),
              picked.data,
            );
          })
          .then(
            () => true,
            () => false,
          );
        if (!landed) {
          this.rejectEnqueue(msg.requestId, msg.kind, "That image could not be copied into the world.");
          return;
        }
        // Nothing was queued: staging a reference spends nothing and reaches no provider.
        this.emitEnqueueResult(msg.requestId, msg.kind, 0, [], [], true);
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "clear-staged-reference": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await this.dropStagedReference(store, msg.key);
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "upload-master-look": {
        const store = this.opts.provider.openStore?.();
        const pick = this.opts.pickFiles;
        if (!store || store.worldId !== msg.worldId || !pick) {
          this.rejectEnqueue(msg.requestId, msg.kind, "Master look upload is unavailable.");
          return;
        }
        const chosen = await pick({ accept: [...IMPORTABLE_IMAGES] }).catch(() => []);
        const [source] = chosen;
        // A closed dialog is not a failure. Nothing was queued and nothing is said.
        if (!source) {
          this.emitEnqueueResult(msg.requestId, msg.kind, 0, [], [], true);
          return;
        }
        if (chosen.length > 1) {
          this.rejectEnqueue(msg.requestId, msg.kind, ONE_IMAGE_ONLY);
          return;
        }
        if (!this.stillOpen(store)) return;
        const picked = await readPickedImage(source);
        // Again after the read: 50 MB takes a moment, and a world switched during it leaves this
        // holding a closed store, which would still accept writes.
        if (!this.stillOpen(store)) return;
        if ("error" in picked) {
          this.rejectEnqueue(msg.requestId, msg.kind, picked.error);
          return;
        }
        const landed = await store
          .gateOp(async () => {
            // One candidate at a time, and the extension follows the bytes — so replacing a PNG
            // with a JPEG must not leave the PNG behind for the scan to find first.
            await rm(toExtendedLength(join(store.dir, MASTER_LOOK_DIR)), { recursive: true, force: true });
            await atomicWriteFile(
              join(store.dir, MASTER_LOOK_DIR, `candidate${picked.extension}`),
              picked.data,
            );
          })
          .then(
            () => true,
            () => false,
          );
        if (!landed) {
          this.rejectEnqueue(msg.requestId, msg.kind, "That image could not be copied into the world.");
          return;
        }
        // Nothing was queued — the offer is on the screen, in the snapshot the gate op just
        // refreshed. Reporting a job that does not exist would send the user to Activity to
        // look for it.
        this.emitEnqueueResult(msg.requestId, msg.kind, 0, [], [], true);
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "use-master-look": {
        const store = this.opts.provider.openStore?.();
        const gate = this.opts.provider.gate?.();
        if (!store || !gate) return;
        // Which of the waiting candidates (design 65), and it must be one of them: this handler
        // copies the named path into the world, so it may not take a path from the renderer on
        // trust.
        const offered = store.getBundle().masterLookCandidates;
        const chosen = "file" in msg ? msg.file : undefined;
        const candidate = chosen === undefined ? offered[0] : offered.find((path) => path === chosen);
        if (candidate === undefined) return;
        /*
         * Accepting a master look is a look change, taken through the gate like any other.
         *
         * The alternative — copying the file in and pointing the current record at it — would
         * mutate an accepted version in place: every take made under v3 would suddenly claim a
         * master look that did not exist when it was made, and the history entry for v3 would
         * describe an image nobody working under v3 ever saw. So the image lands under the
         * *next* version's name, and the record that names it is the next version.
         */
        const direction = store.getBundle().artDirection;
        const next = direction.version + 1;
        const file = masterLookFile(next, extname(candidate).toLowerCase() || ".png");
        const moved = await store
          .ownedWrite(async () => {
            // A world whose look is still derived has no `art-direction/` at all — the folder
            // arrives with the first record, and this can be what happens before that.
            await mkdir(toExtendedLength(join(store.dir, MASTER_LOOK_DIR_ACCEPTED)), { recursive: true });
            await copyFile(
              toExtendedLength(join(store.dir, fromPortable(candidate))),
              toExtendedLength(join(store.dir, fromPortable(file))),
            );
            await rm(toExtendedLength(join(store.dir, MASTER_LOOK_DIR)), { recursive: true, force: true });
          })
          .then(
            () => true,
            () => false,
          );
        if (!moved) {
          await this.refreshWorldSnapshot(msg.worldId);
          return;
        }
        const accepted = await (async () => {
          const proposal = await gate.stageArtDirectionChange(direction.description, file);
          const outcome = await gate.accept(proposal.id, {});
          return outcome.status === "accepted";
        })().catch(() => false);
        if (!accepted) {
          // An image the record does not name is an orphan nothing can show or remove. It goes
          // back to being a candidate, so the offer is still on the screen and can be retried.
          await store
            .ownedWrite(async () => {
              // The directory the forward step just deleted. Without recreating it the copy
              // fails, the failure is swallowed, and the image stays exactly where the rollback
              // exists to stop it staying.
              await mkdir(toExtendedLength(join(store.dir, MASTER_LOOK_DIR)), { recursive: true });
              await copyFile(
                toExtendedLength(join(store.dir, fromPortable(file))),
                toExtendedLength(join(store.dir, MASTER_LOOK_DIR, `candidate${extname(file)}`)),
              );
              await rm(toExtendedLength(join(store.dir, fromPortable(file))), { force: true });
            })
            .catch(() => {});
        }
        if (accepted) await this.dropStagedReference(store, stagedReferenceKey("master-look"));
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "discard-master-look": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await store
          .gateOp(async () =>
            rm(toExtendedLength(join(store.dir, MASTER_LOOK_DIR)), { recursive: true, force: true }),
          )
          .catch(() => {});
        await this.dropStagedReference(store, stagedReferenceKey("master-look"));
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "establish-look": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.opts.manifest) {
          this.rejectEnqueue(msg.requestId, msg.kind, "Reference generation is unavailable.");
          return;
        }
        const sheet = store.getBundle().sheets.find((s) => s.id === msg.sheetId);
        if (!sheet) {
          this.rejectEnqueue(msg.requestId, msg.kind, "The character is no longer available.");
          return;
        }
        const model = imageModelFor(
          this.appSettings ? await this.appSettings.load() : null,
          this.opts.manifest,
        );
        if (!model) {
          this.rejectEnqueue(
            msg.requestId,
            msg.kind,
            "No image model is available. Check provider settings.",
          );
          return;
        }
        const kit = (await readKit(store, msg.sheetId))?.kit ?? null;
        const bundle = store.getBundle();
        let requests;
        try {
          requests = establishRequests(bundle.meta, sheet, kit, model, msg.count, bundle.artDirection);
        } catch {
          this.rejectEnqueue(
            msg.requestId,
            msg.kind,
            "This image model could not be priced for the selected output size. Nothing was queued.",
          );
          return;
        }
        await this.enqueueBatch(
          msg.requestId,
          msg.kind,
          requests.map((request) => request.input),
        );
        return;
      }
      case "choose-anchor": {
        const store = this.opts.provider.openStore?.();
        let source: "upload" | "generated" = msg.selection.source === "candidate" ? "upload" : "generated";
        const report = (
          status: "accepted" | "failed",
          candidateRetained: boolean,
          reason?: string,
          stage?: MainPhotoAcceptanceStage,
        ) => {
          if (stage) {
            void this.appLog?.append(mainPhotoLogRecord(msg.worldId, msg.sheetId, stage, source));
          }
          this.emit({
            at: new Date().toISOString(),
            type: "main-photo.acceptance",
            worldId: msg.worldId,
            sheetId: msg.sheetId,
            status,
            ...(reason ? { reason } : {}),
            candidateRetained,
          });
        };
        if (!store || store.worldId !== msg.worldId) {
          report(
            "failed",
            true,
            "The main photo was not changed. Open this world and try again.",
            "candidate-validation",
          );
          return;
        }
        const sheet = store.getBundle().sheets.find((s) => s.id === msg.sheetId);
        if (!sheet) {
          report(
            "failed",
            true,
            "The main photo was not changed because the character is unavailable.",
            "candidate-validation",
          );
          return;
        }
        let bundle = store.getBundle();
        let selection = msg.selection;
        let sourceCandidatePath: string | null = null;
        if (selection.source === "take") {
          const takeId = selection.takeId;
          const take = bundle.referenceTakes.find((candidate) => candidate.id === takeId);
          const job = take?.jobId
            ? this.jobQueue?.listJobs().find((candidate) => candidate.id === take.jobId)
            : undefined;
          sourceCandidatePath =
            (typeof take?.params["sourceCandidate"] === "string" ? take.params["sourceCandidate"] : null) ??
            job?.landedFiles?.find((path) => path.startsWith(`references/${msg.sheetId}/candidates/`)) ??
            null;
        } else {
          const candidatePath = `references/${msg.sheetId}/candidates/${selection.file}`;
          const job = this.jobQueue
            ?.listJobs()
            .find(
              (candidate) =>
                candidate.status === "succeeded" &&
                (candidate.target.kind === "main-photo-candidate" ||
                  candidate.target.kind === "establish-candidate") &&
                candidate.target.id?.startsWith(`${msg.sheetId}/`) === true &&
                candidate.landedFiles?.includes(candidatePath),
            );
          if (job) {
            source = "generated";
            const recovered = await recordReferenceTake(store, job).catch(() => null);
            if (!recovered) {
              // Accepting settles the ask this reference was staged for (design 67). A rejection does
              // not: the usual answer to one is to run it again, and running it again with the
              // picture you had just chosen is the point of having staged it.
              await this.dropStagedReference(store, stagedReferenceKey("main-photo", msg.sheetId));
              await this.refreshWorldSnapshot(msg.worldId);
              report("failed", true, mainPhotoFailureReason("take-recording"), "take-recording");
              return;
            }
            bundle = store.getBundle();
            selection = { source: "take", takeId: recovered.id };
            sourceCandidatePath = candidatePath;
          }
        }
        const result = await acceptMainPhoto(store, sheet, bundle, selection, sourceCandidatePath);
        await this.refreshWorldSnapshot(msg.worldId);
        if (result.status === "failed") {
          report("failed", result.candidateRetained, mainPhotoFailureReason(result.stage), result.stage);
          return;
        }
        if (result.cleanupError) {
          report("accepted", true, undefined, "candidate-cleanup");
          return;
        }
        report("accepted", false);
        return;
      }
      case "import-main-photo-candidate": {
        const store = this.opts.provider.openStore?.();
        const pick = this.opts.pickFiles;
        // The open world must be the world the frame was written for. Sheet slugs recur across
        // worlds, so a frame from a screen the user has since navigated away from would file the
        // image under the same-named character somewhere else entirely — and the only sign would
        // be a candidate nobody put there. Every other reference handler already checks this.
        if (!store || store.worldId !== msg.worldId || !pick) return;
        const [source] = await pick({ accept: [...IMPORTABLE_IMAGES] }).catch(() => []);
        if (!source) return;
        if (!this.stillOpen(store)) return;
        const picked = await readPickedImage(source);
        if ("error" in picked) {
          // Reported through the acceptance slot the replace dialog already reads. This route
          // adds a candidate rather than accepting one, so it has no report of its own — and
          // saying nothing would leave a refused file indistinguishable from a dead button.
          this.emit({
            at: new Date().toISOString(),
            type: "main-photo.acceptance",
            worldId: msg.worldId,
            sheetId: msg.sheetId,
            status: "failed",
            reason: picked.error,
            candidateRetained: false,
          });
          return;
        }
        await store
          .gateOp(async () => {
            const name = `upload-${Date.now().toString(36)}${picked.extension}`;
            await landUploadedImage(store, msg.sheetId, name, picked.data);
          })
          .catch(() => {});
        this.refreshIfStillOpen(store);
        return;
      }
      case "import-main-photo": {
        const store = this.opts.provider.openStore?.();
        const pick = this.opts.pickFiles;
        const report = (
          status: "accepted" | "failed" | "cancelled",
          candidateRetained: boolean,
          reason?: string,
        ) =>
          this.emit({
            at: new Date().toISOString(),
            type: "main-photo.acceptance",
            worldId: msg.worldId,
            sheetId: msg.sheetId,
            status,
            ...(reason ? { reason } : {}),
            candidateRetained,
          });
        if (!store || store.worldId !== msg.worldId || !pick) return;
        if (!store.getBundle().sheets.some((candidate) => candidate.id === msg.sheetId)) {
          report("failed", false, "The main photo was not changed because the character is unavailable.");
          return;
        }
        const chosen = await pick({ accept: [...IMPORTABLE_IMAGES] }).catch(() => []);
        // A closed dialog is not a failure — no error belongs under a card the user just decided
        // to leave alone — but it is still an ending, and the button that opened it is waiting.
        const [source] = chosen;
        if (!source) {
          report("cancelled", false);
          return;
        }
        if (chosen.length > 1) {
          report("failed", false, ONE_IMAGE_ONLY);
          return;
        }
        // Nor is walking away mid-dialog. Nothing to report to a screen that has gone.
        if (!this.stillOpen(store)) return;
        const picked = await readPickedImage(source);
        // Again after the read: 50 MB takes a moment, and a world switched during it leaves this
        // holding a closed store, which would still accept writes (PR review).
        if (!this.stillOpen(store)) return;
        if ("error" in picked) {
          report("failed", false, picked.error);
          return;
        }
        // Before writing, not only after: a character deleted while the dialog stood open has no
        // card left to reach a retained candidate through, so landing 50 MB under its name would
        // put media in the world that nothing could show and nobody could remove (PR review).
        if (!store.getBundle().sheets.some((candidate) => candidate.id === msg.sheetId)) {
          report("failed", false, "The main photo was not changed because the character is unavailable.");
          return;
        }
        const file = `upload-${Date.now().toString(36)}${picked.extension}`;
        const landed = await store
          .gateOp(() => landUploadedImage(store, msg.sheetId, file, picked.data))
          .then(
            () => true,
            () => false,
          );
        if (!landed) {
          report("failed", false, "The main photo was not changed because that file could not be copied in.");
          return;
        }
        // Re-read after the picker: a dialog can stand open for minutes, and the version this
        // accept records has to be the one the world holds now, not the one it held when the
        // button was pressed (PR #241 review).
        const sheet = store.getBundle().sheets.find((candidate) => candidate.id === msg.sheetId);
        if (!sheet) {
          // Deleted between the two checks. The candidate we just wrote is the only trace, and
          // there is no longer anywhere to see it, so it goes rather than lingering unreachable.
          await store
            .ownedWrite(() => rm(toExtendedLength(join(store.dir, "references", msg.sheetId, "candidates", file))))
            .catch(() => {});
          report("failed", false, "The main photo was not changed because the character is unavailable.");
          return;
        }
        // gateOp rescans on the way out, so the bundle already lists the candidate that
        // acceptMainPhoto is about to validate against — and from here the upload takes the
        // identical path a chosen candidate takes, staged failures and cleanup included.
        const result = await acceptMainPhoto(store, sheet, store.getBundle(), { source: "candidate", file });
        this.refreshIfStillOpen(store);
        if (result.status === "failed") {
          void this.appLog?.append(mainPhotoLogRecord(msg.worldId, msg.sheetId, result.stage, "upload"));
          report("failed", result.candidateRetained, mainPhotoFailureReason(result.stage));
          return;
        }
        if (result.cleanupError) {
          void this.appLog?.append(mainPhotoLogRecord(msg.worldId, msg.sheetId, "candidate-cleanup", "upload"));
          report("accepted", true);
          return;
        }
        report("accepted", false);
        return;
      }
      case "import-character-sheet": {
        const store = this.opts.provider.openStore?.();
        const pick = this.opts.pickFiles;
        const report = (status: "accepted" | "failed" | "cancelled", reason?: string) =>
          this.emit({
            at: new Date().toISOString(),
            type: "character-sheet.acceptance",
            worldId: msg.worldId,
            sheetId: msg.sheetId,
            status,
            ...(reason ? { reason } : {}),
          });
        if (!store || store.worldId !== msg.worldId || !pick) return;
        if (!store.getBundle().sheets.some((candidate) => candidate.id === msg.sheetId)) {
          report("failed", "The character sheet was not changed because the character is unavailable.");
          return;
        }
        const chosen = await pick({ accept: [...IMPORTABLE_IMAGES] }).catch(() => []);
        const [source] = chosen;
        if (!source) {
          report("cancelled");
          return;
        }
        if (chosen.length > 1) {
          report("failed", ONE_IMAGE_ONLY);
          return;
        }
        if (!this.stillOpen(store)) return;
        const picked = await readPickedImage(source);
        if (!this.stillOpen(store)) return;
        if ("error" in picked) {
          report("failed", picked.error);
          return;
        }
        // The button was disabled against the jobs the screen could see when it was pressed. One
        // started since — while the dialog stood open, or by another client — would land later,
        // designate itself, and replace this upload without a word. Refused here, where the queue
        // is actually known (PR review).
        if (this.characterSheetJobRunning(msg.worldId, msg.sheetId)) {
          report(
            "failed",
            "A generated character sheet for this character has not finished. It would land on top of this one. Wait for it, or settle it in Activity, then upload.",
          );
          return;
        }
        const media = `character-sheet-upload-${Date.now().toString(36)}${picked.extension}`;
        const take = await recordUploadedCharacterSheetTake(store, msg.sheetId, media, picked.data).catch(
          () => null,
        );
        if (!take) {
          this.refreshIfStillOpen(store);
          report(
            "failed",
            "The character sheet was not changed because its permanent copy could not be made. Try again.",
          );
          return;
        }
        // And again: writing the take is itself an await, long enough to open another world in.
        // The take is durable and undecided, which is a state the card can offer to accept later.
        if (!this.stillOpen(store)) return;
        const sheet = store.getBundle().sheets.find((candidate) => candidate.id === msg.sheetId);
        if (!sheet) {
          this.refreshIfStillOpen(store);
          report("failed", "The character sheet was not changed because the character is unavailable.");
          return;
        }
        // No anchorFile: this sheet was not drawn from the main photo, so it claims no lineage
        // and no later main photo can call it out of date. Accepted in the same motion as the
        // upload — the human's own action rule, the same one the generated sheet gets at
        // finalization. Nobody needs to review a file they just chose by hand.
        //
        // The version comes from the take rather than from a sheet read before the picker opened:
        // those are the same number only when nothing edited the character while the dialog was
        // up, and when they disagree the compilation is born stale (PR #241 review).
        const accepted = await acceptCharacterSheet(store, sheet, {
          file: `takes/${take.id}/${media}`,
          takeId: take.id,
          sheetVersion: take.provenance.sheets[msg.sheetId] ?? sheet.version,
          artDirectionVersion: store.getBundle().artDirection.version,
          review: referenceReviewDecision(store.now(), take, "accept"),
        }).then(
          () => true,
          () => false,
        );
        this.refreshIfStillOpen(store);
        // The report is scoped to a sheet slug, and slugs recur across worlds, so an outcome
        // arriving after the user has opened another one would surface under whatever character
        // there happens to share the name (PR review).
        if (!this.stillOpen(store)) return;
        report(
          accepted ? "accepted" : "failed",
          accepted ? undefined : "The character sheet was copied in but could not be recorded. Try again.",
        );
        return;
      }
      case "generate-main-photo": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.opts.manifest) {
          this.rejectEnqueue(msg.requestId, msg.kind, "Main-photo generation is unavailable.");
          return;
        }
        const bundle = store.getBundle();
        const sheet = bundle.sheets.find((candidate) => candidate.id === msg.sheetId);
        const kit = (await readKit(store, msg.sheetId))?.kit ?? null;
        const model = imageModelFor(
          this.appSettings ? await this.appSettings.load() : null,
          this.opts.manifest,
          "modelId" in msg ? msg.modelId : undefined,
        );
        if (!sheet || !model) {
          this.rejectEnqueue(msg.requestId, msg.kind, "The character or image model is no longer available.");
          return;
        }
        let requests;
        try {
          const stagedMainPhoto = bundle.stagedReferences[stagedReferenceKey("main-photo", msg.sheetId)];
          requests = mainPhotoRequests(bundle.meta, bundle.artDirection, sheet, kit, model, {
            ...(stagedMainPhoto !== undefined ? { staged: stagedMainPhoto } : {}),
            prompt: msg.prompt,
            count: msg.count,
            identityReferences: msg.identityReferences,
            generationKey: Date.now().toString(36),
            ...(msg.tier !== undefined ? { tier: msg.tier } : {}),
          });
        } catch {
          this.rejectEnqueue(
            msg.requestId,
            msg.kind,
            "This image model could not be priced for the selected output size. Nothing was queued.",
          );
          return;
        }
        await this.enqueueBatch(
          msg.requestId,
          msg.kind,
          requests.map((request) => request.input),
        );
        return;
      }
      case "generate-location-view": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.opts.manifest) {
          this.rejectEnqueue(msg.requestId, msg.kind, "Location-view generation is unavailable.");
          return;
        }
        const bundle = store.getBundle();
        const sheet = bundle.sheets.find((candidate) => candidate.id === msg.sheetId);
        const kit = (await readKit(store, msg.sheetId))?.kit ?? null;
        const model = imageModelFor(
          this.appSettings ? await this.appSettings.load() : null,
          this.opts.manifest,
          "modelId" in msg ? msg.modelId : undefined,
        );
        if (!sheet || sheet.type !== "location" || !model) {
          this.rejectEnqueue(msg.requestId, msg.kind, "The location or image model is no longer available.");
          return;
        }
        // Every angle after the first is anchored to the accepted establishing view, so it is
        // the same room from somewhere else rather than a second room answering the same
        // description. Replacing the establishing view is itself unanchored.
        const establishing = kit ? orderedLocationViews(kit)[0] : undefined;
        const anchorFile = msg.establishing === true ? undefined : establishing?.file;
        if (anchorFile === undefined && msg.establishing !== true && establishing !== undefined) {
          this.rejectEnqueue(msg.requestId, msg.kind, "This location has no accepted establishing view to anchor to.");
          return;
        }
        let requests;
        try {
          const stagedView = bundle.stagedReferences[stagedReferenceKey("location-view", msg.sheetId)];
          requests = locationViewRequests(bundle.meta, bundle.artDirection, sheet, kit, model, {
            ...(stagedView !== undefined ? { staged: stagedView } : {}),
            name: msg.name,
            ...(msg.prompt !== undefined ? { prompt: msg.prompt } : {}),
            count: msg.count,
            ...(anchorFile !== undefined ? { anchorFile } : {}),
            generationKey: Date.now().toString(36),
            ...(msg.tier !== undefined ? { tier: msg.tier } : {}),
          });
        } catch (err) {
          // The named refusals matter here: a model with no reference capacity cannot be
          // anchored, and saying so beats generating an unanchored angle nobody asked for.
          this.rejectEnqueue(
            msg.requestId,
            msg.kind,
            err instanceof Error ? `${err.message}. Nothing was queued.` : "Nothing was queued.",
          );
          return;
        }
        await this.enqueueBatch(
          msg.requestId,
          msg.kind,
          requests.map((request) => request.input),
        );
        return;
      }
      case "import-location-view-candidate": {
        const store = this.opts.provider.openStore?.();
        const pick = this.opts.pickFiles;
        const report = (status: "landed" | "failed" | "cancelled", reason?: string) =>
          this.emit({
            at: new Date().toISOString(),
            type: "location-view.upload",
            worldId: msg.worldId,
            sheetId: msg.sheetId,
            status,
            ...(reason ? { reason } : {}),
          });
        // Sheet slugs recur across worlds, so a frame written for a world the user has since
        // left would file the image under the same-named place somewhere else entirely.
        if (!store || store.worldId !== msg.worldId || !pick) return;
        const sheet = store.getBundle().sheets.find((candidate) => candidate.id === msg.sheetId);
        if (!sheet || sheet.type !== "location") {
          report("failed", "That location is no longer available.");
          return;
        }
        const chosen = await pick({ accept: [...IMPORTABLE_IMAGES] }).catch(() => []);
        const [source] = chosen;
        if (!source) {
          report("cancelled");
          return;
        }
        if (chosen.length > 1) {
          report("failed", "Choose a single image: a view is one angle, not a set.");
          return;
        }
        if (!this.stillOpen(store)) return;
        const picked = await readPickedImage(source);
        if (!this.stillOpen(store)) return;
        if ("error" in picked) {
          report("failed", picked.error);
          return;
        }
        // Lands unreviewed, exactly where a generated candidate lands. Nothing is named or
        // accepted here: naming is the acceptance, and doing both in one motion would put the
        // duplicate-name confirmation behind a file dialog that has already closed.
        const media = `location-view-upload-${Date.now().toString(36)}${picked.extension}`;
        const take = await recordUploadedLocationViewTake(store, msg.sheetId, media, picked.data).catch(
          () => null,
        );
        this.refreshIfStillOpen(store);
        report(
          take ? "landed" : "failed",
          take ? undefined : "The view was not added because its permanent copy could not be made. Try again.",
        );
        return;
      }
      case "accept-location-view": {
        const store = this.opts.provider.openStore?.();
        if (!store || store.worldId !== msg.worldId) return;
        const bundle = store.getBundle();
        const sheet = bundle.sheets.find((candidate) => candidate.id === msg.sheetId);
        const take = pendingReferenceTake(
          bundle.referenceTakes,
          bundle.referenceReviews,
          msg.takeId,
          msg.sheetId,
          "location-view",
        );
        if (!sheet || sheet.type !== "location" || !take?.media) return;
        const media = `references/${msg.sheetId}/takes/${take.id}/${take.media}`;
        if (
          basename(take.media) !== take.media ||
          !(await stat(toExtendedLength(join(store.dir, media))).catch(() => null))
        )
          return;
        const frozen = take.params["provenance"] as { sheets?: Record<string, number> } | undefined;
        const sheetVersion = frozen?.sheets?.[msg.sheetId] ?? take.provenance.sheets[msg.sheetId];
        if (sheetVersion === undefined) return;
        // A refusal — an unconfirmed name, a full location, a view that will not decode — leaves
        // the world exactly as it was, and the candidate still there to accept once the reason
        // is dealt with. The snapshot below re-renders whichever of those two happened.
        await acceptLocationView(store, sheet, {
          id: `lv_${take.id.slice(3)}`,
          name: msg.name,
          file: `takes/${take.id}/${take.media}`,
          takeId: take.id,
          sheetVersion,
          artDirectionVersion: take.provenance.artDirectionVersion ?? bundle.artDirection.version,
          ...(msg.establishing !== undefined ? { establishing: msg.establishing } : {}),
          ...(msg.replaceExistingName !== undefined ? { replaceExistingName: msg.replaceExistingName } : {}),
          review: referenceReviewDecision(store.now(), take, "accept"),
        }).catch(() => {});
        // Accepting settles the ask this reference was staged for (design 67). A rejection does
        // not: the usual answer to one is to run it again, and running it again with the
        // picture you had just chosen is the point of having staged it.
        await this.dropStagedReference(store, stagedReferenceKey("location-view", msg.sheetId));
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "generate-character-sheet": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.opts.manifest) {
          this.rejectEnqueue(msg.requestId, msg.kind, "Character-sheet generation is unavailable.");
          return;
        }
        const bundle = store.getBundle();
        const sheet = bundle.sheets.find((candidate) => candidate.id === msg.sheetId);
        const kit = (await readKit(store, msg.sheetId))?.kit;
        const model = imageModelFor(
          this.appSettings ? await this.appSettings.load() : null,
          this.opts.manifest,
          "modelId" in msg ? msg.modelId : undefined,
        );
        if (!sheet || !kit || !model) {
          this.rejectEnqueue(msg.requestId, msg.kind, "An accepted main photo and image model are required.");
          return;
        }
        let request;
        try {
          request = characterSheetRequest(
            bundle.meta,
            bundle.artDirection,
            sheet,
            kit,
            model,
            Date.now().toString(36),
            msg.styleOverride,
            msg.tier,
            bundle.stagedReferences[stagedReferenceKey("character-sheet", msg.sheetId)],
          );
        } catch (error) {
          this.rejectEnqueue(
            msg.requestId,
            msg.kind,
            error instanceof Error && error.message.includes("cannot receive")
              ? `${model.displayName} cannot receive the accepted main photo. Choose a reference-capable image model before generating a character sheet. Nothing was queued.`
              : error instanceof Error && error.message.includes("could not be priced")
                ? "This image model could not be priced for the selected output size. Nothing was queued."
                : "An accepted main photo is required before generating a character sheet.",
          );
          return;
        }
        await this.enqueueBatch(msg.requestId, msg.kind, [request.input]);
        return;
      }
      case "accept-character-sheet": {
        const store = this.opts.provider.openStore?.();
        if (!store || store.worldId !== msg.worldId) return;
        const bundle = store.getBundle();
        const sheet = bundle.sheets.find((candidate) => candidate.id === msg.sheetId);
        const take = pendingReferenceTake(
          bundle.referenceTakes,
          bundle.referenceReviews,
          msg.takeId,
          msg.sheetId,
          "sheet",
        );
        if (!sheet || !take?.media) return;
        const media = `references/${msg.sheetId}/takes/${take.id}/${take.media}`;
        if (
          basename(take.media) !== take.media ||
          !(await stat(toExtendedLength(join(store.dir, media))).catch(() => null))
        )
          return;
        const review = referenceReviewDecision(store.now(), take, "accept");
        const frozen = take.params["provenance"] as
          { sheets?: Record<string, number>; anchorFile?: string } | undefined;
        const sheetVersion = frozen?.sheets?.[msg.sheetId] ?? take.provenance.sheets[msg.sheetId];
        // A generated take must name the main photo it was conditioned on — without it there is
        // no telling what the composite depicts. An uploaded one has no such lineage and never
        // will, so requiring one here left the "Accept this sheet" button on an upload whose
        // first commit failed permanently inert: pressed, and nothing (PR #241 review).
        const uploaded = take.provider === "user";
        if (sheetVersion === undefined || (!uploaded && !frozen?.anchorFile)) return;
        await acceptCharacterSheet(store, sheet, {
          file: `takes/${take.id}/${take.media}`,
          takeId: take.id,
          sheetVersion,
          ...(frozen?.anchorFile ? { anchorFile: frozen.anchorFile } : {}),
          artDirectionVersion: take.provenance.artDirectionVersion ?? store.getBundle().artDirection.version,
          review,
        }).catch(() => {});
        // Accepting settles the ask this reference was staged for (design 67). A rejection does
        // not: the usual answer to one is to run it again, and running it again with the
        // picture you had just chosen is the point of having staged it.
        await this.dropStagedReference(store, stagedReferenceKey("character-sheet", msg.sheetId));
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "generate-character-looks": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.opts.manifest) {
          this.rejectEnqueue(msg.requestId, msg.kind, "Character-look generation is unavailable.");
          return;
        }
        const bundle = store.getBundle();
        const sheet = bundle.sheets.find((candidate) => candidate.id === msg.sheetId);
        const kit = (await readKit(store, msg.sheetId))?.kit;
        const model = imageModelFor(
          this.appSettings ? await this.appSettings.load() : null,
          this.opts.manifest,
          "modelId" in msg ? msg.modelId : undefined,
        );
        if (!sheet || !kit || !model) {
          this.rejectEnqueue(msg.requestId, msg.kind, "An accepted main photo and image model are required.");
          return;
        }
        let requests;
        try {
          const stagedLook = bundle.stagedReferences[stagedReferenceKey("look", msg.sheetId)];
          requests = characterLookRequests(bundle.meta, bundle.artDirection, sheet, kit, model, {
            ...(stagedLook !== undefined ? { staged: stagedLook } : {}),
            kind: msg.lookKind,
            mode: msg.mode,
            prompt: msg.prompt,
            count: msg.count,
            generationKey: Date.now().toString(36),
            ...(msg.tier !== undefined ? { tier: msg.tier } : {}),
          });
        } catch (error) {
          this.rejectEnqueue(
            msg.requestId,
            msg.kind,
            error instanceof Error && error.message.includes("cannot receive")
              ? `${model.displayName} cannot receive the accepted main photo. Choose a reference-capable image model before generating character looks. Nothing was queued.`
              : error instanceof Error && error.message.includes("could not be priced")
                ? "This image model could not be priced for the selected output size. Nothing was queued."
                : "An accepted main photo is required before generating character looks.",
          );
          return;
        }
        await this.enqueueBatch(
          msg.requestId,
          msg.kind,
          requests.map((request) => request.input),
        );
        return;
      }
      case "accept-character-look": {
        const store = this.opts.provider.openStore?.();
        if (!store || store.worldId !== msg.worldId) return;
        const bundle = store.getBundle();
        const take = pendingReferenceTake(
          bundle.referenceTakes,
          bundle.referenceReviews,
          msg.takeId,
          msg.sheetId,
          "look",
        );
        if (!take?.media) return;
        const producingJob = take.jobId
          ? this.jobQueue?.listJobs().find((candidate) => candidate.id === take.jobId)
          : undefined;
        const lookKind = take.params["lookKind"] ?? producingJob?.params["lookKind"];
        const lookPrompt = take.params["lookPrompt"] ?? producingJob?.params["lookPrompt"];
        if (
          (lookKind !== "costume" && lookKind !== "pose-expression" && lookKind !== "condition-age") ||
          typeof lookPrompt !== "string" ||
          lookPrompt.trim().length === 0
        )
          return;
        const media = `references/${msg.sheetId}/takes/${take.id}/${take.media}`;
        if (
          basename(take.media) !== take.media ||
          !(await stat(toExtendedLength(join(store.dir, media))).catch(() => null))
        )
          return;
        const review = referenceReviewDecision(store.now(), take, "accept");
        await acceptCharacterLook(store, msg.sheetId, {
          id: take.id,
          file: `takes/${take.id}/${take.media}`,
          kind: lookKind,
          prompt: lookPrompt.trim(),
          ...(take.jobId ? { jobId: take.jobId } : {}),
          takeId: take.id,
          artDirectionVersion: take.provenance.artDirectionVersion ?? store.getBundle().artDirection.version,
          review,
        }).catch(() => {});
        // Accepting settles the ask this reference was staged for (design 67). A rejection does
        // not: the usual answer to one is to run it again, and running it again with the
        // picture you had just chosen is the point of having staged it.
        await this.dropStagedReference(store, stagedReferenceKey("look", msg.sheetId));
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "reject-reference-take": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const take = store.getBundle().referenceTakes.find((candidate) => candidate.id === msg.takeId);
        if (!take) return;
        await recordReferenceReview(store, take, "reject", {
          field: msg.field,
          ...(msg.note ? { note: msg.note } : {}),
        }).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "promote-character-look": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const sheet = store.getBundle().sheets.find((candidate) => candidate.id === msg.sheetId);
        if (!sheet) return;
        await promoteCharacterLook(store, sheet, msg.lookId).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "attach-character-look": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await attachCharacterLook(store, msg.sheetId, msg.lookId, msg.scope).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "lock-tile": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await lockTile(store, msg.sheetId, msg.angle, msg.name).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "generate-missing-tiles":
      case "regenerate-tile": {
        const store = this.opts.provider.openStore?.();
        if (!store || !this.opts.manifest) {
          this.rejectEnqueue(msg.requestId, msg.kind, "Reference generation is unavailable.");
          return;
        }
        const sheet = store.getBundle().sheets.find((s) => s.id === msg.sheetId);
        if (!sheet) {
          this.rejectEnqueue(msg.requestId, msg.kind, "The character is no longer available.");
          return;
        }
        const model = imageModelFor(
          this.appSettings ? await this.appSettings.load() : null,
          this.opts.manifest,
        );
        if (!model) {
          this.rejectEnqueue(
            msg.requestId,
            msg.kind,
            "No image model is available. Check provider settings.",
          );
          return;
        }
        const kit = (await readKit(store, msg.sheetId))?.kit ?? null;
        let angles;
        if (msg.kind === "regenerate-tile") {
          angles = [msg.angle];
        } else {
          const missing = missingTileAngles(kit, msg.group);
          if (!missing.ok) {
            // The gate states what is outstanding (R-7, D5) — surfaced via the app log and a
            // no-op; the client shows the same gate from the shared helper before sending.
            void this.appLog?.append({
              kind: "kit.gate-refused",
              sheetId: msg.sheetId,
              reason: missing.reason,
            });
            this.rejectEnqueue(msg.requestId, msg.kind, missing.reason);
            return;
          }
          angles = missing.angles;
        }
        let requests;
        try {
          requests = angles.map(
            (angle) => tileRequest(store.getBundle().meta, sheet, kit, model, angle, store.getBundle().artDirection).input,
          );
        } catch {
          this.rejectEnqueue(
            msg.requestId,
            msg.kind,
            "This image model could not be priced for the selected output size. Nothing was queued.",
          );
          return;
        }
        await this.enqueueBatch(msg.requestId, msg.kind, requests);
        return;
      }
      case "compile-grid": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        const sheet = store.getBundle().sheets.find((s) => s.id === msg.sheetId);
        if (!sheet) return;
        try {
          const result = await compileGrid(store, sheet, () => new Date().toISOString());
          await landGrid(store, sheet, result);
          await this.refreshWorldSnapshot(msg.worldId);
        } catch (err) {
          void this.appLog?.append({
            kind: "kit.compile-failed",
            sheetId: msg.sheetId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "designate-compilation": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await designate(store, msg.sheetId, msg.file).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "set-style-override": {
        const store = this.opts.provider.openStore?.();
        if (!store) return;
        await setStyleOverride(store, msg.sheetId, msg.style).catch(() => {});
        await this.refreshWorldSnapshot(msg.worldId);
        return;
      }
      case "cancel-job": {
        await this.jobQueue?.cancel(msg.jobId);
        return;
      }
      case "retry-job-finalization": {
        await this.jobQueue?.retryFinalization(msg.jobId);
        return;
      }
      case "delete-job": {
        await this.jobQueue?.delete(msg.jobId);
        return;
      }
      case "resolve-held-job": {
        await this.jobQueue?.resolveHeld(msg.jobId, msg.decision);
        return;
      }
      case "queue-resume": {
        // The message IS the explicit confirmation resuming a paused provider (SPEC-009 D7).
        this.jobQueue?.resume(msg.provider);
        return;
      }
      case "detect-harnesses": {
        await this.emitHarnessStatus();
        return;
      }
      case "set-harness-engine": {
        if (!this.appSettings) return;
        const harnesses = await this.harnessAvailability();
        const chosen = harnesses.find((h) => h.id === msg.engine);
        /*
         * The refusal lives here, not only on the screen.
         *
         * A disabled control is a courtesy to the reader; it is not a guarantee, because the
         * availability it was drawn from can be minutes old — a user can uninstall Claude Code
         * with Settings still open. Enabling a harness that is not there would replace working
         * authoring with a lane that cannot start, so the answer is no, and the screen is sent
         * the current truth so it stops showing the choice it thought it had.
         */
        if (!chosen?.installed) {
          await this.emitHarnessStatus(harnesses);
          return;
        }
        await this.appSettings.setHarnessEngine(msg.engine);
        await this.emitHarnessStatus(harnesses);
        return;
      }
      case "choose-claude-executable": {
        if (!this.appSettings || !this.opts.chooseClaudeExecutable) return;
        const chosen = await this.opts.chooseClaudeExecutable().catch(() => null);
        // Cancelling a file dialog is not a decision — it must not clear an existing choice.
        if (chosen === null) return;
        await this.appSettings.setClaudePath(chosen);
        await this.emitHarnessStatus();
        return;
      }
      case "clear-claude-executable": {
        if (!this.appSettings) return;
        await this.appSettings.setClaudePath(null);
        await this.emitHarnessStatus();
        return;
      }
      case "detect-runtimes": {
        if (!this.opts.manifest || !this.opts.probeRuntime) return;
        try {
          const probes = await this.opts.probeRuntime();
          this.emit({
            at: new Date().toISOString(),
            type: "runtime.status",
            runtime: gateLocalRuntimes(this.opts.manifest, probes, new Date().toISOString()),
          });
        } catch {
          // Detection failure means unknown, not unavailable (D12) — nothing is emitted over
          // the last known figures, and nothing gets disabled by a broken probe.
        }
        return;
      }
      case "permission-reply": {
        const adapter = this.opts.adapter;
        if (!adapter) return;
        const actionClass = this.pendingPermissions.get(msg.permissionId);
        if (msg.decision === "always" && actionClass && this.grants) {
          await this.grants.remember(actionClass, new Date().toISOString());
        }
        this.pendingPermissions.delete(msg.permissionId);
        await adapter
          .respondToPermission?.({ permissionId: msg.permissionId, decision: msg.decision })
          .catch(() => {});
        this.emit({
          at: new Date().toISOString(),
          type: "permission.settled",
          permissionId: msg.permissionId,
          decision: msg.decision,
          remembered: false,
        });
        return;
      }
    }
  }

  /**
   * The roster as it will actually run. Both halves are published — what shipped and what the
   * user changed it to — so no screen has to guess which is in force.
   */
  private refreshAgents(overrides: Record<string, { model?: string; brief?: string }>): void {
    const roster = this.opts.authoring?.roster;
    if (!roster) return;
    this.readModel.setAgents(
      roster.map((a) => {
        const over = overrides[a.name];
        return {
          name: a.name,
          description: a.description,
          shippedBrief: a.brief,
          brief: over?.brief ?? a.brief,
          ...(over?.model ? { model: over.model } : {}),
          edited: over?.brief !== undefined && over.brief !== a.brief,
        };
      }),
    );
  }

  /** Gate operations mutate the world; every client re-syncs from a fresh snapshot. */
  /**
   * File one source into the world, and say so when it will not go. Shared by the explicit
   * file-artifact frame and by attaching from a chat, so both refuse in the same words.
   */
  /**
   * Hold a file for a conversation that has no world yet. It lands in the sandbox the agent
   * works in, so it can be read during the conversation, and is filed properly at Begin.
   */
  private async attachToGenesis(genesisId: string, sourcePath: string): Promise<void> {
    const at = new Date().toISOString();
    const dir = await this.opts.provider.genesisDir?.(genesisId).catch(() => null);
    if (!dir) {
      this.emit({
        at,
        type: "genesis.attachment",
        genesisId,
        name: basename(sourcePath),
        kind: "other",
        outcome: "refused",
        reason: "this conversation has no sandbox to hold it",
      });
      return;
    }
    const outcome = await attachToSandbox(dir, sourcePath);
    if ("reason" in outcome) {
      this.emit({
        at,
        type: "genesis.attachment",
        genesisId,
        name: basename(sourcePath),
        kind: "other",
        outcome: "refused",
        reason: outcome.reason,
      });
      return;
    }
    this.emit({
      at,
      type: "genesis.attachment",
      genesisId,
      name: outcome.name,
      kind: outcome.kind,
      outcome: "waiting",
    });
  }

  /**
   * One file handed to a conversation, privately (#70 §13.1, §13.2).
   *
   * The readability gate comes before anything is written, so a refused file leaves nothing on
   * disk to clean up. It is deliberately strict for now: World Chat may only be handed what it
   * can honestly read, because a chip that looks attached while the reply cannot see it is worse
   * than a refusal — the person carries on talking as though it had been read.
   *
   * Nothing is broadcast on success. The attachment is already durable in the conversation's own
   * event log and arrives with the next workspace load; announcing it here as well would give the
   * screen two sources for one fact.
   */
  private async attachToWorldChat(
    store: WorldStore,
    conversationId: ConversationId,
    sourcePath: string,
  ): Promise<void> {
    const name = basename(sourcePath);
    const refuse = (reason: string): void => {
      this.emit({
        at: new Date().toISOString(),
        type: "world-chat.attachment-refused",
        conversationId,
        name,
        reason,
      });
    };

    let bytes: Uint8Array;
    try {
      bytes = await readFile(toExtendedLength(sourcePath));
    } catch {
      refuse("that file could not be read");
      return;
    }

    const unreadable = refuseUnreadable(name, bytes);
    if (unreadable) {
      refuse(unreadable);
      return;
    }

    try {
      await new WorldChatAttachmentStore(store.dir).ingest(conversationId, { fileName: name, bytes });
    } catch (err) {
      refuse(err instanceof AttachmentError ? err.message : "it could not be attached");
    }
  }

  /**
   * Begin: everything the conversation was handed follows it into the world. Filed one by one
   * through the ordinary path, so each gets its sidecar, its hash and its place in the journal.
   */
  private async carryGenesisAttachments(genesisId: string, worldId: string): Promise<void> {
    const dir = await this.opts.provider.genesisDir?.(genesisId).catch(() => null);
    if (!dir) return;
    for (const sourcePath of await sandboxAttachments(dir)) {
      await this.fileOne(worldId, sourcePath, {});
    }
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  /** What a plan driver needs (SPEC-024): the queue, the queue's facts, and the extractor. */
  private planDriverDeps(): PlanDriverDeps {
    return {
      enqueue: (input) => {
        if (!this.jobQueue) throw new Error("the queue is not available");
        return this.jobQueue.enqueue(input);
      },
      jobFacts: (jobIds) => {
        const wanted = new Set(jobIds);
        return (this.jobQueue?.listJobs() ?? [])
          .filter((job) => wanted.has(job.id))
          .map((job) => ({ id: job.id, status: job.status }));
      },
      boundaryFrameMaker: this.opts.boundaryFrameMaker,
      clock: () => new Date().toISOString(),
      onRefused: (planId, reason) => {
        void this.appLog?.append({ kind: "plan.enqueue-refused", planId, reason });
      },
      // Freshness per loop (SPEC-024 R-24): the driver re-checks sources against the store's
      // current bundle rather than the snapshot its caller happened to hold. World-checked —
      // a world switched mid-advance must never be compared against another plan's sources.
      fresh: (worldId) => {
        const store = this.opts.provider.openStore?.();
        return store && store.worldId === worldId ? store.getBundle() : undefined;
      },
    };
  }

  /** The named routing findings, pushed as one event (epic 401, brief §4) — never a score. */
  private async emitRoutingFindings(store: WorldStore, worldId: string, productionId: string): Promise<void> {
    const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
    if (!production) return;
    const findings = await interactiveFindings(store, production).catch(() => []);
    this.emit({
      at: new Date().toISOString(),
      type: "production.routing-findings",
      worldId,
      productionId,
      findings,
    });
  }

  /** The folded states of a production's plans, pushed as one event — disk truth, no timer. */
  private async emitPlanStates(store: WorldStore, worldId: string, productionId: string): Promise<void> {
    const plans = await listPlans(store, productionId);
    const deps = this.planDriverDeps();
    const states = [];
    for (const plan of plans) states.push(await planState(store, plan, deps));
    this.emit({
      at: new Date().toISOString(),
      type: "production.plan-state",
      worldId,
      productionId,
      states,
    });
  }

  /** A settled plan job unblocks its dependents (SPEC-024 R-18): refresh, advance, push state. */
  private async advancePlansForJob(job: Job): Promise<void> {
    const planId = job.params["planId"];
    if (typeof planId !== "string" || job.productionId === undefined) return;
    const store = this.opts.provider.openStore?.();
    if (!store || store.worldId !== job.worldId) return;
    // The landed take must be visible to the bundle before extraction can find it.
    await this.refreshWorldSnapshot(job.worldId).catch(() => {});
    const bundle = store.getBundle();
    const production = bundle.productions.find((p) => p.meta.id === job.productionId);
    if (!production) return;
    const plan = (await listPlans(store, job.productionId)).find((p) => p.planId === planId);
    if (!plan) return;
    await advancePlan(store, production, bundle, plan, this.planDriverDeps()).catch(() => {});
    await this.emitPlanStates(store, job.worldId, job.productionId).catch(() => {});
  }

  /** The open world's bench session by id, or null — a closed world answers no bench command. */
  private async benchFor(worldId: string, sessionId: SessionId): Promise<OpenedBench | null> {
    const store = this.opts.provider.openStore?.();
    if (!store || store.worldId !== worldId) return null;
    const benchStore = new BenchStore(benchSessionDir(store.dir, sessionId));
    const session = await benchStore.fold();
    return session === null ? null : { store: benchStore, session };
  }

  /** Every bench-take job of this world, as the facts recovery joins on. */
  private benchJobFacts(worldId: string): BenchRecoveryJobFacts[] {
    return this.getState()
      .app.jobs.filter((job) => job.worldId === worldId && job.target.kind === "bench-take" && job.target.id !== undefined)
      .map((job) => ({
        jobId: job.id,
        targetId: job.target.id!,
        status: job.status,
        error: job.error,
      }));
  }

  /**
   * Open (or create) a session, run recovery against the job journal, and push the workspace.
   * Recovery is idempotent, so running it on every open costs a read and buys the two crash
   * windows their answer (issue 305 §6).
   */
  private async openBenchWorkspace(store: WorldStore, sessionId?: SessionId, fresh = false): Promise<void> {
    const settings = this.appSettings ? await this.appSettings.load() : null;
    const routed = this.opts.manifest ? imageModelFor(settings, this.opts.manifest) : null;
    const opened = await openBenchSession(store.dir, () => this.nowIso(), {
      sessionId,
      fresh,
      ...(routed ? { defaultModel: { provider: routed.provider, model: routed.id } } : {}),
    }).catch(() => null);
    if (!opened) {
      this.readModel.setBench(null);
      this.transport.broadcastSnapshot();
      return;
    }
    const touched = await recoverBenchSession(opened, this.benchJobFacts(store.worldId), () => this.nowIso()).catch(
      () => false,
    );
    const session = touched ? ((await opened.store.fold()) ?? opened.session) : opened.session;
    await this.backfillBenchPosters(store, session);
    this.readModel.setBench({ worldId: store.worldId, session });
    this.readModel.setBenchSessions(await discoverBenchSessions(store.dir));
    this.transport.broadcastSnapshot();
  }

  /**
   * Draw the missing pictures for video takes that landed before posters existed.
   *
   * Before the snapshot, not after: the strip's `Portrait` remembers a failed decode per source
   * URL, and the URL does not change when the file finally appears — so a poster drawn a moment
   * late would sit on disk unseen until the screen was rebuilt. Blocking the open by a second is
   * the cheaper of the two.
   *
   * Bounded by a wall-clock budget rather than a count. A session with forty old clips draws
   * what it can and the rest next time, which is self-healing and never a session that will not
   * open; and once drawn, every later open finds them all and does nothing at all.
   */
  private async backfillBenchPosters(store: WorldStore, session: BenchSession): Promise<void> {
    await backfillPosters(
      session.takes.flatMap((take) =>
        take.media === undefined
          ? []
          : [{ id: take.id, file: take.media.file, dir: join(store.dir, sessionMediaDir(session.id, take.id)) }],
      ),
      this.opts.takePosterMaker,
      {
        budgetMs: BENCH_POSTER_BACKFILL_MS,
        onUnavailable: (takeId, reason) => {
          void this.appLog?.append({ kind: "take.poster-unavailable", takeId, backfill: true, reason });
        },
      },
    );
  }

  /** Re-fold and push the open workspace + the bundle's session rows after a command. */
  private async refreshBench(worldId: string, sessionId: SessionId): Promise<void> {
    const store = this.opts.provider.openStore?.();
    if (!store || store.worldId !== worldId) return;
    const bench = await this.benchFor(worldId, sessionId);
    if (bench) this.readModel.setBench({ worldId, session: bench.session });
    this.readModel.setBenchSessions(await discoverBenchSessions(store.dir));
    this.transport.broadcastSnapshot();
  }

  /**
   * Append a bench take's terminal outcome to its session log, joining by the job's target id.
   * Success is deliberately not handled here — the replayable finalization records completion
   * WITH media and cost, and recording it twice would race the landing.
   */
  private async recordBenchTerminal(job: Job): Promise<void> {
    const [sessionId, takeId] = (job.target.id ?? "").split("/") as [SessionId | undefined, string | undefined];
    if (!sessionId || !takeId) return;
    const bench = await this.benchFor(job.worldId, sessionId);
    if (!bench) return;
    const take = bench.session.takes.find((t) => t.id === takeId);
    if (!take || take.status === job.status) return;
    await bench.store
      .append(
        {
          type: "take-status",
          takeId: takeId as never,
          status: job.status,
          ...(job.error !== null ? { error: job.error } : {}),
        },
        { at: this.nowIso() },
      )
      .catch(() => {});
    await this.refreshBench(job.worldId, sessionId);
  }

  private async fileOne(
    worldId: string,
    sourcePath: string,
    opts: { links?: string[]; allowLarge?: boolean; supersedes?: string; production?: string | null },
  ): Promise<string | null> {
    const store = this.opts.provider.openStore?.();
    if (!store) return null;
    const outcome = await fileArtifact(store, {
      sourcePath,
      // Measured once, at the moment the bytes land, rather than by every reader afterwards (#283).
      ...(this.opts.mediaProbe !== undefined ? { mediaProbe: this.opts.mediaProbe } : {}),
      // The measurement outlives the gate, so it must not outlive the world it belongs to.
      abandoned: () => !this.stillOpen(store) || this.stopping,
      ...opts,
    }).catch((err) => ({
      outcome: "refused" as const,
      reason: err instanceof Error ? err.message : String(err),
    }));
    if (outcome.outcome === "needs-consent" || outcome.outcome === "refused") {
      this.emit({
        at: new Date().toISOString(),
        type: "artifact.notice",
        worldId,
        sourcePath,
        outcome: outcome.outcome,
        reason: outcome.reason,
        sizeBytes: outcome.outcome === "needs-consent" ? outcome.sizeBytes : null,
      });
      return null;
    }
    this.emit({
      at: new Date().toISOString(),
      type: "artifact.attached",
      worldId,
      artifactId: outcome.artifact.id,
      file: outcome.artifact.file,
      kind: outcome.artifact.kind,
      deduplicated: outcome.outcome === "deduplicated",
    });
    // Against the store that was filed into, never by world id: refreshWorldSnapshot calls
    // loadWorld, so filing that finished after the user switched worlds would have closed the
    // world they just chose and reopened the one they left (Codex round 6).
    this.refreshIfStillOpen(store);
    return outcome.artifact.id;
  }

  /**
   * The runner for the open world, built once and kept (#70 §8).
   *
   * Kept rather than rebuilt per command because it holds the in-flight runs: a runner made
   * fresh for a cancel would have no record of the turn it was asked to stop.
   */
  private worldChatRunner(store: WorldStore, conversationId: ConversationId): WorldChatRunner {
    /*
     * Cached per world, but only while it is the same open store.
     *
     * Close a world and reopen it and the provider hands back a new WorldStore, while these
     * callbacks still close over the old one — so every later prompt would carry the look as it
     * was before the close, and record that version on its drafts. Wrap-up, reading the store
     * that is actually open, would then reject every drafted look as moved: conversational look
     * editing broken until restart, with nothing to point at.
     *
     * A runner mid-turn is kept for the conversation that is mid-turn, and for nothing else.
     * Keeping it for the whole world — which "is anything running?" amounts to — meant one slow
     * turn left over from before the close went on serving every new turn in every other
     * conversation from the closed store, which is the same breakage arriving by a longer road.
     */
    const existing = this.worldChatRunners.runnerFor(store.worldId, store, conversationId);
    if (existing) return existing;

    const leases = new QueryLeaseRegistry(() => this.opts.provider.openStore?.()?.worldId ?? null);
    const attachments = new WorldChatAttachmentStore(store.dir);
    const receipts = new Map<string, WorldChatCheckReceipt[]>();
    /** Which token each run is reading under, so releasing it stops resolving at the server too. */
    const tokenByRun = new Map<string, string>();
    const retrieval = new WorldChatRetrieval({
      leases,
      // The same window the prompt is budgeted from: a run that may be handed a whole library
      // should be able to page back through it as well.
      textBudgetChars: () =>
        Math.max(MAX_TEXT_PER_RUN_CHARS, budgetFor(this.opts.adapter?.knownInputTokenLimit?.() ?? undefined)),
      getBundle: () => this.opts.provider.openStore?.()?.getBundle() ?? null,
      getIndex: () => this.opts.provider.openStore?.()?.getIndex() ?? null,
      attachments,
      findAttachment: async (lease, id) => {
        const loaded = await new WorldChatService(store.dir).load(lease.conversationId);
        return loaded?.attachments.find((a) => a.id === id) ?? null;
      },
      // Off unless the person turned it on. Read at call time, not at construction, so switching
      // it off takes effect on the next tool call rather than the next restart.
      researchAllowed: () => this.researchWeb,
    });

    const runner = new WorldChatRunner({
      adapter: this.opts.adapter ?? null,
      /*
       * A look can only be rewritten by something that can read it — see currentLookContext.
       *
       * From this runner's own world, not from whichever store happens to be open: a turn can
       * still be reading when somebody opens another world, and the provider's selection would
       * have followed them. That would put world B's look, verbatim, in world A's prompt — one
       * world's content shown while talking about another, and an invitation to rewrite A's look
       * into B's words.
       */
      worldContext: () => currentLookContext(store.getBundle().artDirection),
      // Read at the same instant as the look above, and from the same world, so what a draft
      // says it was based on is what the model was actually shown — the words as well as the
      // number, because a derived look is v1 however often the world's tone is edited under it.
      artDirectionLook: () => {
        const look = store.getBundle().artDirection;
        return { version: look.version, description: look.description };
      },
      /*
       * Straight off the disk, and from this runner's own world for the same reason as above.
       *
       * Not from the bundle: `bible.md` is the one authored file the app expects to be edited
       * outside it, and the Studio's own edits land mid-conversation. The bundle is refreshed by
       * a rescan, and a turn assembled between an edit and that rescan would show the model a
       * bible one version behind the one it is about to be checked against — which fails the
       * write it was meant to enable.
       */
      bible: async () => {
        const current = await readBible(store.dir);
        return { version: current.version, text: current.text };
      },
      applyBibleEdits: ({ edits, baseVersion }) =>
        applyTurnBibleEdits(store, edits, { source: "world-chat", baseVersion }),
      prepare: async ({ conversationId, runId, attachmentIds }) => {
        const lease = leases.mint({
          worldId: store.worldId,
          conversationId,
          runId,
          allowedAttachmentIds: attachmentIds,
        });
        /*
         * Started, not merely asked for.
         *
         * `leasedUrl` answers null until the server is up, and this was the only authoring flow
         * that never started it — so whether World Chat could look anything up depended on
         * whether some other flow had happened to start it first. Open a world and go straight to
         * a conversation and the agent had no arke-world tools at all: it could not find the sheet
         * behind a name, so it could not target an edit at one, and it said so rather than
         * guessing an id. Every other caller starts the server before taking a URL from it.
         */
        await this.worldQuery.start().catch(() => {
          /* a turn without retrieval is worse than one with it, and better than no turn at all */
        });
        /*
         * The run's reads, reachable (#70 §8.2).
         *
         * Registering the lease with the server is what makes the URL below answer anything: it
         * routes `/mcp/<token>` to this conversation's retrieval and records every receipt against
         * the run that earned it. Without it the address was live and every request 404'd.
         */
        this.worldQuery.attachLease(lease.token, {
          retrieval,
          onReceipt: (receipt) => {
            const seen = receipts.get(receipt.runId) ?? [];
            receipts.set(receipt.runId, [...seen, receipt]);
          },
        });
        tokenByRun.set(runId, lease.token);
        const url = this.worldQuery.leasedUrl(lease.token) ?? undefined;
        // Without a configured app root — a dev or test coordinator — the OS temp directory
        // still satisfies what §8.2 actually requires: somewhere outside the world.
        const cwd = await createRunScratch({ appRoot: this.opts.appRoot ?? tmpdir(), conversationId, runId });
        if (this.opts.adapter) {
          await writeSessionFiles(this.opts.adapter, cwd, this.sessionInput(url ? { worldQueryUrl: url } : {}));
        }
        return { cwd, leaseToken: lease.token };
      },
      release: async ({ conversationId, runId }) => {
        const token = tokenByRun.get(runId);
        if (token) {
          this.worldQuery.detachLease(token);
          tokenByRun.delete(runId);
        }
        leases.revokeRun(runId);
        retrieval.forgetRun(runId);
        receipts.delete(runId);
        await removeRunScratch(this.opts.appRoot ?? tmpdir(), conversationId, runId);
      },
      receiptsFor: (runId) => receipts.get(runId) ?? [],
      runCheckPlan: async ({ draft, leaseToken }) => {
        const plan = planFor(draft);
        const produced: WorldChatCheckReceipt[] = [];
        /*
         * A call that failed is a check that could not run, not a check nobody asked for.
         *
         * Swallowing the error dropped its receipt, so the category stayed merely *missing* — and
         * missing reads as `partial`, which readiness refuses. The receipt the error carries makes
         * it `unavailable` instead, which deliberately does not block: a broken index is shown to
         * the person and left to their judgement rather than turned into a broken app (§9.4).
         */
        const run = async (tool: string, args: Record<string, unknown>) => {
          try {
            produced.push((await retrieval.call(leaseToken, tool, args)).receipt);
          } catch (err) {
            const receipt = (err as { receipt?: WorldChatCheckReceipt }).receipt;
            if (receipt) produced.push(receipt);
          }
        };

        for (const [category, query] of Object.entries(plan.queries)) {
          await run(category === "sheet-search" ? "search_sheets" : "search_canon", { query });
        }
        for (const target of plan.targets) {
          // Only the world's own entities have a tool to read them. The production records a
          // subject may now name (turn 95's fix) have no `get_entry`/`get_sheet` equivalent, so
          // they are skipped exactly as `world` is rather than reaching a nonexistent call.
          if (target.kind !== "canon" && target.kind !== "sheet") continue;
          const id = target.kind === "canon" ? target.entryId : target.sheetId;
          await run(target.kind === "canon" ? "get_entry" : "get_sheet", { id });
          /*
           * What else touches this entity, when the plan says the answer depends on it.
           *
           * `related-read` is required by `relationship.change` and satisfied by exactly one tool,
           * which nothing here ever called — so every relationship a conversation described stayed
           * `partial` for ever and could not be written. The classification existed, was proposed,
           * reached the rail, and refused with "there is not enough behind it to write it down".
           */
          if (plan.required.includes("related-read")) await run("related", { id });
        }
        // This runner's own world, for the same reason worldContext reads from it: the provider's
        // selection follows whatever the person opened while the turn was still running.
        return { receipts: produced, canonRevision: store.getBundle().meta.canonRevision };
      },
      describeEntry: (context) => describeEntryContext(context, store.getBundle()),
      onTurnFailed: ({ conversationId, runId, cause }) => {
        void this.appLog?.append({ level: "warn", event: "world-chat.turn-failed", conversationId, runId, cause });
      },
      onProgress: (conversationId, label) => {
        this.emit({
          at: new Date().toISOString(),
          type: "world-chat.progress",
          conversationId,
          label,
        });
      },
      evidenceSources: (messages) => ({
        messages,
        bundle: store.getBundle(),
        // The runner supplies these from the fold: it knows which attachments this run was
        // given, and reading every attachment a conversation ever had would be both wasteful
        // and wrong.
        attachments: [],
        attachmentText: new Map(),
      }),
      readAttachmentText: async (attachment) => {
        // Whole. What reaches the model is the prompt budget's decision, taken against the
        // window with every other section in view — not a per-document cut made before it.
        return attachments.readWholeText(attachment).catch(() => null);
      },
      // Whatever this run pulled through get_attachment_text, so a passage the model paged to is
      // quotable even though the prompt only ever inlined the document's opening.
      attachmentReadsFor: (runId) => retrieval.textReadBy(runId),
      now: () => new Date().toISOString(),
    });

    this.worldChatRunners.remember(store.worldId, store, runner);
    return runner;
  }

  /**
   * Bring the conversation rows up to date (#70 §10.3).
   *
   * Called after anything that changes what a row says — creating, renaming from a first
   * message, closing at wrap-up, reopening on send-back. None of those touch a world file, so
   * none of them would otherwise be noticed.
   */
  private async refreshConversations(store: WorldStore): Promise<void> {
    const { summaries } = await discoverConversations(store.dir);
    this.readModel.setConversations(summaries);
  }

  /**
   * Load one conversation into the snapshot (#70 §10.3).
   *
   * Sheet names and versions are resolved here rather than stored on the proposition, because a
   * sheet renamed since the conversation happened should read under its current name — the panel
   * describes what the studio understands about the world as it is now, not as it was.
   */
  private async openWorldChat(store: WorldStore, conversationId: ConversationId): Promise<void> {
    const service = new WorldChatService(store.dir);
    const loaded = await service.load(conversationId);
    if (!loaded) {
      this.readModel.setWorldChat(null);
      this.transport.broadcastSnapshot();
      return;
    }
    const bundle = store.getBundle();
    const sheets = new Map(bundle.sheets.map((s) => [s.id, s]));
    this.readModel.setWorldChat(
      projectWorkspace(loaded, new Map(), {
        sheetName: (slug) => sheets.get(slug)?.name ?? null,
        sheetVersion: (slug) => sheets.get(slug)?.version ?? null,
        // Asked of the runner, which is the only thing that knows a turn is happening now rather
        // than having been abandoned by a crash. Read through the same accessor that made the
        // runner, so a conversation mid-turn reports running even on the first projection.
        liveRun: this.worldChatRunner(store, loaded.id).isRunning(loaded.id),
        // So the rail's count matches what wrap-up will actually carry — see ProjectOptions.
        lookAlreadyProposed: bundle.proposals.some((staged) => staged.proposal.kind === "art-direction"),
        look: { version: bundle.artDirection.version, description: bundle.artDirection.description },
      }),
    );
    this.transport.broadcastSnapshot();
  }

  /**
   * Is a character sheet already being generated for this character?
   *
   * The same reading the kit screen takes, made where the queue actually lives: not yet terminal,
   * or terminal without a finished finalization — a job whose take has not been recorded will
   * still accept and designate itself when it is. That includes a finalization that *failed*,
   * because Activity offers to retry it and a successful retry runs the same acceptance, landing
   * the older generated sheet on top of a newer upload (PR review). Scoped to the world because
   * sheet slugs recur across them.
   */
  private characterSheetJobRunning(worldId: string, sheetId: string): boolean {
    const settled = ["succeeded", "failed", "cancelled", "needs-reconciliation"];
    return (this.jobQueue?.listJobs() ?? []).some(
      (job) =>
        job.worldId === worldId &&
        job.target.kind === "character-sheet" &&
        job.target.id?.startsWith(`${sheetId}/`) === true &&
        (!settled.includes(job.status) ||
          (job.finalization !== undefined && job.finalization.status !== "complete")),
    );
  }

  /**
   * Is this still the world the app is in? (PR #241 review.)
   *
   * A file dialog stands open for as long as the person in front of it wants, and they may well
   * open another world while it is up. Identity, not the id: switching worlds closes the old
   * store, and writing through a closed one is the thing to stop.
   */
  private stillOpen(store: WorldStore): boolean {
    return this.opts.provider.openStore?.() === store;
  }

  /**
   * Throw away the image staged for one surface.
   *
   * Called when the offer it helped make is settled either way, as well as on an explicit
   * removal: a reference kept past the picture it produced would silently join the *next*
   * generation, which nobody asked it to, and the dialog would open with an attachment the
   * person does not remember making.
   */
  private async dropStagedReference(store: WorldStore, key: string): Promise<void> {
    await store
      .gateOp(async () =>
        rm(toExtendedLength(join(store.dir, stagedReferenceDir(key))), { recursive: true, force: true }),
      )
      .catch(() => {});
  }

  /**
   * Publish this store's own bundle, and only while it is still the open one.
   *
   * Deliberately not `refreshWorldSnapshot`: that *loads* the world it is given, and its first
   * act is an awaited directory lookup. A world opened during that await is closed and the old
   * one reopened underneath it — so the check would hold and the harm land anyway (PR review).
   * Nothing is lost by reading the store directly; `loadWorld` returns this same bundle when the
   * world is already open, which is the only case that reaches here.
   */
  private refreshIfStillOpen(store: WorldStore): void {
    if (!this.stillOpen(store)) return;
    this.readModel.setWorld(store.getBundle());
    this.transport.broadcastSnapshot();
  }

  /**
   * Re-read the library rows the picker renders from.
   *
   * Separate from the world snapshot because they are different surfaces reading different
   * things: the open world's bundle, and the registry of every world. Only the actions that
   * change what a *card* shows need this — it walks the worlds directory, so calling it on
   * every snapshot refresh would put a directory scan behind every button in the app.
   */
  /**
   * Every harness the app knows about: the bundled one, which is a constant, plus whatever the
   * host's detector found. A host with no detector wired still gets a coherent answer — one
   * harness, always available — rather than an empty list a screen would have to explain.
   */
  private async harnessAvailability(): Promise<HarnessAvailability[]> {
    const claudePath = (await this.appSettings?.load())?.harness.claudePath ?? null;
    const detected = this.opts.detectHarnesses
      ? await this.opts.detectHarnesses(claudePath).catch(() => [])
      : [];
    return [OPENCODE_AVAILABILITY, ...detected];
  }

  /**
   * The list and the current choice, sent together (see `HarnessStatus`).
   *
   * The stored engine is reported only if it is still available. A user who chose Claude Code
   * and then uninstalled it is running on OpenCode — the launch path already fell back — and a
   * screen still showing Claude Code selected would be describing a session that does not
   * exist. The setting on disk is left alone: reinstalling should restore their choice, not
   * find it quietly erased.
   */
  private async emitHarnessStatus(known?: HarnessAvailability[]): Promise<void> {
    const harnesses = known ?? (await this.harnessAvailability());
    const settings = await this.appSettings?.load();
    const stored = settings?.harness.engine ?? "opencode";
    const claudePath = settings?.harness.claudePath ?? null;
    const engine = harnesses.find((h) => h.id === stored)?.installed ? stored : "opencode";
    this.emit({
      at: new Date().toISOString(),
      type: "harness.status",
      harness: { engine, harnesses, claudePath },
    });
  }

  private async refreshWorldList(): Promise<void> {
    try {
      this.readModel.setWorlds(await this.opts.provider.listWorlds());
    } catch {
      /* the previous list stands */
    }
    this.transport.broadcastSnapshot();
  }

  private async refreshWorldSnapshot(worldId: string): Promise<void> {
    try {
      this.readModel.setWorld(await this.opts.provider.loadWorld(worldId));
    } catch {
      /* the previous snapshot stands */
    }
    this.transport.broadcastSnapshot();
  }

  private async seed(): Promise<void> {
    if (this.opts.jobsSeedPath) {
      this.readModel.seedJobs(await readNdjson(this.opts.jobsSeedPath, (x) => JobSchema.parse(x)));
    }
    if (this.opts.ledgerSeedPath) {
      this.readModel.seedLedger(
        await readNdjson(this.opts.ledgerSeedPath, (x) => LedgerEntrySchema.parse(x)),
      );
    }
    // Asked once, at start-up: whether the sample world is installable is a fact about the
    // build, and the Settings pane should not have to discover it by trying.
    this.readModel.setSampleWorld({
      available:
        this.opts.provider.installSampleWorld !== undefined &&
        (await sampleWorldAvailable(this.opts.sampleWorldPath ?? null)),
    });
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      this.setup?.dispose();
      this.jobQueue?.dispose();
      for (const controller of this.reading.values()) controller.abort();
      for (const handle of this.exports.values()) handle.cancel();
      // Nothing awaits the backfill, but it should stop trying: its next write would be refused
      // by the store anyway once the world begins closing.
      this.backfillAbort?.abort();
      // In-flight frames answer first, then the door shuts: no new work can arrive during the
      // drains below. Transport.stop() was written and never called, so a stopped coordinator
      // went on listening — invisible in the packaged app, where the process exits regardless,
      // and the reason a stop-and-restart in one process could never bind its port again.
      await Promise.allSettled(this.activeMessages);
      await this.transport.stop();
      await Promise.allSettled(this.backgroundWork);
      await Promise.allSettled(this.carrying.values());
      await this.appearanceWrite;
      await this.jobQueue?.waitForIdle();
      await this.jobQueue?.drain();
      await Promise.all([...this.supervisors.values()].map((s) => s.stop()));
      await this.opts.adapter?.dispose?.().catch(() => {});
      await this.worldQuery.stop();
      // Provider close is the critical gate: it saves pending state and releases the world lock.
      await this.opts.provider.close?.();
      await this.opts.providerCalls?.drain();
      await this.ledger?.drain();
      await this.changeLog.drain();
      // The operational log drains with the rest. It was the one writer with a drain nobody
      // called, so a fault recorded in the last moments of a run — the kind most worth having,
      // because the run ended — could still be in the queue when the process left.
      await this.appLog?.drain();
    })();
    try {
      await this.stopPromise;
    } catch (error) {
      this.stopPromise = null;
      this.stopping = false;
      throw error;
    }
  }
}

async function readNdjson<T>(path: string, parse: (x: unknown) => T): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => parse(JSON.parse(l)));
}
