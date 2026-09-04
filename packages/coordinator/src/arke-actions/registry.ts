import {
  ClientMessageSchema,
  WorldChatBibleActionSchema,
  WorldChatEditorRequestActionSchema,
  WorldChatProposalActionSchema,
  WorldChatSceneActionSchema,
  WorldChatArtDirectionActionSchema,
  WorldChatArtDirectionRestoreActionSchema,
  WorldChatCanonActionSchema,
  WorldChatCanonRestoreActionSchema,
  WorldChatCanonRetireActionSchema,
  WorldChatSheetActionSchema,
  WorldChatSheetRestoreActionSchema,
  WorldChatSheetRetireActionSchema,
  WorldChatWorldMetadataActionSchema,
  type ArkeActionAuthority,
  type ArkeActionScope,
  type ArkeActionSupport,
  type ArkeBlockingSeam,
  type ArkeCardFamily,
  type ArkeClientCommandDescriptor,
  type ArkeCommandClassification,
  type ArkePermissionReason,
  type ArkeReadRequirement,
  type ArkeSupportedClientCommand,
  type ClientMessageKind,
  type ClientMessageOfKind,
} from "@arke-studio/contracts";
import { z } from "zod";

type SupportedMetadata = Omit<ArkeSupportedClientCommand<ClientMessageKind>, "kind" | "schema">;
type ExcludedMetadata = {
  readonly classification: Exclude<ArkeCommandClassification, "supported-by-arke">;
  readonly reason: string;
};
type CommandMetadata = SupportedMetadata | ExcludedMetadata;

const AVAILABLE = { state: "available" } as const;

function blocked(blockingSeams: readonly ArkeBlockingSeam[], reason: string) {
  return { state: "blocked", blockingSeams, reason } as const;
}

function action(
  scope: ArkeActionScope,
  cardFamily: ArkeCardFamily,
  authority: ArkeActionAuthority,
  permissionReason: ArkePermissionReason,
  requiredReads: readonly ArkeReadRequirement[],
  support: Partial<ArkeActionSupport> = {},
): SupportedMetadata {
  return {
    classification: "supported-by-arke",
    scope,
    cardFamily,
    authority,
    permissionReason,
    requiredReads,
    support: {
      preparation: support.preparation ?? AVAILABLE,
      reads: support.reads ?? AVAILABLE,
      execution: support.execution ?? AVAILABLE,
    },
  };
}

const readOnly = (reason: string): ExcludedMetadata => ({ classification: "read-only", reason });
const humanOnly = (reason: string): ExcludedMetadata => ({
  classification: "human-only-control-plane",
  reason,
});
const globalOnly = (reason: string): ExcludedMetadata => ({
  classification: "out-of-scope-global",
  reason,
});

const QUERY = "This command retrieves or projects state and does not mutate a creative target.";
const HUMAN_DECISION = "This is a user decision, approval, recovery, or conversation control; Arke cannot invoke it.";
const GLOBAL_OPERATION = "This changes application, account, credential, installation, or pre-world state outside an open world.";
const RECURSIVE_AGENT = "This launches or controls another authoring turn; Arke must propose the underlying typed change instead.";
const GENERATION_QUOTE = blocked(
  ["durable-generation-quote"],
  "A durable coordinator-owned quote and permission-card binding are required before this generation can be prepared.",
);
const COORDINATOR_QUOTE = blocked(
  ["coordinator-owned-generation-quote"],
  "Quote identity, signature, and amount are coordinator-owned and cannot be supplied in a model action.",
);
const SHEET_TARGET = blocked(
  ["typed-sheet-target"],
  "The client command still targets a sheet by path; a typed sheet kind and id seam is required for Arke.",
);
const MEDIA_TARGET = blocked(
  ["typed-media-target"],
  "The client command still selects media by a free filename; a typed candidate or artifact id seam is required for Arke.",
);
const SCENE_TARGET = blocked(
  ["typed-scene-target"],
  "The client command still targets a scene file directly; a typed scene id seam is required for Arke.",
);
const CHAPTER_TARGET = blocked(
  ["typed-chapter-target"],
  "The client command still targets chapter files directly; a typed chapter id seam is required for Arke.",
);
const ARTIFACT_SOURCE = blocked(
  ["typed-artifact-source"],
  "The client command carries a host path; Arke requires a picker-mediated or already-filed artifact id seam.",
);
const COMPLETE_TIMELINE_READ = AVAILABLE;

/**
 * The explicit parity fixture. Every ClientMessage discriminator appears once, even when the
 * honest answer is that it is read-only, global, or reserved for the person at the controls.
 */
