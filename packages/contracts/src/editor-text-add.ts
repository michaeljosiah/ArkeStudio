import { canonicalJson } from "./canonical-json.js";
import type { TextLook } from "./editor-text.js";
import { nextOverlayTrack } from "./editor-media.js";
import type { TextLookPatch } from "./editor-text-set.js";
import { textTypefaceFile, type TextTypefaceId } from "./editor-text-typefaces.js";
import { secondsToFrames, type ProductionTimeline, type TimelineClip, type TimelineClipCommand, type TimelineClipId, type TimelineTrack } from "./timeline.js";

/**
 * What the Cut's Add text places, and the look a new title is given (SPEC-065 R-29, R-30; turn 277
 * rules 2 and 6). These are rules of the record rather than of a screen, and the looks are colours,
 * which client source never spells, so they sit here where a test can hold them without a window.
 */

/** Every Add places these words, whatever the last title said: R-30 copies a look, never words. */
export const TEXT_ADD_WORDS = "Text";
/** Every Add is this long with these fades, whatever the last title's were: the clip around a look is the clip's own (§2.1). */
export const TEXT_ADD_SECONDS = 4, TEXT_ADD_FADE_SECONDS = 0.5;

type TextPart<Key extends "edge" | "shadow" | "rule" | "backing"> = NonNullable<TextLook[Key]>;

/**
 * A production's first title (277a): Geist Regular at 8 % of the frame's height, untracked, lines
 * 120 % apart, centred in the middle of the frame no wider than 90 % of it, white, with a dark
 * shadow straight behind it so the words read over any picture. No edge, rule or backing.
 */
export const TEXT_DEFAULT_LOOK: Readonly<TextLook> = Object.freeze({
  typeface: "geist", weight: "regular", italic: false, size: 0.08, tracking: 0, leading: 1.2, capitals: false,
  align: "center", x: 0.5, y: 0.5, room: 0.9,
  fill: Object.freeze({ kind: "solid", color: "#ffffff" }),
  shadow: Object.freeze({ color: "#000000", opacity: 0.8, blur: 0.3, dx: 0, dy: 0 }),
});

/**
 * What a part is when the Inspector switches it on (turn 277 rule 7): the promo's values as 277d
 * draws them, in black where the promo was a dark brown, since a default has to sit on any picture.
 * Shade and Box are the two backings, so a choice between them is a choice between these two.
 */
export const TEXT_PART_DEFAULTS: Readonly<{ edge: TextPart<"edge">; shadow: TextPart<"shadow">; rule: TextPart<"rule">; shade: TextPart<"backing">; box: TextPart<"backing"> }> = Object.freeze({
  edge: Object.freeze({ color: "#000000", width: 0.022 }),
  shadow: Object.freeze({ color: "#000000", opacity: 0.85, blur: 0.35, dx: 0, dy: 0 }),
  rule: Object.freeze({ length: 0.178, weight: 0.03, gap: 0.35, soft: true }),
  shade: Object.freeze({ kind: "shade", color: "#000000", opacity: 0.45 }),
  box: Object.freeze({ kind: "box", color: "#000000", opacity: 0.45 }),
});

type Timeline = Pick<ProductionTimeline, "tracks" | "history">;
type TextClip = TimelineClip & { source: Extract<TimelineClip["source"], { kind: "text" }> };
const isText = (clip: TimelineClip | null | undefined): clip is TextClip => clip?.source.kind === "text";

/**
 * The look of the title most recently placed or changed (R-30), so four names made in a row match.
 * Read from Undo, newest first: an entry that placed a title, or changed one's words or look, gives
 * the look it left. A trim or a move of an older title changes neither, so it is passed over and a
 * name made after it still matches the last one styled. Within one entry (a `text-set` on several
 * titles) the last clip it lists wins, so the answer never depends on anything but the record.
 * Undo moves an entry to Redo, so after Undo the look is the one before the change undone, which
 * is what the person is looking at.
 *
 * Undo is bounded and a record written before text existed has none of it, so when Undo holds no
 * title the one on the timeline that starts latest lends its look (the higher track, then the later
 * id, on a tie): the nearest the record still comes to "most recent". With no title at all, the
 * default. Always a copy, never the frozen default or an object the record holds, so a caller may
 * change what it is given.
 */
