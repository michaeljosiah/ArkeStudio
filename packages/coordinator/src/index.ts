export { AppLog } from "./app-log.js";
export { AppSettingsFile, routingFaults } from "./app-settings.js";
export { ChangeLog, WriteQueue, type LogRecord } from "./change-log.js";
export { Coordinator, type CoordinatorOptions } from "./coordinator.js";
export { CredentialStore, type Cipher } from "./credentials/store.js";
export { buildDiagnosticsBundle } from "./diagnostics.js";
export { ProviderService, type KeyValidator } from "./providers/service.js";
export { ProviderCallStore } from "./providers/call-store.js";
export { REDACTED, redactDeep, SecretRegistry } from "./redact.js";
export {
  detectDrift,
  DRIFT_MIN_SAMPLES,
  DRIFT_PER_MILLE,
  evaluateSpend,
  rollingSpend,
} from "./spend/analytics.js";
export { LedgerFile } from "./spend/ledger.js";
export { backoffMs, classifyError, isRateLimit, type FailureClass } from "./queue/classify.js";
export {
  JobQueue,
  type DispatchArtifact,
  type DispatchClient,
  type EnqueueInput,
  type JobQueueOptions,
} from "./queue/dispatcher.js";
export { JobJournal } from "./queue/journal.js";
export { verifyArtifact, type VerifiableArtifact } from "./queue/verify.js";
export {
  establishRequests,
  imageModelFor,
  missingTileAngles,
  styleLine,
  tileRequest,
  type TileRequest,
} from "./references/generate.js";
export { attachmentFor, type AttachmentDecision } from "@arke-studio/contracts";
export {
  chooseAnchor,
  compileGrid,
  designate,
  emptyKit,
  kitReport,
  landGrid,
  lockTile,
  readKit,
  setStyleOverride,
  supersedeTile,
  type GridResult,
} from "./references/kit.js";
export { decodePng, drawScaled, encodePng, solidImage, type RgbaImage } from "./references/png.js";
export {
  previewCacheFile,
  VoiceService,
  voiceLineRequest,
  type CloudVoiceSource,
  type SidecarLike,
  type VoiceServiceDeps,
} from "./voice/service.js";
export {
  candidateHash,
  extractText,
  resolveCandidate,
  storeBatch,
  verifyCandidates,
  type RawCandidate,
  type VerifiedBatch,
} from "./artifacts/extraction.js";
export {
  addLinks,
  fileArtifact,
  importFolder,
  kindForFile,
  LARGE_FILE_BYTES,
  pickable,
  type FileOutcome,
  type ImportReport,
} from "./artifacts/filing.js";
export { spoolBytes, spoolDir, spoolName, SPOOL_LIMIT_BYTES, sweepSpool } from "./artifacts/spool.js";
export { recordTakesFromJob, type TakeArrivalOptions } from "./takes/arrival.js";
export {
  createTakeQcAnalyzer,
  measureFramemd5,
  parseFramemd5,
  takeQcArgs,
  QC_MAX_OUTPUT_BYTES,
  QC_THRESHOLD_RATIO,
  QC_TIMEOUT_MS,
  type MediaProbeRunner,
  type TakeQcAnalysis,
  type TakeQcAnalyzer,
  type TakeQcUnavailableReason,
} from "./takes/qc.js";
export { exportWorld, runExport, WORLD_EXPORT_EXCLUDED, type ExportHandle, type FfmpegRunner } from "./takes/export.js";
export { acceptTake, rejectTake, saveAudioTracks } from "./takes/review.js";
export {
  compileBoard,
  composeDispatches,
  createChapter,
  createProduction,
  draftSceneSkeleton,
  exportBoard,
  landBoard,
  reorderChapters,
  saveChapter,
  setPromptOverride,
  type SceneDraft,
} from "./productions/ops.js";
export {
  acceptStoryboard,
  recordStoryboard,
  storyboardRequest,
  type StoryboardRequest,
} from "./productions/storyboard.js";
export { FrontmatterError, parseFrontmatter, splitSections, type BodySection } from "./frontmatter.js";
export { ReadModel } from "./read-model.js";
export {
  allocateLoopbackPort,
  ChildSupervisor,
  registerExitBackstop,
  type SupervisedSpec,
  type SupervisorDeps,
  type SupervisorStatus,
  type SupervisorStatusEvent,
} from "./supervisor.js";
export {
  ChildLedger,
  ownerStamp,
  type ChildRecord,
  type ProcessProbe,
  type ReapReport,
} from "./child-ledger.js";
export { leashChildToParent, type LeashResult } from "./job-leash.js";
export { Transport, type TransportOptions } from "./transport.js";
export { type WorldProvider } from "./world-provider.js";
export { atomicWriteFile, renameWithRetry } from "./world/atomic.js";
export { appendChanges, readChanges } from "./world/change-writer.js";
export {
  classify,
  CommitPlanError,
  CommitStaleError,
  Committer,
  CrashSignal,
  type CommitFileInput,
  type CommitHooks,
  type CommitInput,
  type CommitResult,
} from "./world/commit.js";
export { WorldLock, WorldLockedError } from "./world/lock.js";
export { checkPathBudget, defaultAppRoot, fsPath, toExtendedLength, toPortable } from "./world/paths.js";
export { FsWorldProvider, type CreateWorldInput } from "./world/provider.js";
export { readWorldMeta, scanWorld, SUPPORTED_SCHEMA_VERSION, WorldOpenError } from "./world/scan.js";
export { fallbackSlug, slugify, uniqueSlug } from "./world/slug.js";
export { deleteScanState, WorldStore } from "./world/store.js";
export { JsonFile, MarkdownFile, sha256 } from "./world/text-files.js";
export { applyResolution, mergeMarkdown, type MergeResult } from "./gate/merge.js";
export {
  ProposalManager,
  rippleSignature,
  type AcceptOutcome,
  type StageInput,
} from "./gate/proposals.js";
export { AppIndex } from "./index-db/app-index.js";
export { AskService, excerptAppears, extractJson, normalizeForVerify, verifyClaims } from "./canon/ask.js";
export {
  openThread,
  stageCanonAmendment,
  stageCanonEntry,
  stageThreadSettlement,
} from "./canon/authoring.js";
export {
  buildSheetContent,
  createSheetFromImage,
  createSheetFromSentence,
  duplicateSheet,
  scopeImageExtraction,
  stageSheetRename,
  stageSheetStatus,
  applyVoiceAssignment,
  type ImageExtraction,
} from "./sheets/authoring.js";
export { AuthoringService, describeActionClass, settlePermission } from "./harness/authoring.js";
export { LocalSetupService, type SetupDeps } from "./setup/local-setup.js";
export { SETUP_CATALOGUE, catalogueTotalMb, type CatalogueEntry } from "./setup/catalogue.js";
export { nodeSetupDeps } from "./setup/node-deps.js";
export { GrantStore, type RememberedGrant } from "./harness/grants.js";
export { WorldQueryServer } from "./harness/world-query.js";
export { harnessTrace } from "./harness/trace.js";
export { castRefs, canonStamp, extract } from "./index-db/citations.js";
export {
  contradictionCandidates,
  DEFAULT_RELEVANCE_FLOOR,
  ftsQuery,
  needsYou,
  refsForCanon,
  refsForSheet,
  ripplesForCanonEntry,
  ripplesForSheet,
  searchCanon,
  type CanonCandidate,
  type CanonSearchResult,
  type NeedsYouItem,
  type SheetRefs,
} from "./index-db/queries.js";
export { assertFts5, loadNodeSqlite, type Database, type DatabaseCtor } from "./index-db/sqlite.js";
export { bundleFingerprint, WorldIndex } from "./index-db/world-index.js";