const CLIENT_COMMAND_METADATA = {
  hello: readOnly("Transport handshake handled before coordinator dispatch."),
  "open-world": readOnly("Opens an existing world for reading; it does not alter that world."),
  "create-world": globalOnly("World creation happens before there is an open-world scope for Arke."),
  "read-sheet-section": readOnly(QUERY),
  "read-bible-section": readOnly(QUERY),
  "generate-world-image": action("world", "generation", "job-queue", "spend-and-compute", ["world-metadata", "art-direction"], { preparation: GENERATION_QUOTE }),
  "upload-world-image": action("world", "host-action", "host", "host-file-access", ["world-metadata"]),
  "use-world-image": action("world", "authored-diff", "world-store", "authored-change", ["world-metadata", "references"], { preparation: MEDIA_TARGET }),
  "discard-world-image": action("world", "destructive", "world-store", "destructive-change", ["world-metadata", "references"]),
  "generate-master-look": action("world", "generation", "job-queue", "spend-and-compute", ["art-direction", "references"], { preparation: GENERATION_QUOTE }),
  "pick-staged-reference": action("world", "host-action", "host", "host-file-access", ["references"]),
  "clear-staged-reference": action("world", "command", "world-store", "destructive-change", ["references"]),
  "upload-master-look": action("world", "host-action", "host", "host-file-access", ["art-direction"]),
  "use-master-look": action("world", "authored-diff", "proposal-manager", "authored-change", ["art-direction", "references"], { preparation: MEDIA_TARGET }),
  "discard-master-look": action("world", "destructive", "world-store", "destructive-change", ["art-direction", "references"]),
  "archive-world": action("world", "destructive", "world-store", "world-administration", ["world-metadata", "jobs"]),
  "install-sample-world": globalOnly(GLOBAL_OPERATION),
  "reconcile-external-edit": humanOnly("Adopting an external filesystem edit is a human recovery control."),
  "stage-sheet-edit": action("world", "authored-diff", "proposal-manager", "authored-change", ["sheets", "canon"], { preparation: SHEET_TARGET, execution: SHEET_TARGET }),
  "restore-sheet-version": action("world", "authored-diff", "world-store", "authored-change", ["sheets"], { preparation: SHEET_TARGET, execution: SHEET_TARGET }),
  "stage-art-direction-change": action("world", "authored-diff", "proposal-manager", "authored-change", ["art-direction"]),
  "set-art-direction": action("world", "authored-diff", "proposal-manager", "authored-change", ["art-direction"]),
  "proposal-accept": humanOnly(HUMAN_DECISION),
  "proposal-discard": humanOnly(HUMAN_DECISION),
  "proposal-rebase": humanOnly(HUMAN_DECISION),
  "proposal-resolve-conflict": humanOnly(HUMAN_DECISION),
  "proposal-mark-seen": humanOnly(HUMAN_DECISION),
  "proposal-resolve-choice": humanOnly(HUMAN_DECISION),
  "proposal-update-field": humanOnly(HUMAN_DECISION),
  "world-chat-open": readOnly("Selects a conversation projection; it does not mutate creative state."),
  "conversation-action-decide": humanOnly("Only the local person may approve or deny a prepared conversation action."),
  "world-chat-send": humanOnly("Only the person may add a user message; Arke cannot converse with or prompt itself."),
  "world-chat-wrap-up": humanOnly(HUMAN_DECISION),
  "world-chat-save-point": humanOnly(HUMAN_DECISION),
  "world-chat-reject-point": humanOnly(HUMAN_DECISION),
  "world-chat-open-media": humanOnly(HUMAN_DECISION),
  "world-chat-retry-turn": humanOnly(HUMAN_DECISION),
  "proposal-send-back": humanOnly(HUMAN_DECISION),
  "world-chat-cancel": humanOnly(HUMAN_DECISION),
  "world-chat-create": humanOnly("Conversation creation is a human control; Arke cannot recursively create a conversation."),
  "world-chat-delete": humanOnly(HUMAN_DECISION),
  "world-chat-set-initiative": humanOnly(HUMAN_DECISION),
  "world-chat-archive": humanOnly(HUMAN_DECISION),
  "world-chat-unarchive": humanOnly(HUMAN_DECISION),
  "world-chat-attach": humanOnly("Attaching private host material to a conversation is a human evidence-control gesture."),
  "world-chat-attach-files": humanOnly("Opening the private conversation attachment picker is a human evidence-control gesture."),
  "world-chat-promote-attachment": humanOnly("Only the person may file private conversation evidence into the world."),
  "draft-with-studio": humanOnly(RECURSIVE_AGENT),
  "authoring-cancel": humanOnly(HUMAN_DECISION),
  "setup-skip": globalOnly(GLOBAL_OPERATION),
  "setup-retry": globalOnly(GLOBAL_OPERATION),
  "setup-repair": globalOnly(GLOBAL_OPERATION),
  "setup-cancel": globalOnly(GLOBAL_OPERATION),
  "genesis-chat": globalOnly("Genesis is a pre-world conversation and cannot be targeted from an open world."),
  "genesis-discard": globalOnly("Genesis sandbox lifecycle is outside an open world."),
  "plan-founding-build": globalOnly("Founding plans create a world and are outside an open-world scope."),
  "begin-founding-build": globalOnly("Founding creates a world and cannot be approved by Arke inside one."),
  "stop-founding-build": humanOnly("Stopping an in-flight founding build is a human recovery control."),
  "plan-key-art": readOnly(QUERY),
  "generate-look-preview": globalOnly("The preview belongs to a pre-world genesis sandbox."),
  "run-build-item": action("world", "generation", "job-queue", "spend-and-compute", ["world-metadata", "references", "jobs"], { preparation: GENERATION_QUOTE }),
  "dismiss-build-notice": humanOnly("Dismissing a user-facing completion notice is a human interface control."),
  "permission-reply": humanOnly("A model may never answer or remember a harness permission request."),
  "canon-ask": readOnly(QUERY),
  "canon-search": readOnly(QUERY),
  "canon-refs": readOnly(QUERY),
  "stage-canon-entry": action("world", "authored-diff", "proposal-manager", "authored-change", ["canon"]),
  "stage-canon-amendment": action("world", "authored-diff", "proposal-manager", "authored-change", ["canon"]),
  "open-thread": action("world", "authored-diff", "proposal-manager", "authored-change", ["canon"]),
  "settle-thread": action("world", "authored-diff", "proposal-manager", "authored-change", ["canon"]),
  "retire-entity": action("world", "destructive", "world-store", "destructive-change", ["canon", "sheets"], { preparation: SHEET_TARGET, execution: SHEET_TARGET }),
  "undo-single-act": action("world", "command", "world-store", "authored-change", ["canon", "sheets", "art-direction"], { preparation: SHEET_TARGET, execution: SHEET_TARGET }),
  "canon-contradictions": readOnly(QUERY),
  "create-sheet-from-sentence": action("world", "authored-diff", "proposal-manager", "authored-change", ["sheets", "canon"], {
    preparation: blocked(["typed-sheet-target"], "The client shape includes a settle bypass; Arke needs a typed sheet draft that can only prepare a card."),
  }),
  "promote-guest": action("world", "authored-diff", "proposal-manager", "authored-change", ["sheets"], { preparation: SHEET_TARGET, execution: SHEET_TARGET }),
  "duplicate-sheet": action("world", "authored-diff", "proposal-manager", "authored-change", ["sheets"], { preparation: SHEET_TARGET, execution: SHEET_TARGET }),
  "set-sheet-status": action("world", "authored-diff", "proposal-manager", "authored-change", ["sheets"], { preparation: SHEET_TARGET, execution: SHEET_TARGET }),
  "rename-world": action("world", "authored-diff", "world-store", "authored-change", ["world-metadata"]),
  "rename-sheet": action("world", "authored-diff", "proposal-manager", "authored-change", ["sheets"], { preparation: SHEET_TARGET, execution: SHEET_TARGET }),
  "assign-voice": action("world", "setting", "proposal-manager", "authored-change", ["sheets", "voices"], { preparation: SHEET_TARGET, execution: SHEET_TARGET }),
  "sheet-refs": readOnly(QUERY),
  "set-credential": globalOnly(GLOBAL_OPERATION),
  "clear-credential": globalOnly(GLOBAL_OPERATION),
  "validate-provider": readOnly("Checks provider capability without changing a creative target."),
  "sign-in-provider-tool": globalOnly(GLOBAL_OPERATION),
  "cancel-provider-tool-sign-in": globalOnly(GLOBAL_OPERATION),
  "refresh-provider-tool": readOnly("Refreshes provider availability without changing a creative target."),
  "select-provider-workspace": globalOnly(GLOBAL_OPERATION),
  "refresh-vendor-auth": readOnly("Refreshes vendor connection status without changing a creative target."),
  "begin-vendor-sign-in": globalOnly(GLOBAL_OPERATION),
  "submit-vendor-sign-in-code": globalOnly(GLOBAL_OPERATION),
  "submit-vendor-key": globalOnly(GLOBAL_OPERATION),
  "cancel-vendor-sign-in": globalOnly(GLOBAL_OPERATION),
  "remove-vendor-connection": globalOnly(GLOBAL_OPERATION),
  "set-routing-default": globalOnly(GLOBAL_OPERATION),
  "set-model-enabled": globalOnly(GLOBAL_OPERATION),
  "set-research-web": globalOnly(GLOBAL_OPERATION),
  "set-agent-config": globalOnly(GLOBAL_OPERATION),
  "list-harness-models": readOnly(QUERY),
  "set-spend-threshold": globalOnly(GLOBAL_OPERATION),
  "detect-runtimes": readOnly(QUERY),
  "detect-harnesses": readOnly(QUERY),
  "set-harness-engine": globalOnly(GLOBAL_OPERATION),
  "choose-claude-executable": globalOnly(GLOBAL_OPERATION),
  "clear-claude-executable": globalOnly(GLOBAL_OPERATION),
  "choose-voxa-executable": globalOnly(GLOBAL_OPERATION),
  "clear-voxa-executable": globalOnly(GLOBAL_OPERATION),
  "use-bundled-voxa": globalOnly(GLOBAL_OPERATION),
  "restart-voxa": globalOnly(GLOBAL_OPERATION),
  "choose-comfyui-path": globalOnly(GLOBAL_OPERATION),
  "choose-comfyui-models-dir": globalOnly(GLOBAL_OPERATION),
  "clear-comfyui-models-dir": globalOnly(GLOBAL_OPERATION),
  "set-comfyui-url": globalOnly(GLOBAL_OPERATION),
  "clear-comfyui-engine": globalOnly(GLOBAL_OPERATION),
  "use-detected-comfyui": globalOnly(GLOBAL_OPERATION),
  "comfyui-refresh": readOnly(QUERY),
  "comfyui-restart": globalOnly(GLOBAL_OPERATION),
  "setup-install": globalOnly(GLOBAL_OPERATION),
  "setup-remove": globalOnly(GLOBAL_OPERATION),
  "comfyui-verify-recipe": readOnly(QUERY),
  "repair-voice-models": globalOnly(GLOBAL_OPERATION),
  "open-model-folder": globalOnly(GLOBAL_OPERATION),
  "test-local-voice": readOnly("Produces a transient local test read and does not change a creative target."),
  "set-background-notifications": globalOnly(GLOBAL_OPERATION),
  "set-appearance-theme": globalOnly(GLOBAL_OPERATION),
  "set-narrator": globalOnly(GLOBAL_OPERATION),
  "cancel-job": humanOnly("Cancelling a globally addressed job is a human recovery control until jobs have a world-confined action seam."),
  "list-provider-calls": readOnly(QUERY),
  "retry-job-finalization": humanOnly(HUMAN_DECISION),
  "delete-job": globalOnly("Activity-history deletion is application-global and does not delete a creative result."),
  "resolve-held-job": humanOnly(HUMAN_DECISION),
  "queue-resume": humanOnly("Resuming a provider queue is an explicit human spend-recovery confirmation."),
  "establish-look": action("world", "generation", "job-queue", "spend-and-compute", ["sheets", "art-direction", "references"], { preparation: GENERATION_QUOTE }),
  "choose-anchor": action("world", "take-review", "reference-kit", "authored-change", ["sheets", "references", "takes"]),
  "generate-location-view": action("world", "generation", "job-queue", "spend-and-compute", ["sheets", "art-direction", "references"], { preparation: GENERATION_QUOTE }),
  "import-location-view-candidate": action("world", "host-action", "host", "host-file-access", ["sheets", "references"]),
  "accept-location-view": action("world", "take-review", "reference-kit", "authored-change", ["sheets", "references", "takes"]),
  "import-main-photo-candidate": action("world", "host-action", "host", "host-file-access", ["sheets", "references"]),
  "import-main-photo": action("world", "host-action", "host", "host-file-access", ["sheets", "references"]),
  "import-character-sheet": action("world", "host-action", "host", "host-file-access", ["sheets", "references"]),
  "generate-main-photo": action("world", "generation", "job-queue", "spend-and-compute", ["sheets", "art-direction", "references"], { preparation: GENERATION_QUOTE }),
  "generate-character-sheet": action("world", "generation", "job-queue", "spend-and-compute", ["sheets", "art-direction", "references"], { preparation: GENERATION_QUOTE }),
  "accept-character-sheet": action("world", "take-review", "reference-kit", "authored-change", ["sheets", "references", "takes"]),
  "generate-character-looks": action("world", "generation", "job-queue", "spend-and-compute", ["sheets", "art-direction", "references"], { preparation: GENERATION_QUOTE }),
  "accept-character-look": action("world", "take-review", "reference-kit", "authored-change", ["sheets", "references", "takes"]),
  "reject-reference-take": action("world", "take-review", "take-review", "authored-change", ["sheets", "takes"]),
  "promote-character-look": action("world", "authored-diff", "reference-kit", "authored-change", ["sheets", "references"]),
  "attach-character-look": action("world", "authored-diff", "reference-kit", "authored-change", ["sheets", "references", "production-metadata", "scenes"]),
  "lock-tile": action("world", "take-review", "reference-kit", "authored-change", ["sheets", "references"]),
  "generate-missing-tiles": action("world", "generation", "job-queue", "spend-and-compute", ["sheets", "art-direction", "references"], { preparation: GENERATION_QUOTE }),
  "regenerate-tile": action("world", "generation", "job-queue", "spend-and-compute", ["sheets", "art-direction", "references"], { preparation: GENERATION_QUOTE }),
  "compile-grid": action("world", "command", "reference-kit", "spend-and-compute", ["sheets", "references"]),
  "designate-compilation": action("world", "authored-diff", "reference-kit", "authored-change", ["sheets", "references"], { preparation: MEDIA_TARGET }),
  "set-style-override": action("world", "setting", "reference-kit", "authored-change", ["sheets", "art-direction"]),
  "voice-candidates": readOnly(QUERY),
  "voice-catalogue": readOnly(QUERY),
  "voice-line": action("production", "generation", "voice", "privacy-sensitive", ["sheets", "voices", "scenes", "shots"], { preparation: GENERATION_QUOTE }),
  "voice-preview": action("world", "generation", "voice", "privacy-sensitive", ["sheets", "voices"], { preparation: GENERATION_QUOTE }),
  "transcribe-dictation": readOnly("Returns transient local transcription and does not mutate a creative target."),
  "create-production": action("world", "command", "production-store", "authored-change", ["world-metadata", "series"]),
  "propose-story-overview": action("production", "authored-diff", "proposal-manager", "authored-change", ["production-metadata", "series"]),
  "draft-story-overview": humanOnly(RECURSIVE_AGENT),
  "propose-season": action("production", "authored-diff", "proposal-manager", "authored-change", ["production-metadata", "seasons", "episodes"]),
  "create-episode": action("production", "command", "production-store", "authored-change", ["production-metadata", "episodes"]),
  "propose-episode": action("production", "authored-diff", "proposal-manager", "authored-change", ["production-metadata", "episodes", "scenes"]),
  "reorder-episodes": action("production", "command", "production-store", "authored-change", ["episodes"]),
  "draft-scene": humanOnly(RECURSIVE_AGENT),
  "create-scene": action("production", "command", "scene-store", "authored-change", ["production-metadata", "episodes", "scenes"]),
  "restore-scene": action("production", "authored-diff", "scene-store", "authored-change", ["scenes"]),
  "delete-scene": action("production", "destructive", "scene-store", "destructive-change", ["scenes", "episodes", "takes", "routing"]),
  "scene-command": action("production", "command", "scene-store", "authored-change", ["scenes", "shots", "stage", "boards"]),
  "create-chapter": action("production", "command", "chapter-store", "authored-change", ["chapters"]),
  "save-chapter": action("production", "authored-diff", "chapter-store", "authored-change", ["chapters"], { preparation: CHAPTER_TARGET, execution: CHAPTER_TARGET }),
  "save-bible": action("world", "authored-diff", "bible", "authored-change", ["bible"]),
  "restore-bible": action("world", "authored-diff", "bible", "authored-change", ["bible"]),
  "draft-chapter": humanOnly(RECURSIVE_AGENT),
  "reorder-chapters": action("production", "command", "chapter-store", "authored-change", ["chapters"], { preparation: CHAPTER_TARGET, execution: CHAPTER_TARGET }),
  "reorder-scenes": action("production", "command", "production-store", "authored-change", ["scenes", "episodes"]),
  "set-production-aspect": action("production", "setting", "production-store", "authored-change", ["production-metadata"]),
  "set-production-model": action("production", "setting", "production-store", "authored-change", ["production-metadata"]),
  "frame-run-quote": readOnly("Computes a quote and changes no target or spend authority."),
  "frame-run-start": action("production", "generation", "frame-run", "spend-and-compute", ["production-metadata", "scenes", "shots", "boards", "references", "jobs"], { preparation: COORDINATOR_QUOTE }),
  "frame-run-pause": action("production", "command", "frame-run", "external-network-action", ["jobs"]),
  "frame-run-resume": action("production", "generation", "frame-run", "spend-and-compute", ["jobs"]),
  "frame-run-cancel": action("production", "command", "frame-run", "external-network-action", ["jobs"]),
  "frame-run-retry-step": action("production", "generation", "frame-run", "spend-and-compute", ["jobs"]),
  "frame-run-retry-cell": action("production", "generation", "frame-run", "spend-and-compute", ["jobs", "shots"]),
  "frame-run-list": readOnly(QUERY),
  "frame-run-dismiss": humanOnly("Dismissing a run from the person's workspace is a human interface control."),
  "dispatch-scene-planned": action("production", "generation", "dispatch-plan", "spend-and-compute", ["scenes", "shots", "references", "plans", "jobs"], { preparation: GENERATION_QUOTE }),
  "plan-continue": humanOnly("Continuing a review-gated plan is an explicit human authorization."),
  "plan-reconfirm": humanOnly("Reconfirming changed spend is an explicit human authorization."),
  "plan-cancel": action("production", "command", "dispatch-plan", "external-network-action", ["plans", "jobs"]),
  "list-plans": readOnly(QUERY),
  "save-routing": action("production", "command", "routing", "authored-change", ["routing", "scenes"], {
    preparation: blocked(["typed-routing-command"], "Routing is still submitted as unknown JSON; semantic route-edit commands are required."),
    execution: blocked(["typed-routing-command"], "Routing has no semantic command seam for an action adapter."),
  }),
  "record-traversal": action("production", "command", "routing", "authored-change", ["routing", "scenes"]),
  "list-routing-findings": readOnly(QUERY),
  "propose-branch-canon": action("production", "authored-diff", "proposal-manager", "authored-change", ["routing", "scenes", "canon"]),
  "export-interactive": action("production", "host-action", "export", "export", ["routing", "scenes", "artifacts", "exports"]),
  "compile-scene-board": action("production", "command", "board", "spend-and-compute", ["scenes", "shots", "boards"], { preparation: SCENE_TARGET, execution: SCENE_TARGET }),
  "export-scene-board": action("production", "host-action", "export", "export", ["scenes", "shots", "boards", "exports"], { preparation: SCENE_TARGET, execution: SCENE_TARGET }),
  "dispatch-scene": action("production", "generation", "job-queue", "spend-and-compute", ["scenes", "shots", "references", "jobs"], {
    preparation: blocked(["typed-scene-target", "durable-generation-quote"], "The scene target and spend quote must both become coordinator-owned typed inputs."),
  }),
  "record-review": action("production", "take-review", "take-review", "authored-change", ["takes", "shots", "sheets"]),
  "accept-take": action("production", "take-review", "take-review", "authored-change", ["takes", "shots", "scenes"]),
  "import-shot-frame": action("production", "host-action", "host", "host-file-access", ["shots", "takes"]),
  "stage-playblast": action("production", "host-action", "scene-store", "host-file-access", ["scenes", "shots", "stage"], { preparation: ARTIFACT_SOURCE }),
  "reject-take": action("production", "take-review", "take-review", "authored-change", ["takes", "shots", "sheets"]),
  "set-trim": action("production", "command", "take-review", "authored-change", ["takes", "shots"]),
  "timeline-move-picture": action("production", "command", "timeline", "authored-change", ["timeline", "shots"], { reads: COMPLETE_TIMELINE_READ }),
  "timeline-command": action("production", "command", "timeline", "authored-change", ["timeline", "shots", "takes", "artifacts", "subtitles", "audio"], { reads: COMPLETE_TIMELINE_READ }),
  "editor-request-decide": humanOnly("Only the person may accept or reject an existing Arke editor request."),
  "timeline-history": action("production", "command", "timeline", "authored-change", ["timeline"], { reads: COMPLETE_TIMELINE_READ }),
  "save-audio-tracks": action("production", "command", "audio-cut", "authored-change", ["audio", "timeline"], {
    preparation: blocked(["typed-audio-command"], "Audio tracks are still submitted as unknown cut JSON; semantic audio commands are required."),
    execution: blocked(["typed-audio-command"], "The audio cut has no semantic command seam for an action adapter."),
  }),
  "upload-artifacts": action("world", "host-action", "host", "host-file-access", ["artifacts"]),
  "place-overlay": action("production", "command", "timeline", "authored-change", ["timeline", "artifacts"], { reads: COMPLETE_TIMELINE_READ }),
  "move-overlay": action("production", "command", "timeline", "authored-change", ["timeline", "artifacts"], { reads: COMPLETE_TIMELINE_READ }),
  "split-overlay-audio": action("production", "command", "timeline", "authored-change", ["timeline", "artifacts", "audio"], { reads: COMPLETE_TIMELINE_READ }),
  "rejoin-overlay-audio": action("production", "command", "timeline", "authored-change", ["timeline", "artifacts", "audio"], { reads: COMPLETE_TIMELINE_READ }),
  "remove-overlay": action("production", "destructive", "timeline", "destructive-change", ["timeline", "artifacts"], { reads: COMPLETE_TIMELINE_READ }),
  "export-cut": action("production", "host-action", "export", "export", ["production-metadata", "timeline", "takes", "audio", "subtitles", "exports"], { reads: COMPLETE_TIMELINE_READ }),
  "timeline-transcribe": action("production", "generation", "timeline", "privacy-sensitive", ["timeline", "audio", "subtitles"], { reads: COMPLETE_TIMELINE_READ }),
  "timeline-assemble": action("production", "command", "timeline", "authored-change", ["timeline", "scenes", "shots", "takes", "spine"], { reads: COMPLETE_TIMELINE_READ }),
  "cancel-export": action("world", "command", "export", "external-network-action", ["exports"]),
  "export-world": action("world", "host-action", "export", "export", ["world-metadata", "artifacts", "exports"]),
  "file-artifact": action("world", "host-action", "artifact-store", "host-file-access", ["artifacts"], { preparation: ARTIFACT_SOURCE }),
  "attach-files": action("world", "host-action", "host", "host-file-access", ["artifacts"]),
  "genesis-attach": globalOnly("Genesis attachments belong to a pre-world sandbox."),
  "genesis-attach-files": globalOnly("Genesis attachments belong to a pre-world sandbox."),
  "clone-voice": action("world", "generation", "voice", "privacy-sensitive", ["voices", "sheets", "artifacts"]),
  "stage-voice-clip": action("world", "host-action", "voice", "privacy-sensitive", ["voices"]),
  "discard-voice-clip": humanOnly("Discarding a temporary clip is part of the person's host recording workflow."),
  "import-folder": action("world", "host-action", "artifact-store", "host-file-access", ["artifacts"], { preparation: ARTIFACT_SOURCE }),
  "extract-artifact": action("world", "generation", "extraction", "external-network-action", ["artifacts", "canon", "sheets"]),
  "stop-extraction": action("world", "command", "extraction", "external-network-action", ["artifacts", "jobs"]),
  "resolve-extraction": action("world", "take-review", "proposal-manager", "authored-change", ["artifacts", "canon", "sheets"]),
  "check-updates": readOnly(QUERY),
  "download-update": globalOnly(GLOBAL_OPERATION),
  "install-update-and-restart": globalOnly(GLOBAL_OPERATION),
  "install-update-on-close": globalOnly(GLOBAL_OPERATION),
  "acknowledge-update": globalOnly(GLOBAL_OPERATION),
  "generate-diagnostics": globalOnly(GLOBAL_OPERATION),
  "refresh-diagnostics": readOnly(QUERY),
  "open-data-folder": globalOnly(GLOBAL_OPERATION),
  "bench-open": humanOnly("Opening or implicitly creating a Bench session is a human workspace control."),
  "bench-open-subject": humanOnly("Opening a subject in Bench is a human handoff control, not an action on that subject."),
  "bench-rebuild-subject": action("production", "command", "bench", "authored-change", ["bench", "production-metadata", "scenes", "shots", "boards"]),
  "bench-new-session": humanOnly("Creating a blank Bench workspace is a human workspace control."),
  "bench-close": readOnly("Closes only the current Bench projection."),
  "bench-set-title": action("world", "command", "bench", "authored-change", ["bench"]),
  "bench-compose": action("world", "command", "bench", "authored-change", ["bench", "references"]),
  "bench-add-reference": action("world", "command", "bench", "authored-change", ["bench", "references", "artifacts", "takes"]),
  "bench-remove-reference": action("world", "command", "bench", "destructive-change", ["bench", "references"]),
  "bench-upload-references": action("world", "host-action", "host", "host-file-access", ["bench", "references", "artifacts"]),
  "bench-enhance-brief": readOnly("Returns an optional draft prompt without changing the Bench composer."),
  "bible-helper-run": readOnly("Returns transient helper options and never changes the Bible."),
  "bench-draft-lyrics": readOnly("Returns a lyrics draft without changing the Bench composer."),
  "bench-preset-save": globalOnly("Bench presets are application-global rather than world-scoped creative state."),
  "bench-preset-delete": globalOnly("Bench presets are application-global rather than world-scoped creative state."),
  "bench-dispatch": action("world", "generation", "bench", "spend-and-compute", ["bench", "references", "artifacts", "voices", "jobs"], { preparation: GENERATION_QUOTE }),
  "bench-rerun": action("world", "generation", "bench", "spend-and-compute", ["bench", "takes", "jobs"], { preparation: GENERATION_QUOTE }),
  "bench-keep": action("world", "command", "bench", "authored-change", ["bench", "takes", "artifacts"]),
  "bench-accept": action("production", "take-review", "bench", "authored-change", ["bench", "takes", "scenes", "shots", "boards"]),
  "bench-discard": action("world", "destructive", "bench", "destructive-change", ["bench", "takes"]),
  "bench-clear-view": action("world", "destructive", "bench", "destructive-change", ["bench", "takes"]),
  "bench-select-take": action("world", "command", "bench", "authored-change", ["bench", "takes"]),
  "stage-artifact-reference": action("world", "command", "world-store", "authored-change", ["artifacts", "references"]),
  "attach-files-correlated": action("world", "host-action", "host", "host-file-access", ["artifacts"]),
} as const satisfies Record<ClientMessageKind, CommandMetadata>;

