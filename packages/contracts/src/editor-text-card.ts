import type { ZodNumber } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { TEXT_MAX_CHARACTERS, TEXT_MAX_LINES, TextLookSchema, type TextLook, type TextSource } from "./editor-text.js";
import { TEXT_SET_MAX_CLIPS } from "./editor-text-set.js";
import { TEXT_TYPEFACES, TEXT_TYPEFACE_IDS, TEXT_TYPEFACE_STYLES, type TextTypefaceId } from "./editor-text-typefaces.js";
import type { ProductionTimeline, TimelineClip, TimelineTrack } from "./timeline.js";

/**
 * How a text clip reads on a request's card and to Arke (SPEC-065 R-35, R-36). It sits beside the
 * record so that neither the card nor the guide can state a field or a bound the record does not
 * hold: the guide's numbers are read from the schema, and the card's from the clips. Nothing here
 * lays out or paints, so the client takes it for the cost of its strings.
 */

/**
 * Turn 277's named places (SPEC-065 §3.4): choosing one sets X, Y and the alignment, and a look
 * that matches none reads as its position. Middle and Lower third are the turn's numbers; the
 * other three are this slice's, mirrored from them, and the Inspector's Place (slice 6) offers
 * this table and no other, so a card and the Inspector never name one look two ways.
 */
export const TEXT_PLACES = [
  { name: "Middle", x: 0.5, y: 0.5, align: "center" },
  { name: "Lower third", x: 0.5, y: 0.75, align: "center" },
  { name: "Upper third", x: 0.5, y: 0.25, align: "center" },
  { name: "Lower left", x: 0.1, y: 0.75, align: "left" },
  { name: "Lower right", x: 0.9, y: 0.75, align: "right" },
] as const satisfies readonly { name: string; x: number; y: number; align: TextLook["align"] }[];
export type TextPlaceName = (typeof TEXT_PLACES)[number]["name"];

/** The place a look sits at by name, or null. Exact: a place nudged by hand is no longer that place (turn 277 rule 11). */
export function namedTextPlace(look: Pick<TextLook, "x" | "y" | "align">): TextPlaceName | null {
  return TEXT_PLACES.find(place => place.x === look.x && place.y === look.y && place.align === look.align)?.name ?? null;
}

// Every number a per cent, as the Inspector shows it (turn 277 rule 8). Two places are as fine as a
// person types, and they keep floating-point noise (0.071 is 7.1000000000000005 per cent) off a card.
const percent = (value: number): string => `${Number((value * 100).toFixed(2))}%`;
const ALIGN = { left: "Left", center: "Centre", right: "Right" } as const;
// Lower-cased as a picture's name takes them, so two spellings of one colour never read as a change.
const colour = (value: string): string => value.toLowerCase();
const onOff = (value: boolean): string => value ? "On" : "Off";

/** The named place, else the position: `X 8%, Y 72%, Left`. */
export function textPlaceLabel(look: Pick<TextLook, "x" | "y" | "align">): string {
  return namedTextPlace(look) ?? `X ${percent(look.x)}, Y ${percent(look.y)}, ${ALIGN[look.align]}`;
}

/** A look as the Inspector reads it, label then value, in the Inspector's order. An absent part reads None. */
export function textLookValues(look: TextLook): ReadonlyArray<readonly [label: string, value: string]> {
  const { fill, edge, shadow, rule, backing } = look;
  return [
    ["Typeface", TEXT_TYPEFACES[look.typeface].name],
    ["Weight", look.weight === "bold" ? "Bold" : "Regular"],
    ["Italic", onOff(look.italic)],
    ["Capitals", onOff(look.capitals)],
    ["Size", percent(look.size)],
    ["Tracking", percent(look.tracking)],
    ["Line", percent(look.leading)],
    ["Place", textPlaceLabel(look)],
    ["Max width", percent(look.room)],
    ["Fill", fill.kind === "solid" ? colour(fill.color) : fill.stops.map(stop => `${colour(stop.color)} ${percent(stop.at)}`).join(", ")],
    ["Edge", edge ? `${colour(edge.color)}, width ${percent(edge.width)}` : "None"],
    ["Shadow", shadow
      ? `${colour(shadow.color)}, opacity ${percent(shadow.opacity)}, softness ${percent(shadow.blur)}, X ${percent(shadow.dx)}, Y ${percent(shadow.dy)}`
      : "None"],
    ["Rule", rule ? `length ${percent(rule.length)}, thickness ${percent(rule.weight)}, distance ${percent(rule.gap)}${rule.soft ? ", faded ends" : ""}` : "None"],
    ["Backing", backing ? `${backing.kind === "box" ? "Box" : "Shade"}, ${colour(backing.color)}, opacity ${percent(backing.opacity)}` : "None"],
  ];
}

