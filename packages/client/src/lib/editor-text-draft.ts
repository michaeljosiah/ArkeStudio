import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyTextSetCommand,
  canonicalJson,
  textPictureFrame,
  textPicturePath,
  type ProductionTimeline,
  type TextDraftAnswer,
  type TextDraftCommand,
  type TextDraftItem,
  type TextDraftPicture,
  type TextDraftResult,
  type TextFrame,
  type TextLookPatch,
  type TextSetCommand,
  type TimelineClip,
  type TimelineClipId,
} from "@arke-studio/contracts";
import { onTextDraft, send, subscribeCommandFailures, subscribeTimelineRefusals } from "./store.js";

/**
 * Words and values shown while they are typed (SPEC-065 R-32, §2.3; turn 277 rule 5). The window
 * cannot lay out or paint, so it asks the coordinator for a draft over its own socket and is
 * answered on that socket alone. A draft is a picture held as a blob for as long as the Viewer
 * shows it, and nothing else: no revision, no file, no event. Only the Viewer drafts; the lanes and
 * the Inspector's heading keep the stored words until the field commits.
 */

/** How the channel reaches the coordinator. The store's socket in the app; a stub in a test. */
export interface TextDraftWire {
  send(message: TextDraftCommand): boolean;
  /** Every draft answer this window hears, by request. */
  listen(listener: (requestId: string, answer: TextDraftAnswer) => void): () => void;
  /** Asks the transport could not read (the wire's `invalid`): they will never be answered. */
  refused(listener: (requestId: string) => void): () => void;
  uuid(): string;
}

export const STORE_DRAFT_WIRE: TextDraftWire = {
  send: message => send(message),
  listen: listener => onTextDraft(frame => listener(frame.requestId, frame.answer)),
  refused: listener => subscribeCommandFailures(failure => { if (failure.command === "text-draft" && failure.requestId !== null) listener(failure.requestId); }),
  uuid: () => crypto.randomUUID(),
};

/** One picture wanted: its key (the path the draft plan names it by), the frame and the words and look. */
export interface TextPaintRequest { key: string; frame: TextFrame; item: TextDraftItem }

/** How long typing must pause before a draft is asked for, and how long an ask is waited on. */
export const TEXT_DRAFT_DEBOUNCE_MS = 120, TEXT_DRAFT_TIMEOUT_MS = 5000;

/**
 * The asks one window sends. A picture is asked for once typing pauses, one at a time: a newer
 * wanted picture replaces the one waiting to go, and only the latest ask's answer is shown, so an
 * answer that arrives after its ask was given up on is dropped. A measure (a drawn size or a check
 * before a commit) goes one at a time too, in order. Since this window never has two asks of a kind
 * with the coordinator at once, the coordinator never has to supersede one of ours; an answer of
 * `superseded` is ignored all the same.
 */
