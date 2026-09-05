import { readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ART_DIRECTION_PATH,
  ArtDirectionRecordSchema,
  CanonEntrySchema,
  deriveArtDirectionDescription,
  productionFrameRate,
  productionShape,
  SceneRecordSchema,
  orderedShots,
  sceneDeleteBlockers,
  SheetSchema,
  sortScenes,
  WorldMetaSchema,
  ClientMessageSchema,
  describeEditorRequestDigest,
  ModelWorldChatActionSchema,
  applyBibleEdits,
  sheetDir,
  splitBible,
  WorldChatArtDirectionActionSchema,
  WorldChatArtDirectionRestoreActionSchema,
  WorldChatArtifactExtractionActionSchema,
  WorldChatArtifactExtractionReviewActionSchema,
  WorldChatArtifactExtractionStopActionSchema,
  WorldChatArtifactImportActionSchema,
  WorldChatArtifactMetadataActionSchema,
  WorldChatArtifactReferenceActionSchema,
  WorldChatBibleActionSchema,
  WorldChatCanonActionSchema,
  WorldChatCanonRestoreActionSchema,
  WorldChatCanonRetireActionSchema,
  WorldChatEditorRequestActionSchema,
  WorldChatProposalActionSchema,
  WorldChatProductionChapterActionSchema,
  WorldChatProductionChapterOrderActionSchema,
  WorldChatProductionCreateActionSchema,
  WorldChatProductionEpisodeActionSchema,
  WorldChatProductionEpisodeOrderActionSchema,
  WorldChatProductionMetadataActionSchema,
  WorldChatProductionModelActionSchema,
  WorldChatProductionOverviewActionSchema,
  WorldChatProductionSceneActionSchema,
  WorldChatProductionSceneDeleteActionSchema,
  WorldChatProductionSceneOrderActionSchema,
  WorldChatProductionSceneRestoreActionSchema,
  WorldChatProductionSeasonActionSchema,
  WorldChatProductionSeriesActionSchema,
  WorldChatProductionStyleActionSchema,
  WorldChatProductionSceneCommandActionSchema,
  WorldChatProductionBoardCompileActionSchema,
  WorldChatProductionBoardExportActionSchema,
  WorldChatProductionTakeImportActionSchema,
  WorldChatProductionTakeGenerationActionSchema,
  WorldChatProductionTakeReviewActionSchema,
  WorldChatProductionTakeTrimActionSchema,
  WorldChatProductionStagePlayblastActionSchema,
  WorldChatReferenceChangeActionSchema,
  WorldChatReferenceCompileActionSchema,
  WorldChatReferenceGenerationActionSchema,
  WorldChatReferenceImageDiscardActionSchema,
  WorldChatReferenceImageImportActionSchema,
  WorldChatReferenceImportActionSchema,
  WorldChatReferenceMasterLookResultUseActionSchema,
  WorldChatReferenceResultUseActionSchema,
  WorldChatReferenceReviewActionSchema,
  WorldChatReferenceStyleActionSchema,
  WorldChatReferenceTileLockActionSchema,
  WorldChatReferenceWorldImageResultUseActionSchema,
  WorldChatSceneActionSchema,
  WorldChatSheetActionSchema,
  WorldChatSheetRestoreActionSchema,
  WorldChatSheetRetireActionSchema,
  WorldChatWorldMetadataActionSchema,
  WorldChatAudioSpineActionSchema,
  WorldChatVoiceAssignmentActionSchema,
  WorldChatVoiceAuditionActionSchema,
  WorldChatVoiceCloneActionSchema,
  WorldChatVoiceClipReviewActionSchema,
  WorldChatWorldArchiveActionSchema,
  WorldChatWorldExportActionSchema,
  WorldChatPreparedActionSchema,
  type BibleEdit,
  type CandidateId,
  type CandidateGroup,
  type ConversationActionCard,
  type ConversationActionPrepareIntent,
  type ConversationActionReceipt,
  type ConversationActionTarget,
  type ConversationId,
  type ArkeReadObservation,
  type ArkeReadRequirement,
  type ModelWorldChatAction,
  type WorldChatArtDirectionRestoreAction,
  type WorldChatCanonRestoreAction,
  type WorldChatCanonRetireAction,
  type WorldChatSheetRestoreAction,
  type WorldChatSheetRetireAction,
  type WorldChatWorldMetadataAction,
  type WorldChatReferenceImageDiscardAction,
  type WorldChatReferenceImageImportAction,
  type WorldChatReferenceImportAction,
  type WorldChatReferenceResultUseAction,
  type WorldChatVoiceAssignmentAction,
  type WorldChatProductionTakeImportAction,
  type WorldChatProductionTakeGenerationAction,
  type ModelEditorRequest,
  type ModelSceneEdit,
  type ProposalId,
  type TurnId,
  type WorldChangeCandidate,
  type WorldChatContext,
  type WorldChatCheckReceipt,
  type WorldChatPreparedAction,
} from "@arke-studio/contracts";
import { resolveCandidate } from "../artifacts/extraction.js";
import {
  ATTACHABLE_EXTENSIONS,
  addLinks,
  fileArtifact,
  importFolder,
  setOwner,
} from "../artifacts/filing.js";
import type {
  ConversationActionAuthorityAdapter,
  ConversationActionExecutionOutcome,
  PreparedConversationActionAuthority,
} from "../arke-actions/lifecycle.js";
import { ConversationActionLifecycle, conversationActionDigest } from "../arke-actions/lifecycle.js";
import {
  acceptDecided,
  explainAcceptRefusal,
  landed,
  type AcceptOutcome,
  type ProposalManager,
} from "../gate/proposals.js";
import { discoverBenchSessions } from "../bench/service.js";
import {
  decideEditorRequest,
  productionOfContext,
  readEditorRequest,
  readEditorRequestByAction,
  stageEditorRequests,
  previewProductionEditorRequest,
  validateEditorRequest,
} from "../productions/editor-requests.js";
import { applySceneEdits, sceneOfContext } from "../productions/scene-edits.js";
import {
  createProductionFromPlan,
  deleteScene,
  planProductionCreation,
  reorderChapters,
  reorderEpisodes,
  reorderScenes,
  restoreScene,
  setProductionModel,
  setProductionStyle,
  updateProductionMetadata,
  validateProductionMetadataChanges,
  compileBoard,
  exportBoard,
  landBoard,
} from "../productions/ops.js";
import { applyProductionSpineCommand, previewAudioSpineCommand } from "../productions/spine.js";
import { applySceneCommand, sceneCommandFrom } from "../productions/scene-commands.js";
import { filePlayblast } from "../productions/stage-playblast.js";
import {
  acceptCharacterLook,
  acceptCharacterSheet,
  acceptLocationView,
  attachCharacterLook,
  chooseAnchor,
  compileGrid,
  designate,
  landGrid,
  lockTile,
  promoteCharacterLook,
  readKit,
  setStyleOverride,
} from "../references/kit.js";
import { acceptMainPhoto } from "../references/main-photo.js";
import {
  pendingReferenceTake,
  recordReferenceReview,
  referenceReviewDecision,
} from "../references/takes.js";
import { stagedReferenceDir } from "../references/master-look.js";
import { applyVoiceAssignment } from "../sheets/authoring.js";
import { acceptTake, rejectTake, setTrim } from "../takes/review.js";
import { acceptStill } from "../takes/drawn-frame.js";
import { posterNameFor } from "../takes/poster.js";
import type { BoundaryFrameMaker } from "../takes/boundary.js";
import { AUDIO_EXTENSIONS as CLONEABLE_AUDIO_EXTENSIONS, cloneVoice } from "../voice/library.js";
import type { MediaProbe } from "../media/probe.js";
import { atomicWriteFile } from "../world/atomic.js";
import { readBible, applyTurnBibleEdits } from "../world/bible.js";
import { readChanges } from "../world/change-writer.js";
import { CommitStaleError, type CommitResult } from "../world/commit.js";
import {
  WorldStateStaleError,
  type WorldStatePrecondition,
  type WorldStore,
} from "../world/store.js";
import { MarkdownFile } from "../world/text-files.js";
import { toExtendedLength } from "../world/paths.js";
import { foldConversation } from "./fold.js";
import { evaluateReadiness } from "./readiness.js";
import { sendBack } from "./resolution.js";
import { conversationDir, WorldChatStore } from "./store.js";
import {
  artDirectionFence,
  artifactsFence,
  bibleFence,
  canonFence,
  chaptersFence,
  episodesFence,
  productionMetadataFence,
  productionsFence,
  referencesFence,
  sceneFence,
  sceneScriptFence,
  scenesFence,
  seasonFence,
  seriesFence,
  sheetsFence,
  storyFence,
  spineFence,
  timelineFence,
  takesFence,
  voicesFence,
  worldMetadataFence,
} from "./target-reads.js";
import { stageWorldChatProductionAuthoredAction } from "./production-authoring.js";
import {
  stageWorldChatArtDirectionAction,
  stageWorldChatCanonAction,
  stageWorldChatSheetAction,
} from "./world-authoring.js";

export interface PreparedWorldChatAction {
  readonly intent: ConversationActionPrepareIntent;
  readonly payload: WorldChatPreparedAction;
}

export interface WorldChatActionTurn {
  readonly conversationId: ConversationId;
  readonly turnId: TurnId;
  readonly entryContext: WorldChatContext | undefined;
  readonly existingCandidates: readonly WorldChangeCandidate[];
  readonly existingGroups: readonly CandidateGroup[];
  readonly candidates: readonly WorldChangeCandidate[];
  readonly groups: readonly CandidateGroup[];
  readonly bibleEdits: readonly BibleEdit[];
  readonly bibleBaseVersion: number;
  readonly sceneEdits: readonly ModelSceneEdit[];
  readonly sceneBaseVersion: number | null;
  readonly editorRequests: readonly ModelEditorRequest[];
  readonly actions: readonly ModelWorldChatAction[];
  /** Present on live runs; absent only on callers created before complete target receipts. */
  readonly receipts?: readonly WorldChatCheckReceipt[];
  readonly at: string;
}

export interface WorldChatActionAdapterDeps {
  readonly pickFiles?: (input: { accept: readonly string[] }) => Promise<readonly string[]>;
  readonly pickFolder?: () => Promise<string | null>;
  readonly mediaProbe?: MediaProbe;
  readonly extractArtifact?: (
    artifactId: string,
    mutation: { source: string; requestId: string; precondition: WorldStatePrecondition },
  ) => Promise<{ found: number; dropped: number; outcome: string }>;
  readonly stopExtraction?: (artifactId: string) => void;
  readonly importReference?: (
    change: WorldChatReferenceImportAction["action"]["change"],
    mutation: { source: string; requestId: string; precondition: WorldStatePrecondition },
  ) => Promise<{ status: "completed" | "cancelled" | "failed"; id?: string; detail?: string }>;
  readonly importReferenceImage?: (
    target: WorldChatReferenceImageImportAction["action"]["target"],
    mutation: { source: string; requestId: string; precondition: WorldStatePrecondition },
  ) => Promise<{ status: "completed" | "cancelled" | "failed"; id?: string; detail?: string }>;
  readonly useWorldImage?: (
    candidateIndex: number,
    mutation: { source: string; requestId: string; precondition: WorldStatePrecondition },
  ) => Promise<boolean>;
  readonly useMasterLook?: (
    candidateIndex: number,
    mutation: { source: string; requestId: string; precondition: WorldStatePrecondition },
  ) => Promise<boolean>;
  readonly useReferenceCandidate?: (
    change: WorldChatReferenceResultUseAction["action"]["change"],
    mutation: { source: string; requestId: string; precondition: WorldStatePrecondition },
  ) => Promise<{ status: "completed" | "failed"; id?: string; detail?: string }>;
  readonly discardReferenceImage?: (
    target: WorldChatReferenceImageDiscardAction["action"]["target"],
    mutation: { source: string; requestId: string; precondition: WorldStatePrecondition },
  ) => Promise<boolean>;
  readonly archiveWorld?: () => Promise<{ id: string }>;
  readonly exportWorld?: (actionId: string) => Promise<{ id: string }>;
  readonly inFlightWorldJobs?: () => number;
  readonly voiceAvailable?: (voice: NonNullable<WorldChatVoiceAssignmentAction["action"]["voice"]>) => Promise<boolean>;
  readonly boundaryFrameMaker?: BoundaryFrameMaker;
  readonly importProductionTake?: (
    action: WorldChatProductionTakeImportAction["action"],
    mutation: { source: string; requestId: string; precondition: WorldStatePrecondition },
  ) => Promise<{ status: "completed" | "cancelled" | "failed"; id?: string; detail?: string }>;
  /** Opens a prepared Bench subject. Provider execution remains a separate confirmation in Bench. */
  readonly openProductionTakeGeneration?: (
    action: WorldChatProductionTakeGenerationAction["action"],
    mutation: { source: string; requestId: string; precondition: WorldStatePrecondition },
  ) => Promise<{ status: "completed" | "failed"; id?: string; detail?: string }>;
}

function completeObservation(
  receipts: readonly WorldChatCheckReceipt[],
  requirement: "bible" | "timeline",
  target: string,
  expectedFence?: string,
) {
  const receipt = receipts.findLast((entry) =>
    entry.tool === "target-read" &&
    (entry.status === "complete" || entry.status === "empty") &&
    entry.complete === true &&
    entry.nextCursor === null &&
    entry.target?.requirement === requirement &&
    entry.target.id === target &&
    entry.observedRevisionOrDigest !== undefined &&
    (expectedFence === undefined || entry.observedRevisionOrDigest === expectedFence));
  return receipt
    ? {
        requirement,
        target,
        revisionOrDigest: receipt.observedRevisionOrDigest!,
        complete: true as const,
        receiptId: receipt.id,
      }
    : null;
}

const WORLD_ACTION_REQUIREMENTS: Record<ModelWorldChatAction["kind"], readonly ArkeReadRequirement[]> = {
  "world-metadata": ["world-metadata", "art-direction"],
  canon: ["canon", "sheets"],
  "canon-retire": ["canon", "sheets"],
  "canon-restore": ["canon", "sheets"],
  sheet: ["sheets", "canon"],
  "sheet-retire": ["sheets", "canon"],
  "sheet-restore": ["sheets", "canon"],
  "art-direction": ["art-direction"],
  "art-direction-restore": ["art-direction"],
  "artifact-import": ["artifacts"],
  "artifact-metadata": ["artifacts", "production-metadata"],
  "artifact-extraction": ["artifacts", "canon", "sheets"],
  "artifact-extraction-stop": ["artifacts"],
  "artifact-extraction-review": ["artifacts", "canon", "sheets"],
  "artifact-reference": ["artifacts", "references"],
  "reference-import": ["sheets", "references"],
  "reference-result-use": ["sheets", "references"],
  "reference-review": ["sheets", "references"],
  "reference-change": ["sheets", "references"],
  "reference-tile-lock": ["sheets", "references"],
  "reference-compile": ["sheets", "references"],
  "reference-style": ["sheets", "art-direction", "references"],
  "reference-generation": ["sheets", "art-direction", "references"],
  "reference-image-import": ["references"],
  "reference-world-image-result-use": ["references", "world-metadata"],
  "reference-master-look-result-use": ["references", "art-direction"],
  "reference-image-discard": ["references"],
  "voice-assignment": ["sheets", "voices"],
  "voice-audition": ["sheets", "voices"],
  "voice-clone": ["sheets", "voices"],
  "voice-clip-review": ["takes", "sheets"],
  "world-archive": ["world-metadata"],
  "world-export": ["world-metadata", "artifacts"],
  "production-create": ["production-metadata", "series"],
  "production-metadata": ["production-metadata", "series", "timeline"],
  "production-model": ["production-metadata"],
  "production-series": ["production-metadata", "series"],
  "production-overview": ["story"],
  "production-season": ["seasons"],
  "production-episode": ["episodes"],
  "production-chapter": ["chapters"],
  "production-scene": ["scenes"],
  "production-episode-order": ["episodes"],
  "production-chapter-order": ["chapters"],
  "production-scene-order": ["scenes"],
  "production-scene-delete": ["scenes"],
  "production-scene-restore": ["scenes"],
  "production-style": ["production-metadata", "art-direction"],
  "production-scene-command": ["scenes"],
  "production-board-compile": ["scenes", "takes", "artifacts"],
  "production-board-export": ["scenes", "takes", "artifacts"],
  "production-take-import": ["scenes", "takes"],
  "production-take-generation": ["scenes", "takes"],
  "production-take-review": ["takes"],
  "production-take-trim": ["takes"],
  "production-stage-playblast": ["scenes"],
  "audio-spine-command": ["spine"],
};

function currentWorldObservation(
  store: WorldStore,
  requirement: ArkeReadRequirement,
  target?: string,
): { target: string; fence: string } | null {
  const bundle = store.getBundle();
  switch (requirement) {
    case "world-metadata": return { target: store.worldId, fence: worldMetadataFence(bundle) };
    case "canon": return { target: store.worldId, fence: canonFence(bundle) };
    case "sheets": return { target: store.worldId, fence: sheetsFence(bundle) };
    case "art-direction": return { target: "art-direction", fence: artDirectionFence(bundle) };
    case "references": return { target: store.worldId, fence: referencesFence(bundle) };
    case "artifacts": return { target: store.worldId, fence: artifactsFence(bundle) };
    case "voices": return { target: store.worldId, fence: voicesFence(bundle) };
    case "production-metadata": {
      const productionId = target ?? store.worldId;
      return productionId === store.worldId
        ? { target: store.worldId, fence: productionsFence(bundle) }
        : { target: productionId, fence: productionMetadataFence(bundle, productionId) };
    }
    case "series": return { target: store.worldId, fence: seriesFence(bundle) };
    case "story": {
      const productionId = target ?? store.worldId;
      return { target: productionId, fence: storyFence(bundle.productions.find((candidate) => candidate.meta.id === productionId)) };
    }
    case "seasons": {
      const productionId = target ?? store.worldId;
      return { target: productionId, fence: seasonFence(bundle.productions.find((candidate) => candidate.meta.id === productionId)) };
    }
    case "episodes": {
      const productionId = target ?? store.worldId;
      return { target: productionId, fence: episodesFence(bundle.productions.find((candidate) => candidate.meta.id === productionId)) };
    }
    case "chapters": {
      const productionId = target ?? store.worldId;
      return { target: productionId, fence: chaptersFence(bundle.productions.find((candidate) => candidate.meta.id === productionId)) };
    }
    case "scenes": {
      const targetId = target ?? store.worldId;
      const [productionId, sceneId, suffix] = targetId.split(":");
      const production = bundle.productions.find((candidate) => candidate.meta.id === productionId);
      if (sceneId && suffix === "script") return { target: targetId, fence: sceneScriptFence(production, sceneId) };
      if (sceneId && suffix === undefined) return { target: targetId, fence: sceneFence(production, sceneId) };
      return { target: targetId, fence: scenesFence(production) };
    }
    case "timeline": {
      const productionId = target ?? store.worldId;
      return { target: productionId, fence: timelineFence(bundle.productions.find((candidate) => candidate.meta.id === productionId), bundle.artifacts) };
    }
    case "spine": {
      const productionId = target ?? store.worldId;
      return { target: productionId, fence: spineFence(bundle.productions.find((candidate) => candidate.meta.id === productionId), bundle.artifacts) };
    }
    case "takes": {
      const productionId = target ?? store.worldId;
      const production = bundle.productions.find((candidate) => candidate.meta.id === productionId);
      return { target: productionId, fence: takesFence(production) };
    }
    default: return null;
  }
}

function productionActionTargets(
  store: WorldStore,
  action: ModelWorldChatAction,
): Array<{ requirement: ArkeReadRequirement; target: string }> {
  const worldId = store.worldId;
  switch (action.kind) {
    case "production-create": return [
      { requirement: "production-metadata", target: worldId },
      { requirement: "series", target: worldId },
    ];
    case "production-metadata": return [
      { requirement: "production-metadata", target: action.productionId },
      { requirement: "series", target: worldId },
      { requirement: "timeline", target: action.productionId },
    ];
    case "production-model": return [{ requirement: "production-metadata", target: action.productionId }];
    case "production-series": return [
      { requirement: "production-metadata", target: action.productionId },
      { requirement: "series", target: worldId },
    ];
    case "production-overview": return [{ requirement: "story", target: action.productionId }];
    case "production-season": return [
      { requirement: "seasons", target: action.productionId },
      ...(action.changes.arcs !== undefined && action.changes.arcs !== null
        ? [{ requirement: "episodes" as const, target: action.productionId }]
        : []),
    ];
    case "production-episode": return [
      { requirement: "episodes", target: action.productionId },
      ...((action.change.operation === "create" && action.change.scenes.length > 0) ||
          (action.change.operation === "edit" && action.change.changes.scenes !== undefined)
        ? [{ requirement: "scenes" as const, target: action.productionId }]
        : []),
    ];
    case "production-chapter": {
      const draws = action.change.operation === "create" ? action.change.draws : action.change.changes.draws;
      return [
        { requirement: "chapters", target: action.productionId },
        ...(draws
          ? [
              { requirement: "sheets" as const, target: worldId },
              { requirement: "canon" as const, target: worldId },
            ]
          : []),
      ];
    }
    case "production-scene": return [
      {
        requirement: "scenes",
        target: action.change.operation === "create"
          ? action.productionId
          : action.change.operation === "replace-script"
            ? `${action.productionId}:${action.change.sceneId}:script`
            : `${action.productionId}:${action.change.sceneId}`,
      },
      ...(action.change.operation === "create" && action.change.episodeId !== undefined
        ? [{ requirement: "episodes" as const, target: action.productionId }]
        : []),
    ];
    case "production-episode-order": return [{ requirement: "episodes", target: action.productionId }];
    case "production-chapter-order": return [{ requirement: "chapters", target: action.productionId }];
    case "production-scene-order": return [{ requirement: "scenes", target: action.productionId }];
    case "production-scene-delete":
    case "production-scene-restore": return [{ requirement: "scenes", target: `${action.productionId}:${action.sceneId}` }];
    case "production-style": return [
      { requirement: "production-metadata", target: action.productionId },
      { requirement: "art-direction", target: "art-direction" },
    ];
    case "production-scene-command": return [
      { requirement: "scenes", target: `${action.productionId}:${action.sceneId}` },
    ];
    case "production-board-compile":
    case "production-board-export": return [
      { requirement: "scenes", target: `${action.productionId}:${action.sceneId}` },
      { requirement: "takes", target: action.productionId },
      { requirement: "artifacts", target: worldId },
    ];
    case "production-take-import":
    case "production-take-generation": return [
      { requirement: "scenes", target: `${action.productionId}:${action.sceneId}` },
      { requirement: "takes", target: action.productionId },
    ];
    case "production-take-review":
    case "production-take-trim": return [{ requirement: "takes", target: action.productionId }];
    case "production-stage-playblast": return [
      { requirement: "scenes", target: `${action.productionId}:${action.sceneId}` },
    ];
    case "audio-spine-command": return [{ requirement: "spine", target: action.productionId }];
    default: return [];
  }
}

