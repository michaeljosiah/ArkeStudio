import { z } from "zod";
import type { LeasedTools } from "../harness/world-query.js";
import type { VoiceBackgroundContext, VoiceBackgroundOwner } from "./background.js";

const operationId = z.string().regex(/^vop_[0-9A-HJKMNP-TV-Z]{26}$/);

/** Foreground requests return admission/status, never await a worker's inference. */
export function voiceBackgroundTools(owner: VoiceBackgroundOwner, context: VoiceBackgroundContext): LeasedTools {
  let starts = 0;
  const idProperty = { type: "string", pattern: "^vop_[0-9A-HJKMNP-TV-Z]{26}$" };
  return { tools: [
    { name: "start_background_lookup", description: "Start one read-only canon/sheet lookup in a separate worker, then keep talking. Returns promptly with an operation ID; it is not a completed result. No changes or generations. Do not read the ID aloud unless asked.",
      inputSchema: { type: "object", properties: { request: { type: "string", minLength: 1, maxLength: 1500 } }, required: ["request"], additionalProperties: false } },
    { name: "background_status", description: "Check this conversation's background lookup status. Omit ID for the ten latest status summaries. Never claim an unfinished result.",
      inputSchema: { type: "object", properties: { operationId: idProperty }, additionalProperties: false } },
    { name: "cancel_background_lookup", description: "Explicitly request cancellation of one background lookup. A requested cancellation is not confirmed until status says cancelled. Speaking over a reply does not cancel a lookup.",
      inputSchema: { type: "object", properties: { operationId: idProperty }, required: ["operationId"], additionalProperties: false } },
  ], call: async (name, args) => {
    let result: unknown;
    if (name === "start_background_lookup") {
      const { request } = z.object({ request: z.string().trim().min(1).max(1500) }).strict().parse(args);
      if (++starts > 2) throw new Error("This spoken turn has already requested its background lookups.");
      const operation = await owner.start(context, request);
      result = { operationId: operation.id, status: operation.status };
    } else if (name === "background_status") {
      const parsed = z.object({ operationId: operationId.optional() }).strict().parse(args);
      const rows = await owner.list(context.worldId, context.conversationId);
      result = parsed.operationId ? rows.find(row => row.id === parsed.operationId) ?? { unavailable: true }
        : rows.slice(-10).map(row => ({ operationId: row.id, status: row.status }));
    } else if (name === "cancel_background_lookup") {
      const parsed = z.object({ operationId }).strict().parse(args);
      const operation = await owner.cancel(context.worldId, context.conversationId, parsed.operationId);
      result = operation ? { operationId: operation.id, status: operation.status } : { unavailable: true };
    } else throw new Error("This tool is unavailable in a voice conversation.");
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } };
}