export function textLookForNewClip(timeline: Timeline): TextLook {
  for (let index = timeline.history.undo.length - 1; index >= 0; index--) {
    const entry = timeline.history.undo[index]!;
    if (entry.kind !== "change") continue;
    let look: TextLook | null = null;
    for (const { before, after } of entry.clips) {
      if (!isText(after)) continue;
      // The same words in the same look: a trim, a move or a fade, not a title styled.
      if (isText(before) && canonicalJson(before.source) === canonicalJson(after.source)) continue;
      look = after.source.look;
    }
    if (look !== null) return structuredClone(look);
  }
  let latest: { clip: TextClip; order: number } | null = null;
  const later = (clip: TextClip, order: number, than: { clip: TextClip; order: number }): boolean =>
    clip.startFrame !== than.clip.startFrame ? clip.startFrame > than.clip.startFrame
      : order !== than.order ? order > than.order : clip.id > than.clip.id;
  for (const track of timeline.tracks) for (const clip of track.clips) {
    if (isText(clip) && (latest === null || later(clip, track.order, latest))) latest = { clip, order: track.order };
  }
  return structuredClone(latest?.clip.source.look ?? TEXT_DEFAULT_LOOK);
}

/**
 * Add text, as one batch (R-24, R-29): a four-second title reading "Text" at the playhead, in the
 * look of the last one made (R-30), with half-second fades. It goes on the highest Picture track
 * whose whole four seconds from the playhead are free — the base track among them, since 277a asks
 * it first — and a track that is hidden is passed over, because the words are placed to be seen
 * while they are typed (§3.2: a hidden track hides its text). When none has room, the batch first
 * adds the next Overlay track, named and numbered as the Cut names an overlay it makes for a drop;
 * left without an order, the reducer puts it above every track, so it is the highest picture.
 * Sent together, the track and the clip are one revision and one Undo.
 */
export function textAddCommands(timeline: Pick<ProductionTimeline, "tracks" | "history" | "frameRate">,
  at: { playheadFrame: number; clipId: TimelineClipId }): TimelineClipCommand[] {
  if (!Number.isSafeInteger(at.playheadFrame) || at.playheadFrame < 0) throw new RangeError("The playhead is a whole frame");
  const durationFrames = secondsToFrames(TEXT_ADD_SECONDS, timeline.frameRate), fade = secondsToFrames(TEXT_ADD_FADE_SECONDS, timeline.frameRate);
  const start = at.playheadFrame, end = start + durationFrames;
  const free = (track: TimelineTrack) => !track.clips.some(clip => clip.startFrame < end && clip.startFrame + clip.durationFrames > start);
  // Highest first, then by id, so two tracks that share an order are chosen between the same way every time.
  const pictures = timeline.tracks.filter(track => track.kind === "picture" && !track.muted)
    .sort((a, b) => b.order - a.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const commands: TimelineClipCommand[] = [];
  let trackId = pictures.find(free)?.id;
  if (trackId === undefined) {
    const overlay = nextOverlayTrack(timeline);
    commands.push({ kind: "add-track", trackId: overlay.trackId, trackKind: "picture", name: overlay.name });
    trackId = overlay.trackId;
  }
  commands.push({ kind: "place", trackId, clip: {
    id: at.clipId, startFrame: start, durationFrames, sourceInFrames: 0,
    source: { kind: "text", label: TEXT_ADD_WORDS, text: TEXT_ADD_WORDS, look: textLookForNewClip(timeline) },
    fade: { inFrames: fade, outFrames: fade },
  } });
  return commands;
}

/**
 * What choosing a typeface sends (turn 277 rules 7, 10): the face, and Regular or upright with it
 * wherever a clip's weight or slant is one the face lacks, so the choice is one revision and never
 * a refusal. A slant goes before a weight: a bold italic title moved to a face with bold and no
 * italic stays bold. With several titles the patch is one for all, so what one of them needs the
 * rest are given too, and it is checked that every one of them then draws.
 */
export function textTypefacePatch(typeface: TextTypefaceId, looks: readonly Pick<TextLook, "weight" | "italic">[]): TextLookPatch {
  let upright = false, regular = false;
  for (const look of looks) {
    if (textTypefaceFile(typeface, look.weight, look.italic).ok) continue;
    if (textTypefaceFile(typeface, look.weight, false).ok) upright = true;
    else if (textTypefaceFile(typeface, "regular", look.italic).ok) regular = true;
    else { upright = true; regular = true; }
  }
  if (looks.some(look => !textTypefaceFile(typeface, regular ? "regular" : look.weight, upright ? false : look.italic).ok)) { upright = true; regular = true; }
  return { typeface, ...(regular ? { weight: "regular" as const } : {}), ...(upright ? { italic: false } : {}) };
}