export class TextDraftChannel {
  private wanted: TextPaintRequest | null = null;
  private due = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private flight: { requestId: string; key: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private measures: { frame: TextFrame; items: TextDraftItem[]; timeoutMs: number; resolve: (results: TextDraftResult[] | null) => void }[] = [];
  private measuring: { requestId: string; timer: ReturnType<typeof setTimeout>; resolve: (results: TextDraftResult[] | null) => void } | null = null;
  private stops: (() => void)[];
  private stopped = false;

  constructor(private wire: TextDraftWire, private onPainted: (key: string, result: TextDraftResult, picture: TextDraftPicture | undefined) => void,
    private timing = { debounceMs: TEXT_DRAFT_DEBOUNCE_MS, timeoutMs: TEXT_DRAFT_TIMEOUT_MS }) {
    this.stops = [wire.listen((requestId, answer) => this.heard(requestId, answer)), wire.refused(requestId => this.heard(requestId, null))];
  }

  /** Wants a picture once typing pauses, in place of any still waiting to go; null wants none. */
  paint(request: TextPaintRequest | null): void {
    if (this.stopped) return;
    this.wanted = request; this.due = false;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = null;
    if (request === null) return;
    this.debounce = setTimeout(() => { this.debounce = null; this.due = true; this.pump(); }, this.timing.debounceMs);
  }

  /** Each item's drawn size or refusal, in order; null when no answer came in time or the window is not connected. */
  measure(frame: TextFrame, items: TextDraftItem[], timeoutMs: number = this.timing.timeoutMs): Promise<TextDraftResult[] | null> {
    if (this.stopped || items.length === 0) return Promise.resolve(null);
    return new Promise(resolve => { this.measures.push({ frame, items, timeoutMs, resolve }); this.pumpMeasure(); });
  }

  destroy(): void {
    this.stopped = true;
    for (const stop of this.stops) stop();
    if (this.debounce !== null) clearTimeout(this.debounce);
    if (this.flight !== null) clearTimeout(this.flight.timer);
    if (this.measuring !== null) { clearTimeout(this.measuring.timer); this.measuring.resolve(null); }
    for (const waiting of this.measures) waiting.resolve(null);
    this.wanted = null; this.flight = null; this.measuring = null; this.measures = [];
  }

  private pump(): void {
    if (this.stopped || this.flight !== null || !this.due || this.wanted === null) return;
    const wanted = this.wanted;
    this.wanted = null; this.due = false;
    const requestId = this.wire.uuid();
    if (!this.wire.send({ kind: "text-draft", requestId, frame: wanted.frame, ask: { kind: "paint", item: wanted.item } })) return;
    const timer = setTimeout(() => {
      if (this.flight?.requestId !== requestId) return;
      this.flight = null; this.pump();
    }, this.timing.timeoutMs);
    this.flight = { requestId, key: wanted.key, timer };
  }

  private pumpMeasure(): void {
    if (this.stopped || this.measuring !== null) return;
    const next = this.measures.shift();
    if (next === undefined) return;
    const requestId = this.wire.uuid();
    if (!this.wire.send({ kind: "text-draft", requestId, frame: next.frame, ask: { kind: "measure", items: next.items } })) {
      next.resolve(null); this.pumpMeasure(); return;
    }
    const timer = setTimeout(() => {
      if (this.measuring?.requestId !== requestId) return;
      this.measuring = null; next.resolve(null); this.pumpMeasure();
    }, next.timeoutMs);
    this.measuring = { requestId, timer, resolve: next.resolve };
  }

  private heard(requestId: string, answer: TextDraftAnswer | null): void {
    if (this.flight?.requestId === requestId) {
      const { key, timer } = this.flight;
      clearTimeout(timer); this.flight = null;
      const result = answer?.kind === "drawn" ? answer.results[0] : undefined;
      if (result !== undefined) this.onPainted(key, result, answer?.kind === "drawn" ? answer.picture : undefined);
      this.pump();
      return;
    }
    if (this.measuring?.requestId === requestId) {
      const { timer, resolve } = this.measuring;
      clearTimeout(timer); this.measuring = null;
      resolve(answer?.kind === "drawn" ? answer.results : null);
      this.pumpMeasure();
    }
    // Anything else answers an ask this window gave up on: dropped.
  }
}

/** What one clip is being changed to while it is typed: the words, a look patch, or both. */
export interface TextDraftWant { clipId: TimelineClipId; text?: string; look?: TextLookPatch }

/** What the Viewer draws in place of the record: a timeline in memory, and the pictures it names that the media route does not hold. */
export interface TextDraftViewer { timeline: ProductionTimeline; pictureUrls: ReadonlyMap<string, string> }

export type TextDraftPlan =
  | { kind: "none" }
  /** The draft is the stored picture: nothing is asked, and the timeline only drops a fade, or is the record. */
  | { kind: "stored"; timeline: ProductionTimeline | null }
  /** Refused before any ask, in the record's words: empty, 13 lines, 501 characters. */
  | { kind: "refused"; reason: string; timeline: ProductionTimeline | null }
  | { kind: "picture"; clipId: TimelineClipId; key: string; item: TextDraftItem; timeline: ProductionTimeline; withdrawn: ProductionTimeline | null };

/** The record with one clip's edge fades left out, in memory. Its crossfades stay: those are a pair's (SPEC-054 R-17). */
function withoutFade(timeline: ProductionTimeline, clipId: string): ProductionTimeline {
  return { ...timeline, tracks: timeline.tracks.map(track => track.clips.some(clip => clip.id === clipId && clip.fade !== undefined)
    ? { ...track, clips: track.clips.map(clip => (clip.id === clipId ? { ...clip, fade: undefined } : clip)) } : track) };
}

const clipOf = (timeline: ProductionTimeline, clipId: string): TimelineClip | null =>
  timeline.tracks.flatMap(track => track.clips).find(clip => clip.id === clipId) ?? null;

/**
 * The draft as a plan of what to draw (R-32). The words and the patch are laid on the record in
 * memory by the record's own command (`applyTextSetCommand`), so words a write would refuse are
 * refused here in the record's words and nothing is asked. While the Words field has focus the
 * clip is drawn without its edge fades, in memory only (turn 277 rule 5): a new title starts at
 * the playhead with a fade, and its first frame would otherwise show the words faint. A moving
 * clip's plan names its doubled picture; the draft is painted at the plain frame and put in its
 * place, which keeps the geometry and costs a quarter of the paint.
 */
export function textDraftPlan(timeline: ProductionTimeline | null, frame: TextFrame | null, want: TextDraftWant | null, wordsFocus: TimelineClipId | null): TextDraftPlan {
  if (timeline === null || frame === null) return { kind: "none" };
  const clipId = want?.clipId ?? wordsFocus;
  if (clipId === null) return { kind: "none" };
  const stored = clipOf(timeline, clipId);
  if (stored === null || stored.source.kind !== "text") return { kind: "none" };
  const faded = wordsFocus === clipId ? withoutFade(timeline, clipId) : null;
  if (want === null || want.clipId !== clipId || (want.text === undefined && want.look === undefined)) return { kind: "stored", timeline: faded };
  const command: TextSetCommand = { kind: "text-set", clipIds: [clipId],
    ...(want.text !== undefined ? { text: want.text } : {}), ...(want.look !== undefined ? { look: want.look } : {}) };
  let drafted: ProductionTimeline;
  try { drafted = { ...timeline, tracks: applyTextSetCommand(timeline.tracks, command) }; }
  catch (error) { return { kind: "refused", reason: error instanceof Error ? error.message : String(error), timeline: faded }; }
  const clip = clipOf(drafted, clipId);
  if (clip === null || clip.source.kind !== "text") return { kind: "none" };
  const size = textPictureFrame(frame, clip.motion !== undefined);
  const path = textPicturePath(clip.source, size), held = textPicturePath(stored.source, size);
  if (!path.ok) return { kind: "refused", reason: path.reason, timeline: faded };
  if (held.ok && path.path === held.path) return { kind: "stored", timeline: faded };
  return { kind: "picture", clipId, key: path.path, item: { text: clip.source.text, look: clip.source.look },
    timeline: wordsFocus === clipId ? withoutFade(drafted, clipId) : drafted, withdrawn: faded };
}

/**
 * What the Viewer draws (R-32): a trim in hand first, since the hand is what it follows; then a
 * title's draft, with the pictures only that draft names; then the plan the screen shows. The
 * spans and the monitor mix are never handed the draft: they are keyed on the plan, and a new
 * plan with every keystroke would restart the sound (issue 1158).
 */
export function cutViewerPlan<Plan>(trim: Plan | null, text: { plan: Plan; pictureUrls: ReadonlyMap<string, string> } | null, shown: Plan):
  { plan: Plan; pictureUrls?: ReadonlyMap<string, string> } {
  if (trim !== null) return { plan: trim };
  if (text !== null) return { plan: text.plan, pictureUrls: text.pictureUrls };
  return { plan: shown };
}

/** A picture answered as base64, as a blob URL the Viewer's image loads. */
export function textDraftBlobUrl(png: string): string {
  const bytes = Uint8Array.from(atob(png), character => character.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
}

export interface TextDraftApi {
  /** What the Viewer draws in place of the record, or null. */
  viewer: TextDraftViewer | null;
  /** The draft being typed, or null for none. */
  want: (draft: TextDraftWant | null) => void;
  /** The clip whose Words field has focus, or null. */
  setWordsFocus: (clipId: TimelineClipId | null) => void;
  /** The painter's answer for what is wanted now — its drawn size or its refusal — or null while there is none. */
  result: TextDraftResult | null;
  /** Words refused before any ask, in the record's words. */
  localRefusal: string | null;
  /** Each stored clip's drawn size or refusal, by id, measured on selection and on every revision. */
  stored: ReadonlyMap<string, TextDraftResult>;
  /** Each item's drawn size or refusal at the Viewer's frame; null when no answer came. */
  measure: (items: TextDraftItem[], timeoutMs?: number) => Promise<TextDraftResult[] | null>;
  /**
   * The field has committed: the draft stays up until the snapshot carries the new revision, so
   * the Viewer does not flash back to the old words in between.
   */
  hold: () => void;
}

interface Painted { key: string; clipId: string; revision: number; result: TextDraftResult; url: string | null; timeline: ProductionTimeline }

const EMPTY_URLS: ReadonlyMap<string, string> = new Map();
const NO_STORED: ReadonlyMap<string, TextDraftResult> = new Map();

/**
 * The draft controller (R-32). It lives with the Cut rather than the Inspector, so a commit still
 * waiting on its check survives the selection moving. `selected` is the text clips selected now:
 * their stored words are measured on selection and on every revision, which is how the Inspector
 * knows the size Fit draws them at (R-10) and any refusal of a look already stored.
 */
export function useTextDraft({ timeline, frame, selected, wire = STORE_DRAFT_WIRE }: {
  timeline: ProductionTimeline | null;
  frame: TextFrame | null;
  selected: readonly TimelineClip[];
  wire?: TextDraftWire;
}): TextDraftApi {
  const [wanted, setWanted] = useState<{ want: TextDraftWant; revision: number } | null>(null);
  const [focus, setFocus] = useState<TimelineClipId | null>(null);
  const [painted, setPainted] = useState<Painted | null>(null);
  const [stored, setStored] = useState<ReadonlyMap<string, TextDraftResult>>(NO_STORED);
  const [held, setHeld] = useState<{ revision: number; viewer: TextDraftViewer | null } | null>(null);
  const revision = timeline?.revision ?? -1;
  // A draft is wanted against the revision it was typed on. A revision that lands from elsewhere
  // sets every field back to the record and drops what was typed in it, and the draft goes with it:
  // kept, it was painted again on the new record and the Viewer went on drawing words that were in
  // no field and would never be saved, until the selection changed. A commit drops its own first.
  const wantedNow = wanted !== null && wanted.revision === revision ? wanted.want : null;
  const plan = useMemo(() => textDraftPlan(timeline, frame, wantedNow, focus), [timeline, frame, wantedNow, focus]);
  // What each picture asked for was drafted from, so an answer that lands after typing moved on is
  // still shown in its own timeline: the newest picture there is, until a newer one comes.
  const asked = useRef(new Map<string, { clipId: string; revision: number; timeline: ProductionTimeline }>());
  const live = useRef({ plan, revision });
  live.current = { plan, revision };
  // Made in an effect, not a memo, so a component mounted twice (React's strict development mode)
  // gets a live channel the second time rather than the one its first unmount destroyed.
  const [channel, setChannel] = useState<TextDraftChannel | null>(null);
  useEffect(() => {
    const made = new TextDraftChannel(wire, (key, result, picture) => {
      const now = live.current, source = asked.current.get(key);
      // Only a picture of the clip still being drafted, on the record it was asked against.
      if (source === undefined || now.plan.kind !== "picture" || source.revision !== now.revision || now.plan.clipId !== source.clipId) return;
      // A refusal of words already typed past says nothing about the words there now.
      if (!result.ok && key !== now.plan.key) return;
      const url = result.ok && picture !== undefined ? textDraftBlobUrl(picture.png) : null;
      setPainted({ key, clipId: source.clipId, revision: source.revision, result, url, timeline: source.timeline });
    });
    setChannel(made);
    return () => made.destroy();
  }, [wire]);

  const planKey = plan.kind === "picture" ? plan.key : null;
  const frameWidth = frame?.width ?? 0, frameHeight = frame?.height ?? 0;
  useEffect(() => {
    const now = live.current.plan;
    if (channel === null) return;
    if (now.kind !== "picture" || frameWidth === 0) { channel.paint(null); return; }
    asked.current.set(now.key, { clipId: now.clipId, revision: live.current.revision, timeline: now.timeline });
    // Two are enough: the one in flight and the one about to go.
    for (const key of [...asked.current.keys()].slice(0, -2)) asked.current.delete(key);
    channel.paint({ key: now.key, frame: { width: frameWidth, height: frameHeight }, item: now.item });
  }, [channel, planKey, frameWidth, frameHeight]);
  // A draft no longer wanted gives its picture up, so the next one starts clean.
  const planKind = plan.kind;
  useEffect(() => { if (planKind !== "picture") setPainted(null); }, [planKind]);

  // Stored words, measured on selection and whenever they or the frame change.
  const storedItems = useMemo(() => selected.flatMap(clip => clip.source.kind === "text"
    ? [{ id: clip.id, item: { text: clip.source.text, look: clip.source.look } }] : []), [selected]);
  const storedKey = frameWidth === 0 ? "" : canonicalJson({ frameWidth, frameHeight, items: storedItems });
  const storedNow = useRef(storedItems);
  storedNow.current = storedItems;
  useEffect(() => {
    const items = storedNow.current;
    if (channel === null) return;
    if (storedKey === "" || items.length === 0) { setStored(NO_STORED); return; }
    let current = true;
    void channel.measure({ width: frameWidth, height: frameHeight }, items.map(entry => entry.item)).then(results => {
      if (!current || results === null) return;
      setStored(new Map(items.flatMap((entry, index) => {
        const result = results[index];
        return result === undefined ? [] : [[entry.id, result] as const];
      })));
    });
    return () => { current = false; };
  }, [channel, storedKey, frameWidth, frameHeight]);

  // A commit's draft stays up until the revision moves, a refusal arrives, or a bounded wait ends.
  useEffect(() => { if (held !== null && held.revision !== revision) setHeld(null); }, [held, revision]);
  useEffect(() => {
    if (held === null) return;
    const timer = setTimeout(() => setHeld(null), 8000);
    const stop = subscribeTimelineRefusals(() => setHeld(null));
    return () => { clearTimeout(timer); stop(); };
  }, [held]);

  const fresh = painted !== null && painted.revision === revision && plan.kind === "picture" && painted.clipId === plan.clipId ? painted : null;
  const viewer = useMemo((): TextDraftViewer | null => {
    if (plan.kind === "none") return null;
    if (plan.kind !== "picture") return plan.timeline === null ? null : { timeline: plan.timeline, pictureUrls: EMPTY_URLS };
    // A refused draft is withdrawn: the Viewer shows the stored words (rule 13).
    const refused = fresh !== null && fresh.key === plan.key && !fresh.result.ok;
    if (fresh !== null && fresh.url !== null && !refused) return { timeline: fresh.timeline, pictureUrls: new Map([[fresh.key, fresh.url]]) };
    return plan.withdrawn === null ? null : { timeline: plan.withdrawn, pictureUrls: EMPTY_URLS };
  }, [plan, fresh]);

  // A picture is held no longer than something shows it, and every one is let go on unmount.
  const heldViewer = held !== null && held.revision === revision ? held.viewer : undefined;
  const inUseKey = [...(viewer?.pictureUrls.values() ?? []), ...(heldViewer?.pictureUrls.values() ?? []), ...(painted?.url ? [painted.url] : [])].join(" ");
  const alive = useRef(new Set<string>());
  useEffect(() => {
    const keep = new Set(inUseKey === "" ? [] : inUseKey.split(" "));
    for (const url of alive.current) if (!keep.has(url)) URL.revokeObjectURL(url);
    alive.current = keep;
  }, [inUseKey]);
  useEffect(() => () => { for (const url of alive.current) URL.revokeObjectURL(url); alive.current = new Set(); }, []);

  const want = useCallback((draft: TextDraftWant | null) => setWanted(before => {
    const now = live.current.revision;
    if (draft === null) return null;
    return before !== null && before.revision === now && canonicalJson(before.want) === canonicalJson(draft) ? before : { want: draft, revision: now };
  }), []);
  const measure = useCallback((items: TextDraftItem[], timeoutMs?: number) =>
    frameWidth === 0 || channel === null ? Promise.resolve(null) : channel.measure({ width: frameWidth, height: frameHeight }, items, timeoutMs), [channel, frameWidth, frameHeight]);
  const hold = useCallback(() => setHeld({ revision: live.current.revision, viewer }), [viewer]);
  return {
    viewer: heldViewer !== undefined ? heldViewer : viewer,
    want, setWordsFocus: setFocus, measure, hold,
    result: fresh !== null && plan.kind === "picture" && fresh.key === plan.key ? fresh.result : null,
    localRefusal: plan.kind === "refused" ? plan.reason : null,
    stored,
  };
}