export type ArkeClientCommandRegistry = {
  readonly [K in ClientMessageKind]: ArkeClientCommandDescriptor<K>;
};

function buildClientRegistry(): ArkeClientCommandRegistry {
  const schemas = new Map<ClientMessageKind, z.ZodDiscriminatedUnionOption<"kind">>();
  for (const option of ClientMessageSchema.options) {
    const field = option.shape.kind as z.ZodLiteral<string>;
    if (zodTypeName(field) !== "ZodLiteral" || typeof field.value !== "string") {
      throw new Error("ClientMessageSchema has an option without a literal kind");
    }
    const kind = field.value as ClientMessageKind;
    if (schemas.has(kind)) throw new Error(`ClientMessageSchema repeats ${kind}`);
    schemas.set(kind, option);
  }

  const built: Partial<Record<ClientMessageKind, ArkeClientCommandDescriptor>> = {};
  for (const kind of Object.keys(CLIENT_COMMAND_METADATA) as ClientMessageKind[]) {
    const schema = schemas.get(kind);
    if (!schema) throw new Error(`Arke command registry classifies unknown command ${kind}`);
    built[kind] = { kind, schema, ...CLIENT_COMMAND_METADATA[kind] } as ArkeClientCommandDescriptor;
  }
  for (const kind of schemas.keys()) {
    if (!(kind in built)) throw new Error(`Arke command registry does not classify ${kind}`);
  }
  return Object.freeze(built) as ArkeClientCommandRegistry;
}