function worldActionObservations(
  store: WorldStore,
  receipts: readonly WorldChatCheckReceipt[],
  action: ModelWorldChatAction,
): ArkeReadObservation[] {
  const observations = action.checkReceiptIds.map((id) => {
    const receipt = receipts.find((entry) => entry.id === id);
    if (
      !receipt ||
      receipt.tool !== "target-read" ||
      (receipt.status !== "complete" && receipt.status !== "empty") ||
      receipt.complete !== true ||
      receipt.nextCursor !== null ||
      !receipt.target ||
      !receipt.observedRevisionOrDigest
    ) throw new Error("A world action requires the final receipt from a complete target read.");
    const current = currentWorldObservation(store, receipt.target.requirement, receipt.target.id);
    if (
      !current ||
      current.target !== receipt.target.id ||
      current.fence !== receipt.observedRevisionOrDigest
    ) throw new Error(`The complete ${receipt.target.requirement} read is no longer current.`);
    return {
      requirement: receipt.target.requirement,
      target: receipt.target.id,
      revisionOrDigest: receipt.observedRevisionOrDigest,
      complete: true as const,
      receiptId: receipt.id,
    };
  });
  const observed = new Set(observations.map((observation) => observation.requirement));
  const missing = WORLD_ACTION_REQUIREMENTS[action.kind].find((requirement) => !observed.has(requirement));
  if (missing) throw new Error(`A ${action.kind} action requires a complete current ${missing} read.`);
  const wrongTarget = productionActionTargets(store, action).find((required) =>
    !observations.some((observation) =>
      observation.requirement === required.requirement && observation.target === required.target));
  if (wrongTarget) {
    throw new Error(`A ${action.kind} action requires the complete current ${wrongTarget.requirement} read for ${wrongTarget.target}.`);
  }
  return [...new Map(observations.map((observation) => [observation.receiptId, observation])).values()];
}

function preparedWorldPayload(
  store: WorldStore,
  action: ModelWorldChatAction,
  productionId?: string,
  at = store.now(),
): WorldChatPreparedAction {
  const worldId = store.worldId;
  const common = { worldId, ...(productionId !== undefined ? { productionId } : {}), action };
  switch (action.kind) {
    case "world-metadata": return WorldChatWorldMetadataActionSchema.parse({ kind: "world-chat-world-metadata", ...common });
    case "canon": return WorldChatCanonActionSchema.parse({ kind: "world-chat-canon", ...common });
    case "canon-retire": return WorldChatCanonRetireActionSchema.parse({ kind: "world-chat-canon-retire", ...common });
    case "canon-restore": return WorldChatCanonRestoreActionSchema.parse({ kind: "world-chat-canon-restore", ...common });
    case "sheet": return WorldChatSheetActionSchema.parse({ kind: "world-chat-sheet", ...common });
    case "sheet-retire": return WorldChatSheetRetireActionSchema.parse({ kind: "world-chat-sheet-retire", ...common });
    case "sheet-restore": return WorldChatSheetRestoreActionSchema.parse({ kind: "world-chat-sheet-restore", ...common });
    case "art-direction": return WorldChatArtDirectionActionSchema.parse({ kind: "world-chat-art-direction", ...common });
    case "art-direction-restore": return WorldChatArtDirectionRestoreActionSchema.parse({ kind: "world-chat-art-direction-restore", ...common });
    case "artifact-import": return WorldChatArtifactImportActionSchema.parse({ kind: "world-chat-artifact-import", ...common });
    case "artifact-metadata": return WorldChatArtifactMetadataActionSchema.parse({ kind: "world-chat-artifact-metadata", ...common });
    case "artifact-extraction": return WorldChatArtifactExtractionActionSchema.parse({ kind: "world-chat-artifact-extraction", ...common });
    case "artifact-extraction-stop": return WorldChatArtifactExtractionStopActionSchema.parse({ kind: "world-chat-artifact-extraction-stop", ...common });
    case "artifact-extraction-review": return WorldChatArtifactExtractionReviewActionSchema.parse({ kind: "world-chat-artifact-extraction-review", ...common });
    case "artifact-reference": return WorldChatArtifactReferenceActionSchema.parse({ kind: "world-chat-artifact-reference", ...common });
    case "reference-import": return WorldChatReferenceImportActionSchema.parse({ kind: "world-chat-reference-import", ...common });
    case "reference-result-use": return WorldChatReferenceResultUseActionSchema.parse({ kind: "world-chat-reference-result-use", ...common });
    case "reference-review": return WorldChatReferenceReviewActionSchema.parse({ kind: "world-chat-reference-review", ...common });
    case "reference-change": return WorldChatReferenceChangeActionSchema.parse({ kind: "world-chat-reference-change", ...common });
    case "reference-tile-lock": return WorldChatReferenceTileLockActionSchema.parse({ kind: "world-chat-reference-tile-lock", ...common });
    case "reference-compile": return WorldChatReferenceCompileActionSchema.parse({ kind: "world-chat-reference-compile", ...common });
    case "reference-style": return WorldChatReferenceStyleActionSchema.parse({ kind: "world-chat-reference-style", ...common });
    case "reference-generation": return WorldChatReferenceGenerationActionSchema.parse({ kind: "world-chat-reference-generation", ...common });
    case "reference-image-import": return WorldChatReferenceImageImportActionSchema.parse({ kind: "world-chat-reference-image-import", ...common });
    case "reference-world-image-result-use": return WorldChatReferenceWorldImageResultUseActionSchema.parse({ kind: "world-chat-reference-world-image-result-use", ...common });
    case "reference-master-look-result-use": return WorldChatReferenceMasterLookResultUseActionSchema.parse({ kind: "world-chat-reference-master-look-result-use", ...common });
    case "reference-image-discard": return WorldChatReferenceImageDiscardActionSchema.parse({ kind: "world-chat-reference-image-discard", ...common });
    case "voice-assignment": return WorldChatVoiceAssignmentActionSchema.parse({ kind: "world-chat-voice-assignment", ...common });
    case "voice-audition": return WorldChatVoiceAuditionActionSchema.parse({ kind: "world-chat-voice-audition", ...common });
    case "voice-clone": return WorldChatVoiceCloneActionSchema.parse({ kind: "world-chat-voice-clone", ...common });
    case "voice-clip-review": return WorldChatVoiceClipReviewActionSchema.parse({ kind: "world-chat-voice-clip-review", ...common });
    case "world-archive": return WorldChatWorldArchiveActionSchema.parse({ kind: "world-chat-world-archive", ...common });
    case "world-export": return WorldChatWorldExportActionSchema.parse({ kind: "world-chat-world-export", ...common });
    case "production-create": return WorldChatProductionCreateActionSchema.parse({
      kind: "world-chat-production-create",
      worldId,
      action,
      plan: planProductionCreation(store.getBundle(), action.production, at),
    });
    case "production-metadata": return WorldChatProductionMetadataActionSchema.parse({ kind: "world-chat-production-metadata", ...common });
    case "production-model": return WorldChatProductionModelActionSchema.parse({ kind: "world-chat-production-model", ...common });
    case "production-series": return WorldChatProductionSeriesActionSchema.parse({ kind: "world-chat-production-series", ...common });
    case "production-overview": return WorldChatProductionOverviewActionSchema.parse({ kind: "world-chat-production-overview", ...common });
    case "production-season": return WorldChatProductionSeasonActionSchema.parse({ kind: "world-chat-production-season", ...common });
    case "production-episode": return WorldChatProductionEpisodeActionSchema.parse({ kind: "world-chat-production-episode", ...common });
    case "production-chapter": return WorldChatProductionChapterActionSchema.parse({ kind: "world-chat-production-chapter", ...common });
    case "production-scene": return WorldChatProductionSceneActionSchema.parse({ kind: "world-chat-production-scene", ...common });
    case "production-episode-order": return WorldChatProductionEpisodeOrderActionSchema.parse({ kind: "world-chat-production-episode-order", ...common });
    case "production-chapter-order": return WorldChatProductionChapterOrderActionSchema.parse({ kind: "world-chat-production-chapter-order", ...common });
    case "production-scene-order": return WorldChatProductionSceneOrderActionSchema.parse({ kind: "world-chat-production-scene-order", ...common });
    case "production-scene-delete": return WorldChatProductionSceneDeleteActionSchema.parse({ kind: "world-chat-production-scene-delete", ...common });
    case "production-scene-restore": return WorldChatProductionSceneRestoreActionSchema.parse({ kind: "world-chat-production-scene-restore", ...common });
    case "production-style": return WorldChatProductionStyleActionSchema.parse({ kind: "world-chat-production-style", ...common });
    case "production-scene-command": return WorldChatProductionSceneCommandActionSchema.parse({ kind: "world-chat-production-scene-command", ...common });
    case "production-board-compile": return WorldChatProductionBoardCompileActionSchema.parse({ kind: "world-chat-production-board-compile", ...common });
    case "production-board-export": return WorldChatProductionBoardExportActionSchema.parse({ kind: "world-chat-production-board-export", ...common });
    case "production-take-import": return WorldChatProductionTakeImportActionSchema.parse({ kind: "world-chat-production-take-import", ...common });
    case "production-take-generation": return WorldChatProductionTakeGenerationActionSchema.parse({ kind: "world-chat-production-take-generation", ...common });
    case "production-take-review": return WorldChatProductionTakeReviewActionSchema.parse({ kind: "world-chat-production-take-review", ...common });
    case "production-take-trim": return WorldChatProductionTakeTrimActionSchema.parse({ kind: "world-chat-production-take-trim", ...common });
    case "production-stage-playblast": return WorldChatProductionStagePlayblastActionSchema.parse({ kind: "world-chat-production-stage-playblast", ...common });
    case "audio-spine-command": return WorldChatAudioSpineActionSchema.parse({ kind: "world-chat-audio-spine-command", ...common });
  }
}

function scopedWorldAction(
  store: WorldStore,
  action: ModelWorldChatAction,
  productionId: string | undefined,
): ModelWorldChatAction {
  const declaredProductionId = actionProduction(action, undefined);
  if (productionId && declaredProductionId && declaredProductionId !== productionId) {
    throw new Error(action.kind === "production-style"
      ? "A Production Chat action cannot change another production's style."
      : "A Production Chat action cannot change another production.");
  }
  let sheetIds: Array<string | undefined> = [];
  if (action.kind === "sheet") {
    if (action.change.operation === "relationship") {
      sheetIds = [
        action.change.from.sheetId,
        ...(action.change.to.kind === "sheet" ? [action.change.to.sheetId] : []),
        ...action.change.proseEdits.map((edit) => edit.sheetId),
      ];
    } else if (action.change.operation !== "create") {
      sheetIds = [action.change.sheetId];
    }
  } else if (
    action.kind === "sheet-retire" || action.kind === "sheet-restore" ||
    action.kind === "reference-tile-lock" || action.kind === "reference-compile" ||
    action.kind === "reference-style" || action.kind === "voice-assignment" || action.kind === "voice-audition"
  ) {
    sheetIds = [action.sheetId];
  } else if (action.kind === "reference-import" || action.kind === "reference-result-use" || action.kind === "reference-change") {
    sheetIds = [action.change.sheetId];
  } else if (action.kind === "reference-generation") {
    sheetIds = [action.request.sheetId];
  } else if (action.kind === "reference-review") {
    sheetIds = [store.getBundle().referenceTakes.find((take) => take.id === action.takeId)?.reference?.sheetId];
  } else if (action.kind === "voice-clone") {
    sheetIds = [action.sheetId];
  }
  if (productionId) {
    for (const sheetId of sheetIds) {
      const sheet = sheetId ? store.getBundle().sheets.find((candidate) => candidate.id === sheetId) : undefined;
      if (sheet?.production !== undefined && sheet.production !== productionId) {
        throw new Error("A Production Chat action cannot change another production's cast or references.");
      }
    }
  }
  const artifactId = action.kind === "artifact-import"
    ? action.supersedes
    : action.kind === "artifact-metadata"
    ? action.change.artifactId
    : action.kind === "artifact-extraction" || action.kind === "artifact-extraction-stop" ||
        action.kind === "artifact-extraction-review" || action.kind === "artifact-reference"
      ? action.artifactId
      : undefined;
  if (productionId && artifactId) {
    const artifact = store.getBundle().artifacts.find((candidate) => candidate.id === artifactId);
    if (artifact?.production !== undefined && artifact.production !== productionId) {
      throw new Error("A Production Chat action cannot change another production's artifact.");
    }
  }
  if (productionId) {
    const stagedKey = (action.kind === "reference-image-import" || action.kind === "reference-image-discard") &&
      action.target.surface === "staged-reference"
      ? action.target.key
      : action.kind === "artifact-reference"
        ? action.key
        : undefined;
    if (stagedKey && store.getBundle().sheets.some((sheet) =>
      sheet.production !== undefined && sheet.production !== productionId && stagedKey.endsWith(`--${sheet.id}`))) {
      throw new Error("A Production Chat action cannot stage a reference for another production's cast.");
    }
  }
  if (action.kind === "sheet" && action.change.operation === "create") {
    if (productionId && action.change.productionId && action.change.productionId !== productionId) {
      throw new Error("A Production Chat action cannot create cast for another production.");
    }
    return productionId && action.change.productionId === undefined
      ? ModelWorldChatActionSchema.parse({ ...action, change: { ...action.change, productionId } })
      : action;
  }
  if (action.kind === "artifact-import" && productionId) {
    if (typeof action.productionId === "string" && action.productionId !== productionId) {
      throw new Error("A Production Chat action cannot file an artifact for another production.");
    }
    return action.productionId === undefined
      ? ModelWorldChatActionSchema.parse({ ...action, productionId })
      : action;
  }
  if (
    action.kind === "artifact-metadata" &&
    action.change.operation === "set-owner" &&
    productionId &&
    typeof action.change.productionId === "string" &&
    action.change.productionId !== productionId
  ) throw new Error("A Production Chat action cannot reassign an artifact to another production.");
  if (
    action.kind === "reference-change" &&
    action.change.operation === "attach-look" &&
    action.change.scope &&
    productionId &&
    action.change.scope.productionId !== productionId
  ) throw new Error("A Production Chat action cannot attach a look to another production.");
  if (action.kind === "production-style" && productionId && action.productionId !== productionId) {
    throw new Error("A Production Chat action cannot change another production's style.");
  }
  if (action.kind === "voice-clip-review" && productionId && action.productionId !== productionId) {
    throw new Error("A Production Chat action cannot review another production's voice clip.");
  }
  return action;
}

function actionProduction(action: ModelWorldChatAction, contextProductionId: string | undefined): string | undefined {
  if (action.kind === "production-create") return undefined;
  if (contextProductionId) return contextProductionId;
  if ("productionId" in action && typeof action.productionId === "string") return action.productionId;
  if (action.kind === "artifact-import" && typeof action.productionId === "string") return action.productionId;
  if (action.kind === "artifact-metadata" && action.change.operation === "set-owner") {
    return action.change.productionId ?? undefined;
  }
  if (action.kind === "sheet" && action.change.operation === "create") return action.change.productionId;
  if (action.kind === "reference-change" && action.change.operation === "attach-look") {
    return action.change.scope?.productionId;
  }
  return undefined;
}

function worldActionTargets(
  store: WorldStore,
  action: ModelWorldChatAction,
  fallbackId: string,
): ConversationActionTarget[] {
  switch (action.kind) {
    case "world-metadata": return [{ kind: "world", id: "metadata", label: "World metadata" }];
    case "canon-retire":
    case "canon-restore": return [{ kind: "canon", id: action.entryId, label: action.entryId }];
    case "canon": {
      const change = action.change;
      const id = "entryId" in change ? change.entryId : fallbackId;
      return [{ kind: "canon", id, label: "title" in change ? change.title : id }];
    }
    case "sheet-retire":
    case "sheet-restore": return [{ kind: action.sheetType, id: action.sheetId, label: action.sheetId }];
    case "sheet": {
      const change = action.change;
      if (change.operation === "relationship") {
        const targets = [
          { kind: change.from.sheetType, id: change.from.sheetId, label: change.from.sheetId },
          ...change.proseEdits.map((edit) => ({ kind: edit.sheetType, id: edit.sheetId, label: edit.sheetId })),
        ];
        return [...new Map(targets.map((target) => [`${target.kind}:${target.id}`, target])).values()];
      }
      const id = "sheetId" in change ? change.sheetId : fallbackId;
      return [{ kind: "sheetType" in change ? change.sheetType : "sheet", id, label: "name" in change ? change.name : id }];
    }
    case "art-direction":
    case "art-direction-restore": return [{ kind: "art-direction", id: "art-direction", label: "Art direction" }];
    case "artifact-import": return [
      { kind: "artifact-import", id: fallbackId, label: action.source === "folder" ? "Artifact folder" : "Artifact files" },
      ...(action.supersedes ? [{ kind: "artifact", id: action.supersedes, label: action.supersedes }] : []),
    ];
    case "artifact-metadata": return [{ kind: "artifact", id: action.change.artifactId, label: action.change.artifactId }];
    case "artifact-extraction":
    case "artifact-extraction-stop": return [{ kind: "artifact", id: action.artifactId, label: action.artifactId }];
    case "artifact-extraction-review": return [{ kind: "extraction-candidate", id: action.candidateHash, label: action.candidateHash }];
    case "artifact-reference": return [{ kind: "artifact", id: action.artifactId, label: action.artifactId }];
    case "reference-import": return [{ kind: "sheet", id: action.change.sheetId, label: action.change.sheetId }];
    case "reference-result-use": {
      const selection = "selection" in action.change
        ? action.change.selection
        : { source: "take" as const, takeId: action.change.takeId };
      const id = selection.source === "take" ? selection.takeId : `candidate:${selection.candidateIndex}`;
      return [
        { kind: "sheet", id: action.change.sheetId, label: action.change.sheetId },
        { kind: selection.source, id, label: id },
      ];
    }
    case "reference-review": return [{ kind: "take", id: action.takeId, label: action.takeId }];
    case "reference-change": {
      const change = action.change;
      return [{ kind: "sheet", id: change.sheetId, label: change.sheetId }];
    }
    case "reference-tile-lock": return [{ kind: "sheet", id: action.sheetId, label: action.sheetId }];
    case "reference-compile": return [{ kind: "sheet", id: action.sheetId, label: action.sheetId }];
    case "reference-style": return [{ kind: "sheet", id: action.sheetId, label: action.sheetId }];
    case "reference-generation": return [{ kind: "sheet", id: action.request.sheetId, label: action.request.sheetId }];
    case "reference-image-import": return [{
      kind: action.target.surface,
      id: action.target.surface === "staged-reference" ? action.target.key : fallbackId,
      label: action.target.surface === "staged-reference" ? action.target.key : action.target.surface,
    }];
    case "reference-world-image-result-use": return [{ kind: "world-image", id: `candidate:${action.candidateIndex}`, label: `Key art candidate ${action.candidateIndex}` }];
    case "reference-master-look-result-use": return [{ kind: "master-look", id: `candidate:${action.candidateIndex}`, label: `Master look candidate ${action.candidateIndex}` }];
    case "reference-image-discard": return [{
      kind: action.target.surface,
      id: action.target.surface === "staged-reference" ? action.target.key : fallbackId,
      label: action.target.surface === "staged-reference" ? action.target.key : action.target.surface,
    }];
    case "voice-assignment": return [{ kind: action.sheetType, id: action.sheetId, label: action.sheetId }];
    case "voice-audition": return [{ kind: "character", id: action.sheetId, label: action.sheetId }];
    case "voice-clone": return [{ kind: "voice", id: fallbackId, label: action.name }];
    case "voice-clip-review": return [
      { kind: "take", id: action.takeId, label: action.takeId },
      { kind: "production", id: action.productionId, label: action.productionId },
    ];
    case "world-archive":
    case "world-export": return [{ kind: "world", id: fallbackId, label: action.kind === "world-archive" ? "World archive" : "World export" }];
    case "production-create": return [{ kind: "production", id: fallbackId, label: action.production.title }];
    case "production-metadata": {
      const seriesIds = action.changes.seriesId === undefined
        ? []
        : [
            ...store.getBundle().series
              .filter((series) => series.seasons.includes(action.productionId))
              .map((series) => series.id),
            ...(action.changes.seriesId ? [action.changes.seriesId] : []),
          ];
      return [
        { kind: "production", id: action.productionId, label: action.productionId },
        ...[...new Set(seriesIds)].map((id) => ({ kind: "series", id, label: id })),
      ];
    }
    case "production-model": return [{ kind: "production", id: action.productionId, label: `${action.capability} model` }];
    case "production-series": return [{
      kind: "series",
      id: action.change.operation === "edit" ? action.change.seriesId : fallbackId,
      label: action.change.operation === "edit" ? action.change.seriesId : action.change.title,
    }];
    case "production-overview": return [{ kind: "story", id: action.productionId, label: "Story overview" }];
    case "production-season": return [{ kind: "season", id: action.productionId, label: "Season" }];
    case "production-episode": return [{
      kind: "episode",
      id: action.change.operation === "edit" ? action.change.episodeId : fallbackId,
      label: action.change.operation === "edit" ? action.change.episodeId : action.change.title,
    }];
    case "production-chapter": return [{
      kind: "chapter",
      id: action.change.operation === "edit" ? action.change.chapterId : fallbackId,
      label: action.change.operation === "edit" ? action.change.chapterId : action.change.title,
    }];
    case "production-scene": return [
      {
        kind: "scene",
        id: action.change.operation === "create" ? fallbackId : action.change.sceneId,
        label: action.change.operation === "create" ? action.change.title : action.change.sceneId,
      },
      ...(action.change.operation === "create" && action.change.episodeId
        ? [{ kind: "episode", id: action.change.episodeId, label: action.change.episodeId }]
        : []),
    ];
    case "production-episode-order": return action.orderedIds.map((id) => ({ kind: "episode", id, label: id }));
    case "production-chapter-order": return action.orderedIds.map((id) => ({ kind: "chapter", id, label: id }));
    case "production-scene-order": return action.orderedIds.map((id) => ({ kind: "scene", id, label: id }));
    case "production-scene-delete":
    case "production-scene-restore": return [{ kind: "scene", id: action.sceneId, label: action.sceneId }];
    case "production-style": return [{ kind: "production", id: action.productionId, label: action.productionId }];
    case "production-scene-command": return [{ kind: "scene", id: action.sceneId, label: action.sceneId }];
    case "production-board-compile":
    case "production-board-export": return [{ kind: "scene", id: action.sceneId, label: action.sceneId }];
    case "production-take-import": return [{ kind: "shot", id: action.shotId, label: action.shotId }];
    case "production-take-generation": return action.target.kind === "shot"
      ? [{ kind: "shot", id: action.target.shotId, label: action.target.shotId }]
      : action.target.memberShotIds.map((shotId) => ({ kind: "shot", id: shotId, label: shotId }));
    case "production-take-review": return [
      { kind: "take", id: action.takeId, label: action.takeId },
      ...(action.review.shotId ? [{ kind: "shot", id: action.review.shotId, label: action.review.shotId }] : []),
    ];
    case "production-take-trim": return [
      { kind: "take", id: action.takeId, label: action.takeId },
      { kind: "shot", id: action.shotId, label: action.shotId },
    ];
    case "production-stage-playblast": return [{ kind: "shot", id: action.shotId, label: action.shotId }];
    case "audio-spine-command": return [{ kind: "audio-spine", id: action.productionId, label: "Audio spine" }];
  }
}