/** What a request does to one text clip, in the person's terms (R-36). */
export interface EditorTextChange {
  change: "add" | "remove" | "change";
  clipId: string;
  /** The words in full as stored: the words added or removed, or, for a change, the words before it. */
  words: string;
  /** The track's name, not its id: what the person reads in the Cut. */
  track: string;
  startFrame: number;
  endFrame: number;
  /** `textPlaceLabel` of the look. */
  place: string;
  /** For a change, each value that differs, before and after: Words, Track, Frames, then the look's rows. */
  values: ReadonlyArray<{ label: string; before: string; after: string }>;
}

type TextClip = TimelineClip & { source: TextSource };
const isText = (clip: TimelineClip): clip is TextClip => clip.source.kind === "text";
// Code-unit order, never the machine's collation: the card reads alike on every host.
const byId = (a: { id: string }, b: { id: string }): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
interface Held { clip: TextClip; track: TimelineTrack }

/** Every text clip, in track order and then start order, as the Cut lays them out. */
function textClipsOf(timeline: Pick<ProductionTimeline, "tracks">): Held[] {
  return [...timeline.tracks].sort((a, b) => a.order - b.order || byId(a, b))
    .flatMap(track => track.clips.filter(isText).sort((a, b) => a.startFrame - b.startFrame || byId(a, b)).map(clip => ({ clip, track })));
}

// A line break as ⏎, which reads the same in whatever a card draws the line in, where a newline
// would be folded away. Not the ` / ` turn 277's notes write a two-line title with: a person types
// a slash, and then one line and two would read alike on a card while their pictures differ. No
// face has ⏎ and the painter refuses a character its face lacks (R-21), so stored words never do.
const quoted = (words: string): string => `“${words.split("\n").join(" ⏎ ")}”`;
const frames = (clip: TimelineClip): string => `${clip.startFrame}–${clip.startFrame + clip.durationFrames}`;

function stated(change: EditorTextChange["change"], held: Held, values: EditorTextChange["values"]): EditorTextChange {
  const { clip, track } = held;
  return { change, clipId: clip.id, words: clip.source.text, track: track.name, startFrame: clip.startFrame,
    endFrame: clip.startFrame + clip.durationFrames, place: textPlaceLabel(clip.source.look), values };
}

/**
 * Every text clip two timelines disagree about, paired by clip id across tracks: in the after
 * timeline's track order and clip start order, then the removed ones. A clip whose words, look,
 * track and frames are all unchanged is not listed: a fade or a move on a title is the generic
 * lines' to state, not these.
 */
export function editorTextChanges(before: Pick<ProductionTimeline, "tracks">, after: Pick<ProductionTimeline, "tracks">): EditorTextChange[] {
  const was = new Map(textClipsOf(before).map(held => [held.clip.id, held] as const));
  const now = textClipsOf(after), kept = new Set(now.map(held => held.clip.id));
  const changes: EditorTextChange[] = [];
  for (const held of now) {
    const prior = was.get(held.clip.id);
    if (prior === undefined) { changes.push(stated("add", held, [])); continue; }
    const values: { label: string; before: string; after: string }[] = [];
    const differs = (label: string, then: string, next: string) => { if (then !== next) values.push({ label, before: then, after: next }); };
    // Decided on the stored words, never on how a card writes them.
    if (prior.clip.source.text !== held.clip.source.text) values.push({ label: "Words", before: quoted(prior.clip.source.text), after: quoted(held.clip.source.text) });
    if (prior.track.id !== held.track.id) values.push({ label: "Track", before: prior.track.name, after: held.track.name });
    differs("Frames", frames(prior.clip), frames(held.clip));
    const then = textLookValues(prior.clip.source.look), next = textLookValues(held.clip.source.look);
    then.forEach(([label, value], index) => differs(label, value, next[index]![1]));
    // A look that moved by less than a card shows is still a change the person accepts, so it is
    // listed by its words alone rather than left off.
    if (values.length > 0 || canonicalJson(prior.clip.source.look) !== canonicalJson(held.clip.source.look)) {
      changes.push({ ...stated("change", held, values), words: prior.clip.source.text });
    }
  }
  for (const held of was.values()) if (!kept.has(held.clip.id)) changes.push(stated("remove", held, []));
  return changes;
}