export const ARKE_CLIENT_COMMAND_REGISTRY = buildClientRegistry();

/** Internal preparation shapes, kept out of client-command parity and the model catalogue. */
const WORLD_CHAT_ACTION_REGISTRY = {
  "world-chat-proposal": {
    kind: "world-chat-proposal",
    schema: WorldChatProposalActionSchema,
    ...action("world", "authored-diff", "proposal-manager", "authored-change", []),
  },
  "world-chat-bible-edit": {
    kind: "world-chat-bible-edit",
    schema: WorldChatBibleActionSchema,
    ...action("world", "authored-diff", "bible", "authored-change", ["bible"]),
  },
  "world-chat-scene-edit": {
    kind: "world-chat-scene-edit",
    schema: WorldChatSceneActionSchema,
    ...action("production", "authored-diff", "scene-store", "authored-change", ["scenes"]),
  },
  "world-chat-editor-request": {
    kind: "world-chat-editor-request",
    schema: WorldChatEditorRequestActionSchema,
    ...action("production", "command", "timeline", "authored-change", ["timeline"]),
  },
  "world-chat-world-metadata": {
    kind: "world-chat-world-metadata",
    schema: WorldChatWorldMetadataActionSchema,
    ...action("world", "authored-diff", "world-store", "authored-change", ["world-metadata", "art-direction"]),
  },
  "world-chat-canon": {
    kind: "world-chat-canon",
    schema: WorldChatCanonActionSchema,
    ...action("world", "authored-diff", "proposal-manager", "authored-change", ["canon", "sheets"]),
  },
  "world-chat-canon-retire": {
    kind: "world-chat-canon-retire",
    schema: WorldChatCanonRetireActionSchema,
    ...action("world", "destructive", "world-store", "destructive-change", ["canon", "sheets"]),
  },
  "world-chat-canon-restore": {
    kind: "world-chat-canon-restore",
    schema: WorldChatCanonRestoreActionSchema,
    ...action("world", "authored-diff", "world-store", "authored-change", ["canon", "sheets"]),
  },
  "world-chat-sheet": {
    kind: "world-chat-sheet",
    schema: WorldChatSheetActionSchema,
    ...action("world", "authored-diff", "proposal-manager", "authored-change", ["sheets", "canon"]),
  },
  "world-chat-sheet-retire": {
    kind: "world-chat-sheet-retire",
    schema: WorldChatSheetRetireActionSchema,
    ...action("world", "destructive", "world-store", "destructive-change", ["sheets", "canon"]),
  },
  "world-chat-sheet-restore": {
    kind: "world-chat-sheet-restore",
    schema: WorldChatSheetRestoreActionSchema,
    ...action("world", "authored-diff", "world-store", "authored-change", ["sheets", "canon"]),
  },
  "world-chat-art-direction": {
    kind: "world-chat-art-direction",
    schema: WorldChatArtDirectionActionSchema,
    ...action("world", "authored-diff", "proposal-manager", "authored-change", ["art-direction"]),
  },
  "world-chat-art-direction-restore": {
    kind: "world-chat-art-direction-restore",
    schema: WorldChatArtDirectionRestoreActionSchema,
    ...action("world", "authored-diff", "world-store", "authored-change", ["art-direction"]),
  },
} as const;

