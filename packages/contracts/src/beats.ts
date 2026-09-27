import { orderedShots, type SceneRecord } from "./scene-flow.js";
import { performanceLineKey } from "./performance.js";
import type { Shot } from "./scene.js";

/**
 * A visual novel's scene as beats (turn 174): one picture and one line each, read in order.
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
  /**
   * Narration has no speaker; dialogue names its speaker's sheet — or, as a draft still missing
   * one, names nobody and is not narration for it: nobody is chosen to read it.
   */
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

/**
 * Whether a legacy shot's authored audio is a line the reader should see, and whose. A voice-over
 * with no speaker is the narrator's; dialogue with no speaker is still dialogue, waiting for one.
 */
function legacyLine(shot: Shot): { text: string; kind: "narration" | "dialogue"; speaker?: string } | null {
  const audio = shot.audio;
  if (!audio || !["vo", "dialogue"].includes(audio.kind) || !audio.line?.trim()) return null;
  const kind = audio.speaker || audio.kind === "dialogue" ? "dialogue" : "narration";
  return { text: audio.line.trim(), kind, ...(audio.speaker ? { speaker: audio.speaker } : {}) };
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
        // An action block is narration. A dialogue block is its speaker's — and a draft whose
        // speaker is missing stays dialogue, never recast into the narrator's voice.
        beats.push(
          block.kind === "dialogue"
            ? { shot, lineId, blockId: block.id, kind: "dialogue", ...(block.speaker ? { speaker: block.speaker } : {}), text: block.text }
            : { shot, lineId, blockId: block.id, kind: "narration", text: block.text },
        );
      }
    } else {
      const line = legacyLine(shot);
      if (line) {
        const lineId = performanceLineKey({ sceneId: scene.id, shotId: shot.id });
        beats.push({ shot, lineId, kind: line.kind, ...(line.speaker ? { speaker: line.speaker } : {}), text: line.text });
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

/** One beat as the player reads it (`InteractivePlayerBeat`), before its media are addressed. */
export interface PlayerBeat {
  picture?: string;
  text?: string;
  speaker?: string;
  audio?: string;
  advance: "voice" | "tap" | "hold";
  holdSec: number;
  motion: "push" | "drift" | "none";
}

/**
 * A scene's beats for the player — the preview and the exported package both build them here, so
 * the two cannot read a scene differently. Where a picture or a voice lives is the caller's: the
 * app addresses media through the studio, the package through its own folder.
 */
export function playerBeats(
  scene: SceneRecord,
  resolve: {
    /** The shot's picture, or none. */
    picture: (shotId: string) => string | undefined;
    /** The line's voice, or none (it reads as text). */
    audio: (lineId: string) => string | undefined;
    /** The name a speaker's tab shows. */
    speakerName: (sheetId: string) => string;
  },
): PlayerBeat[] {
  const shots = orderedShots(scene);
  return sceneBeats(scene).map((beat) => {
    const picture = resolve.picture(beatPictureShotId(shots, beat.shot.id));
    const audio = beat.lineId === undefined ? undefined : resolve.audio(beat.lineId);
    return {
      ...(picture !== undefined ? { picture } : {}),
      ...(beat.text ? { text: beat.text } : {}),
      ...(beat.kind === "dialogue" && beat.speaker ? { speaker: resolve.speakerName(beat.speaker) } : {}),
      ...(audio !== undefined ? { audio } : {}),
      ...beatPlayback(beat.shot),
    };
  });
}