/** One card line (R-36): an add or a removal by its words, track, frames and place; a change by what it changes. */
export function describeEditorTextChange(change: EditorTextChange): string {
  if (change.change === "change") {
    return [`Changes text ${quoted(change.words)}`, ...change.values.map(value => `${value.label} ${value.before} → ${value.after}`)].join(" · ");
  }
  return [`${change.change === "add" ? "Adds" : "Removes"} text ${quoted(change.words)}`, change.track,
    `frames ${change.startFrame}–${change.endFrame}`, change.place].join(" · ");
}

// Arke's guide (R-35). Faces, places, fields and bounds are read from their tables and the schema,
// so the guide cannot tell Arke of a value the record would refuse.
const span = (bound: ZodNumber): string => `${bound.minValue ?? "any"} to ${bound.maxValue ?? "any"}`;
const list = (items: readonly string[]): string => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const LOOK = TextLookSchema.shape;
const EDGE = LOOK.edge.unwrap().shape, SHADOW = LOOK.shadow.unwrap().shape, RULE = LOOK.rule.unwrap().shape, BACKING = LOOK.backing.unwrap().shape;
const fields = (optional: boolean): string[] => Object.entries(LOOK).filter(([, schema]) => schema.isOptional() === optional).map(([field]) => field);
const styles = (id: TextTypefaceId): string[] =>
  TEXT_TYPEFACE_STYLES.filter(style => TEXT_TYPEFACES[id].files[style] !== undefined).map(style => style.replace("-", " "));

/** What Arke is told about titles, one ` | ` clause each, read beside the command list. */
export const TEXT_REQUEST_GUIDE = [
  `place may carry a title: clip.source {kind: "text", label: its first line, text, look}, sourceInFrames 0, on a Picture track, with no gain, audio, role or link`,
  `text is 1 to ${TEXT_MAX_CHARACTERS} characters in at most ${TEXT_MAX_LINES} lines, stored as typed; a line ends only where you break it and nothing wraps`,
  `look holds ${list(fields(false))}, may hold ${list(fields(true))}, and holds nothing else`,
  `typeface is one id: ${TEXT_TYPEFACE_IDS.map(id => `${id} ${styles(id).join(", ")}`).join("; ")}`,
  `weight is regular or bold and italic true or false, only as the typeface lists them`,
  `size ${span(LOOK.size)} of the frame's height; tracking ${span(LOOK.tracking)} and leading ${span(LOOK.leading)} of the size; room ${span(LOOK.room)} of the frame's width, and a line wider than room draws the whole block smaller`,
  `x ${span(LOOK.x)} and y ${span(LOOK.y)} of the frame: y is the block's middle, x its left edge, centre or right edge as align is left, center or right`,
  `capitals true draws upper case and keeps the words as typed`,
  `fill {kind: "solid", color} or {kind: "gradient", stops: 2 to 4 of {at 0 to 1, color}}, colours as "#rrggbb"`,
  `edge {color, width ${span(EDGE.width)}}; shadow {color, opacity ${span(SHADOW.opacity)}, blur ${span(SHADOW.blur)}, dx ${span(SHADOW.dx)}, dy ${span(SHADOW.dy)}}; `
    + `rule {length ${span(RULE.length)} of the frame's width, weight ${span(RULE.weight)}, gap ${span(RULE.gap)}, soft}; `
    + `backing {kind: ${BACKING.kind.options.join(" or ")}, color, opacity ${span(BACKING.opacity)}}; edge width, blur, dx, dy, rule weight and gap are of the size`,
  `named places: ${TEXT_PLACES.map(place => `${place.name} x ${place.x}, y ${place.y}, ${place.align}`).join("; ")}`,
  `titles that belong together share one look: copy it from a text clip in get_timeline`,
  `text-set sets look fields on 1 to ${TEXT_SET_MAX_CLIPS} text clips, and the words too when it names one; a field left out keeps its value and null removes edge, shadow, rule or backing`,
  `a character the typeface cannot draw is refused, never replaced; only eb-garamond draws ẹ, ọ and ṣ`,
].join(" | ");