export interface ArkeBlockedAuthoritySeam {
  readonly kind: string;
  readonly scope: ArkeActionScope;
  readonly cardFamily: ArkeCardFamily;
  readonly authority: ArkeActionAuthority;
  readonly permissionReason: ArkePermissionReason;
  readonly requiredReads: readonly ArkeReadRequirement[];
  readonly support: ArkeActionSupport;
}

/** Intended authorities that have no ClientMessage command to classify yet (SPEC-041 R-52). */
export const ARKE_BLOCKED_AUTHORITY_SEAMS = {
  "audio-spine-command": {
    kind: "audio-spine-command",
    scope: "production",
    cardFamily: "command",
    authority: "audio-spine",
    permissionReason: "authored-change",
    requiredReads: ["spine", "artifacts", "shots", "audio"],
    support: {
      preparation: blocked(
        ["typed-audio-spine-command"],
        "The spine needs typed semantic commands for creation, track assignment, markers, anchors, audio policy, and deletion.",
      ),
      reads: AVAILABLE,
      execution: blocked(
        ["typed-audio-spine-command"],
        "The audio spine has no safe semantic command seam for an action adapter.",
      ),
    },
  },
} as const satisfies Record<string, ArkeBlockedAuthoritySeam>;

export const ARKE_ACTION_REGISTRY = Object.freeze({
  clientCommands: ARKE_CLIENT_COMMAND_REGISTRY,
  blockedAuthorities: ARKE_BLOCKED_AUTHORITY_SEAMS,
});

