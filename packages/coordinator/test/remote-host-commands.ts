import { REMOTE_HOST_ONLY_COMMANDS, ClientMessageSchema } from "@arke-studio/contracts";
/** Valid wire messages, shared by the live-gateway test and the real Chrome pairing check. */
export function hostOnlyCommandFixtures(sourcePath: string) {
    const worldId = "01ARZ3NDEKTSV4RRFFQ69G5FAV", conversationId = "cv_" + worldId;
    const playblast = { worldId, productionId: "pilot", sceneFile: "sc-one.md", sceneId: "sc_one", shotId: "sh_one",
      baseVersion: 1, stagingVersion: 1, durationSec: 1, aspect: "16:9", sourcePath, openingFrameSourcePath: sourcePath,
      referenceFrames: [{ kind: "last", at: 1, sourcePath }, { kind: "overview", at: 0, sourcePath }] };
    const hostCommands = [
      { kind: "file-artifact", worldId, sourcePath },
      { kind: "genesis-attach", genesisId: "new-world", sourcePath },
      { kind: "world-chat-attach", worldId, conversationId, sourcePath },
      { kind: "import-folder", worldId, sourcePath },
      { kind: "upload-artifacts", worldId, requestId: worldId, sourcePaths: [sourcePath] },
      { kind: "upload-artifacts", worldId, requestId: worldId },
      { kind: "stage-playblast", ...playblast },
      { kind: "conversation-action-stage-playblast-complete", ...playblast, conversationId, actionId: "act_" + worldId, status: "completed" },
    ];

    const payloads: Record<string, Record<string, unknown>> = {
      "account-open": { page: "account" }, "set-background-notifications": { preference: "off" },
      "set-credential": { provider: "openai", key: "test-secret-only" },
      "clear-credential": { provider: "openai" },
      "submit-vendor-key": { vendor: "openai", key: "test-secret-only" },
      "begin-vendor-sign-in": { vendor: "openai", method: "oauth" },
      "submit-vendor-sign-in-code": { vendor: "openai", code: "test-code" },
      "remove-vendor-connection": { vendor: "openai", credential: "personal" },
      "sign-in-provider-tool": { provider: "higgsfield" },
      "cancel-provider-tool-sign-in": { provider: "higgsfield" },
      "select-provider-workspace": { provider: "higgsfield", workspaceId: null },
      "set-harness-engine": { engine: "claude" },
      "set-comfyui-url": { url: "http://127.0.0.1:8188" },
      "use-detected-comfyui": { location: "test-install" },
    };
    return [...hostCommands, ...REMOTE_HOST_ONLY_COMMANDS.filter(kind => !hostCommands.some(command => command.kind === kind)).map(kind => ({ kind, ...payloads[kind] }))].map(command => ClientMessageSchema.parse(command));
}
