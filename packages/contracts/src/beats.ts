import { orderedShots, type SceneRecord } from "./scene-flow.js";
import { performanceLineKey } from "./performance.js";
import type { Shot } from "./scene.js";

/**
 * A visual novel's scene as beats (turn 172): one picture and one line each, read in order.
 *
 * A beat is a shot — no store of its own — and its line is the script block the shot covers.
 * An action block is narration, read by the narrator; a dialogue block is its speaker's line,
 * read in the voice on their sheet. A shot that covers several blocks is several beats on one
 * picture, which is how a visual novel holds a picture while two people talk. A shot that covers
 * nothing is a beat with no line: the picture alone, held until the reader moves on.
 *
 * The walk is `deriveRehearsalLines`'s — authored shot order, then covered script order, a block
 * covered twice read once — so a beat's `lineId` is the table read's id for the same line, and
 * the audio the table read prepares is found by it.
 */
export interface SceneBeat {
  shot: Shot;
  /** The table read's line id; absent for a beat with no line. */
  lineId?: string;
  blockId?: string;
  /** Narration has no speaker; dialogue names its speaker's sheet. */
  kind: "narration" | "dialogue" | "picture";
  speaker?: string;
  text: string;
}

export const BEAT_DEFAULTS = {
  advance: "tap",
  holdSec: 4,
  motion: "push",
} as const satisfies { advance: "voice" | "tap" | "hold"; holdSec: number; motion: "push" | "drift" | "none" };

/** The advance and motion a shot plays with: its own where set, the defaults otherwise. */
export function beatPlayback(shot: Pick<Shot, "beat">): { advance: "voice" | "tap" | "hold"; holdSec: number; motion: "push" | "drift" | "none" } {
  return {
    advance: shot.beat?.advance ?? BEAT_DEFAULTS.advance,
    holdSec: shot.beat?.holdSec ?? BEAT_DEFAULTS.holdSec,
    motion: shot.beat?.motion ?? BEAT_DEFAULTS.motion,
  };
}

/** Whether a legacy shot's authored audio is a line the reader should see. */
function legacyLine(shot: Shot): { text: string; speaker?: string } | null {
  const audio = shot.audio;
  if (!audio || !["vo", "dialogue"].includes(audio.kind) || !audio.line?.trim()) return null;
  return { text: audio.line.trim(), ...(audio.speaker ? { speaker: audio.speaker } : {}) };
}

export function sceneBeats(scene: SceneRecord): SceneBeat[] {
  const beats: SceneBeat[] = [];
  const seen = new Set<string>();
  const blocks = scene.script?.blocks ?? [];
  for (const shot of orderedShots(scene)) {
    const before = beats.length;
    if (shot.covers?.length) {
      // Script order, as the table read walks it; a cover whose block is gone reads nothing.
      for (const block of blocks.filter((b) => shot.covers?.some((c) => c.blockId === b.id))) {
        if (seen.has(block.id)) continue;
        seen.add(block.id);
        const lineId = performanceLineKey({ sceneId: scene.id, shotId: shot.id, blockId: block.id });
        beats.push(
          block.kind === "dialogue" && block.speaker
            ? { shot, lineId, blockId: block.id, kind: "dialogue", speaker: block.speaker, text: block.text }
            : { shot, lineId, blockId: block.id, kind: "narration", text: block.text },
        );
      }
    } else {
      const line = legacyLine(shot);
      if (line) {
        const lineId = performanceLineKey({ sceneId: scene.id, shotId: shot.id });
        beats.push(
          line.speaker
            ? { shot, lineId, kind: "dialogue", speaker: line.speaker, text: line.text }
            : { shot, lineId, kind: "narration", text: line.text },
        );
      }
    }
    if (beats.length === before) beats.push({ shot, kind: "picture", text: "" });
  }
  return beats;
}

/**
 * The shot whose picture a beat shows: its own, or — where it keeps the picture before — the
 * nearest earlier shot that has one of its own. The first shot of a scene cannot keep a
 * picture it was never shown, so it shows its own.
 */
export function beatPictureShotId(shots: readonly Pick<Shot, "id" | "beat">[], shotId: string): string {
  let index = shots.findIndex((shot) => shot.id === shotId);
  if (index < 0) return shotId;
  while (index > 0 && shots[index]!.beat?.samePicture === true) index -= 1;
  return shots[index]!.id;
}