export interface ModelActionField {
  readonly name: string;
  readonly type: string;
  readonly optional: boolean;
}

export interface ModelActionCatalogueEntry {
  readonly kind: string;
  readonly description: string;
  readonly scope: ArkeActionScope;
  readonly cardFamily: ArkeCardFamily;
  readonly authority: ArkeActionAuthority;
  readonly permissionReason: ArkePermissionReason;
  readonly requiredReads: readonly ArkeReadRequirement[];
  readonly support: ArkeActionSupport;
  /** Empty while preparation is blocked, so unsafe legacy fields are not advertised to the model. */
  readonly fields: readonly ModelActionField[];
}

function zodTypeName(schema: z.ZodTypeAny): string {
  return (schema._def as { typeName?: string }).typeName ?? "";
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    const typeName = zodTypeName(current);
    if (typeName === "ZodOptional" || typeName === "ZodNullable") {
      current = (current as z.ZodOptional<z.ZodTypeAny> | z.ZodNullable<z.ZodTypeAny>).unwrap();
      continue;
    }
    if (typeName === "ZodDefault") {
      current = (current as z.ZodDefault<z.ZodTypeAny>).removeDefault();
      continue;
    }
    if (typeName === "ZodCatch") {
      current = (current as z.ZodCatch<z.ZodTypeAny>).removeCatch();
      continue;
    }
    if (typeName === "ZodEffects") {
      current = (current as z.ZodEffects<z.ZodTypeAny>).innerType();
      continue;
    }
    return current;
  }
}

