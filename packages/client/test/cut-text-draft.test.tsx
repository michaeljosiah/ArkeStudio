import { THREE_TITLES, installDom, settle, stateWith } from "./cut-text-fixture.js";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  textPictureFrame, textPicturePath,
  type ProductionTimeline, type TextDraftAnswer, type TextDraftCommand, type TextFrame, type TimelineClip,
} from "@arke-studio/contracts";
import { cutViewerPlan, useTextDraft, type TextDraftApi, type TextDraftViewer, type TextDraftWire } from "../src/lib/editor-text-draft.js";

/**
 * The Viewer's draft (SPEC-065 R-32; turn 277 rules 5 and 13): typing paints a draft the Viewer
 * draws in place of the stored words, in memory, and only once its picture has come; a refused
 * draft is withdrawn; and while Words has focus the title is drawn without its fades.
 */

installDom(1024);
afterEach(() => { document.body.replaceChildren(); });

const FRAME: TextFrame = { width: 1280, height: 720 };
const state = stateWith(THREE_TITLES);
const production = state.world!.productions[0]!;
assert.ok(production.timeline?.status === "ready");
const TIMELINE: ProductionTimeline = production.timeline.timeline;
const clipOf = (timeline: ProductionTimeline, id: string): TimelineClip => timeline.tracks.flatMap(track => track.clips).find(clip => clip.id === id)!;

async function mountDraft() {
  const sent: TextDraftCommand[] = [];
  let heard: ((requestId: string, answer: TextDraftAnswer) => void) | null = null;
  let n = 0;
  const wire: TextDraftWire = {
    send: message => { sent.push(message); return true; },
    listen: listener => { heard = listener; return () => { heard = null; }; },
    refused: () => () => {},
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  };
  let api: TextDraftApi | null = null;
  function Probe({ timeline }: { timeline: ProductionTimeline }) { api = useTextDraft({ timeline, frame: FRAME, selected: [], wire }); return null; }
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Probe timeline={TIMELINE} />));
  return {
    sent,
    /** A snapshot carrying a new revision of the record, as another window's change brings one. */
    async snapshot(timeline: ProductionTimeline) { await act(async () => root.render(<Probe timeline={timeline} />)); },
    get api(): TextDraftApi { assert.ok(api); return api; },
    /** Read afresh each time: an assertion on one reading says nothing of the next. */
    viewer(): TextDraftViewer | null { assert.ok(api); return api.viewer; },
    paints: () => sent.filter(message => message.ask.kind === "paint"),
    async answer(message: TextDraftCommand, answer: TextDraftAnswer) { await act(async () => heard?.(message.requestId, answer)); },
    async act(run: (api: TextDraftApi) => void) { await act(async () => { assert.ok(api); run(api); }); },
    async close() { await act(async () => root.unmount()); container.remove(); },
  };
}
const DRAWN: TextDraftAnswer = { kind: "drawn", results: [{ ok: true, drawnSize: 0.09 }], picture: { name: "0".repeat(64), png: "iVBORw0KGgo=" } };

it("a keystroke asks for a draft once the typing pauses, and only the latest is in flight", async () => {
  const draft = await mountDraft();
  try {
    await draft.act(api => api.want({ clipId: "cl_one", text: "H" }));
    await draft.act(api => api.want({ clipId: "cl_one", text: "Ha" }));
    await draft.act(api => api.want({ clipId: "cl_one", text: "Har" }));
    assert.equal(draft.paints().length, 0, "nothing while typing goes on");
    await settle(160);
    assert.deepEqual(draft.paints().map(message => message.ask.kind === "paint" && message.ask.item.text), ["Har"]);
    assert.deepEqual(draft.paints()[0]!.frame, FRAME, "drawn at the Viewer's frame");
    await draft.act(api => api.want({ clipId: "cl_one", text: "Harb" }));
    await settle(160);
    assert.equal(draft.paints().length, 1, "one in flight at a time");
    await draft.answer(draft.paints()[0]!, DRAWN);
    await settle(5);
    assert.deepEqual(draft.paints().map(message => message.ask.kind === "paint" && message.ask.item.text), ["Har", "Harb"]);
  } finally { await draft.close(); }
});

it("an answer to a superseded ask is dropped", async () => {
  const draft = await mountDraft();
  try {
    await draft.act(api => api.want({ clipId: "cl_one", text: "Harbour lights at dusk" }));
    await settle(160);
    // The draft is given up before its answer comes: Escape, say.
    await draft.act(api => api.want(null));
    await draft.answer(draft.paints()[0]!, DRAWN);
    assert.equal(draft.viewer(), null, "nothing drawn for words no longer wanted");
    assert.equal(draft.api.result, null);
    // While nothing is wanted nothing is drawn whatever was kept, so what tells is the next draft:
    // until its own picture comes, the words given up must not stand in for it.
    await draft.act(api => api.want({ clipId: "cl_one", text: "Something new" }));
    assert.equal(draft.viewer(), null, "the abandoned words are not drawn for the new ones");
    assert.equal(draft.api.result, null, "nor answer for them");
    await settle(160);
    const next = draft.paints().at(-1)!;
    assert.ok(next.ask.kind === "paint" && next.ask.item.text === "Something new");
    await draft.answer(next, DRAWN);
    assert.equal(draft.viewer()?.pictureUrls.size, 1, "the new words, once theirs has come");
  } finally { await draft.close(); }
});

