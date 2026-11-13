import {
  canonicalJson,
  TEXT_LOOK_BOUNDS,
  type TextLook,
  type TextLookNumber,
  type TextLookPatch,
  type TextSetCommand,
  type TimelineClipId,
} from "@arke-studio/contracts";

/**
 * The text Inspector's numbers (SPEC-065 R-31; turn 277 rules 8 and 14). The record keeps
 * fractions of the frame and ems; the screen shows every one as a per cent and never an em, so
 * this is the one place that turns one into the other, and the one place that knows what a
 * selection of several titles shows where their values differ.
 */

/** A value the selected titles do not share: the control shows Mixed and holds no value of its own. */
export const MIXED: unique symbol = Symbol("Mixed");
export type Mixed<T> = T | typeof MIXED;

/** The one value every item holds, or MIXED. Compared as the record compares, so `0.5` and `0.50` are one value. */
export function sameOf<T>(values: readonly T[]): Mixed<T> {
  if (values.length === 0) return MIXED;
  const first = canonicalJson(values[0] ?? null);
  return values.every(value => canonicalJson(value ?? null) === first) ? values[0]! : MIXED;
}

/**
 * A record value as the screen shows it: per cent, two places. The same rounding a request's
 * card uses (`editor-text-card.ts`), so 0.071 reads 7.1 and not 7.1000000000000005, and a value
 * the screen cannot tell apart from the one held is the one held (R-25: it writes nothing).
 */
export const percentShown = (value: number): number => Number((value * 100).toFixed(2));

/** A field's range as the screen shows it, read from the record's own bounds. */
export function percentRange(key: TextLookNumber): { min: number; max: number } {
  const bound = TEXT_LOOK_BOUNDS[key];
  return { min: percentShown(bound.min), max: percentShown(bound.max) };
}

const minus = (value: number): string => String(value).replace("-", "−");
/** The one clause a value out of range is refused with (turn 277 rule 13): `1 to 40 %`. Never clamped. */
export function percentProblem(key: TextLookNumber, shown: number): string | null {
  const { min, max } = percentRange(key);
  return shown < min || shown > max ? `${minus(min)} to ${minus(max)} %` : null;
}

/** What a person typed, as a number, or null. A minus may be typed as either sign, and a trailing % is allowed. */
export function parsePercent(text: string): number | null {
  const value = text.trim().replace(/%$/, "").trim().replace("−", "-");
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** A number in a look by where it sits, or undefined when its part is switched off. */
export function lookNumber(look: TextLook, key: TextLookNumber): number | undefined {
  switch (key) {
    case "edge.width": return look.edge?.width;
    case "shadow.opacity": return look.shadow?.opacity;
    case "shadow.blur": return look.shadow?.blur;
    case "shadow.dx": return look.shadow?.dx;
    case "shadow.dy": return look.shadow?.dy;
    case "rule.length": return look.rule?.length;
    case "rule.weight": return look.rule?.weight;
    case "rule.gap": return look.rule?.gap;
    case "backing.opacity": return look.backing?.opacity;
    default: return look[key];
  }
}

/**
 * The patch that puts one number into one look. A part is replaced whole (R-25), so a number
 * inside a part carries the rest of that look's part with it; a look without the part gets
 * nothing, since the Inspector shows a part's numbers only where the part is on.
 */
export function numberPatch(look: TextLook, key: TextLookNumber, value: number): TextLookPatch {
  switch (key) {
    case "edge.width": return look.edge ? { edge: { ...look.edge, width: value } } : {};
    case "shadow.opacity": return look.shadow ? { shadow: { ...look.shadow, opacity: value } } : {};
    case "shadow.blur": return look.shadow ? { shadow: { ...look.shadow, blur: value } } : {};
    case "shadow.dx": return look.shadow ? { shadow: { ...look.shadow, dx: value } } : {};
    case "shadow.dy": return look.shadow ? { shadow: { ...look.shadow, dy: value } } : {};
    case "rule.length": return look.rule ? { rule: { ...look.rule, length: value } } : {};
    case "rule.weight": return look.rule ? { rule: { ...look.rule, weight: value } } : {};
    case "rule.gap": return look.rule ? { rule: { ...look.rule, gap: value } } : {};
    case "backing.opacity": return look.backing ? { backing: { ...look.backing, opacity: value } } : {};
    case "size": return { size: value };
    case "tracking": return { tracking: value };
    case "leading": return { leading: value };
    case "x": return { x: value };
    case "y": return { y: value };
    case "room": return { room: value };
  }
}

/** One clip's look, by id, as a change reaches it. */
export interface TextLookOf { id: TimelineClipId; look: TextLook }

/**
 * The commands one change to the look sends (R-25, rule 14). Each title is given the patch the
 * change makes of its own look, and titles given the same patch share one `text-set`, so a change
 * to a value that does not depend on the title — a size, a place, a typeface — is one command
 * naming every title selected; the record writes only those that do not hold it already. A change
 * inside a part the titles hold differently (an edge width where their edge colours differ) is one
 * command per kind of edge, since a part is replaced whole and no title's colour may become
 * another's; the batch is still one revision and one Undo. A patch every title holds already sends
 * nothing at all.
 */
export function textLookCommands(clips: readonly TextLookOf[], edit: (look: TextLook) => TextLookPatch): TextSetCommand[] {
  const groups = new Map<string, { clipIds: TimelineClipId[]; look: TextLookPatch; changes: boolean }>();
  for (const clip of clips) {
    const patch = edit(clip.look);
    const held = new Map<string, unknown>(Object.entries(clip.look));
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length === 0) continue;
    const changes = entries.some(([name, value]) => canonicalJson(value ?? null) !== canonicalJson(held.get(name) ?? null));
    const key = canonicalJson(patch);
    const group = groups.get(key);
    if (group) { group.clipIds.push(clip.id); group.changes ||= changes; }
    else groups.set(key, { clipIds: [clip.id], look: patch, changes });
  }
  return [...groups.values()].filter(group => group.changes).map(group => ({ kind: "text-set", clipIds: group.clipIds, look: group.look }));
}

/** A fill of `count` colours: one is solid; more run evenly top to bottom, keeping the colours there were and repeating the last. */
export function fillWithCount(fill: TextLook["fill"], count: number): TextLook["fill"] {
  const colours = fill.kind === "solid" ? [fill.color] : fill.stops.map(stop => stop.color);
  if (count <= 1) return { kind: "solid", color: colours[0]! };
  const stops = Array.from({ length: count }, (_, index) => ({ at: Number((index / (count - 1)).toFixed(4)), color: colours[Math.min(index, colours.length - 1)]! }));
  return { kind: "gradient", stops };
}

/** A fill with one colour changed. Every stop keeps its place, so a gradient placed unevenly is not re-spaced by a pick. */
export function fillWithColour(fill: TextLook["fill"], index: number, color: string): TextLook["fill"] {
  if (fill.kind === "solid") return index === 0 ? { kind: "solid", color } : fill;
  return { kind: "gradient", stops: fill.stops.map((stop, at) => (at === index ? { ...stop, color } : stop)) };
}

export const fillColours = (fill: TextLook["fill"]): string[] => (fill.kind === "solid" ? [fill.color] : fill.stops.map(stop => stop.color));
