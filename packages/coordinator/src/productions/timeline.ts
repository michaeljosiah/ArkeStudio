import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ProductionTimelineSchema,
  TimelineOperationRefused,
  movePictureClip,
  redoPictureMove,
  seedStoryPictureTimeline,
  storyTimelineFingerprint,
  undoPictureMove,
  type ProductionTimeline,
  type TimelineClipId,
  type TimelineMoveDirection,
} from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";

export type TimelineCommand =
  | {
      kind: "move-picture";
      clipId: TimelineClipId;
      direction: TimelineMoveDirection;
      baseRevision: number | null;
      sourceFingerprint: string;
    }
  | { kind: "undo" | "redo"; baseRevision: number };

export class TimelineCommandRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "TimelineCommandRefused";
  }
}

const missing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";

/** Materialise or update one production timeline under the world's existing atomic write gate. */
export async function applyTimelineCommand(
  store: WorldStore,
  productionId: string,
  command: TimelineCommand,
): Promise<void> {
  const path = `productions/${productionId}/timeline.json`;

  await store.gateOp(async () => {
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === productionId);
    if (!production) throw new TimelineCommandRefused(`production ${productionId} is not in this world`);
    if (production.spine) {
      throw new TimelineCommandRefused("music-timed timeline editing is not in this first Picture slice");
    }

    let raw: string | null = null;
    try {
      raw = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
    } catch (error) {
      if (!missing(error)) throw error;
    }

    let current: ProductionTimeline;
    if (raw === null) {
      if (command.kind !== "move-picture" || command.baseRevision !== null) {
        throw new TimelineCommandRefused("the timeline has not been materialised yet");
      }
      const fingerprint = storyTimelineFingerprint(production);
      if (fingerprint !== command.sourceFingerprint) {
        throw new TimelineCommandRefused("the story order changed while this move was being made");
      }
      current = seedStoryPictureTimeline(production);
    } else {
      try {
        current = ProductionTimelineSchema.parse(JSON.parse(raw));
      } catch (error) {
        throw new TimelineCommandRefused(
          `timeline.json is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (command.baseRevision !== current.revision) {
        throw new TimelineCommandRefused(
          `the timeline moved from revision ${command.baseRevision ?? "none"} to ${current.revision} while this edit was being made`,
        );
      }
    }

    let next: ProductionTimeline;
    try {
      next =
        command.kind === "move-picture"
          ? movePictureClip(current, command.clipId, command.direction)
          : command.kind === "undo"
            ? undoPictureMove(current)
            : redoPictureMove(current);
    } catch (error) {
      if (error instanceof TimelineOperationRefused) throw new TimelineCommandRefused(error.reason);
      throw error;
    }
    ProductionTimelineSchema.parse(next);

    await store.commitUnserialised({
      kind: "timeline-command",
      source: command.kind,
      // A build that does not understand timeline authority must refuse this world rather than
      // export the old derived order. The boundary lands atomically with first materialisation.
      raiseSchemaVersion: 5,
      files: [
        {
          path,
          action: raw === null ? "create" : "replace",
          content: `${JSON.stringify(next, null, 2)}\n`,
          baseHash: raw === null ? null : sha256(raw),
        },
      ],
    });
  });
}
