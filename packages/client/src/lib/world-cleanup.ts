import { cleanupAction, CLEANUP_HOLD_DAYS, type CleanupItem, type WorldCleanupAnswer, type WorldCleanupOp } from "@arke-studio/contracts";
import { onWorldCleanup, send } from "./store.js";

/**
 * Clean up (SPEC-066) asks and is answered over the window's own socket, as the typeface files
 * are: the plan names world paths, so the coordinator sends it to the Studio window that asked
 * and folds nothing into shared state (R-2, R-17). A plan reads the whole world, so it waits
 * longer than the small ops; an answer that never comes reads as a refusal, never as a plan.
 */
export function askWorldCleanup(worldId: string, request: WorldCleanupOp): Promise<WorldCleanupAnswer> {
  const requestId = crypto.randomUUID();
  // Restore and Empty now answer once every item has moved, which on a large plan is minutes.
  const timeoutMs = request.op === "plan" || request.op === "restore" || request.op === "empty" ? 300_000 : 60_000;
  return new Promise(resolve => {
    const stop = onWorldCleanup(frame => {
      if (frame.requestId !== requestId) return;
      clearTimeout(timer); stop(); resolve(frame.answer);
    });
    const timer = setTimeout(() => { stop(); resolve({ ok: false, reason: "No answer" }); }, timeoutMs);
    if (!send({ kind: "world-cleanup", requestId, worldId, request })) { clearTimeout(timer); stop(); resolve({ ok: false, reason: "Not connected" }); }
  });
}

const DAY = 86_400_000;

/** When a hold that starts now ends: the date the sheet promises before anything runs. */
export const holdEnd = (days: number, now: number): number => now + days * DAY;

/**
 * Now and After hold over the ticked items (R-9): a link or a cleared mix counts in both, a hold
 * only in After hold, which carries the last hold's end. Items are already counted once per file.
 */
export function cleanupTotals(items: readonly CleanupItem[], ticked: ReadonlySet<string>, now: number): { now: number; after: number; count: number; until: number | null } {
  let nowBytes = 0, after = 0, count = 0, days = 0;
  for (const item of items) {
    if (!ticked.has(item.id)) continue;
    count += 1; after += item.bytes;
    if (cleanupAction(item.class) === "hold") days = Math.max(days, CLEANUP_HOLD_DAYS[item.class]);
    else nowBytes += item.bytes;
  }
  return { now: nowBytes, after, count, until: days ? holdEnd(days, now) : null };
}

/** Dates as the sheet reads them: 20 Nov, and with its time where a moment matters. */
export const cleanupDate = (at: string | number): string => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
export const cleanupMoment = (at: string | number): string => new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
