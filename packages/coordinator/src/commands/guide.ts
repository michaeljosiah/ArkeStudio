import type { DomainEvent } from "@arke-studio/contracts";
import { draftGuideDescription, GUIDE_WRITER_MAX_CHARS, guideUndescribed, guideVoiceLines, setGuideEntry, setGuideStory, setGuideTeasers, type GuideWriter } from "../productions/world-guide.js";
import type { makeArtDirector } from "../references/art-director.js";
import type { CommandContext } from "./context.js";
import type { CommandModule } from "./router.js";

type GuideDrafting = Extract<DomainEvent, { type: "guide.drafting" }>;

/**
 * Each world's Draft run (R-40), so Stop can end it and a second press waits, and where each is,
 * so a window that joins mid-run is told it (codex on PR 2849). The coordinator holds one, for its
 * stop and its replay to a joining window.
 */
export class GuideDraftRuns {
  readonly stops = new Map<string, AbortController>();
  readonly progress = new Map<string, GuideDrafting>();
  /** What a joining window is told: each run still going, as of now. */
  replay(at: string): GuideDrafting[] { return [...this.progress.values()].map((event) => ({ ...event, at })); }
  /** Ends every run: each waits on a writer for every entry left. */
  stopAll(): void { for (const stop of this.stops.values()) stop.abort(); }
}

/**
 * The world's Guide (SPEC-059): what a reader may see of it, its teasers, and the descriptions Arke
 * drafts. Open world only, but for Stop.
 */
export function guideCommands(ctx: CommandContext, deps: {
  runs: GuideDraftRuns;
  /** An answer from one roster agent, or null while the writing harness is not running. */
  ask: (options: Parameters<typeof makeArtDirector>[3]) => GuideWriter | null;
  logDrafted: (entry: { worldId: string; done: number; failed: number; reason?: string }) => void;
}) {
  const { stops: drafts, progress: draftProgress } = deps.runs;
  return {
    "set-guide-entry": {
      scope: "open-world",
      async handle(msg, store) {
        try {
          await setGuideEntry(store, msg.change, "editor");
        } catch (err) {
          // The switch springs back with the snapshot below; this says why.
          ctx.emit({ at: ctx.nowIso(), type: "command.failed", command: msg.kind, requestId: null, reason: err instanceof Error ? err.message.slice(0, 300) : "The Guide could not be saved" });
        }
        await ctx.refreshWorldSnapshot(msg.worldId);
      },
    },
    "set-guide-teasers": {
      scope: "open-world",
      async handle(msg, store) {
        try {
          await setGuideTeasers(store, msg.change, "editor");
        } catch (err) {
          // The row goes back to what is kept with the snapshot below; this says why.
          ctx.emit({ at: ctx.nowIso(), type: "command.failed", command: msg.kind, requestId: null, reason: err instanceof Error ? err.message.slice(0, 300) : "The teasers could not be saved" });
        }
        await ctx.refreshWorldSnapshot(msg.worldId);
      },
    },
    "set-guide-story": {
      scope: "open-world",
      async handle(msg, store) {
        try {
          await setGuideStory(store, msg.change, "editor");
        } catch (err) {
          ctx.emit({ at: ctx.nowIso(), type: "command.failed", command: msg.kind, requestId: null, reason: err instanceof Error ? err.message.slice(0, 300) : "The story could not be saved" });
        }
        await ctx.refreshWorldSnapshot(msg.worldId);
      },
    },
    "draft-guide-description": {
      scope: "open-world",
      // Draft (R-40): the Guide writer answers and each description is kept marked as a draft,
      // reaching the Guide with the snapshot after it. Draft N goes one entry at a time, so a run
      // of fourteen holds one harness session at a time, not fourteen. A world that is not open is
      // the router's refusal, which the page reads by this request's id.
      async handle(msg, store) {
        type Progress = Omit<GuideDrafting, "at" | "type" | "worldId" | "requestId">;
        const progress = (state: Progress) => {
          const event: GuideDrafting = { at: ctx.nowIso(), type: "guide.drafting", worldId: msg.worldId, requestId: msg.requestId, ...state };
          // Only this run's own word is kept for a window that joins, and only while it goes.
          if (drafts.has(msg.worldId) && !state.finished) draftProgress.set(msg.worldId, event);
          else if (state.finished && draftProgress.get(msg.worldId)?.requestId === msg.requestId) draftProgress.delete(msg.worldId);
          ctx.emit(event);
        };
        // One run a world: the page disables Draft while one goes, and a second frame is not a second run.
        if (drafts.has(msg.worldId)) return;
        const stop = new AbortController();
        const writer = deps.ask({ agent: "guide-writer", answerKey: "description", maxChars: GUIDE_WRITER_MAX_CHARS, signal: stop.signal });
        if (writer === null) return progress({ of: 0, done: 0, failed: 0, finished: true, reason: "The writing harness is not running" });
        // Read before the run is held, so nothing thrown here leaves a run that no Stop can end.
        const targets = msg.entry !== undefined ? [msg.entry] : guideUndescribed(store.getBundle().guide, store.getBundle());
        drafts.set(msg.worldId, stop);
        progress({ of: targets.length, done: 0, failed: 0, ...(msg.entry !== undefined ? { entry: msg.entry } : {}), finished: false });
        let done = 0;
        let failed = 0;
        let reason: string | undefined;
        try {
          for (const entry of targets) {
            if (stop.signal.aborted) break;
            // Draft N rechecks each entry when its turn comes, so words written meanwhile stand.
            const drafted = await draftGuideDescription(store, entry, writer, (chapter) => progress({ of: targets.length, done, failed, entry, chapter, finished: false }), { onlyUndescribed: msg.entry === undefined });
            if (stop.signal.aborted) break;
            if (drafted.ok) done++;
            else if (drafted.kept !== true) {
              failed++;
              reason = drafted.reason;
            }
            await ctx.refreshWorldSnapshot(msg.worldId);
          }
        } catch (err) {
          // A Guide that will not read or a write refused still ends the run, so the page is never
          // left saying Drafting with nothing to stop (codex on PR 2849).
          failed++;
          reason = err instanceof Error ? err.message.slice(0, 200) : "The Guide could not be saved";
        } finally {
          drafts.delete(msg.worldId);
        }
        if (stop.signal.aborted) reason = "Stopped";
        deps.logDrafted({ worldId: msg.worldId, done, failed, ...(reason !== undefined ? { reason } : {}) });
        progress({ of: targets.length, done, failed, finished: true, ...(reason !== undefined ? { reason } : {}) });
      },
    },
    // Stop reaches a run whatever is open: a run outlives the world it was started in only until
    // its next write fails, and ending it sooner is always right.
    "stop-guide-drafting": { scope: "any-world", handle(msg) { drafts.get(msg.worldId)?.abort(); } },
    "list-guide-voice-lines": {
      scope: "open-world",
      async handle(msg, store) {
        try {
          const lines = await guideVoiceLines(store, msg.character, store.closingSignal);
          ctx.emit({ at: ctx.nowIso(), type: "guide.voice-lines", requestId: msg.requestId, worldId: msg.worldId, character: msg.character, lines });
        } catch (err) {
          ctx.emit({ at: ctx.nowIso(), type: "guide.voice-lines", requestId: msg.requestId, worldId: msg.worldId, character: msg.character, lines: [], refused: err instanceof Error ? err.message.slice(0, 300) : "Lines could not be read" });
        }
      },
    },
  } satisfies CommandModule;
}