/** Build strict, digest-bound intents. This is pure and runs before `turn.completed` is appended. */
export function prepareWorldChatActions(
  store: WorldStore,
  lifecycle: ConversationActionLifecycle,
  turn: WorldChatActionTurn,
): PreparedWorldChatAction[] {
  const prepared: PreparedWorldChatAction[] = [];
  const candidateById = new Map(turn.existingCandidates.map((candidate) => [candidate.id, candidate]));
  for (const candidate of turn.candidates) candidateById.set(candidate.id, candidate);
  const groupById = new Map(turn.existingGroups.map((group) => [group.id, group]));
  for (const group of turn.groups) groupById.set(group.id, group);

  const ready = new Set(
    evaluateReadiness([...candidateById.values()], store.getBundle()).carried.map((candidate) => candidate.id),
  );
  const changed = new Set(turn.candidates.map((candidate) => candidate.id));
  const claimed = new Set<string>();
  for (const candidate of turn.candidates) {
    if (!changed.has(candidate.id) || !ready.has(candidate.id) || candidate.status !== "live") continue;
    const group = candidate.groupId ? groupById.get(candidate.groupId) : undefined;
    const members = group?.status === "live"
      ? group.members.map((member) => candidateById.get(member.candidateId)).filter((one): one is WorldChangeCandidate => one !== undefined)
      : [candidate];
    if (members.length === 0 || members.some((member) => !ready.has(member.id))) continue;
    const key = group ? `group:${group.id}` : `candidate:${candidate.id}`;
    if (claimed.has(key)) continue;
    claimed.add(key);
    const payload = {
      kind: "world-chat-proposal" as const,
      worldId: store.worldId,
      candidate: { candidateId: candidate.id, revision: candidate.revision },
      members: members.map((member) => ({ candidateId: member.id, revision: member.revision })),
    };
    prepared.push({
      payload,
      intent: lifecycle.createIntent({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        worldId: store.worldId,
        actionKind: payload.kind,
        targets: members.map((member) => ({ kind: "world-change", id: member.id, label: member.title })),
        payload,
        baseObservations: [...new Map(
          members.flatMap((member) => (member.checks.targetReads ?? []).map((read) => [
            read.checkId,
            {
              requirement: read.target.requirement,
              target: read.target.id,
              revisionOrDigest: read.observedRevisionOrDigest,
              complete: true as const,
              receiptId: read.checkId,
            },
          ] as const)),
        ).values()],
        createdAt: turn.at,
      }),
    });
  }

  const contextProductionId = productionOfContext(turn.entryContext) ?? undefined;
  const plannedProductionIds = new Set<string>();
  const plannedSeriesIds = new Set<string>();
  for (const [index, rawAction] of turn.actions.entries()) {
    const action = scopedWorldAction(store, rawAction, contextProductionId);
    const productionId = actionProduction(action, contextProductionId);
    const payload = preparedWorldPayload(store, action, productionId, turn.at);
    if (payload.kind === "world-chat-production-create") {
      if (plannedProductionIds.has(payload.plan.production.id)) {
        throw new Error("Two production creations in one turn cannot claim the same fixed identity.");
      }
      plannedProductionIds.add(payload.plan.production.id);
      if (payload.plan.series.operation === "create") {
        if (plannedSeriesIds.has(payload.plan.series.record.id)) {
          throw new Error("Two production creations in one turn cannot create the same fixed Series identity.");
        }
        plannedSeriesIds.add(payload.plan.series.record.id);
      }
    }
    prepared.push({
      payload,
      intent: lifecycle.createIntent({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        worldId: store.worldId,
        ...(productionId !== undefined ? { productionId } : {}),
        actionKind: payload.kind,
        targets: [
          ...worldActionTargets(
            store,
            action,
            payload.kind === "world-chat-production-create" ? payload.plan.production.id : `${turn.turnId}:${index + 1}`,
          ),
          ...(payload.kind === "world-chat-production-create" && payload.plan.series.operation !== "none"
            ? [{ kind: "series", id: payload.plan.series.record.id, label: payload.plan.series.record.title }]
            : []),
        ],
        payload,
        baseObservations: worldActionObservations(store, turn.receipts ?? [], action),
        createdAt: turn.at,
      }),
    });
  }

  if (turn.bibleEdits.length > 0) {
    const replacesWholeBible = turn.bibleEdits.some((edit) => edit.op === "replace-document");
    const read = completeObservation(turn.receipts ?? [], "bible", "bible", bibleFence(store.getBundle()));
    if (turn.receipts !== undefined && replacesWholeBible && read === null) {
      throw new Error("A whole Bible replacement requires a complete current Bible read.");
    }
    const payload = {
      kind: "world-chat-bible-edit" as const,
      worldId: store.worldId,
      baseVersion: turn.bibleBaseVersion,
      edits: [...turn.bibleEdits],
    };
    prepared.push({
      payload,
      intent: lifecycle.createIntent({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        worldId: store.worldId,
        actionKind: payload.kind,
        targets: [{ kind: "bible", id: "bible", label: "Bible" }],
        payload,
        baseObservations: read
          ? [read]
          : [{ requirement: "bible", target: "bible", revisionOrDigest: `v${turn.bibleBaseVersion}`, complete: true }],
        createdAt: turn.at,
      }),
    });
  }

  const scene = sceneOfContext(turn.entryContext);
  if (scene && turn.sceneBaseVersion !== null) {
    for (const edit of turn.sceneEdits) {
      const payload = {
        kind: "world-chat-scene-edit" as const,
        worldId: store.worldId,
        productionId: scene.productionId,
        sceneId: scene.sceneId,
        baseVersion: turn.sceneBaseVersion,
        edit,
      };
      prepared.push({
        payload,
        intent: lifecycle.createIntent({
          conversationId: turn.conversationId,
          turnId: turn.turnId,
          worldId: store.worldId,
          productionId: scene.productionId,
          actionKind: payload.kind,
          targets: [{ kind: "scene", id: scene.sceneId, label: "Scene" }],
          payload,
          baseObservations: [{ requirement: "scenes", target: scene.sceneId, revisionOrDigest: `v${turn.sceneBaseVersion}`, complete: true }],
          createdAt: turn.at,
        }),
      });
    }
  }

  const productionId = productionOfContext(turn.entryContext);
  if (productionId) {
    const production = store.getBundle().productions.find((one) => one.meta.id === productionId);
    const read = completeObservation(turn.receipts ?? [], "timeline", productionId, timelineFence(production, store.getBundle().artifacts));
    if (turn.receipts !== undefined && turn.editorRequests.length > 0 && read === null) {
      throw new Error("A timeline request requires a complete current timeline read.");
    }
    for (const request of turn.editorRequests) {
      const payload = {
        kind: "world-chat-editor-request" as const,
        worldId: store.worldId,
        productionId,
        request,
      };
      prepared.push({
        payload,
        intent: lifecycle.createIntent({
          conversationId: turn.conversationId,
          turnId: turn.turnId,
          worldId: store.worldId,
          productionId,
          actionKind: payload.kind,
          targets: [{ kind: "timeline", id: productionId, label: "Timeline" }],
          payload,
          baseObservations: read
            ? [read]
            : [{ requirement: "timeline", target: productionId, revisionOrDigest: timelineFence(production, store.getBundle().artifacts), complete: true }],
          createdAt: turn.at,
        }),
      });
    }
  }
  return prepared;
}

const clipped = (value: string | null, max = 20_000): string | null =>
  value === null || value.length <= max ? value : `${value.slice(0, max - 1)}…`;

async function proposalProjection(
  gate: ProposalManager,
  intent: Pick<ConversationActionPrepareIntent, "targets">,
  proposalId: string,
): Promise<PreparedConversationActionAuthority> {
  const { proposal, review, ripple } = await gate.project(proposalId);
  const fields = review.targets.flatMap((target) =>
    target.fields.map((field) => ({
      label: `${target.label}: ${field.field}`.slice(0, 200),
      before: clipped(field.before),
      after: clipped(field.proposed),
    })),
  );
  return {
    authority: { kind: "proposal-manager", id: proposal.id },
    authorityRevision: proposal.draftRevision,
    shown: {
      title: proposal.summary.slice(0, 200),
      consequence: proposal.targets.length === 1
        ? "Writes one reviewed world record."
        : `Writes ${proposal.targets.length} reviewed world records atomically.`,
      affectedTargets: [...intent.targets],
      ripples: (ripple?.items ?? []).map((item) => item.summary.slice(0, 2_000)),
      permissionReason: "authored-change",
      body: {
        family: "authored-diff",
        fields: fields.length > 0 ? fields : [{ label: "Change", before: null, after: proposal.summary.slice(0, 20_000) }],
        conflicts: (proposal.conflicts ?? []).map((conflict) => `${conflict.field} has conflicting edits.`),
        openChoices: (proposal.openChoices ?? []).map((choice) => choice.question),
      },
    },
  };
}

const preparationPath = (store: WorldStore, authority: "bible" | "scene" | "world", actionId: string): string =>
  join(store.dir, ".history", authority, "prepared", `${actionId}.json`);

async function writePreparation(store: WorldStore, authority: "bible" | "scene" | "world", actionId: string, payload: WorldChatPreparedAction): Promise<void> {
  await atomicWriteFile(preparationPath(store, authority, actionId), `${JSON.stringify(payload, null, 2)}\n`);
}

async function readPreparation(store: WorldStore, authority: "bible" | "scene" | "world", intent: ConversationActionPrepareIntent): Promise<WorldChatPreparedAction | null> {
  const raw = await readFile(preparationPath(store, authority, intent.actionId), "utf8").catch(() => null);
  if (raw === null) return null;
  const parsed = authority === "bible"
    ? WorldChatBibleActionSchema.safeParse(JSON.parse(raw))
    : authority === "scene"
      ? WorldChatSceneActionSchema.safeParse(JSON.parse(raw))
      : WorldChatPreparedActionSchema.safeParse(JSON.parse(raw));
  return parsed.success && conversationActionDigest(parsed.data) === intent.payloadDigest ? parsed.data : null;
}

async function removePreparation(store: WorldStore, authority: "bible" | "scene" | "world", actionId: string): Promise<void> {
  await rm(preparationPath(store, authority, actionId), { force: true });
}

async function committedAction(store: WorldStore, actionId: string): Promise<{ commitId: string; toVersion?: number } | null> {
  const record = (await readChanges(join(store.dir, "changes.jsonl"))).find(
    (line) => {
      const value = line as Record<string, unknown>;
      return value["requestId"] === actionId ||
        (typeof value["source"] === "string" && value["source"].endsWith(`:${actionId}`));
    },
  ) as (Record<string, unknown> & { toVersion?: number }) | undefined;
  return record && typeof record["commitId"] === "string"
    ? { commitId: record["commitId"], ...(record.toVersion !== undefined ? { toVersion: record.toVersion } : {}) }
    : null;
}

async function settledProposal(store: WorldStore, proposalId: string): Promise<{ id: string; summary: string } | null> {
  const record = (await readChanges(join(store.dir, "changes.jsonl"))).find(
    (line) => (line as Record<string, unknown>)["proposalId"] === proposalId,
  ) as Record<string, unknown> | undefined;
  if (!record) return null;
  return typeof record["commitId"] === "string"
    ? { id: record["commitId"], summary: "The proposal was accepted." }
    : record["settled"] === "already-live"
      ? { id: proposalId, summary: "The world already contained this proposal." }
      : null;
}

async function recordBoundProposalResolution(
  store: WorldStore,
  action: ConversationActionCard,
  outcome: "accepted" | "discarded",
  now: () => string,
): Promise<void> {
  const log = new WorldChatStore(conversationDir(store.dir, action.conversationId));
  if (!(await log.readMeta())) return;
  await log.append(
    {
      type: "proposal.resolved",
      proposalId: action.authority.id as ProposalId,
      outcome,
      candidateIds: action.targets.map((target) => target.id as CandidateId),
    },
    { at: now(), requestId: `conversation-action-proposal:${action.actionId}:${outcome}` },
  ).catch(() => {
    /* the proposal authority has already settled; conversation bookkeeping is best-effort */
  });
}

async function settleSaveAttempt(
  store: WorldStore,
  intent: ConversationActionPrepareIntent,
  proposalIds: readonly string[],
  now: () => string,
): Promise<void> {
  const log = new WorldChatStore(conversationDir(store.dir, intent.conversationId));
  if (!(await log.readMeta())) return;
  let open = false;
  for (const envelope of (await log.read()).events) {
    if (envelope.event.type === "save.intent-recorded" && envelope.event.requestId === intent.actionId) {
      open = true;
    }
    if (envelope.event.type === "save.settled" && envelope.event.requestId === intent.actionId) {
      open = false;
    }
  }
  if (!open) return;
  await log.append(
    { type: "save.settled", requestId: intent.actionId, proposalIds: [...proposalIds] as ProposalId[] },
    { at: now(), requestId: `conversation-action-save:${intent.actionId}` },
  );
}

async function conversationCandidates(store: WorldStore, action: ConversationActionCard): Promise<WorldChangeCandidate[]> {
  const log = new WorldChatStore(conversationDir(store.dir, action.conversationId));
  const meta = await log.readMeta();
  if (!meta) return [];
  return foldConversation(meta.id, meta.createdAt, (await log.read()).events).view.candidates.filter((candidate) =>
    action.targets.some((target) => target.id === candidate.id),
  );
}

async function editorRequestForAction(store: WorldStore, actionId: string) {
  return (await Promise.all(
    store.getBundle().productions.map(async (production) =>
      readEditorRequestByAction(store, production.meta.id, actionId).catch(() => null)),
  )).find((request) => request?.actionId === actionId) ?? null;
}

function observationsCurrent(
  store: WorldStore,
  action: Pick<ConversationActionPrepareIntent, "baseObservations">,
): { ok: true } | { ok: false; reason: "stale"; detail: string } {
  for (const observation of action.baseObservations) {
    const current = currentWorldObservation(store, observation.requirement, observation.target);
    if (!current) return { ok: false, reason: "stale", detail: `The ${observation.requirement} read can no longer be verified.` };
    if (
      !observation.complete ||
      current.target !== observation.target ||
      current.fence !== observation.revisionOrDigest
    ) return { ok: false, reason: "stale", detail: `The ${observation.requirement} changed after this action was prepared.` };
  }
  return { ok: true };
}

function observationPrecondition(
  store: WorldStore,
  action: Pick<ConversationActionPrepareIntent, "baseObservations">,
): WorldStatePrecondition {
  return () => {
    const current = observationsCurrent(store, action);
    return current.ok ? null : current.detail;
  };
}

function shownValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  labels: Record<string, string> = {},
) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => ({ label: labels[key] ?? key, before: clipped(shownValue(before[key])), after: clipped(shownValue(after[key])) }));
}

function requireExactOrder(current: readonly string[], proposed: readonly string[], label: string): void {
  if (
    proposed.length !== current.length ||
    new Set(proposed).size !== proposed.length ||
    proposed.some((id) => !current.includes(id))
  ) {
    throw new Error(`${label} order must contain every current id exactly once.`);
  }
  if (proposed.every((id, index) => id === current[index])) {
    throw new Error(`The ${label.toLowerCase()} are already in that order.`);
  }
}

function canonView(raw: string): { label: string; fields: Record<string, unknown> } {
  const doc = MarkdownFile.parse(raw);
  const entry = CanonEntrySchema.parse({ ...doc.data, body: doc.body.trim() });
  return {
    label: `${entry.id}: ${entry.title}`,
    fields: {
      type: entry.type,
      title: entry.title,
      status: entry.status,
      links: entry.links,
      retired: entry.retired ?? false,
      statement: entry.body,
    },
  };
}

function sheetView(raw: string): { label: string; fields: Record<string, unknown> } {
  const doc = MarkdownFile.parse(raw);
  const sheet = SheetSchema.parse({ ...doc.data, sections: doc.sections() });
  return {
    label: sheet.name,
    fields: {
      name: sheet.name,
      status: sheet.status,
      role: sheet.role,
      billing: sheet.billing,
      region: sheet.region,
      canonRules: sheet.canonRules,
      links: sheet.links,
      owner: sheet.production ?? "world",
      origin: sheet.origin,
      voice: sheet.voice,
      retired: sheet.retired ?? false,
      sections: sheet.sections,
    },
  };
}

function artDirectionFields(direction: {
  description: string;
  masterLook?: string;
  audio: unknown;
  failureModes: readonly string[];
  keyArtIntent?: unknown;
}): Record<string, unknown> {
  return {
    description: direction.description,
    masterLook: direction.masterLook,
    audio: direction.audio,
    failureModes: direction.failureModes,
    keyArtIntent: direction.keyArtIntent,
  };
}

function artDirectionView(raw: string): { label: string; fields: Record<string, unknown> } {
  const direction = ArtDirectionRecordSchema.parse(JSON.parse(raw));
  return { label: `Art direction v${direction.version}`, fields: artDirectionFields(direction) };
}

async function historyContent(store: WorldStore, path: string): Promise<string> {
  const raw = await readFile(join(store.dir, ...path.split("/")), "utf8").catch(() => null);
  if (raw === null) throw new Error(`No history snapshot exists at ${path}.`);
  return raw;
}

