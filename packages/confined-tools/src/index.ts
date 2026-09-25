export {
  captureRootIdentity, ConfinedFiles, ConfinementError, confinedTarget, fileConfinementUnavailable, resolveRoot, WindowsFiles, within,
  type FileEntry, type FileIdentity,
} from "./confined-files.js";
export { WINDOWS_FILES_BOOTSTRAP, WINDOWS_FILES_SOURCE } from "./windows-files.js";
export {
  discoverWorldTools, executeTool, toolsFor, worldRequest,
  type ExecutedTool, type ToolContent, type ToolDefinition, type ToolResult, type ToolSession,
} from "./tools.js";
export { object, type JsonObject } from "./json.js";
