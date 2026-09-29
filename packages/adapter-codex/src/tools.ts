import {
  discoverWorldTools as discoverShared, executeTool as executeShared, toolsFor as toolsForShared,
  type ToolContent as SharedContent, type ToolResult as SharedResult, type ToolSession,
} from "@arke-studio/confined-tools";
import type { JsonObject } from "./rpc.js";
export { ConfinementError, resolveRoot, within, worldRequest } from "@arke-studio/confined-tools";
export type { ToolSession } from "@arke-studio/confined-tools";

/**
 * Codex's shapes for the shared confined tools (issue 1247, Phase 1).
 *
 * The tools themselves — which are offered under a confinement, how a file is reached through
 * the pinned root, what the world-query client accepts — live in @arke-studio/confined-tools.
 * This file only says how Codex spells them: a dynamic function with an `inputSchema`, and
 * results as `inputText` / `inputImage` items with the image as a data URL.
 */
export interface DynamicFunction { type: "function"; name: string; description: string; inputSchema: JsonObject }
export type ToolContent = { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string };
export interface ToolResult { success: boolean; contentItems: ToolContent[] }
export interface ExecutedTool { result: ToolResult; summary?: string }

function codexContent(item: SharedContent): ToolContent {
  return item.type === "text" ? { type: "inputText", text: item.text } : { type: "inputImage", imageUrl: `data:${item.mimeType};base64,${item.data}` };
}
function codexResult(result: SharedResult): ToolResult {
  return { success: result.success, contentItems: result.content.map(codexContent) };
}

export function toolsFor(session: ToolSession): DynamicFunction[] {
  return toolsForShared(session).map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.parameters }));
}

export async function discoverWorldTools(session: ToolSession, signal?: AbortSignal): Promise<void> {
  return discoverShared(session, signal);
}

export async function executeTool(session: ToolSession, name: string, args: JsonObject, signal: AbortSignal): Promise<ExecutedTool> {
  const executed = await executeShared(session, name, args, signal);
  return { result: codexResult(executed.result), ...(executed.summary !== undefined ? { summary: executed.summary } : {}) };
}