async function metadataProjection(
  store: WorldStore,
  intent: ConversationActionPrepareIntent,
  payload: WorldChatWorldMetadataAction,
): Promise<PreparedConversationActionAuthority> {
  const before = store.getBundle().meta;
  const next: Record<string, unknown> = { ...before };
  for (const [key, value] of Object.entries(payload.action.changes)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  const after = WorldMetaSchema.parse(next);
  const fields = diffFields(before, after, { name: "Name", logline: "Logline", tone: "Tone", genre: "Genre" });
  if (fields.length === 0) throw new Error("The world metadata already has those values.");
  const ripples = store.getBundle().artDirection.derived && deriveArtDirectionDescription(before) !== deriveArtDirectionDescription(after)
    ? [`The metadata-derived art direction changes to: ${deriveArtDirectionDescription(after)}`]
    : [];
  await writePreparation(store, "world", intent.actionId, payload);
  return {
    authority: { kind: "world-store", id: intent.actionId },
    authorityRevision: 0,
    shown: {
      title: fields.length === 1 ? `Change world ${fields[0]!.label.toLowerCase()}` : "Change world metadata",
      consequence: "Updates the world's authored metadata without changing its identity or folder.",
      affectedTargets: [...intent.targets],
      ripples,
      permissionReason: "authored-change",
      body: {
        family: "authored-diff",
        fields,
        conflicts: [],
        openChoices: [],
      },
    },
  };
}

async function retirementProjection(
  store: WorldStore,
  intent: ConversationActionPrepareIntent,
  payload: WorldChatCanonRetireAction | WorldChatSheetRetireAction,
): Promise<PreparedConversationActionAuthority> {
  const bundle = store.getBundle();
  const canon = payload.kind === "world-chat-canon-retire";
  const entity = canon
    ? bundle.canon.find((entry) => entry.id === payload.action.entryId)
    : bundle.sheets.find((sheet) => sheet.id === payload.action.sheetId && sheet.type === payload.action.sheetType);
  if (!entity) throw new Error("The entity to retire is not in this world.");
  const id = entity.id;
  const version = "version" in entity
    ? entity.version
    : Math.max(entity.introducedAt, entity.settledAt ?? 0, entity.amendedAt ?? 0);
  const alreadyRetired = entity.retired === true;
  const dependents = canon
    ? [
        ...bundle.canon.filter((entry) => entry.id !== id && entry.links.includes(id)).map((entry) => entry.id),
        ...bundle.sheets.filter((sheet) => sheet.canonRules.includes(id)).map((sheet) => sheet.id),
      ]
    : [
        ...bundle.canon.filter((entry) => entry.links.includes(id)).map((entry) => entry.id),
        ...bundle.sheets.filter((sheet) => sheet.id !== id && sheet.links.includes(id)).map((sheet) => sheet.id),
      ];
  const blockers = alreadyRetired ? [`${id} is already retired.`] : [];
  await writePreparation(store, "world", intent.actionId, payload);
  return {
    authority: { kind: "world-store", id: intent.actionId },
    authorityRevision: version,
    ...(blockers.length > 0 ? { approvalBlockedReason: blockers[0] } : {}),
    shown: {
      title: `Retire ${"title" in entity ? entity.title : entity.name}`,
      consequence: "Removes this entity from active authoring and retrieval without deleting its file, identity, citations, or history.",
      affectedTargets: [...intent.targets],
      ripples: dependents.length > 0 ? [`${dependents.length} linked record${dependents.length === 1 ? " keeps" : "s keep"} resolving this retired identity.`] : [],
      permissionReason: "destructive-change",
      body: {
        family: "destructive",
        removed: [`${id} from active pickers, retrieval, and future suggestions`],
        retained: ["The entity file and stable identity", "All version history", "Existing citations and links"],
        dependentChanges: dependents.length > 0 ? [`Linked records remain unchanged: ${dependents.join(", ")}`] : ["No linked records change"],
        blockers,
        undoAvailable: true,
      },
    },
  };
}

async function restoreProjection(
  store: WorldStore,
  intent: ConversationActionPrepareIntent,
  payload: WorldChatCanonRestoreAction | WorldChatSheetRestoreAction | WorldChatArtDirectionRestoreAction,
): Promise<PreparedConversationActionAuthority> {
  let label: string;
  let version: number;
  let ripples: string[];
  let before: Record<string, unknown>;
  let after: Record<string, unknown>;
  if (payload.kind === "world-chat-canon-restore") {
    const live = await readFile(join(store.dir, "canon", `${payload.action.entryId}.md`), "utf8");
    const snapshot = await historyContent(store, `.history/canon/${payload.action.entryId}/v${payload.action.version}.md`);
    const current = canonView(live);
    label = current.label;
    version = store.getBundle().meta.canonRevision;
    ripples = ["Canon advances to a new revision; linked records and future dispatches see the restored content."];
    before = current.fields;
    after = canonView(snapshot).fields;
  } else if (payload.kind === "world-chat-sheet-restore") {
    const path = `${sheetDir(payload.action.sheetType)}/${payload.action.sheetId}.md`;
    const live = await readFile(join(store.dir, ...path.split("/")), "utf8");
    const snapshot = await historyContent(store, `.history/${sheetDir(payload.action.sheetType)}/${payload.action.sheetId}/v${payload.action.version}.md`);
    const current = sheetView(live);
    label = current.label;
    version = store.getBundle().sheets.find((sheet) => sheet.id === payload.action.sheetId)!.version;
    ripples = ["Future uses see the restored sheet as a new version; accepted takes stay pinned to their recorded versions."];
    before = current.fields;
    after = sheetView(snapshot).fields;
  } else {
    const current = store.getBundle().artDirection;
    const historical = current.history.find((entry) => entry.version === payload.action.version);
    const snapshot = historical
      ? { label: `Art direction v${historical.version}`, fields: artDirectionFields(historical) }
      : artDirectionView(await historyContent(store, `.history/art-direction/v${payload.action.version}.json`));
    label = `Art direction v${current.version}`;
    version = current.version;
    ripples = ["Reference kits and future generations pick up the restored look; accepted assets remain pinned to their recorded versions."];
    before = artDirectionFields(current);
    after = snapshot.fields;
  }
  const fields = diffFields(before, after);
  await writePreparation(store, "world", intent.actionId, payload);
  return {
    authority: { kind: "world-store", id: intent.actionId },
    authorityRevision: version,
    shown: {
      title: `Restore ${label} from v${payload.action.version}`,
      consequence: "Restores the selected snapshot as a new version and retains every later version in history.",
      affectedTargets: [...intent.targets],
      ripples,
      permissionReason: "authored-change",
      body: {
        family: "authored-diff",
        fields: fields.length > 0 ? fields : [{ label: "Content", before: "Current", after: "Same in selected version" }],
        conflicts: [],
        openChoices: [],
      },
    },
  };
}

function semanticVoice(voice: { provider: string; model?: string; voiceId: string; label?: string }): string {
  return voice.label ?? `${voice.provider} · ${voice.model ?? "default"} · ${voice.voiceId}`;
}

function generationPrompt(payload: Extract<WorldChatPreparedAction, { kind: "world-chat-reference-generation" }>): string {
  const request = payload.action.request;
  if ("prompt" in request && request.prompt) return request.prompt;
  if (request.operation === "character-sheet" && request.styleOverride) return request.styleOverride;
  if (request.operation === "location-view") return `${request.name} for ${request.sheetId}`;
  return `${request.operation.replaceAll("-", " ")} for ${request.sheetId}`;
}

async function sharedResourceProjection(
  store: WorldStore,
  intent: ConversationActionPrepareIntent,
  payload: WorldChatPreparedAction,
  deps: WorldChatActionAdapterDeps,
): Promise<PreparedConversationActionAuthority> {
  let authority: PreparedConversationActionAuthority["authority"];
  let authorityRevision = 0;
  let approvalBlockedReason: string | undefined;
  let shown: PreparedConversationActionAuthority["shown"];
  const bundle = store.getBundle();

  switch (payload.kind) {
    case "world-chat-artifact-import": {
      const folder = payload.action.source === "folder";
      if (folder && (payload.action.supersedes !== undefined || payload.action.allowLarge !== undefined)) {
        throw new Error("Replacement and large-file consent apply to a single selected artifact, not a folder import.");
      }
      if (payload.action.supersedes && !bundle.artifacts.some((artifact) => artifact.id === payload.action.supersedes)) {
        throw new Error("The artifact being replaced is no longer in this world.");
      }
      authority = { kind: "artifact-store", id: intent.actionId };
      if ((folder && !deps.pickFolder) || (!folder && !deps.pickFiles)) {
        approvalBlockedReason = "This import needs the desktop host's file picker.";
      }
      shown = {
        title: folder ? "Import an artifact folder" : "Import artifact files",
        consequence: payload.action.supersedes
          ? "Opens a host-owned picker after approval and files one immutable replacement linked to the artifact it supersedes."
          : "Opens a host-owned picker after approval and copies only the files selected there into this world.",
        affectedTargets: [...intent.targets],
        ripples: [
          ...(payload.action.productionId ? [`The imported artifacts belong to ${payload.action.productionId}.`] : []),
          ...(payload.action.allowLarge ? ["This approval includes the existing large-file storage consent."] : []),
        ],
        permissionReason: "host-file-access",
        body: {
          family: "host-action",
          action: folder ? "Choose one folder on this device" : "Choose files on this device",
          effect: "The model, card, and conversation receive artifact IDs only; host paths and file bytes remain inside the coordinator.",
        },
      };
      break;
    }
    case "world-chat-artifact-metadata": {
      const artifact = bundle.artifacts.find((candidate) => candidate.id === payload.action.change.artifactId);
      if (!artifact) throw new Error("That artifact is no longer in this world.");
      authority = { kind: "artifact-store", id: intent.actionId };
      const change = payload.action.change;
      const fields = change.operation === "add-links"
        ? [{ label: "Links", before: JSON.stringify(artifact.links), after: JSON.stringify([...new Set([...artifact.links, ...change.links])]) }]
        : [{ label: "Owner", before: artifact.production ?? "World", after: change.productionId ?? "World" }];
      shown = {
        title: change.operation === "add-links" ? "Link the artifact" : "Change artifact ownership",
        consequence: "Updates the artifact sidecar while keeping its immutable media and provenance unchanged.",
        affectedTargets: [...intent.targets],
        ripples: change.operation === "set-owner" ? ["Ownership changes where the artifact appears and what extraction may author."] : [],
        permissionReason: "authored-change",
        body: { family: "authored-diff", fields, conflicts: [], openChoices: [] },
      };
      break;
    }
    case "world-chat-artifact-extraction":
      authority = { kind: "extraction", id: intent.actionId };
      if (!bundle.artifacts.some((artifact) => artifact.id === payload.action.artifactId)) {
        throw new Error("That artifact is no longer in this world.");
      }
      if (!deps.extractArtifact) approvalBlockedReason = "Artifact extraction is unavailable in this authoring session.";
      shown = {
        title: "Extract grounded facts from the artifact",
        consequence: "Reads the filed document and offers only mechanically verified, quoted candidates for separate review.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "external-network-action",
        body: {
          family: "command",
          commands: [{ label: "Read and verify the filed artifact" }],
          expectedResult: "A pending extraction batch; no Canon or sheet change lands in this step.",
          undoAvailable: false,
        },
      };
      break;
    case "world-chat-artifact-extraction-stop":
      authority = { kind: "extraction", id: intent.actionId };
      if (!deps.stopExtraction) approvalBlockedReason = "No active extraction controller is available.";
      shown = {
        title: "Stop artifact extraction",
        consequence: "Stops the in-flight reading and leaves the filed artifact unchanged.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "external-network-action",
        body: {
          family: "command",
          commands: [{ label: "Stop reading" }],
          expectedResult: "The extraction stops without deleting the artifact.",
          undoAvailable: false,
        },
      };
      break;
    case "world-chat-artifact-extraction-review": {
      authority = { kind: "extraction", id: intent.actionId };
      const artifact = bundle.artifacts.find((candidate) => candidate.id === payload.action.artifactId);
      const candidate = artifact?.extraction?.pending.find((entry) => entry.hash === payload.action.candidateHash);
      if (!artifact || !candidate) throw new Error("That extraction candidate is no longer pending.");
      shown = {
        title: `${payload.action.decision === "accept" ? "Accept" : "Reject"} extracted ${candidate.kind}`,
        consequence: payload.action.decision === "accept"
          ? "Applies this one grounded candidate through the existing Canon or sheet proposal authority."
          : "Records this candidate as decided and writes no authored record.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "authored-change",
        body: {
          family: "take-review",
          mediaKind: "document",
          mediaId: candidate.hash,
          destination: candidate.kind === "canon" ? "World Canon" : `${artifact.production ?? "World"} ${candidate.kind} sheets`,
          currentSelection: null,
          reason: candidate.name,
        },
      };
      break;
    }
    case "world-chat-artifact-reference": {
      authority = { kind: "world-store", id: intent.actionId };
      const artifact = bundle.artifacts.find((candidate) => candidate.id === payload.action.artifactId);
      if (!artifact || (artifact.kind !== "image" && artifact.kind !== "board")) {
        throw new Error("That artifact cannot be used as an image reference.");
      }
      shown = {
        title: "Stage the artifact as a reference",
        consequence: "Points the named generation slot at the existing artifact without copying or changing it.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "authored-change",
        body: {
          family: "command",
          commands: [{ label: `Stage ${artifact.id} for ${payload.action.key}` }],
          expectedResult: "The reference slot resolves to this artifact until it is cleared or replaced.",
          undoAvailable: true,
        },
      };
      break;
    }
    case "world-chat-reference-import":
      authority = { kind: "host", id: intent.actionId };
      if (!deps.importReference) approvalBlockedReason = "This reference import needs the desktop host's image picker.";
      shown = {
        title: `Import ${payload.action.change.operation.replaceAll("-", " ")}`,
        consequence: "Opens a host-owned image picker after approval; no host path or image bytes enter the conversation.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "host-file-access",
        body: {
          family: "host-action",
          action: "Choose one image on this device",
          effect: payload.action.change.operation.endsWith("candidate")
            ? "The image lands as an unreviewed take; using it remains a separate action."
            : "The chosen image is imported through the existing reference authority.",
        },
      };
      break;
    case "world-chat-reference-result-use": {
      authority = { kind: "reference-kit", id: intent.actionId };
      const selection = "selection" in payload.action.change
        ? payload.action.change.selection
        : { source: "take" as const, takeId: payload.action.change.takeId };
      const take = selection.source === "take"
        ? bundle.referenceTakes.find((candidate) => candidate.id === selection.takeId)
        : undefined;
      const candidate = selection.source === "candidate"
        ? bundle.referenceCandidates[payload.action.change.sheetId]?.[selection.candidateIndex - 1]
        : undefined;
      if (!take && !candidate) throw new Error("That reference result is no longer available.");
      if (selection.source === "candidate" && !deps.useReferenceCandidate) {
        approvalBlockedReason = "Raw reference candidate recovery is unavailable.";
      }
      const kit = bundle.referenceKits.find((candidate) => candidate.sheetId === payload.action.change.sheetId);
      const currentSelection = kit?.mainPhoto?.sourceTakeId ??
        kit?.compilations.find((compilation) => compilation.file === kit.designatedCompilation && compilation.accepted)?.source ??
        null;
      shown = {
        title: payload.action.change.operation.replaceAll("-", " "),
        consequence: "Uses one already-generated or imported result through the reference kit's existing review and history authority.",
        affectedTargets: [...intent.targets],
        ripples: ["Generation approval never selects this result; this card is the separate artistic decision."],
        permissionReason: "authored-change",
        body: {
          family: "take-review",
          mediaKind: "image",
          mediaId: take?.id ?? `reference-candidate:${payload.action.change.sheetId}:${selection.source === "candidate" ? selection.candidateIndex : 0}`,
          destination: `${payload.action.change.sheetId} reference kit`,
          currentSelection: currentSelection === null ? null : String(currentSelection),
        },
      };
      break;
    }
    case "world-chat-reference-review": {
      authority = { kind: "take-review", id: intent.actionId };
      const take = bundle.referenceTakes.find((candidate) => candidate.id === payload.action.takeId);
      if (!take) throw new Error("That reference take is no longer available.");
      shown = {
        title: "Reject the reference take",
        consequence: "Appends the ordinary cited review decision and retains the take and its provenance.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "authored-change",
        body: {
          family: "take-review",
          mediaKind: "image",
          mediaId: take.id,
          destination: take.reference?.sheetId ?? "Reference review history",
          currentSelection: null,
          reason: payload.action.note ?? payload.action.field,
        },
      };
      break;
    }
    case "world-chat-reference-change": {
      authority = { kind: "reference-kit", id: intent.actionId };
      const change = payload.action.change;
      const kit = await readKit(store, change.sheetId);
      if (!kit) throw new Error("That reference kit is no longer available.");
      let field: { label: string; before: string | null; after: string | null };
      let title: string;
      if (change.operation === "promote-look") {
        const look = kit.kit.looks?.find((candidate) => candidate.id === change.lookId);
        if (!look) throw new Error("That accepted look is no longer available.");
        field = { label: "Identity anchor", before: kit.kit.mainPhoto?.sourceTakeId ?? null, after: look.sourceTakeId ?? null };
        title = "Promote the character look";
      } else if (change.operation === "attach-look") {
        const look = kit.kit.looks?.find((candidate) => candidate.id === change.lookId);
        if (!look) throw new Error("That accepted look is no longer available.");
        field = {
          label: "Attached scope",
          before: look.attachedTo ? JSON.stringify(look.attachedTo) : null,
          after: change.scope ? JSON.stringify(change.scope) : null,
        };
        title = change.scope ? "Attach the character look" : "Detach the character look";
      } else {
        const compilation = kit.kit.compilations.find((candidate) =>
          candidate.accepted &&
          candidate.format === change.compilation.format &&
          candidate.compiledAt === change.compilation.compiledAt);
        if (!compilation) throw new Error("That accepted compilation is no longer available.");
        const current = kit.kit.compilations.find((candidate) => candidate.file === kit.kit.designatedCompilation);
        field = {
          label: "Designated compilation",
          before: current ? `${current.format} · ${current.compiledAt}` : null,
          after: `${compilation.format} · ${compilation.compiledAt}`,
        };
        title = "Designate the compilation";
      }
      shown = {
        title,
        consequence: "Updates the existing reference kit and retains prior takes, compilations, and review history.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "authored-change",
        body: { family: "authored-diff", fields: [field], conflicts: [], openChoices: [] },
      };
      break;
    }
    case "world-chat-reference-tile-lock": {
      authority = { kind: "reference-kit", id: intent.actionId };
      const kit = await readKit(store, payload.action.sheetId);
      const tile = kit?.kit.tiles.find((candidate) =>
        candidate.status === "generated" &&
        candidate.angle === payload.action.angle &&
        (payload.action.name === undefined || candidate.name === payload.action.name));
      if (!tile) throw new Error("That generated reference tile is no longer available.");
      shown = {
        title: `Lock the ${payload.action.angle} tile`,
        consequence: "Accepts this generated tile into the reference set and retains any superseded history.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "authored-change",
        body: {
          family: "take-review",
          mediaKind: "image",
          mediaId: tile.sourceTakeId ?? `tile:${payload.action.angle}:${payload.action.name ?? "unnamed"}`,
          destination: `${payload.action.sheetId} reference kit`,
          currentSelection: null,
        },
      };
      break;
    }
    case "world-chat-reference-compile": {
      authority = { kind: "reference-kit", id: intent.actionId };
      const sheet = bundle.sheets.find((candidate) => candidate.id === payload.action.sheetId);
      const kit = await readKit(store, payload.action.sheetId);
      if (!sheet || !kit?.kit.tiles.some((tile) => tile.status === "locked")) {
        throw new Error("That sheet has no locked reference tiles to compile.");
      }
      authorityRevision = sheet.version;
      shown = {
        title: "Compile the reference grid",
        consequence: "Builds the deterministic local grid from locked tiles and records it in the existing kit.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "spend-and-compute",
        body: {
          family: "command",
          commands: [{ label: "Compile locked tiles" }],
          expectedResult: "A local accepted compilation; no provider is called and no money is spent.",
          undoAvailable: true,
        },
      };
      break;
    }
    case "world-chat-reference-style": {
      authority = { kind: "reference-kit", id: intent.actionId };
      const kit = await readKit(store, payload.action.sheetId);
      shown = {
        title: payload.action.style === null ? "Clear the sheet style" : "Set the sheet style",
        consequence: "Changes only this sheet's rendering override; world Canon and accepted assets remain unchanged.",
        affectedTargets: [...intent.targets],
        ripples: ["Future reference generations for this sheet use the resulting style."],
        permissionReason: "authored-change",
        body: {
          family: "setting",
          setting: "Sheet rendering style",
          current: kit?.kit.styleOverride ?? null,
          proposed: payload.action.style,
          consequences: ["Existing accepted references remain pinned to their recorded provenance."],
        },
      };
      break;
    }
    case "world-chat-reference-generation": {
      authority = { kind: "job-queue", id: intent.actionId };
      const request = payload.action.request;
      shown = {
        title: `Generate ${request.operation.replaceAll("-", " ")}`,
        consequence: "Describes generation intent only. A coordinator-owned route and durable quote are required before it can run.",
        affectedTargets: [...intent.targets],
        ripples: ["Approving generation will not select any result; result use is a separate typed review action."],
        permissionReason: "spend-and-compute",
        body: {
          family: "generation",
          medium: "image",
          purpose: request.operation.replaceAll("-", " "),
          prompt: generationPrompt(payload),
          references: "identityReferenceIds" in request
            ? request.identityReferenceIds.map((id) => ({ id, role: "identity" }))
            : [],
          provider: "Pending coordinator-owned route",
          model: "Pending coordinator-owned route",
          quantity: "count" in request ? request.count : 1,
          output: `${request.sheetId} reference candidates`,
          cost: "Pending durable quote",
        },
      };
      break;
    }
    case "world-chat-reference-image-import": {
      authority = { kind: "host", id: intent.actionId };
      if (!deps.importReferenceImage) approvalBlockedReason = "Reference image import is unavailable in this host.";
      const target = payload.action.target;
      const label = target.surface === "world-image"
        ? "key art candidate"
        : target.surface === "master-look"
          ? "master look candidate"
          : `${target.key} staged reference`;
      shown = {
        title: `Import a ${label}`,
        consequence: "Opens the trusted host picker only after approval and copies one validated image into the world's pending reference area.",
        affectedTargets: [...intent.targets],
        ripples: ["Import does not accept a key-art or master-look candidate; selection remains a separate card."],
        permissionReason: "host-file-access",
        body: {
          family: "host-action",
          action: "Choose one image on this device",
          effect: "The selected path and bytes remain in the trusted host and never enter the model payload, card, or conversation log.",
        },
      };
      break;
    }
    case "world-chat-reference-world-image-result-use": {
      authority = { kind: "world-store", id: intent.actionId };
      if (!bundle.keyArtCandidates[payload.action.candidateIndex - 1]) {
        throw new Error("That key art candidate is no longer available.");
      }
      if (!deps.useWorldImage) approvalBlockedReason = "Key art selection is unavailable.";
      shown = {
        title: `Use key art candidate ${payload.action.candidateIndex}`,
        consequence: "Promotes the selected pending image to the world's key art and clears the candidate set.",
        affectedTargets: [...intent.targets],
        ripples: ["Generation or import never selects this result; this card is the separate artistic decision."],
        permissionReason: "authored-change",
        body: {
          family: "take-review",
          mediaKind: "image",
          mediaId: `world-image-candidate:${payload.action.candidateIndex}`,
          destination: "World key art",
          currentSelection: bundle.keyArt === null ? null : "Current key art",
        },
      };
      break;
    }
    case "world-chat-reference-master-look-result-use": {
      authority = { kind: "proposal-manager", id: intent.actionId };
      if (!bundle.masterLookCandidates[payload.action.candidateIndex - 1]) {
        throw new Error("That master look candidate is no longer available.");
      }
      if (!deps.useMasterLook) approvalBlockedReason = "Master look selection is unavailable.";
      shown = {
        title: `Use master look candidate ${payload.action.candidateIndex}`,
        consequence: "Accepts the selected image as a new version of the world look, preserving the prior look and its history.",
        affectedTargets: [...intent.targets],
        ripples: ["Future image generation uses the new master look; existing takes retain their recorded provenance."],
        permissionReason: "authored-change",
        body: {
          family: "take-review",
          mediaKind: "image",
          mediaId: `master-look-candidate:${payload.action.candidateIndex}`,
          destination: "World master look",
          currentSelection: bundle.artDirection.masterLook ? "Current master look" : null,
        },
      };
      break;
    }
    case "world-chat-reference-image-discard": {
      authority = { kind: "world-store", id: intent.actionId };
      if (!deps.discardReferenceImage) approvalBlockedReason = "Reference image removal is unavailable.";
      const target = payload.action.target;
      const available = target.surface === "world-image"
        ? bundle.keyArtCandidates.length > 0
        : target.surface === "master-look"
          ? bundle.masterLookCandidates.length > 0
          : bundle.stagedReferences[target.key] !== undefined;
      if (!available) throw new Error("That pending reference image is no longer available.");
      const label = target.surface === "world-image"
        ? "pending key art candidates"
        : target.surface === "master-look"
          ? "pending master look candidates"
          : `${target.key} staged reference`;
      shown = {
        title: `Discard ${label}`,
        consequence: "Removes only the pending or staged image; accepted key art, look history, and generated takes remain unchanged.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "destructive-change",
        body: {
          family: "destructive",
          removed: [label],
          retained: ["Accepted reference assets", "Reference and art-direction history"],
          dependentChanges: [],
          blockers: [],
          undoAvailable: false,
        },
      };
      break;
    }
    case "world-chat-voice-assignment": {
      authority = { kind: "voice", id: intent.actionId };
      const sheet = bundle.sheets.find((candidate) =>
        candidate.id === payload.action.sheetId && candidate.type === payload.action.sheetType);
      if (!sheet) throw new Error("That sheet is no longer available.");
      authorityRevision = sheet.version;
      if (payload.action.voice && !deps.voiceAvailable) {
        approvalBlockedReason = "The current voice catalogue cannot validate this assignment.";
      }
      shown = {
        title: payload.action.voice ? "Assign the voice" : "Remove the voice",
        consequence: "Versions the character sheet through the existing voice-assignment authority and preserves its ripple history.",
        affectedTargets: [...intent.targets],
        ripples: ["Future dialogue generation uses the resulting assignment; existing takes stay pinned."],
        permissionReason: "authored-change",
        body: {
          family: "setting",
          setting: "Character voice",
          current: sheet.voice ? semanticVoice(sheet.voice) : null,
          proposed: payload.action.voice ? semanticVoice(payload.action.voice) : null,
          consequences: ["Existing generated dialogue is not replaced."],
        },
      };
      break;
    }
    case "world-chat-voice-audition":
      authority = { kind: "voice", id: intent.actionId };
      shown = {
        title: "Generate a voice audition",
        consequence: "Describes a privacy-sensitive audio preview only; a coordinator-owned route and quote are required before it can run.",
        affectedTargets: [...intent.targets],
        ripples: ["The audition does not assign the voice. Assignment remains a separate typed action."],
        permissionReason: "privacy-sensitive",
        body: {
          family: "generation",
          medium: "audio",
          purpose: `Audition ${semanticVoice(payload.action.voice)}`,
          prompt: payload.action.text ?? "Use the character's coordinator-selected audition line.",
          references: [],
          provider: payload.action.voice.provider,
          model: payload.action.voice.model,
          quantity: 1,
          output: "Transient voice audition",
          cost: "Pending durable quote",
        },
      };
      break;
    case "world-chat-voice-clone":
      authority = { kind: "voice", id: intent.actionId };
      if (!deps.pickFiles) approvalBlockedReason = "Voice cloning needs the desktop host's recording picker.";
      shown = {
        title: `Clone the voice “${payload.action.name}”`,
        consequence: "A voice recording is biometric-like identity data. Approve only with the recorded speaker's informed consent; the recording is copied into this world and may be sent to the selected voice provider when used.",
        affectedTargets: [...intent.targets],
        ripples: payload.action.sheetId ? [`The clone records ${payload.action.sheetId} as provenance, not ownership.`] : [],
        permissionReason: "privacy-sensitive",
        body: {
          family: "host-action",
          action: "Choose the consented speaker recording after approval",
          effect: "The required host gesture keeps its path and bytes out of the model, card, and conversation log; cancelling creates no voice.",
        },
      };
      break;
    case "world-chat-voice-clip-review": {
      authority = { kind: "take-review", id: intent.actionId };
      const production = bundle.productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      const take = production?.takes.find((candidate) => candidate.id === payload.action.takeId);
      if (!production || !take || take.kind !== "voice") {
        throw new Error("That voice clip is no longer available for review.");
      }
      if (production.reviews.some((review) => review.takeId === take.id)) {
        throw new Error("That voice clip has already been reviewed.");
      }
      shown = {
        title: `${payload.action.review.decision === "accept" ? "Accept" : "Reject"} the voice clip`,
        consequence: payload.action.review.decision === "accept"
          ? "Records the review and selects this immutable voice take for the named shot in one commit."
          : "Appends the cited rejection while leaving the current shot selection unchanged.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "authored-change",
        body: {
          family: "take-review",
          mediaKind: "audio",
          mediaId: take.id,
          destination: payload.action.review.shotId ?? production.meta.id,
          currentSelection: payload.action.review.shotId
            ? production.selections[payload.action.review.shotId]?.acceptedTakeId ?? null
            : null,
          ...(payload.action.review.decision === "reject"
            ? { reason: `${payload.action.review.citation.sheet} · ${payload.action.review.citation.field}${payload.action.review.citation.note ? ` · ${payload.action.review.citation.note}` : ""}` }
            : {}),
        },
      };
      break;
    }
    case "world-chat-world-archive": {
      authority = { kind: "world-store", id: intent.actionId };
      const inFlight = deps.inFlightWorldJobs?.() ?? 0;
      const blockers = inFlight > 0 ? [`${inFlight} world job${inFlight === 1 ? " is" : "s are"} still running.`] : [];
      if (!deps.archiveWorld) approvalBlockedReason = "World archiving is unavailable in this host.";
      else if (blockers[0]) approvalBlockedReason = blockers[0];
      shown = {
        title: `Archive ${bundle.meta.name}`,
        consequence: "Moves the whole world out of the active library. Its files, identities, conversations, and history are retained.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "world-administration",
        body: {
          family: "destructive",
          removed: ["The world from the active library"],
          retained: ["All world files", "Version history", "Conversation cards and receipts"],
          dependentChanges: ["No creative record is deleted or rewritten."],
          blockers,
          undoAvailable: false,
        },
      };
      break;
    }
    case "world-chat-world-export":
      authority = { kind: "export", id: intent.actionId };
      if (!deps.exportWorld) approvalBlockedReason = "World export is unavailable in this host.";
      shown = {
        title: `Export ${bundle.meta.name}`,
        consequence: "Copies a portable world with authored history while excluding caches, locks, staging, and private conversation working files.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "export",
        body: {
          family: "host-action",
          action: "Create a portable world export",
          effect: "The destination is chosen by the trusted host and is never written into the model payload, card, or conversation log.",
        },
      };
      break;
    case "world-chat-production-create": {
      authority = { kind: "production-store", id: intent.actionId };
      const plan = payload.plan;
      shown = {
        title: `Create ${plan.production.title}`,
        consequence: "Creates the fixed production identity and every shown initial record atomically, without replanning after approval.",
        affectedTargets: [...intent.targets],
        ripples: [
          plan.series.operation === "none"
            ? "No Series record changes."
            : plan.series.operation === "create"
              ? `Creates Series ${plan.series.record.title} with this production as its first season.`
              : `Adds this production to Series ${plan.series.record.title}.`,
        ],
        permissionReason: "authored-change",
        body: {
          family: "command",
          commands: [
            { label: `Create production ${plan.production.id}`, detail: JSON.stringify(plan.production) },
            {
              label: "Initial season",
              detail: plan.initialSeason === null ? "None" : JSON.stringify(plan.initialSeason),
            },
            {
              label: "Series consequence",
              detail: plan.series.operation === "none"
                ? "None"
                : `${plan.series.operation}: ${JSON.stringify(plan.series.record)}`,
            },
          ],
          expectedResult: `Production ${plan.production.id} exists with exactly the shown metadata${plan.initialSeason ? ", initial season" : ""}${plan.series.operation === "none" ? "" : ", and Series consequence"}.`,
          undoAvailable: true,
        },
      };
      break;
    }
    case "world-chat-production-metadata": {
      authority = { kind: "production-store", id: intent.actionId };
      const production = bundle.productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      if (!production) throw new Error("That production is no longer in this world.");
      validateProductionMetadataChanges(production, payload.action.changes);
      const currentSeries = bundle.series.find((series) => series.seasons.includes(production.meta.id))?.id ?? null;
      const currentShape = productionShape(production.meta);
      const before = {
        title: production.meta.title,
        medium: currentShape.medium,
        productionKind: currentShape.kind,
        seriesId: currentSeries,
        status: production.meta.status,
        aspect: production.meta.aspect ?? null,
        frameRate: productionFrameRate(production.meta),
      };
      const after = { ...before, ...payload.action.changes };
      if (
        payload.action.changes.seriesId !== undefined &&
        payload.action.changes.seriesId !== null &&
        !bundle.series.some((series) => series.id === payload.action.changes.seriesId)
      ) throw new Error("That Series is no longer in this world.");
      const fields = diffFields(before, after, {
        title: "Title",
        medium: "Medium",
        productionKind: "Kind",
        seriesId: "Series",
        status: "Status",
        aspect: "Aspect",
        frameRate: "Frame rate",
      });
      if (fields.length === 0) throw new Error("The production metadata already has those values.");
      shown = {
        title: `Change ${production.meta.title} metadata`,
        consequence: "Updates the world-owned production record and, when requested, its Series membership in one commit.",
        affectedTargets: [...intent.targets],
        ripples: [
          ...(payload.action.changes.frameRate !== undefined ? ["Future frame-based work uses the new production frame rate."] : []),
          ...(payload.action.changes.seriesId !== undefined ? ["Series season membership changes atomically with production metadata."] : []),
        ],
        permissionReason: "authored-change",
        body: { family: "authored-diff", fields, conflicts: [], openChoices: [] },
      };
      break;
    }
    case "world-chat-production-model": {
      authority = { kind: "production-store", id: intent.actionId };
      const production = bundle.productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      if (!production) throw new Error("That production is no longer in this world.");
      const current = production.meta.models?.[payload.action.capability] ?? null;
      if (current === payload.action.modelId) throw new Error("That model assignment is already set.");
      shown = {
        title: `${payload.action.modelId === null ? "Clear" : "Set"} the ${payload.action.capability} model`,
        consequence: "Changes where this production routes future work for one capability.",
        affectedTargets: [...intent.targets],
        ripples: ["Accepted work remains pinned to the model and provenance it already recorded."],
        permissionReason: "authored-change",
        body: {
          family: "setting",
          setting: `${payload.action.capability} model`,
          current,
          proposed: payload.action.modelId,
          consequences: ["World-wide routing defaults are unchanged."],
        },
      };
      break;
    }
    case "world-chat-production-episode-order":
    case "world-chat-production-chapter-order":
    case "world-chat-production-scene-order": {
      authority = { kind: "production-store", id: intent.actionId };
      const production = bundle.productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      if (!production) throw new Error("That production is no longer in this world.");
      const label = payload.kind === "world-chat-production-episode-order"
        ? "Episodes"
        : payload.kind === "world-chat-production-chapter-order"
          ? "Chapters"
          : "Scenes";
      const current = payload.kind === "world-chat-production-episode-order"
        ? [...production.episodes].sort((a, b) => a.order - b.order).map((episode) => episode.id)
        : payload.kind === "world-chat-production-chapter-order"
          ? [...production.chapters].sort((a, b) => a.order - b.order).map((chapter) => chapter.id)
          : sortScenes(production.scenes).map((scene) => scene.id);
      requireExactOrder(current, payload.action.orderedIds, label);
      shown = {
        title: `Reorder ${label.toLowerCase()}`,
        consequence: `Writes the shown complete ${label.toLowerCase()} order through the existing production authority.`,
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "authored-change",
        body: {
          family: "command",
          commands: payload.action.orderedIds.map((id, index) => ({ label: `${index + 1}. ${id}` })),
          expectedResult: `${label} appear in exactly this order.`,
          undoAvailable: true,
        },
      };
      break;
    }
    case "world-chat-production-scene-delete": {
      authority = { kind: "production-store", id: intent.actionId };
      const production = bundle.productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      const scene = production?.scenes.find((candidate) => candidate.id === payload.action.sceneId);
      if (!production || !scene) throw new Error("That scene is no longer in this production.");
      const blockers = sceneDeleteBlockers(production, scene);
      approvalBlockedReason = blockers[0];
      shown = {
        title: `Delete ${scene.title}`,
        consequence: "Deletes the scene through the existing blocker-aware operation and retains its version history.",
        affectedTargets: [...intent.targets],
        ripples: ["Episode membership and shot selections owned by this scene are repaired in the same commit."],
        permissionReason: "destructive-change",
        body: {
          family: "destructive",
          removed: [`Scene ${scene.id} from the production`],
          retained: ["Scene version history", "Takes, reviews, and immutable spend history"],
          dependentChanges: ["Episode membership and scene-owned shot selections are removed atomically."],
          blockers,
          undoAvailable: true,
        },
      };
      authorityRevision = scene.version;
      break;
    }
    case "world-chat-production-scene-restore": {
      authority = { kind: "production-store", id: intent.actionId };
      const production = bundle.productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      const scene = production?.scenes.find((candidate) => candidate.id === payload.action.sceneId);
      const stem = production?.sceneFiles[payload.action.sceneId];
      if (!production || !scene || !stem) throw new Error("That scene is no longer in this production.");
      const snapshot = SceneRecordSchema.parse(JSON.parse(await historyContent(
        store,
        `.history/productions/${production.meta.id}/scenes/${stem}/v${payload.action.version}.json`,
      )));
      const fields = diffFields(scene, snapshot);
      shown = {
        title: `Restore ${scene.title} from v${payload.action.version}`,
        consequence: "Restores the complete historical scene as a new version without deleting later history.",
        affectedTargets: [...intent.targets],
        ripples: ["Script, shot, inherited-context, and Stage data in that snapshot return together."],
        permissionReason: "authored-change",
        body: {
          family: "authored-diff",
          fields: fields.length > 0 ? fields : [{ label: "Scene", before: "Current", after: "Same in selected version" }],
          conflicts: [],
          openChoices: [],
        },
      };
      authorityRevision = scene.version;
      break;
    }
    case "world-chat-production-style": {
      authority = { kind: "production-store", id: intent.actionId };
      const production = bundle.productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      if (!production) throw new Error("That production is no longer in this world.");
      if ((production.meta.styleOverride ?? null) === payload.action.style) {
        throw new Error("The production style already has that value.");
      }
      shown = {
        title: payload.action.style === null ? "Clear the production style" : "Set the production style",
        consequence: "Updates the production's scoped style through its world-owned production metadata authority.",
        affectedTargets: [...intent.targets],
        ripples: ["Future production generations inherit this style; accepted assets remain pinned."],
        permissionReason: "authored-change",
        body: {
          family: "setting",
          setting: "Production style",
          current: production.meta.styleOverride ?? null,
          proposed: payload.action.style,
          consequences: ["The world art direction is not copied or changed."],
        },
      };
      break;
    }
    case "world-chat-production-scene-command": {
      authority = { kind: "scene-store", id: intent.actionId };
      const production = bundle.productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      const scene = production?.scenes.find((candidate) => candidate.id === payload.action.sceneId);
      if (!production || !scene || !production.sceneFiles[scene.id]) {
        throw new Error("That scene is no longer in this production.");
      }
      const command = payload.action.command;
      const namedShot = "shotId" in command ? command.shotId : undefined;
      if (namedShot !== undefined && !orderedShots(scene).some((shot) => shot.id === namedShot)) {
        throw new Error(`Shot ${namedShot} is no longer in this scene.`);
      }
      shown = {
        title: `${command.kind.replaceAll("-", " ")} in ${scene.title}`,
        consequence: "Applies this one semantic command and versions the complete validated scene.",
        affectedTargets: [...intent.targets],
        ripples: command.kind === "delete-shot"
          ? ["The authority rechecks takes, selections, and active plans before deleting the shot."]
          : [],
        permissionReason: "authored-change",
        body: {
          family: "command",
          commands: [{ label: command.kind.replaceAll("-", " "), detail: clipped(JSON.stringify(command)) ?? undefined }],
          expectedResult: `Scene ${scene.id} advances from v${scene.version} only if the semantic operation remains valid.`,
          undoAvailable: true,
        },
      };
      authorityRevision = scene.version;
      break;
    }
    case "world-chat-production-board-compile":
    case "world-chat-production-board-export": {
      const exporting = payload.kind === "world-chat-production-board-export";
      authority = { kind: exporting ? "export" : "board", id: intent.actionId };
      const production = bundle.productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      const scene = production?.scenes.find((candidate) => candidate.id === payload.action.sceneId);
      if (!production || !scene || !production.sceneFiles[scene.id]) {
        throw new Error("That scene is no longer in this production.");
      }
      shown = exporting
        ? {
            title: `Export the board for ${scene.title}`,
            consequence: "Compiles the current selected frames locally and files one immutable board artifact.",
            affectedTargets: [...intent.targets],
            ripples: [],
            permissionReason: "export",
            body: {
              family: "host-action",
              action: "File one board snapshot in this world",
              effect: "No external provider runs and no destination path comes from the model.",
            },
          }
        : {
            title: `Compile the board for ${scene.title}`,
            consequence: "Compiles selected and pinned frames locally, then records the result on the scene.",
            affectedTargets: [...intent.targets],
            ripples: [],
            permissionReason: "authored-change",
            body: {
              family: "command",
              commands: [{ label: `Compile ${orderedShots(scene).length} shot cells` }],
              expectedResult: "The scene points at a fresh deterministic board image; takes and selections remain unchanged.",
              undoAvailable: false,
            },
          };
      authorityRevision = scene.version;
      break;
    }
    case "world-chat-production-take-import": {
      authority = { kind: "host", id: intent.actionId };
      const production = bundle.productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      const scene = production?.scenes.find((candidate) => candidate.id === payload.action.sceneId);
      const shot = scene && orderedShots(scene).find((candidate) => candidate.id === payload.action.shotId);
      if (!production || !scene || !shot) throw new Error("That shot is no longer in this scene.");
      if (!deps.importProductionTake) approvalBlockedReason = "This take import needs the desktop host's image picker.";
      shown = {
        title: `Import a frame take for ${shot.title}`,
        consequence: "Opens a host-owned image picker and records the chosen image as an immutable take.",
        affectedTargets: [...intent.targets],
        ripples: ["The imported take is not selected, accepted, or placed by this action."],
        permissionReason: "host-file-access",
        body: {
          family: "host-action",
          action: "Choose one image on this device",
          effect: "The host path and bytes stay outside the conversation; only the new take ID is returned.",
        },
      };
      break;
    }
    case "world-chat-production-take-generation": {
      authority = { kind: "bench", id: intent.actionId };
      const production = bundle.productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      const scene = production?.scenes.find((candidate) => candidate.id === payload.action.sceneId);
      if (!production || !scene) throw new Error("That scene is no longer in this production.");
      const shotIds = payload.action.target.kind === "shot"
        ? [payload.action.target.shotId]
        : payload.action.target.memberShotIds;
      if (shotIds.some((shotId) => !orderedShots(scene).some((shot) => shot.id === shotId))) {
        throw new Error("A generation target is no longer in this scene.");
      }
      if (payload.action.retakeOf && !production.takes.some((take) => take.id === payload.action.retakeOf)) {
        throw new Error("The take being retaken is no longer in this production.");
      }
      if (!deps.openProductionTakeGeneration) approvalBlockedReason = "The production generator is unavailable in this authoring session.";
      shown = {
        title: payload.action.retakeOf ? "Prepare a retake" : "Prepare take generation",
        consequence: "Opens the exact shot or board in Bench. Provider execution and result selection remain separate decisions.",
        affectedTargets: [...intent.targets],
        ripples: ["Generated output will arrive as an unselected immutable take."],
        permissionReason: "spend-and-compute",
        body: {
          family: "generation",
          medium: payload.action.mode,
          purpose: payload.action.retakeOf ? `Retake ${payload.action.retakeOf}` : `Generate ${payload.action.target.kind}`,
          prompt: payload.action.instruction ?? "Use the scene's current inherited context and prompt overrides.",
          references: payload.action.retakeOf ? [{ id: payload.action.retakeOf, role: "retake reference" }] : [],
          provider: "Chosen in Bench",
          model: "Chosen in Bench",
          quantity: 1,
          output: "One or more unselected production takes",
          cost: "Quoted in Bench before provider execution",
        },
      };
      break;
    }
    case "world-chat-production-take-review": {
      authority = { kind: "take-review", id: intent.actionId };
      const production = bundle.productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      const take = production?.takes.find((candidate) => candidate.id === payload.action.takeId);
      if (!production || !take) throw new Error("That take is no longer in this production.");
      const shotId = payload.action.review.shotId ?? take.coversShots[0];
      const located = shotId === undefined
        ? undefined
        : production.scenes.flatMap((scene) => orderedShots(scene).map((shot) => ({ scene, shot })))
            .find((candidate) => candidate.shot.id === shotId);
      if (payload.action.review.decision === "accept" && !located) {
        throw new Error("The destination shot is no longer in this production.");
      }
      const sourceTake = take.media !== undefined
        ? take
        : take.segment !== undefined
          ? production.takes.find((candidate) => candidate.id === take.segment!.passTakeId)
          : undefined;
      const mediaPath = sourceTake?.media
        ? `productions/${production.meta.id}/takes/${sourceTake.id}/${sourceTake.media}`
        : undefined;
      const mediaKind = take.kind === "clip" ? "video" as const : take.kind === "voice" ? "audio" as const : "image" as const;
      const selection = located ? production.selections[located.shot.id] : undefined;
      const currentSelection = selection?.acceptedTakeId ?? selection?.startFrameTakeId ?? null;
      const history = production.reviews
        .filter((review) => review.takeId === take.id)
        .map((review) => `${review.ts} · ${review.decision}${review.shotId ? ` for ${review.shotId}` : ""} · ${review.by}`);
      shown = {
        title: `${payload.action.review.decision === "accept" ? "Accept" : "Reject"} ${take.id}`,
        consequence: payload.action.review.decision === "accept"
          ? "Records acceptance and changes the destination selection atomically through the take authority."
          : "Appends a cited rejection without changing the take or current selection.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "authored-change",
        body: {
          family: "take-review",
          mediaKind,
          mediaId: take.id,
          destination: located ? `${located.scene.title} · ${located.shot.title}` : production.meta.title,
          currentSelection,
          ...(mediaPath ? { mediaPath } : {}),
          ...(mediaKind === "video" && sourceTake?.media
            ? { posterPath: `productions/${production.meta.id}/takes/${sourceTake.id}/${posterNameFor(sourceTake.media)}` }
            : {}),
          ...(located ? { scene: `${located.scene.number} · ${located.scene.title}`, shot: `${located.shot.number} · ${located.shot.title}` } : {}),
          reviewHistory: history,
          ...(payload.action.review.decision === "reject" ? { rejectionCitation: payload.action.review.citation } : {}),
        },
      };
      break;
    }
    case "world-chat-production-take-trim": {
      authority = { kind: "take-review", id: intent.actionId };
      const production = bundle.productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      const selection = production?.selections[payload.action.shotId];
      if (!production || selection?.acceptedTakeId !== payload.action.takeId) {
        throw new Error("That take is no longer selected for this shot.");
      }
      shown = {
        title: `Trim ${payload.action.shotId}`,
        consequence: "Changes only where the selected footage starts; the immutable take and review history remain unchanged.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "authored-change",
        body: {
          family: "command",
          commands: [{ label: `Set trim-in to ${payload.action.trimInSec}s`, detail: payload.action.takeId }],
          expectedResult: `Shot ${payload.action.shotId} starts ${payload.action.trimInSec}s into the selected take.`,
          undoAvailable: true,
        },
      };
      break;
    }
    case "world-chat-production-stage-playblast": {
      authority = { kind: "scene-store", id: intent.actionId };
      const production = bundle.productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      const scene = production?.scenes.find((candidate) => candidate.id === payload.action.sceneId);
      const shot = scene && orderedShots(scene).find((candidate) => candidate.id === payload.action.shotId);
      if (!production || !scene || !shot) throw new Error("That Stage shot is no longer available.");
      if (!shot.staging) throw new Error("Stage the shot before preparing a playblast.");
      shown = {
        title: `Record a playblast for ${shot.title}`,
        consequence: "Asks the renderer to record the current Stage, then files the MP4, opening frame, and staging pin atomically.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "host-file-access",
        body: {
          family: "host-action",
          action: "Record the current Stage",
          effect: "Renderer-owned temporary paths stay outside the model and are accepted only by the existing version-fenced filing authority.",
        },
      };
      authorityRevision = scene.version;
      break;
    }
    case "world-chat-audio-spine-command": {
      authority = { kind: "audio-spine", id: intent.actionId };
      const preview = previewAudioSpineCommand(bundle, payload.action, store.now());
      authorityRevision = preview.authorityRevision;
      shown = {
        title: preview.title.slice(0, 200),
        consequence: payload.action.command.kind === "delete-spine"
          ? "Deletes the production's authored song clock, markers, and shot anchors."
          : "Applies this semantic command through the version-fenced production audio-spine authority.",
        affectedTargets: [...intent.targets],
        ripples: payload.action.command.kind === "delete-spine"
          ? ["A saved timeline remains authoritative and is not reordered or deleted."]
          : [],
        permissionReason: "authored-change",
        body: {
          family: "command",
          commands: preview.commands.map((command) => ({
            label: command.label.slice(0, 200),
            ...(command.detail !== undefined ? { detail: clipped(command.detail, 4_000) ?? undefined } : {}),
          })),
          expectedResult: preview.expectedResult,
          undoAvailable: false,
        },
      };
      break;
    }
    default:
      throw new Error("That shared-resource action cannot be projected.");
  }

  await writePreparation(store, "world", intent.actionId, payload);
  return {
    authority,
    authorityRevision,
    shown,
    ...(approvalBlockedReason !== undefined ? { approvalBlockedReason } : {}),
  };
}

function referenceMutationOptions(
  action: ConversationActionCard,
  precondition: WorldStatePrecondition,
) {
  return {
    source: `world-chat:${action.conversationId}:${action.actionId}`,
    requestId: action.actionId,
    precondition,
  };
}

async function useReferenceResult(
  store: WorldStore,
  payload: WorldChatReferenceResultUseAction,
  action: ConversationActionCard,
  precondition: WorldStatePrecondition,
): Promise<void> {
  const change = payload.action.change;
  const bundle = store.getBundle();
  const sheet = bundle.sheets.find((candidate) => candidate.id === change.sheetId);
  if (!sheet) throw new Error("That sheet is no longer available.");
  const options = referenceMutationOptions(action, precondition);

  if (change.operation === "choose-anchor") {
    if (change.selection.source !== "take") throw new Error("That raw candidate requires its recovery authority.");
    const result = await acceptMainPhoto(
      store,
      sheet,
      bundle,
      change.selection,
      null,
      { commitAnchor: (owned, sheetId, input) => chooseAnchor(owned, sheetId, input, options) },
    );
    if (result.status === "failed") throw new Error(result.error);
    return;
  }

  let takeId: string;
  if (change.operation === "accept-location-view") {
    if (change.selection.source !== "take") throw new Error("That raw candidate requires its recovery authority.");
    takeId = change.selection.takeId;
  } else {
    takeId = change.takeId;
  }
  const expectedKind = change.operation === "accept-location-view"
    ? "location-view"
    : change.operation === "accept-character-sheet"
      ? "sheet"
      : "look";
  const take = pendingReferenceTake(
    bundle.referenceTakes,
    bundle.referenceReviews,
    takeId,
    change.sheetId,
    expectedKind,
  );
  if (!take?.media || basename(take.media) !== take.media) throw new Error("That reference take is unavailable or already decided.");
  const media = `references/${change.sheetId}/takes/${take.id}/${take.media}`;
  if (!(await stat(toExtendedLength(join(store.dir, media))).catch(() => null))) {
    throw new Error("That reference take's media is unavailable.");
  }
  const review = referenceReviewDecision(store.now(), take, "accept");

  if (change.operation === "accept-location-view") {
    if (sheet.type !== "location") throw new Error("A location view can only be accepted for a location.");
    const frozen = take.params["provenance"] as { sheets?: Record<string, number> } | undefined;
    const sheetVersion = frozen?.sheets?.[change.sheetId] ?? take.provenance.sheets[change.sheetId];
    if (sheetVersion === undefined) throw new Error("That take does not record the location version it depicts.");
    await acceptLocationView(store, sheet, {
      id: `lv_${take.id.slice(3)}`,
      name: change.name,
      file: `takes/${take.id}/${take.media}`,
      takeId: take.id,
      sheetVersion,
      artDirectionVersion: take.provenance.artDirectionVersion ?? bundle.artDirection.version,
      ...(change.establishing !== undefined ? { establishing: change.establishing } : {}),
      ...(change.replaceExistingName !== undefined ? { replaceExistingName: change.replaceExistingName } : {}),
      review,
    }, options);
    return;
  }

  if (change.operation === "accept-character-sheet") {
    const frozen = take.params["provenance"] as { sheets?: Record<string, number>; anchorFile?: string } | undefined;
    const sheetVersion = frozen?.sheets?.[change.sheetId] ?? take.provenance.sheets[change.sheetId];
    if (sheetVersion === undefined || (take.provider !== "user" && !frozen?.anchorFile)) {
      throw new Error("That take does not record the character identity it was generated from.");
    }
    await acceptCharacterSheet(store, sheet, {
      file: `takes/${take.id}/${take.media}`,
      takeId: take.id,
      sheetVersion,
      ...(frozen?.anchorFile ? { anchorFile: frozen.anchorFile } : {}),
      artDirectionVersion: take.provenance.artDirectionVersion ?? bundle.artDirection.version,
      review,
    }, options);
    return;
  }

  const lookKind = take.params["lookKind"];
  const lookPrompt = take.params["lookPrompt"];
  if (
    (lookKind !== "costume" && lookKind !== "pose-expression" && lookKind !== "condition-age") ||
    typeof lookPrompt !== "string" ||
    lookPrompt.trim() === ""
  ) throw new Error("That take does not record the look it was generated for.");
  await acceptCharacterLook(store, change.sheetId, {
    id: take.id,
    file: `takes/${take.id}/${take.media}`,
    kind: lookKind,
    prompt: lookPrompt.trim(),
    ...(take.jobId ? { jobId: take.jobId } : {}),
    takeId: take.id,
    artDirectionVersion: take.provenance.artDirectionVersion ?? bundle.artDirection.version,
    review,
  }, options);
}

async function executeSharedResource(
  store: WorldStore,
  gate: ProposalManager | null,
  payload: WorldChatPreparedAction,
  action: ConversationActionCard,
  precondition: WorldStatePrecondition,
  now: () => string,
  deps: WorldChatActionAdapterDeps,
): Promise<ConversationActionExecutionOutcome> {
  const options = referenceMutationOptions(action, precondition);
  switch (payload.kind) {
    case "world-chat-artifact-import": {
      if (payload.action.source === "folder") {
        const folder = await deps.pickFolder?.();
        if (!folder) return { status: "cancelled", detail: "No folder was selected." };
        const stale = precondition();
        if (stale) throw new WorldStateStaleError(stale);
        const report = await importFolder(store, folder, deps.mediaProbe, () => store.isClosed());
        await store.commit({ kind: "world-chat-artifact-import", source: options.source, files: [], requestId: action.actionId });
        return {
          status: "completed",
          receipt: {
            kind: "artifact-import",
            id: action.actionId,
            summary: `Imported ${report.filed.length} and reused ${report.deduplicated.length} artifact files; ${report.excluded.length} were excluded.`,
          },
        };
      }
      const selected = await deps.pickFiles?.({ accept: ATTACHABLE_EXTENSIONS }) ?? [];
      if (selected.length === 0) return { status: "cancelled", detail: "No files were selected." };
      if (payload.action.supersedes !== undefined && selected.length !== 1) {
        return { status: "failed", detail: "Choose one file for an artifact replacement." };
      }
      const artifactIds: string[] = [];
      let refused = 0;
      for (const [index, sourcePath] of selected.entries()) {
        const filed = await fileArtifact(store, {
          sourcePath,
          links: payload.action.links,
          ...(payload.action.allowLarge !== undefined ? { allowLarge: payload.action.allowLarge } : {}),
          ...(payload.action.supersedes !== undefined ? { supersedes: payload.action.supersedes } : {}),
          ...(payload.action.productionId !== undefined ? { production: payload.action.productionId } : {}),
          ...(deps.mediaProbe !== undefined ? { mediaProbe: deps.mediaProbe } : {}),
          mutation: index === 0
            ? { ...options, requestId: `${action.actionId}:${index + 1}` }
            : { source: options.source, requestId: `${action.actionId}:${index + 1}` },
        });
        if (filed.outcome === "filed" || filed.outcome === "deduplicated") artifactIds.push(filed.artifact.id);
        else refused += 1;
      }
      if (artifactIds.length === 0) return { status: "failed", detail: "None of the selected files could be filed." };
      await store.commit({ kind: "world-chat-artifact-import", source: options.source, files: [], requestId: action.actionId });
      return {
        status: "completed",
        receipt: {
          kind: "artifact-import",
          id: artifactIds[0]!,
          summary: `Filed ${artifactIds.length} artifact${artifactIds.length === 1 ? "" : "s"}${refused > 0 ? `; ${refused} were refused` : ""}.`,
        },
      };
    }
    case "world-chat-artifact-metadata": {
      const change = payload.action.change;
      const artifact = store.getBundle().artifacts.find((candidate) => candidate.id === change.artifactId);
      if (!artifact) throw new Error("That artifact is no longer in this world.");
      if (
        change.operation === "set-owner" &&
        change.productionId !== null &&
        !store.getBundle().productions.some((production) => production.meta.id === change.productionId)
      ) throw new Error("That production is no longer in this world.");
      const updated = change.operation === "add-links"
        ? await addLinks(store, artifact, change.links, options)
        : await setOwner(store, artifact, change.productionId, options);
      return {
        status: "completed",
        receipt: { kind: "artifact", id: updated.id, summary: "The artifact metadata was updated." },
      };
    }
    case "world-chat-artifact-extraction": {
      if (!deps.extractArtifact) return { status: "failed", detail: "Artifact extraction is unavailable." };
      const result = await deps.extractArtifact(payload.action.artifactId, options);
      if (result.outcome === "no-text" || result.outcome === "unavailable") {
        return { status: "failed", detail: result.outcome === "no-text" ? "That artifact has no readable text." : "Artifact extraction is unavailable." };
      }
      return {
        status: "completed",
        receipt: {
          kind: "extraction",
          id: payload.action.artifactId,
          summary: `Extraction finished with ${result.found} candidate${result.found === 1 ? "" : "s"} and ${result.dropped} dropped claim${result.dropped === 1 ? "" : "s"}.`,
        },
      };
    }
    case "world-chat-artifact-extraction-stop":
      deps.stopExtraction?.(payload.action.artifactId);
      return { status: "completed", receipt: { kind: "extraction", id: payload.action.artifactId, summary: "The extraction stop was requested." } };
    case "world-chat-artifact-extraction-review": {
      if (!gate) return { status: "failed", detail: "The proposal authority is unavailable." };
      const artifact = store.getBundle().artifacts.find((candidate) => candidate.id === payload.action.artifactId);
      if (!artifact) throw new Error("That artifact is no longer in this world.");
      await resolveCandidate(
        store,
        gate,
        artifact,
        payload.action.candidateHash,
        payload.action.decision,
        options,
      );
      return {
        status: "completed",
        receipt: {
          kind: "extraction-review",
          id: payload.action.candidateHash,
          summary: `The extraction candidate was ${payload.action.decision === "accept" ? "accepted" : "rejected"}.`,
        },
      };
    }
    case "world-chat-artifact-reference": {
      const artifact = store.getBundle().artifacts.find((candidate) => candidate.id === payload.action.artifactId);
      if (!artifact || (artifact.kind !== "image" && artifact.kind !== "board")) {
        throw new Error("That artifact cannot be used as an image reference.");
      }
      await store.gateOp(async () => {
        const stale = precondition();
        if (stale) throw new WorldStateStaleError(stale);
        await rm(toExtendedLength(join(store.dir, stagedReferenceDir(payload.action.key))), { recursive: true, force: true });
        await atomicWriteFile(
          join(store.dir, stagedReferenceDir(payload.action.key), "artifact.json"),
          Buffer.from(JSON.stringify({ file: artifact.file }), "utf8"),
        );
      });
      return { status: "completed", receipt: { kind: "staged-reference", id: artifact.id, summary: "The artifact was staged as a reference." } };
    }
    case "world-chat-reference-import": {
      if (!deps.importReference) return { status: "failed", detail: "Reference import is unavailable." };
      const result = await deps.importReference(payload.action.change, options);
      if (result.status !== "completed") return { status: result.status, detail: result.detail };
      return {
        status: "completed",
        receipt: { kind: "reference-import", id: result.id ?? action.actionId, summary: "The reference image was imported." },
      };
    }
    case "world-chat-reference-result-use": {
      const change = payload.action.change;
      if ("selection" in change && change.selection.source === "candidate") {
        if (!deps.useReferenceCandidate) return { status: "failed", detail: "Raw reference candidate recovery is unavailable." };
        const result = await deps.useReferenceCandidate(change, options);
        if (result.status === "failed") return { status: "failed", detail: result.detail };
        return {
          status: "completed",
          receipt: { kind: "reference-result", id: result.id ?? action.actionId, summary: "The selected reference result was accepted." },
        };
      }
      await useReferenceResult(store, payload, action, precondition);
      const takeId = "selection" in change
        ? change.selection.source === "take"
          ? change.selection.takeId
          : action.actionId
        : change.takeId;
      return {
        status: "completed",
        receipt: {
          kind: "reference-result",
          id: takeId,
          summary: "The selected reference result was accepted.",
        },
      };
    }
    case "world-chat-reference-review": {
      const take = store.getBundle().referenceTakes.find((candidate) => candidate.id === payload.action.takeId);
      if (!take) throw new Error("That reference take is no longer available.");
      await recordReferenceReview(
        store,
        take,
        "reject",
        { field: payload.action.field, ...(payload.action.note ? { note: payload.action.note } : {}) },
        options,
      );
      return { status: "completed", receipt: { kind: "reference-review", id: take.id, summary: "The reference take was rejected with its citation retained." } };
    }
    case "world-chat-reference-change": {
      const change = payload.action.change;
      const sheet = store.getBundle().sheets.find((candidate) => candidate.id === change.sheetId);
      if (!sheet) throw new Error("That sheet is no longer available.");
      if (change.operation === "promote-look") {
        await promoteCharacterLook(store, sheet, change.lookId, options);
      } else if (change.operation === "attach-look") {
        if (
          change.scope &&
          !store.getBundle().productions.some((production) => production.meta.id === change.scope!.productionId)
        ) throw new Error("That production is no longer in this world.");
        await attachCharacterLook(store, change.sheetId, change.lookId, change.scope, options);
      } else {
        const kit = await readKit(store, change.sheetId);
        const compilation = kit?.kit.compilations.find((candidate) =>
          candidate.accepted &&
          candidate.format === change.compilation.format &&
          candidate.compiledAt === change.compilation.compiledAt);
        if (!compilation) throw new Error("That accepted compilation is no longer available.");
        await designate(store, change.sheetId, compilation.file, options);
      }
      return { status: "completed", receipt: { kind: "reference-kit", id: change.sheetId, summary: "The reference kit was updated." } };
    }
    case "world-chat-reference-tile-lock":
      await lockTile(store, payload.action.sheetId, payload.action.angle, payload.action.name, options);
      return { status: "completed", receipt: { kind: "reference-kit", id: payload.action.sheetId, summary: "The generated tile was locked into the reference set." } };
    case "world-chat-reference-compile": {
      const sheet = store.getBundle().sheets.find((candidate) => candidate.id === payload.action.sheetId);
      if (!sheet) throw new Error("That sheet is no longer available.");
      const result = await compileGrid(store, sheet, now);
      await landGrid(store, sheet, result, options);
      return { status: "completed", receipt: { kind: "reference-compilation", id: payload.action.sheetId, summary: "The deterministic reference grid was compiled." } };
    }
    case "world-chat-reference-style":
      await setStyleOverride(store, payload.action.sheetId, payload.action.style, options);
      return { status: "completed", receipt: { kind: "reference-kit", id: payload.action.sheetId, summary: "The sheet style was updated." } };
    case "world-chat-reference-image-import": {
      if (!deps.importReferenceImage) return { status: "failed", detail: "Reference image import is unavailable." };
      const result = await deps.importReferenceImage(payload.action.target, options);
      if (result.status !== "completed") return { status: result.status, detail: result.detail };
      return {
        status: "completed",
        receipt: { kind: "reference-image-import", id: result.id ?? action.actionId, summary: "The image was imported into the pending reference area." },
      };
    }
    case "world-chat-reference-world-image-result-use": {
      if (!await deps.useWorldImage?.(payload.action.candidateIndex, options)) {
        return { status: "failed", detail: "That key art candidate could not be selected." };
      }
      return { status: "completed", receipt: { kind: "world-image", id: action.actionId, summary: "The selected candidate became the world's key art." } };
    }
    case "world-chat-reference-master-look-result-use": {
      if (!await deps.useMasterLook?.(payload.action.candidateIndex, options)) {
        return { status: "failed", detail: "That master look candidate could not be selected." };
      }
      return { status: "completed", receipt: { kind: "master-look", id: action.actionId, summary: "The selected candidate became a new master look version." } };
    }
    case "world-chat-reference-image-discard": {
      if (!await deps.discardReferenceImage?.(payload.action.target, options)) {
        return { status: "failed", detail: "That pending reference image could not be removed." };
      }
      return { status: "completed", receipt: { kind: "reference-image-discard", id: action.actionId, summary: "The pending reference image was removed." } };
    }
    case "world-chat-reference-generation":
    case "world-chat-voice-audition":
      return { status: "failed", detail: "A durable coordinator-owned generation quote is required." };
    case "world-chat-voice-assignment": {
      if (payload.action.voice && !(await deps.voiceAvailable?.(payload.action.voice))) {
        return { status: "failed", detail: "That voice is no longer available." };
      }
      const result = await applyVoiceAssignment(
        store,
        {
          path: `${sheetDir(payload.action.sheetType)}/${payload.action.sheetId}.md`,
          voice: payload.action.voice,
        },
        options,
      );
      return { status: "completed", receipt: { kind: "sheet-version", id: result.commitId, summary: payload.action.voice ? "The voice was assigned." : "The voice assignment was removed." } };
    }
    case "world-chat-voice-clone": {
      const selected = await deps.pickFiles?.({ accept: [...CLONEABLE_AUDIO_EXTENSIONS] }) ?? [];
      if (selected.length === 0) return { status: "cancelled", detail: "No recording was selected." };
      if (selected.length !== 1) return { status: "failed", detail: "Choose one consented speaker recording." };
      const result = await cloneVoice(store, store.getBundle().clonedVoices, {
        sourcePath: selected[0]!,
        name: payload.action.name,
        description: payload.action.description,
        consent: true,
        ...(payload.action.sheetId !== undefined ? { sheetId: payload.action.sheetId } : {}),
        mutation: options,
      });
      if (!result.ok) return { status: "failed", detail: result.reason };
      return { status: "completed", receipt: { kind: "voice", id: result.voice.id, summary: "The consented recording was cloned into the world's voice library." } };
    }
    case "world-chat-voice-clip-review": {
      const production = store.getBundle().productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      const take = production?.takes.find((candidate) => candidate.id === payload.action.takeId);
      if (!production || !take || take.kind !== "voice") throw new Error("That voice clip is no longer available for review.");
      if (payload.action.review.decision === "accept") {
        await acceptTake(store, production, {
          takeId: take.id,
          shotId: payload.action.review.shotId,
          by: "user",
        }, options);
      } else {
        await rejectTake(store, production, {
          takeId: take.id,
          ...(payload.action.review.shotId !== undefined ? { shotId: payload.action.review.shotId } : {}),
          by: "user",
          citation: payload.action.review.citation,
        }, options);
      }
      return {
        status: "completed",
        receipt: {
          kind: "voice-review",
          id: take.id,
          summary: `The voice clip was ${payload.action.review.decision === "accept" ? "accepted" : "rejected"}.`,
        },
      };
    }
    case "world-chat-world-archive": {
      const inFlight = deps.inFlightWorldJobs?.() ?? 0;
      if (inFlight > 0) return { status: "failed", detail: "World jobs are still running." };
      if (!deps.archiveWorld) return { status: "failed", detail: "World archiving is unavailable." };
      const archived = await deps.archiveWorld();
      return { status: "completed", receipt: { kind: "world-archive", id: archived.id, summary: "The world was archived with its history retained." } };
    }
    case "world-chat-world-export": {
      if (!deps.exportWorld) return { status: "failed", detail: "World export is unavailable." };
      const exported = await deps.exportWorld(action.actionId);
      await store.commit({ kind: "world-chat-world-export", source: options.source, files: [], requestId: action.actionId });
      return { status: "completed", receipt: { kind: "world-export", id: exported.id, summary: "The portable world export completed." } };
    }
    case "world-chat-production-create": {
      const result = await createProductionFromPlan(store, payload.plan, options);
      return {
        status: "completed",
        receipt: { kind: "production", id: payload.plan.production.id, summary: `Created ${payload.plan.production.title} in commit ${result.commitId}.` },
      };
    }
    case "world-chat-production-metadata": {
      const result = await updateProductionMetadata(
        store,
        payload.action.productionId,
        payload.action.changes,
        options,
      );
      return {
        status: "completed",
        receipt: { kind: "production", id: payload.action.productionId, summary: `The production metadata was updated in commit ${result.commitId}.` },
      };
    }
    case "world-chat-production-model":
      await setProductionModel(
        store,
        payload.action.productionId,
        payload.action.capability,
        payload.action.modelId,
        options,
      );
      return { status: "completed", receipt: { kind: "production", id: payload.action.productionId, summary: "The production model assignment was updated." } };
    case "world-chat-production-episode-order":
      await reorderEpisodes(store, payload.action.productionId, payload.action.orderedIds, options);
      return { status: "completed", receipt: { kind: "production-order", id: payload.action.productionId, summary: "The episodes were reordered." } };
    case "world-chat-production-chapter-order": {
      const production = store.getBundle().productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      if (!production) throw new Error("That production is no longer in this world.");
      const files = payload.action.orderedIds.map((id) => {
        const chapter = production.chapters.find((candidate) => candidate.id === id);
        if (!chapter) throw new Error(`Chapter ${id} is no longer in this production.`);
        return chapter.file;
      });
      await reorderChapters(store, payload.action.productionId, files, options);
      return { status: "completed", receipt: { kind: "production-order", id: payload.action.productionId, summary: "The chapters were reordered." } };
    }
    case "world-chat-production-scene-order":
      await reorderScenes(store, payload.action.productionId, payload.action.orderedIds, options);
      return { status: "completed", receipt: { kind: "production-order", id: payload.action.productionId, summary: "The scenes were reordered." } };
    case "world-chat-production-scene-delete": {
      const production = store.getBundle().productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      const sceneFile = production?.sceneFiles[payload.action.sceneId];
      if (!sceneFile) throw new Error("That scene is no longer in this production.");
      await deleteScene(store, {
        productionId: payload.action.productionId,
        sceneFile,
        ...options,
      });
      return { status: "completed", receipt: { kind: "scene", id: payload.action.sceneId, summary: "The scene was deleted with its history retained." } };
    }
    case "world-chat-production-scene-restore": {
      const production = store.getBundle().productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      const sceneFile = production?.sceneFiles[payload.action.sceneId];
      if (!sceneFile) throw new Error("That scene is no longer in this production.");
      await restoreScene(store, {
        productionId: payload.action.productionId,
        sceneFile,
        version: payload.action.version,
        ...options,
      });
      return { status: "completed", receipt: { kind: "scene-version", id: payload.action.sceneId, summary: "The selected scene snapshot was restored as a new version." } };
    }
    case "world-chat-production-style":
      await setProductionStyle(
        store,
        payload.action.productionId,
        payload.action.style,
        options,
      );
      return { status: "completed", receipt: { kind: "production", id: payload.action.productionId, summary: "The production style was updated." } };
    case "world-chat-production-scene-command": {
      const production = store.getBundle().productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      const scene = production?.scenes.find((candidate) => candidate.id === payload.action.sceneId);
      const sceneFile = production?.sceneFiles[payload.action.sceneId];
      if (!scene || !sceneFile) throw new Error("That scene is no longer in this production.");
      await applySceneCommand(store, {
        productionId: payload.action.productionId,
        sceneFile,
        sceneId: payload.action.sceneId,
        baseVersion: scene.version,
        command: sceneCommandFrom(payload.action.command),
        requestId: action.actionId,
      });
      return { status: "completed", receipt: { kind: "scene-version", id: `${scene.id}-v${scene.version + 1}`, summary: "The semantic scene command was applied." } };
    }
    case "world-chat-production-board-compile":
    case "world-chat-production-board-export": {
      const production = store.getBundle().productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      const scene = production?.scenes.find((candidate) => candidate.id === payload.action.sceneId);
      const sceneFile = production?.sceneFiles[payload.action.sceneId];
      if (!production || !scene || !sceneFile) throw new Error("That scene is no longer in this production.");
      const png = await compileBoard(store, production, scene, store.getBundle().artifacts);
      if (payload.kind === "world-chat-production-board-compile") {
        await landBoard(store, production.meta.id, sceneFile, png, now, {
          ...options,
          sceneId: scene.id,
          baseVersion: scene.version,
        });
        return { status: "completed", receipt: { kind: "board", id: scene.id, summary: "The scene board was compiled locally." } };
      }
      const file = await exportBoard(store, production.meta.id, scene, png, now, options);
      return { status: "completed", receipt: { kind: "board-export", id: file, summary: "One immutable board artifact was filed." } };
    }
    case "world-chat-production-take-import": {
      if (!deps.importProductionTake) return { status: "failed", detail: "The desktop image picker is unavailable." };
      const result = await deps.importProductionTake(payload.action, options);
      return result.status === "completed"
        ? { status: "completed", receipt: { kind: "take", id: result.id ?? action.actionId, summary: "The image was recorded as an unselected immutable take." } }
        : { status: result.status, detail: result.detail };
    }
    case "world-chat-production-take-generation": {
      if (!deps.openProductionTakeGeneration) return { status: "failed", detail: "The production generator is unavailable." };
      const result = await deps.openProductionTakeGeneration(payload.action, options);
      return result.status === "completed"
        ? { status: "completed", receipt: { kind: "bench-session", id: result.id ?? action.actionId, summary: "The generation intent was opened in Bench; no provider ran and no take was selected." } }
        : { status: "failed", detail: result.detail };
    }
    case "world-chat-production-take-review": {
      const production = store.getBundle().productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      const take = production?.takes.find((candidate) => candidate.id === payload.action.takeId);
      if (!production || !take) throw new Error("That take is no longer in this production.");
      if (payload.action.review.decision === "accept") {
        if (take.kind === "frame" || take.kind === "still") {
          const accepted = await acceptStill(store, production, {
            takeId: take.id,
            shotId: payload.action.review.shotId,
            by: `world-chat:${action.conversationId}`,
            ...(deps.boundaryFrameMaker ? { toPng: deps.boundaryFrameMaker } : {}),
            source: options.source,
            requestId: options.requestId,
            precondition: options.precondition,
          });
          if (!accepted.outcome.ok) throw new Error(accepted.outcome.reason);
          if ("superseded" in accepted.outcome) return { status: "stale", detail: accepted.outcome.reason };
        } else {
          await acceptTake(store, production, {
            takeId: take.id,
            shotId: payload.action.review.shotId,
            by: `world-chat:${action.conversationId}`,
          }, options);
        }
      } else {
        await rejectTake(store, production, {
          takeId: take.id,
          ...(payload.action.review.shotId ? { shotId: payload.action.review.shotId } : {}),
          by: `world-chat:${action.conversationId}`,
          citation: payload.action.review.citation,
        }, options);
      }
      return { status: "completed", receipt: { kind: "take-review", id: take.id, summary: `The take was ${payload.action.review.decision === "accept" ? "accepted and selected" : "rejected with its citation"}.` } };
    }
    case "world-chat-production-take-trim": {
      const production = store.getBundle().productions.find((candidate) => candidate.meta.id === payload.action.productionId);
      if (!production || production.selections[payload.action.shotId]?.acceptedTakeId !== payload.action.takeId) {
        throw new Error("That take is no longer selected for this shot.");
      }
      await setTrim(store, production, {
        shotId: payload.action.shotId,
        trimInSec: payload.action.trimInSec,
      }, options);
      return { status: "completed", receipt: { kind: "take-trim", id: payload.action.shotId, summary: "The selected take's trim-in was updated." } };
    }
    case "world-chat-production-stage-playblast": {
      return { status: "awaiting-host", detail: "Waiting for the desktop renderer to record the Stage." };
    }
    case "world-chat-audio-spine-command": {
      const result = await applyProductionSpineCommand(store, payload.action, {
        source: `world-chat:${action.conversationId}:${action.actionId}`,
        requestId: action.actionId,
        precondition,
      });
      return {
        status: "completed",
        receipt: {
          kind: "audio-spine",
          id: result.commit.commitId,
          summary: result.spine === null ? "The audio spine was deleted." : `The audio spine advanced to revision ${result.spine.revision}.`,
        },
      };
    }
    default:
      return { status: "failed", detail: "That shared-resource action cannot execute." };
  }
}

export function worldChatActionAdapters(
  store: WorldStore,
  gate: ProposalManager | null,
  now: () => string,
  deps: WorldChatActionAdapterDeps = {},
): ConversationActionAuthorityAdapter[] {
  const proposal: ConversationActionAuthorityAdapter = {
    actionKind: "world-chat-proposal",
    prepare: async ({ intent, payload }) => {
      if (!gate) throw new Error("The proposal authority is unavailable.");
      const action = WorldChatProposalActionSchema.parse(payload);
      const staged = await saveProposalPoint(store, gate, intent, action.candidate, action.members, now);
      return proposalProjection(gate, intent, staged);
    },
    recoverPreparation: async (intent) => {
      if (!gate) return null;
      const found = (await gate.listOpen()).filter((candidate) =>
        candidate.worldChatOrigins?.some((origin) => origin.requestId === intent.actionId),
      );
      if (found.length !== 1) return null;
      await settleSaveAttempt(store, intent, [found[0]!.id], now);
      return proposalProjection(gate, intent, found[0]!.id);
    },
    abandonPreparation: async (intent) => {
      if (!gate) return;
      const found = (await gate.listOpen()).filter((candidate) =>
        candidate.worldChatOrigins?.some((origin) => origin.requestId === intent.actionId),
      );
      for (const candidate of found) await sendBack(store, gate, candidate, now);
      await settleSaveAttempt(store, intent, found.map((candidate) => candidate.id), now);
    },
    validate: async (action) => {
      if (!gate) return { ok: false, reason: "blocked", detail: "The proposal authority is unavailable." };
      const checked = await gate.validatePending(action.authority.id, action.authorityRevision);
      return checked.ok
        ? { ok: true }
        : { ok: false, reason: checked.stale ? "stale" : "blocked", detail: checked.detail };
    },
    execute: async (action) => {
      if (!gate) return { status: "failed", detail: "The proposal authority is unavailable." };
      const proposal = await gate.readManifest(action.authority.id);
      const outcome = await acceptDecided(gate, proposal.id);
      if (landed(outcome)) {
        await recordBoundProposalResolution(store, action, "accepted", now);
        const id = outcome.status === "accepted" ? outcome.result.commitId : proposal.id;
        return {
          status: "completed",
          receipt: { kind: "proposal", id, summary: outcome.status === "accepted" ? "The proposal was accepted." : "The world already contained this proposal." },
        };
      }
      return outcome.status === "stale"
        ? { status: "stale", detail: explainAcceptRefusal(outcome) }
        : { status: "failed", detail: explainAcceptRefusal(outcome) };
    },
    deny: async (action) => {
      if (!gate) return;
      const proposal = await gate.readManifest(action.authority.id).catch(() => null);
      if (!proposal) return;
      await recordBoundProposalResolution(store, action, "discarded", now);
      await gate.discard(proposal.id);
    },
    reconcile: async (action) => {
      if (!gate) return null;
      if ((await gate.listOpen()).some((proposal) => proposal.id === action.authority.id)) return null;
      const settled = await settledProposal(store, action.authority.id);
      if (settled) {
        await recordBoundProposalResolution(store, action, "accepted", now);
        return { status: "completed", receipt: { kind: "proposal", ...settled } };
      }
      const candidates = await conversationCandidates(store, action);
      if (candidates.length > 0 && candidates.every((candidate) => candidate.status === "accepted")) {
        return { status: "completed", receipt: { kind: "proposal", id: action.authority.id, summary: "The proposal was accepted." } };
      }
      if (candidates.some((candidate) => candidate.status === "discarded")) {
        return { status: "cancelled", detail: "The proposal was discarded outside this card." };
      }
      return null;
    },
  };

  const bibleProjection = async (intent: ConversationActionPrepareIntent, payload: WorldChatPreparedAction) => {
    const action = WorldChatBibleActionSchema.parse(payload);
    const current = await readBible(store.dir);
    if (current.version !== action.baseVersion) throw new Error("The Bible changed while this action was prepared.");
    let previewText = current.text;
    const fields = action.edits.map((edit) => {
      const before = edit.op === "replace-document"
        ? previewText
        : splitBible(previewText).sections.find(
            (section) => section.heading.trim().toLowerCase() === edit.heading.trim().toLowerCase(),
          )?.body ?? null;
      previewText = applyBibleEdits(previewText, [edit]).text;
      const after = edit.op === "replace-document"
        ? previewText
        : splitBible(previewText).sections.find(
            (section) => section.heading.trim().toLowerCase() === edit.heading.trim().toLowerCase(),
          )?.body ?? null;
      return {
        label: (edit.op === "replace-document" ? "Whole Bible" : edit.heading).slice(0, 200),
        before: clipped(before),
        after: clipped(after),
      };
    });
    const headings = action.edits.map((edit) => edit.op === "replace-document" ? "the whole Bible" : edit.heading);
    await writePreparation(store, "bible", intent.actionId, action);
    return {
      authority: { kind: "bible" as const, id: intent.actionId },
      authorityRevision: action.baseVersion,
      shown: {
        title: headings.length === 1 ? `Edit ${headings[0]}` : `Edit ${headings.length} Bible sections`,
        consequence: "Versions the Bible after applying the shown section edits.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "authored-change" as const,
        body: {
          family: "authored-diff" as const,
          fields,
          conflicts: [],
          openChoices: [],
        },
      },
    };
  };
  const bible: ConversationActionAuthorityAdapter = {
    actionKind: "world-chat-bible-edit",
    prepare: ({ intent, payload }) => bibleProjection(intent, WorldChatBibleActionSchema.parse(payload)),
    recoverPreparation: async (intent) => {
      const payload = await readPreparation(store, "bible", intent);
      return payload ? bibleProjection(intent, payload) : null;
    },
    abandonPreparation: (intent) => removePreparation(store, "bible", intent.actionId),
    validate: async (action) => {
      const prepared = await readPreparation(store, "bible", action);
      if (!prepared) return { ok: false, reason: "blocked", detail: "The prepared Bible edit is unavailable." };
      const current = await readBible(store.dir);
      return current.version === action.authorityRevision
        ? { ok: true }
        : { ok: false, reason: "stale", detail: "The Bible changed after this edit was prepared." };
    },
    execute: async (action) => {
      const prepared = WorldChatBibleActionSchema.parse(await readPreparation(store, "bible", action));
      const record = await applyTurnBibleEdits(store, prepared.edits, {
        source: `world-chat:${action.conversationId}`,
        baseVersion: prepared.baseVersion,
        requestId: action.actionId,
      });
      await removePreparation(store, "bible", action.actionId);
      return {
        status: "completed",
        receipt: { kind: "bible-version", id: `bible-v${record!.toVersion}`, summary: `Bible v${record!.toVersion} was written.` },
      };
    },
    deny: (action) => removePreparation(store, "bible", action.actionId),
    reconcile: async (action) => {
      const commit = await committedAction(store, action.actionId);
      return commit
        ? { status: "completed", receipt: { kind: "bible-version", id: `bible-v${commit.toVersion ?? action.authorityRevision + 1}`, summary: "The Bible edit completed." } }
        : null;
    },
  };

  const sceneProjection = async (intent: ConversationActionPrepareIntent, payload: WorldChatPreparedAction) => {
    const action = WorldChatSceneActionSchema.parse(payload);
    await applySceneEdits(store, {
      entryContext: { kind: "scene", productionId: action.productionId, sceneId: action.sceneId },
      edits: [action.edit],
      baseVersion: action.baseVersion,
      dryRun: true,
    });
    const production = store.getBundle().productions.find((one) => one.meta.id === action.productionId);
    const before = production?.scenes.find((one) => one.id === action.sceneId)?.title ?? null;
    await writePreparation(store, "scene", intent.actionId, action);
    return {
      authority: { kind: "scene-store" as const, id: intent.actionId },
      authorityRevision: action.baseVersion,
      shown: {
        title: "Rename the scene",
        consequence: "Changes the scene title and versions the scene.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "authored-change" as const,
        body: {
          family: "authored-diff" as const,
          fields: [{ label: "Title", before, after: action.edit.title }],
          conflicts: [],
          openChoices: [],
        },
      },
    };
  };
  const scene: ConversationActionAuthorityAdapter = {
    actionKind: "world-chat-scene-edit",
    prepare: ({ intent, payload }) => sceneProjection(intent, WorldChatSceneActionSchema.parse(payload)),
    recoverPreparation: async (intent) => {
      const payload = await readPreparation(store, "scene", intent);
      return payload ? sceneProjection(intent, payload) : null;
    },
    abandonPreparation: (intent) => removePreparation(store, "scene", intent.actionId),
    validate: async (action) => {
      const prepared = await readPreparation(store, "scene", action);
      if (!prepared) return { ok: false, reason: "blocked", detail: "The prepared scene edit is unavailable." };
      const input = WorldChatSceneActionSchema.parse(prepared);
      const current = store.getBundle().productions
        .find((one) => one.meta.id === input.productionId)?.scenes.find((one) => one.id === input.sceneId)?.version;
      return current === input.baseVersion
        ? { ok: true }
        : { ok: false, reason: "stale", detail: "The scene changed after this rename was prepared." };
    },
    execute: async (action) => {
      const prepared = WorldChatSceneActionSchema.parse(await readPreparation(store, "scene", action));
      await applySceneEdits(store, {
        entryContext: { kind: "scene", productionId: prepared.productionId, sceneId: prepared.sceneId },
        edits: [prepared.edit],
        baseVersion: prepared.baseVersion,
        requestId: action.actionId,
      });
      await removePreparation(store, "scene", action.actionId);
      return {
        status: "completed",
        receipt: { kind: "scene-version", id: `${prepared.sceneId}-v${prepared.baseVersion + 1}`, summary: `The scene was renamed at v${prepared.baseVersion + 1}.` },
      };
    },
    deny: (action) => removePreparation(store, "scene", action.actionId),
    reconcile: async (action) => {
      const commit = await committedAction(store, action.actionId);
      return commit
        ? { status: "completed", receipt: { kind: "scene-version", id: commit.commitId, summary: "The scene rename completed." } }
        : null;
    },
  };

  const editorProjection = (
    intent: ConversationActionPrepareIntent,
    request: Pick<ReturnType<typeof editorRequestForAction> extends Promise<infer T> ? NonNullable<T> : never, "id" | "productionId" | "summary" | "commands" | "baseRevision">,
  ): PreparedConversationActionAuthority => {
    const preview = previewProductionEditorRequest(store, request.productionId, { summary: request.summary, commands: request.commands }, now());
    if (!preview.ok) throw new Error(`The editor request can no longer be previewed: ${preview.reason}`);
    const result = [request.summary, ...describeEditorRequestDigest(preview.digest, preview.timeline.frameRate)].join("\n");
    return {
      authority: { kind: "timeline", id: request.id },
      authorityRevision: request.baseRevision ?? 0,
      shown: {
        title: request.summary.slice(0, 200),
        consequence: "Applies every shown effect atomically as one timeline revision and one Undo entry.",
        affectedTargets: [...intent.targets],
        ripples: [],
        permissionReason: "authored-change",
        body: {
          family: "command",
          commands: preview.digest.effects.map((effect) => ({
            label: effect.label.slice(0, 200),
            ...(effect.detail !== undefined ? { detail: clipped(effect.detail, 4_000) ?? undefined } : {}),
          })),
          expectedResult: clipped(result, 4_000) ?? request.summary.slice(0, 4_000),
          undoAvailable: true,
        },
      },
    };
  };
  const editor: ConversationActionAuthorityAdapter = {
    actionKind: "world-chat-editor-request",
    prepare: async ({ intent, payload }) => {
      const action = WorldChatEditorRequestActionSchema.parse(payload);
      const [request] = await stageEditorRequests(store, {
        conversationId: intent.conversationId,
        actionId: intent.actionId,
        entryContext: { kind: "production", productionId: action.productionId },
        requests: [action.request],
        now: now(),
      });
      if (!request) throw new Error("The editor request was not staged.");
      return editorProjection(intent, request);
    },
    recoverPreparation: async (intent) => {
      const action = await editorRequestForAction(store, intent.actionId);
      if (!action) return null;
      return editorProjection(intent, action);
    },
    abandonPreparation: async (intent) => {
      const request = await editorRequestForAction(store, intent.actionId);
      if (!request || request.status !== "pending") return;
      await decideEditorRequest(store, {
        productionId: request.productionId,
        requestId: request.id,
        decision: "reject",
        now: now(),
      });
    },
    validate: async (action) => {
      const current = observationsCurrent(store, action);
      if (!current.ok) return current;
      const checked = await validateEditorRequest(store, action.productionId!, action.authority.id);
      return checked.ok
        ? { ok: true }
        : { ok: false, reason: checked.stale ? "stale" : "blocked", detail: checked.detail };
    },
    execute: async (action) => {
      const request = await decideEditorRequest(store, {
        productionId: action.productionId!,
        requestId: action.authority.id,
        decision: "accept",
        now: now(),
      });
      return {
        status: "completed",
        receipt: { kind: "editor-request", id: request.id, summary: `The timeline request completed at revision ${request.resultRevision}.` },
      };
    },
    deny: async (action) => {
      const current = await readEditorRequest(store, action.productionId!, action.authority.id);
      if (!current || current.status !== "pending") return;
      await decideEditorRequest(store, {
        productionId: action.productionId!,
        requestId: action.authority.id,
        decision: "reject",
        now: now(),
      });
    },
    reconcile: async (action) => {
      const request = await readEditorRequest(store, action.productionId!, action.authority.id);
      if (request?.status === "accepted") {
        return { status: "completed", receipt: { kind: "editor-request", id: request.id, summary: "The timeline request completed." } };
      }
      if (request?.status === "rejected") return { status: "cancelled", detail: "The editor request was rejected outside this card." };
      if (request?.status === "stale") return { status: "stale", detail: request.reason ?? "The editor request became stale." };
      return null;
    },
  };

  const proposalBacked = <T extends WorldChatPreparedAction>(
    actionKind: string,
    parse: (value: unknown) => T,
    stage: (
      intent: ConversationActionPrepareIntent,
      payload: T,
      precondition: WorldStatePrecondition,
    ) => Promise<{ id: string }>,
  ): ConversationActionAuthorityAdapter => ({
    actionKind,
    prepare: async ({ intent, payload }) => {
      if (!gate) throw new Error("The proposal authority is unavailable.");
      const current = observationsCurrent(store, intent);
      if (!current.ok) throw new Error(current.detail);
      const staged = await stage(intent, parse(payload), observationPrecondition(store, intent));
      return proposalProjection(gate, intent, staged.id);
    },
    recoverPreparation: async (intent) => {
      if (!gate) return null;
      const current = observationsCurrent(store, intent);
      if (!current.ok) throw new Error(current.detail);
      const found = (await gate.listOpen()).filter((candidate) => candidate.source === `world-chat-action:${intent.actionId}`);
      return found.length === 1 ? proposalProjection(gate, intent, found[0]!.id) : null;
    },
    abandonPreparation: async (intent) => {
      if (!gate) return;
      const found = (await gate.listOpen()).filter((candidate) => candidate.source === `world-chat-action:${intent.actionId}`);
      for (const candidate of found) await gate.discard(candidate.id);
    },
    validate: async (action) => {
      if (!gate) return { ok: false, reason: "blocked", detail: "The proposal authority is unavailable." };
      const current = observationsCurrent(store, action);
      if (!current.ok) {
        await gate.discard(action.authority.id);
        return current;
      }
      const checked = await gate.validatePending(action.authority.id, action.authorityRevision);
      if (!checked.ok && checked.stale) await gate.discard(action.authority.id);
      if (!checked.ok) {
        return { ok: false, reason: checked.stale ? "stale" : "blocked", detail: checked.detail };
      }
      const currentProjection = await proposalProjection(gate, action, action.authority.id);
      if (conversationActionDigest(currentProjection.shown) !== action.previewDigest) {
        await gate.discard(action.authority.id);
        return { ok: false, reason: "stale", detail: "The proposal preview changed after this card was prepared." };
      }
      return { ok: true };
    },
    execute: async (action) => {
      if (!gate) return { status: "failed", detail: "The proposal authority is unavailable." };
      const proposal = await gate.readManifest(action.authority.id);
      const outcome = await gate.accept(proposal.id, {
        precondition: observationPrecondition(store, action),
      }).catch((error): AcceptOutcome => {
        if (error instanceof WorldStateStaleError) {
          return { status: "stale", stalePaths: [], detail: error.detail };
        }
        throw error;
      });
      if (landed(outcome)) {
        const id = outcome.status === "accepted" ? outcome.result.commitId : proposal.id;
        return {
          status: "completed",
          receipt: {
            kind: "proposal",
            id,
            summary: outcome.status === "accepted" ? "The reviewed world change was accepted." : "The world already contained this change.",
          },
        };
      }
      await gate.discard(proposal.id);
      return outcome.status === "stale" || outcome.status === "needs-reconfirm"
        ? { status: "stale", detail: explainAcceptRefusal(outcome) }
        : { status: "failed", detail: explainAcceptRefusal(outcome) };
    },
    deny: async (action) => {
      if (!gate) return;
      await gate.discard(action.authority.id).catch(() => {});
    },
    reconcile: async (action) => {
      if (!gate) return null;
      if ((await gate.listOpen()).some((candidate) => candidate.id === action.authority.id)) return null;
      const settled = await settledProposal(store, action.authority.id);
      return settled
        ? { status: "completed", receipt: { kind: "proposal", ...settled } }
        : { status: "cancelled", detail: "The proposal was discarded outside this card." };
    },
  });

  const direct = <T extends WorldChatPreparedAction>(
    actionKind: string,
    parse: (value: unknown) => T,
    project: (intent: ConversationActionPrepareIntent, payload: T) => Promise<PreparedConversationActionAuthority>,
    execute: (
      payload: T,
      action: ConversationActionCard,
      precondition: WorldStatePrecondition,
    ) => Promise<CommitResult>,
    receipt: (result: CommitResult | null) => ConversationActionReceipt,
    undo?: (action: ConversationActionCard) => { readonly kind: string; readonly id: string } | null,
  ): ConversationActionAuthorityAdapter => ({
    actionKind,
    prepare: async ({ intent, payload }) => {
      const current = observationsCurrent(store, intent);
      if (!current.ok) throw new Error(current.detail);
      return project(intent, parse(payload));
    },
    recoverPreparation: async (intent) => {
      const payload = await readPreparation(store, "world", intent);
      return payload ? project(intent, parse(payload)) : null;
    },
    abandonPreparation: (intent) => removePreparation(store, "world", intent.actionId),
    validate: async (action) => {
      const payload = await readPreparation(store, "world", action);
      if (!payload) return { ok: false, reason: "blocked", detail: "The prepared world change is unavailable." };
      try {
        parse(payload);
      } catch {
        return { ok: false, reason: "blocked", detail: "The prepared world change is invalid." };
      }
      const current = observationsCurrent(store, action);
      if (!current.ok) await removePreparation(store, "world", action.actionId);
      return current;
    },
    execute: async (action) => {
      const existing = await committedAction(store, action.actionId);
      if (existing) {
        await removePreparation(store, "world", action.actionId);
        return { status: "completed", receipt: receipt(null) };
      }
      const payload = parse(await readPreparation(store, "world", action));
      try {
        const result = await execute(payload, action, observationPrecondition(store, action));
        await removePreparation(store, "world", action.actionId);
        return { status: "completed", receipt: receipt(result) };
      } catch (error) {
        if (error instanceof WorldStateStaleError || error instanceof CommitStaleError) {
          await removePreparation(store, "world", action.actionId);
          return { status: "stale", detail: error instanceof WorldStateStaleError ? error.detail : error.message };
        }
        throw error;
      }
    },
    deny: (action) => removePreparation(store, "world", action.actionId),
    reconcile: async (action) => {
      const committed = await committedAction(store, action.actionId);
      return committed ? { status: "completed", receipt: receipt(null) } : null;
    },
    ...(undo ? { undo } : {}),
  });

  const sharedResource = (actionKind: WorldChatPreparedAction["kind"]): ConversationActionAuthorityAdapter => {
    const parse = (value: unknown): WorldChatPreparedAction => {
      const payload = WorldChatPreparedActionSchema.parse(value);
      if (payload.kind !== actionKind) throw new Error("The prepared shared-resource action has the wrong kind.");
      return payload;
    };
    return {
      actionKind,
      prepare: async ({ intent, payload }) => {
        const current = observationsCurrent(store, intent);
        if (!current.ok) throw new Error(current.detail);
        return sharedResourceProjection(store, intent, parse(payload), deps);
      },
      recoverPreparation: async (intent) => {
        const payload = await readPreparation(store, "world", intent);
        if (!payload) return null;
        const current = observationsCurrent(store, intent);
        if (!current.ok) throw new Error(current.detail);
        return sharedResourceProjection(store, intent, parse(payload), deps);
      },
      abandonPreparation: (intent) => removePreparation(store, "world", intent.actionId),
      validate: async (action) => {
        const payload = await readPreparation(store, "world", action);
        if (!payload) return { ok: false, reason: "blocked", detail: "The prepared shared-resource action is unavailable." };
        const current = observationsCurrent(store, action);
        if (!current.ok) {
          await removePreparation(store, "world", action.actionId);
          return current;
        }
        let projection: PreparedConversationActionAuthority;
        try {
          projection = await sharedResourceProjection(store, action, parse(payload), deps);
        } catch {
          await removePreparation(store, "world", action.actionId);
          return { ok: false, reason: "stale", detail: "The shared resource changed after this card was prepared." };
        }
        if (projection.approvalBlockedReason) {
          return { ok: false, reason: "blocked", detail: projection.approvalBlockedReason };
        }
        if (conversationActionDigest(projection.shown) !== action.previewDigest) {
          await removePreparation(store, "world", action.actionId);
          return { ok: false, reason: "stale", detail: "The action preview changed after this card was prepared." };
        }
        return { ok: true };
      },
      execute: async (action) => {
        const payload = parse(await readPreparation(store, "world", action));
        try {
          const outcome = await executeSharedResource(
            store,
            gate,
            payload,
            action,
            observationPrecondition(store, action),
            now,
            deps,
          );
          if (outcome.status !== "awaiting-host") {
            await removePreparation(store, "world", action.actionId);
          }
          return outcome;
        } catch (error) {
          if (error instanceof WorldStateStaleError || error instanceof CommitStaleError) {
            await removePreparation(store, "world", action.actionId);
            return { status: "stale", detail: error instanceof WorldStateStaleError ? error.detail : error.message };
          }
          throw error;
        }
      },
      deny: (action) => removePreparation(store, "world", action.actionId),
      reconcile: async (action) => {
        if (action.actionKind === "world-chat-production-take-generation") {
          const sessionId = `sess_${action.actionId.slice(4)}`;
          if ((await discoverBenchSessions(store.dir)).some((session) => session.id === sessionId)) {
            await removePreparation(store, "world", action.actionId);
            return {
              status: "completed",
              receipt: {
                kind: "bench-session",
                id: sessionId,
                summary: "The generation intent was opened in Bench; no provider ran and no take was selected.",
              },
            };
          }
        }
        const committed = await committedAction(store, action.actionId);
        if (committed) await removePreparation(store, "world", action.actionId);
        return committed
          ? {
              status: "completed",
              receipt: { kind: action.authority.kind, id: committed.commitId, summary: "The shared-resource action completed." },
            }
          : null;
      },
      ...(actionKind === "world-chat-production-stage-playblast"
        ? {
            completeHost: async (action: ConversationActionCard, value: unknown): Promise<ConversationActionExecutionOutcome> => {
              const parsed = ClientMessageSchema.safeParse(value);
              const message = parsed.success ? parsed.data : null;
              if (
                message?.kind !== "conversation-action-stage-playblast-complete" ||
                message.worldId !== action.worldId ||
                message.conversationId !== action.conversationId ||
                message.actionId !== action.actionId
              ) {
                await removePreparation(store, "world", action.actionId);
                return { status: "failed", detail: "The Stage completion did not match this approved action." };
              }
              if (message.status !== "completed") {
                await removePreparation(store, "world", action.actionId);
                return { status: message.status, detail: message.detail ?? "The Stage recording did not complete." };
              }
              const existing = await committedAction(store, action.actionId);
              if (existing) {
                await removePreparation(store, "world", action.actionId);
                return {
                  status: "completed",
                  receipt: {
                    kind: "stage-playblast",
                    id: existing.commitId,
                    summary: "The playblast and opening frame were already filed and pinned atomically.",
                  },
                };
              }
              const parsedPreparation = WorldChatProductionStagePlayblastActionSchema.safeParse(
                await readPreparation(store, "world", action),
              );
              if (!parsedPreparation.success) {
                await removePreparation(store, "world", action.actionId);
                return { status: "failed", detail: "The prepared Stage action is unavailable." };
              }
              const prepared = parsedPreparation.data;
              if (
                message.productionId !== prepared.action.productionId ||
                message.sceneId !== prepared.action.sceneId ||
                message.shotId !== prepared.action.shotId ||
                message.sceneFile === undefined ||
                message.baseVersion === undefined ||
                message.stagingVersion === undefined ||
                message.durationSec === undefined ||
                message.aspect === undefined ||
                message.sourcePath === undefined ||
                message.openingFrameSourcePath === undefined
              ) {
                await removePreparation(store, "world", action.actionId);
                return { status: "failed", detail: "The Stage completion was incomplete or named another target." };
              }
              try {
                const outcome = await filePlayblast(store, {
                  productionId: message.productionId,
                  sceneFile: message.sceneFile,
                  sceneId: message.sceneId,
                  baseVersion: message.baseVersion,
                  shotId: message.shotId,
                  stagingVersion: message.stagingVersion,
                  sourcePath: message.sourcePath,
                  openingFrameSourcePath: message.openingFrameSourcePath,
                  durationSec: message.durationSec,
                  aspect: message.aspect,
                  ...(message.lens !== undefined ? { lens: message.lens } : {}),
                }, {
                  source: `world-chat:${action.conversationId}:${action.actionId}`,
                  requestId: action.actionId,
                  precondition: observationPrecondition(store, action),
                });
                await removePreparation(store, "world", action.actionId);
                return outcome.outcome === "filed"
                  ? {
                      status: "completed",
                      receipt: {
                        kind: "stage-playblast",
                        id: outcome.artifacts[0].id,
                        summary: "The playblast and opening frame were filed and pinned atomically.",
                      },
                    }
                  : { status: "stale", detail: outcome.reason };
              } catch (error) {
                const committed = await committedAction(store, action.actionId);
                await removePreparation(store, "world", action.actionId);
                if (committed) {
                  return {
                    status: "completed",
                    receipt: {
                      kind: "stage-playblast",
                      id: committed.commitId,
                      summary: "The playblast and opening frame were filed and pinned atomically.",
                    },
                  };
                }
                if (error instanceof WorldStateStaleError || error instanceof CommitStaleError) {
                  return { status: "stale", detail: error instanceof WorldStateStaleError ? error.detail : error.message };
                }
                return { status: "failed", detail: "The host could not file the Stage recording." };
              }
            },
          }
        : {}),
    };
  };

  const sharedResources = [
    "world-chat-artifact-import",
    "world-chat-artifact-metadata",
    "world-chat-artifact-extraction",
    "world-chat-artifact-extraction-stop",
    "world-chat-artifact-extraction-review",
    "world-chat-artifact-reference",
    "world-chat-reference-import",
    "world-chat-reference-result-use",
    "world-chat-reference-review",
    "world-chat-reference-change",
    "world-chat-reference-tile-lock",
    "world-chat-reference-compile",
    "world-chat-reference-style",
    "world-chat-reference-generation",
    "world-chat-reference-image-import",
    "world-chat-reference-world-image-result-use",
    "world-chat-reference-master-look-result-use",
    "world-chat-reference-image-discard",
    "world-chat-voice-assignment",
    "world-chat-voice-audition",
    "world-chat-voice-clone",
    "world-chat-voice-clip-review",
    "world-chat-world-archive",
    "world-chat-world-export",
    "world-chat-production-create",
    "world-chat-production-metadata",
    "world-chat-production-model",
    "world-chat-production-episode-order",
    "world-chat-production-chapter-order",
    "world-chat-production-scene-order",
    "world-chat-production-scene-delete",
    "world-chat-production-scene-restore",
    "world-chat-production-style",
    "world-chat-production-scene-command",
    "world-chat-production-board-compile",
    "world-chat-production-board-export",
    "world-chat-production-take-import",
    "world-chat-production-take-generation",
    "world-chat-production-take-review",
    "world-chat-production-take-trim",
    "world-chat-production-stage-playblast",
    "world-chat-audio-spine-command",
  ] satisfies readonly WorldChatPreparedAction["kind"][];

  const canonAction = proposalBacked(
    "world-chat-canon",
    (value) => WorldChatCanonActionSchema.parse(value),
    (intent, payload, precondition) => {
      if (!gate) throw new Error("The proposal authority is unavailable.");
      return stageWorldChatCanonAction(store, gate, intent, payload, precondition);
    },
  );
  const sheetAction = proposalBacked(
    "world-chat-sheet",
    (value) => WorldChatSheetActionSchema.parse(value),
    (intent, payload, precondition) => {
      if (!gate) throw new Error("The proposal authority is unavailable.");
      return stageWorldChatSheetAction(store, gate, intent, payload, precondition);
    },
  );
  const artDirectionAction = proposalBacked(
    "world-chat-art-direction",
    (value) => WorldChatArtDirectionActionSchema.parse(value),
    (intent, payload, precondition) => {
      if (!gate) throw new Error("The proposal authority is unavailable.");
      return stageWorldChatArtDirectionAction(store, gate, intent, payload, precondition);
    },
  );
  const productionSeries = proposalBacked(
    "world-chat-production-series",
    (value) => WorldChatProductionSeriesActionSchema.parse(value),
    (intent, payload, precondition) => {
      if (!gate) throw new Error("The proposal authority is unavailable.");
      return stageWorldChatProductionAuthoredAction(store, gate, intent, payload, precondition);
    },
  );
  const productionOverview = proposalBacked(
    "world-chat-production-overview",
    (value) => WorldChatProductionOverviewActionSchema.parse(value),
    (intent, payload, precondition) => {
      if (!gate) throw new Error("The proposal authority is unavailable.");
      return stageWorldChatProductionAuthoredAction(store, gate, intent, payload, precondition);
    },
  );
  const productionSeason = proposalBacked(
    "world-chat-production-season",
    (value) => WorldChatProductionSeasonActionSchema.parse(value),
    (intent, payload, precondition) => {
      if (!gate) throw new Error("The proposal authority is unavailable.");
      return stageWorldChatProductionAuthoredAction(store, gate, intent, payload, precondition);
    },
  );
  const productionEpisode = proposalBacked(
    "world-chat-production-episode",
    (value) => WorldChatProductionEpisodeActionSchema.parse(value),
    (intent, payload, precondition) => {
      if (!gate) throw new Error("The proposal authority is unavailable.");
      return stageWorldChatProductionAuthoredAction(store, gate, intent, payload, precondition);
    },
  );
  const productionChapter = proposalBacked(
    "world-chat-production-chapter",
    (value) => WorldChatProductionChapterActionSchema.parse(value),
    (intent, payload, precondition) => {
      if (!gate) throw new Error("The proposal authority is unavailable.");
      return stageWorldChatProductionAuthoredAction(store, gate, intent, payload, precondition);
    },
  );
  const productionScene = proposalBacked(
    "world-chat-production-scene",
    (value) => WorldChatProductionSceneActionSchema.parse(value),
    (intent, payload, precondition) => {
      if (!gate) throw new Error("The proposal authority is unavailable.");
      return stageWorldChatProductionAuthoredAction(store, gate, intent, payload, precondition);
    },
  );
  const worldMetadata = direct(
    "world-chat-world-metadata",
    (value) => WorldChatWorldMetadataActionSchema.parse(value),
    (intent, payload) => metadataProjection(store, intent, payload),
    (payload, action, precondition) => store.updateWorldMetadata(payload.action.changes, `world-chat:${action.conversationId}`, action.actionId, precondition),
    (result) => ({ kind: "world-metadata", id: result?.commitId ?? "world-metadata", summary: "The world metadata was updated." }),
  );
  const canonRetire = direct(
    "world-chat-canon-retire",
    (value) => WorldChatCanonRetireActionSchema.parse(value),
    (intent, payload) => retirementProjection(store, intent, payload),
    (payload, action, precondition) => store.retire(`canon/${payload.action.entryId}.md`, `world-chat:${action.conversationId}`, action.actionId, precondition),
    (result) => ({ kind: "canon-retirement", id: result?.commitId ?? "canon-retirement", summary: "The Canon entry was retired with its history retained." }),
    (action) => ({ kind: "canon-version", id: `${action.targets[0]!.id}:v${action.authorityRevision}` }),
  );
  const sheetRetire = direct(
    "world-chat-sheet-retire",
    (value) => WorldChatSheetRetireActionSchema.parse(value),
    (intent, payload) => retirementProjection(store, intent, payload),
    (payload, action, precondition) => store.retire(`${sheetDir(payload.action.sheetType)}/${payload.action.sheetId}.md`, `world-chat:${action.conversationId}`, action.actionId, precondition),
    (result) => ({ kind: "sheet-retirement", id: result?.commitId ?? "sheet-retirement", summary: "The sheet was retired with its history retained." }),
    (action) => ({ kind: "sheet-version", id: `${action.targets[0]!.kind}:${action.targets[0]!.id}:v${action.authorityRevision}` }),
  );
  const canonRestore = direct(
    "world-chat-canon-restore",
    (value) => WorldChatCanonRestoreActionSchema.parse(value),
    (intent, payload) => restoreProjection(store, intent, payload),
    (payload, action, precondition) => store.restoreVersion(`canon/${payload.action.entryId}.md`, payload.action.version, `world-chat:${action.conversationId}`, action.actionId, precondition),
    (result) => ({ kind: "canon-version", id: result?.commitId ?? "canon-version", summary: "The selected Canon snapshot was restored as a new revision." }),
  );
  const sheetRestore = direct(
    "world-chat-sheet-restore",
    (value) => WorldChatSheetRestoreActionSchema.parse(value),
    (intent, payload) => restoreProjection(store, intent, payload),
    (payload, action, precondition) => store.restoreVersion(`${sheetDir(payload.action.sheetType)}/${payload.action.sheetId}.md`, payload.action.version, `world-chat:${action.conversationId}`, action.actionId, precondition),
    (result) => ({ kind: "sheet-version", id: result?.commitId ?? "sheet-version", summary: "The selected sheet snapshot was restored as a new version." }),
  );
  const artDirectionRestore = direct(
    "world-chat-art-direction-restore",
    (value) => WorldChatArtDirectionRestoreActionSchema.parse(value),
    (intent, payload) => restoreProjection(store, intent, payload),
    (payload, action, precondition) => store.restoreVersion(ART_DIRECTION_PATH, payload.action.version, `world-chat:${action.conversationId}`, action.actionId, precondition),
    (result) => ({ kind: "art-direction-version", id: result?.commitId ?? "art-direction-version", summary: "The selected art direction was restored as a new version." }),
  );

  return [
    proposal,
    bible,
    scene,
    editor,
    worldMetadata,
    canonAction,
    canonRetire,
    canonRestore,
    sheetAction,
    sheetRetire,
    sheetRestore,
    artDirectionAction,
    artDirectionRestore,
    productionSeries,
    productionOverview,
    productionSeason,
    productionEpisode,
    productionChapter,
    productionScene,
    ...sharedResources.map(sharedResource),
  ];
}

async function saveProposalPoint(
  store: WorldStore,
  gate: ProposalManager,
  intent: ConversationActionPrepareIntent,
  candidate: { candidateId: string; revision: number },
  members: readonly { candidateId: string; revision: number }[],
  now: () => string,
): Promise<string> {
  const { savePoint } = await import("./wrapup.js");
  const staged = await savePoint({
    store,
    gate,
    conversationId: intent.conversationId,
    requestId: intent.actionId,
    candidateId: candidate.candidateId,
    expectedCandidateRevision: candidate.revision,
    expectedGroupRevisions: [...members],
    now,
  });
  if (staged.proposalIds.length !== 1) throw new Error("A conversation action must bind one proposal authority.");
  return staged.proposalIds[0]!;
}
