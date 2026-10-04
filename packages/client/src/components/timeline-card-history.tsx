import { useEffect, useState } from "react";
import type { ConversationActionCard, ProductionBundle, TimelineHistoryEntry } from "@arke-studio/contracts";
import { moveTimelineHistory } from "../lib/store.js";
import { Button } from "./ui.js";

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}
export async function historyEntryDigest(entry: TimelineHistoryEntry): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(entry)));
  return `sha256:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
export async function cardHistoryControl(action: ConversationActionCard, production: ProductionBundle) {
  const state = production.timeline;
  if (action.status !== "completed" || state?.status !== "ready") return null;
  const timeline = state.timeline;
  const requestId = action.receipt?.kind === "editor-request" ? action.receipt.id : action.actionId;
  for (const operation of ["undo", "redo"] as const) {
    const entry = timeline.history[operation].at(-1);
    if (!entry) continue;
    const matches = action.receipt?.kind === "timeline-history" && action.receipt.digest
      ? await historyEntryDigest(entry) === action.receipt.digest : entry.kind === "change" && entry.requestId === requestId;
    if (matches) return { revision: timeline.revision, operation, label: entry.kind === "change" ? entry.label : `Move ${entry.clipId} ${entry.direction}` };
  }
  return null;
}

/** Human-owned native history controls. They never approve another chat action. */
export function TimelineCardHistory({ action, production }: { action: ConversationActionCard; production: ProductionBundle }) {
  const [matched, setMatched] = useState<{ revision: number; operation: "undo" | "redo"; label: string } | null>(null);
  const state = production.timeline;
  useEffect(() => {
    let cancelled = false;
    setMatched(null);
    if (action.status !== "completed" || state?.status !== "ready") return;
    void cardHistoryControl(action, production).then(control => { if (!cancelled) setMatched(control); }).catch(() => {});
    return () => { cancelled = true; };
  }, [action, state]);
  if (!matched || state?.status !== "ready" || state.timeline.revision !== matched.revision) return null;
  return <Button variant="ghost" onClick={() => moveTimelineHistory(action.worldId, production.meta.id, matched.operation, matched.revision)}>
    {matched.operation === "undo" ? "Undo" : "Redo"} {matched.label}
  </Button>;
}