function objectType(schema: z.ZodObject<z.ZodRawShape>, depth: number): string {
  const fields = Object.entries(schema.shape).map(([name, field]) => {
    const typed = field as z.ZodTypeAny;
    return `${name}: ${schemaType(typed, depth + 1)}${typed.isOptional() ? "?" : ""}`;
  });
  return `{${fields.join(", ")}}`;
}

/** A bounded signature derived from the schema itself, including nested union option names. */
function schemaType(schema: z.ZodTypeAny, depth = 0): string {
  const current = unwrap(schema);
  const typeName = zodTypeName(current);
  if (typeName === "ZodLiteral") return JSON.stringify((current as z.ZodLiteral<unknown>).value);
  if (typeName === "ZodEnum") {
    return ((current as z.ZodEnum<[string, ...string[]]>).options as string[])
      .map((option: string) => JSON.stringify(option))
      .join(" | ");
  }
  if (typeName === "ZodString") return "string";
  if (typeName === "ZodNumber") return "number";
  if (typeName === "ZodBoolean") return "boolean";
  if (typeName === "ZodNull") return "null";
  if (typeName === "ZodUnknown") return "unknown";
  if (typeName === "ZodArray") {
    return `array<${schemaType((current as z.ZodArray<z.ZodTypeAny>).element, depth + 1)}>`;
  }
  if (typeName === "ZodRecord") {
    return `record<string, ${schemaType((current as z.ZodRecord).valueSchema, depth + 1)}>`;
  }
  if (typeName === "ZodDiscriminatedUnion") {
    const union = current as z.ZodDiscriminatedUnion<string, z.ZodDiscriminatedUnionOption<string>[]>;
    return (union.options as Array<z.ZodObject<z.ZodRawShape>>)
      .map((option: z.ZodObject<z.ZodRawShape>) => {
        const discriminator = option.shape[union.discriminator] as z.ZodLiteral<unknown> | undefined;
        const label = discriminator && zodTypeName(discriminator) === "ZodLiteral"
          ? String(discriminator.value)
          : "option";
        return depth >= 3 ? label : `${label} ${objectType(option, depth + 1)}`;
      })
      .join(" | ");
  }
  if (typeName === "ZodUnion") {
    return (current as z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]>).options
      .map((option: z.ZodTypeAny) => schemaType(option, depth + 1))
      .join(" | ");
  }
  if (typeName === "ZodObject") {
    return depth >= 3 ? "object" : objectType(current as z.ZodObject<z.ZodRawShape>, depth + 1);
  }
  return "value";
}