it("a revision that lands while words are drafted drops the draft, as the fields drop what was typed", async () => {
  const draft = await mountDraft();
  try {
    await draft.act(api => api.want({ clipId: "cl_one", text: "Hello there" }));
    await settle(160);
    await draft.answer(draft.paints()[0]!, DRAWN);
    assert.equal(draft.viewer()?.pictureUrls.size, 1, "drawn");
    // Another window resizes the title: the snapshot carries the next revision.
    const resized = { ...TIMELINE, revision: TIMELINE.revision + 1, tracks: TIMELINE.tracks.map(track => ({ ...track,
      clips: track.clips.map(clip => (clip.id === "cl_one" && clip.source.kind === "text" ? { ...clip, source: { ...clip.source, look: { ...clip.source.look, size: 0.1 } } } : clip)) })) };
    await draft.snapshot(resized);
    assert.equal(draft.viewer(), null, "the Viewer draws the record");
    assert.equal(draft.api.result, null);
    await settle(160);
    assert.equal(draft.paints().length, 1, "the words in no field are not painted again on the new record");
  } finally { await draft.close(); }
});

it("the draft plan names the drafted picture and the Viewer maps it to the answered blob", async () => {
  const draft = await mountDraft();
  try {
    await draft.act(api => api.want({ clipId: "cl_one", text: "Harbour lights at dusk" }));
    await settle(160);
    assert.equal(draft.viewer(), null, "the Viewer switches only once the picture has come");
    await draft.answer(draft.paints()[0]!, DRAWN);
    const viewer = draft.viewer();
    assert.ok(viewer);
    const drafted = clipOf(viewer.timeline, "cl_one");
    assert.ok(drafted.source.kind === "text" && drafted.source.text === "Harbour lights at dusk", "the plan is drawn from the draft, in memory");
    const named = textPicturePath(drafted.source, textPictureFrame(FRAME, drafted.motion !== undefined));
    assert.ok(named.ok);
    assert.match(viewer.pictureUrls.get(named.path) ?? "", /^blob:/, "the path the plan names is the answered picture, held as a blob");
    assert.equal(viewer.pictureUrls.size, 1, "no other picture is taken off the media route");
    const stored = clipOf(TIMELINE, "cl_one");
    assert.ok(stored.source.kind === "text" && stored.source.text === "Harbour lights", "the record is untouched");
    assert.deepEqual(draft.api.result, { ok: true, drawnSize: 0.09 });
  } finally { await draft.close(); }
});

it("while Words has focus the draft drops the clip's fades, and only that clip's", async () => {
  const draft = await mountDraft();
  try {
    await draft.act(api => api.setWordsFocus("cl_one"));
    const viewer = draft.viewer();
    assert.ok(viewer, "focus alone draws the clip without its fades, with no picture asked");
    assert.equal(draft.sent.length, 0);
    assert.equal(clipOf(viewer.timeline, "cl_one").fade, undefined);
    assert.deepEqual(clipOf(viewer.timeline, "cl_two").fade, { inFrames: 12, outFrames: 12 }, "every other title keeps its fades");
    assert.deepEqual(clipOf(TIMELINE, "cl_one").fade, { inFrames: 12, outFrames: 12 }, "and the record keeps this one's");
    await draft.act(api => api.setWordsFocus(null));
    assert.equal(draft.viewer(), null, "the true frame returns when focus leaves");
  } finally { await draft.close(); }
});

it("a refused draft withdraws the drafted picture; the Viewer shows the stored words", async () => {
  const draft = await mountDraft();
  try {
    await draft.act(api => { api.setWordsFocus("cl_one"); api.want({ clipId: "cl_one", text: "Harbour" }); });
    await settle(160);
    await draft.answer(draft.paints()[0]!, DRAWN);
    assert.equal(draft.viewer()?.pictureUrls.size, 1);
    await draft.act(api => api.want({ clipId: "cl_one", text: "Alẹ́" }));
    await settle(160);
    await draft.answer(draft.paints()[1]!, { kind: "drawn", results: [{ ok: false, reason: "Geist has no ẹ", field: "words" }] });
    assert.deepEqual(draft.api.result, { ok: false, reason: "Geist has no ẹ", field: "words" });
    const viewer = draft.viewer();
    assert.ok(viewer);
    assert.equal(viewer.pictureUrls.size, 0, "the draft's picture is withdrawn");
    const shown = clipOf(viewer.timeline, "cl_one");
    assert.ok(shown.source.kind === "text" && shown.source.text === "Harbour lights", "the stored words");
    assert.equal(shown.fade, undefined, "still drawn without its fades while Words has focus");
  } finally { await draft.close(); }
});

it("the trim draft wins over a text draft; neither reaches the monitor mix", () => {
  const urls = new Map([["a.png", "blob:a"]]);
  assert.deepEqual(cutViewerPlan("trim", { plan: "text", pictureUrls: urls }, "shown"), { plan: "trim" }, "a trim in hand: the text draft's pictures go with it");
  assert.deepEqual(cutViewerPlan(null, { plan: "text", pictureUrls: urls }, "shown"), { plan: "text", pictureUrls: urls });
  assert.deepEqual(cutViewerPlan(null, null, "shown"), { plan: "shown" });
  // The Viewer's plan is this helper's alone; the monitor mix and the spans read the preview plan,
  // which the Cut builds from the trim draft and the record and never from a text draft.
});
