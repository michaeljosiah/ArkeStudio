export { ChangeLog, WriteQueue, type LogRecord } from "./change-log.js";
export { Coordinator, type CoordinatorOptions } from "./coordinator.js";
export { FrontmatterError, parseFrontmatter, splitSections, type BodySection } from "./frontmatter.js";
export { ReadModel } from "./read-model.js";
export {
  allocateLoopbackPort,
  ChildSupervisor,
  type SupervisedSpec,
  type SupervisorStatus,
  type SupervisorStatusEvent,
} from "./supervisor.js";
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
  stageVoiceAssignment,
  type ImageExtraction,
} from "./sheets/authoring.js";
export { AuthoringService, describeActionClass, settlePermission } from "./harness/authoring.js";
export { GrantStore, type RememberedGrant } from "./harness/grants.js";
export { WorldQueryServer } from "./harness/world-query.js";
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