function fieldsFor(schema: z.ZodTypeAny): readonly ModelActionField[] {
  const object = unwrap(schema);
  if (zodTypeName(object) !== "ZodObject") return [];
  return Object.entries((object as z.ZodObject<z.ZodRawShape>).shape)
    .filter(([name]) => name !== "kind")
    .map(([name, field]) => {
      const typed = field as z.ZodTypeAny;
      return { name, type: schemaType(typed), optional: typed.isOptional() };
    });
}

/** The model-facing projection has no separately maintained command list or field vocabulary. */
export function modelActionCatalogue(): readonly ModelActionCatalogueEntry[] {
  const entries: ModelActionCatalogueEntry[] = [];
  for (const descriptor of Object.values(ARKE_CLIENT_COMMAND_REGISTRY)) {
    if (descriptor.classification !== "supported-by-arke") continue;
    entries.push({
      kind: descriptor.kind,
      description: descriptor.kind.replaceAll("-", " "),
      scope: descriptor.scope,
      cardFamily: descriptor.cardFamily,
      authority: descriptor.authority,
      permissionReason: descriptor.permissionReason,
      requiredReads: descriptor.requiredReads,
      support: descriptor.support,
      fields: descriptor.support.preparation.state === "available" ? fieldsFor(descriptor.schema) : [],
    });
  }
  for (const descriptor of Object.values(ARKE_BLOCKED_AUTHORITY_SEAMS)) {
    entries.push({
      ...descriptor,
      description: descriptor.kind.replaceAll("-", " "),
      fields: [],
    });
  }
  return entries;
}

function supportLabel(support: ArkeActionSupport): string {
  return (["preparation", "reads", "execution"] as const)
    .map((part) => {
      const value = support[part];
      return value.state === "available"
        ? `${part}=available`
        : `${part}=blocked(${value.blockingSeams.join(", ")}): ${value.reason}`;
    })
    .join("; ");
}

/** Text suitable for a model instruction, generated entirely from the registry projection. */
export function modelActionCatalogueText(): string {
  return modelActionCatalogue()
    .map((entry) => {
      const fields = entry.fields.length === 0
        ? "payload unavailable"
        : entry.fields.map((field) => `${field.name}: ${field.type}${field.optional ? " (optional)" : ""}`).join("; ");
      const reads = entry.requiredReads.length === 0 ? "none" : entry.requiredReads.join(", ");
      return `- ${entry.kind} [${entry.scope}; ${entry.cardFamily}; ${entry.authority}; ${entry.permissionReason}] reads: ${reads}; ${supportLabel(entry.support)}; ${fields}`;
    })
    .join("\n");
}

/** A typed lookup for coordinator adapters; unknown action kinds fail closed. */
export function arkeClientCommand<K extends ClientMessageKind>(
  kind: K,
): ArkeClientCommandDescriptor<K> {
  return ARKE_CLIENT_COMMAND_REGISTRY[kind];
}

/** Kept local to this boundary so arbitrary strings never acquire a descriptor by assertion. */
export function findArkeClientCommand(kind: string): ArkeClientCommandDescriptor | undefined {
  return Object.prototype.hasOwnProperty.call(ARKE_CLIENT_COMMAND_REGISTRY, kind)
    ? ARKE_CLIENT_COMMAND_REGISTRY[kind as ClientMessageKind]
    : undefined;
}

export function findArkeAction(kind: string) {
  const client = findArkeClientCommand(kind);
  if (client) return client;
  return Object.prototype.hasOwnProperty.call(WORLD_CHAT_ACTION_REGISTRY, kind)
    ? WORLD_CHAT_ACTION_REGISTRY[kind as keyof typeof WORLD_CHAT_ACTION_REGISTRY]
    : undefined;
}

type _EveryClientCommandIsClassified = Exclude<ClientMessageKind, keyof typeof CLIENT_COMMAND_METADATA> extends never
  ? true
  : false;
type _NoInventedClientCommand = Exclude<keyof typeof CLIENT_COMMAND_METADATA, ClientMessageKind> extends never
  ? true
  : false;
export const ARKE_CLIENT_COMMAND_COMPILE_TIME_PARITY: _EveryClientCommandIsClassified & _NoInventedClientCommand = true;

// This alias is useful to adapter implementations without widening their payload back to ClientMessage.
export type RegisteredClientAction<K extends ClientMessageKind> = ClientMessageOfKind<K>;
