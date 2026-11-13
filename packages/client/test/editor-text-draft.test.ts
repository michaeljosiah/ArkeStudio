import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  applyTimelineCommands, seedEmptyPictureTimeline, textLabel,
  type ClientState, type TextDraftAnswer, type TextDraftCommand, type TextDraftItem, type TextDraftResult, type TextLook, type TimelineClip,
} from "@arke-studio/contracts";
import { TextDraftChannel, textDraftPlan, type TextDraftWire } from "../src/lib/editor-text-draft.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The draft channel (SPEC-065 R-32): asks for a picture once typing pauses, keeps one in flight,
 * shows only the latest ask's answer, and never makes the coordinator choose between two of ours.
 * Driven on mocked timers, so the 120 ms pause and the 5 s wait are exact.
 */

const LOOK: TextLook = { typeface: "geist", weight: "regular", italic: false, size: 0.08, tracking: 0, leading: 1.2, capitals: false, align: "center",
  x: 0.5, y: 0.5, room: 0.9, fill: { kind: "solid", color: "#ffffff" } };
const FRAME = { width: 1280, height: 720 };
const item = (text: string): TextDraftItem => ({ text, look: LOOK });

function wire() {
  const sent: TextDraftCommand[] = [];
  let heard: ((requestId: string, answer: TextDraftAnswer) => void) | null = null;
  let refused: ((requestId: string) => void) | null = null;
  let id = 0;
  const stub: TextDraftWire = {
    send: message => { sent.push(message); return true; },
    listen: listener => { heard = listener; return () => { heard = null; }; },
    refused: listener => { refused = listener; return () => { refused = null; }; },
    uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
  };
  return { stub, sent, answer: (requestId: string, answer: TextDraftAnswer) => heard?.(requestId, answer), refuse: (requestId: string) => refused?.(requestId) };
}
const drawn = (size = 0.08): TextDraftAnswer => ({ kind: "drawn", results: [{ ok: true, drawnSize: size }], picture: { name: "0".repeat(64), png: "iVBORw0KGgo=" } });
const paints = (sent: readonly TextDraftCommand[]) => sent.flatMap(message => (message.ask.kind === "paint" ? [message.ask.item.text] : []));

describe("the draft channel", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  it("a keystroke asks for a draft once the typing pauses, and only the latest is in flight", () => {
    const { stub, sent, answer } = wire();
    const painted: string[] = [];
    const channel = new TextDraftChannel(stub, key => painted.push(key));
    channel.paint({ key: "H", frame: FRAME, item: item("H") });
    mock.timers.tick(60);
    channel.paint({ key: "Ha", frame: FRAME, item: item("Ha") });
    mock.timers.tick(119);
    assert.deepEqual(paints(sent), [], "nothing while the typing goes on");
    mock.timers.tick(1);
    assert.deepEqual(paints(sent), ["Ha"], "the latest, 120 ms after the last keystroke");
    channel.paint({ key: "Har", frame: FRAME, item: item("Har") });
    channel.paint({ key: "Harb", frame: FRAME, item: item("Harb") });
    mock.timers.tick(500);
    assert.deepEqual(paints(sent), ["Ha"], "one in flight: the next waits for its answer");
    answer(sent[0]!.requestId, drawn());
    assert.deepEqual(painted, ["Ha"]);
    assert.deepEqual(paints(sent), ["Ha", "Harb"], "then the newest wanted goes; the one it replaced never does");
    channel.destroy();
  });

  it("an answer to a superseded ask is dropped", () => {
    const { stub, sent, answer } = wire();
    const painted: string[] = [];
    const channel = new TextDraftChannel(stub, key => painted.push(key));
    channel.paint({ key: "A", frame: FRAME, item: item("A") });
    mock.timers.tick(120);
    channel.paint({ key: "B", frame: FRAME, item: item("B") });
    mock.timers.tick(120);
    assert.deepEqual(paints(sent), ["A"]);
    // A goes unanswered for five seconds: it is given up on, and B goes in its place.
    mock.timers.tick(5000);
    assert.deepEqual(paints(sent), ["A", "B"]);
    answer(sent[0]!.requestId, drawn());
    assert.deepEqual(painted, [], "A's late answer is dropped");
    answer(sent[1]!.requestId, { kind: "superseded" });
    assert.deepEqual(painted, [], "an answer of superseded paints nothing");
    channel.destroy();
  });

  it("an ask refused as invalid is let go, and the next goes", () => {
    const { stub, sent, refuse } = wire();
    const channel = new TextDraftChannel(stub, () => {});
    channel.paint({ key: "A", frame: FRAME, item: item("A") });
    mock.timers.tick(120);
    channel.paint({ key: "B", frame: FRAME, item: item("B") });
    mock.timers.tick(120);
    refuse(sent[0]!.requestId);
    assert.deepEqual(paints(sent), ["A", "B"]);
    channel.destroy();
  });

  it("measures go one at a time, in order, and each is answered with its results", async () => {
    const { stub, sent, answer } = wire();
    const channel = new TextDraftChannel(stub, () => {});
    const first = channel.measure(FRAME, [item("one")]);
    const second = channel.measure(FRAME, [item("two"), item("three")]);
    assert.equal(sent.length, 1, "the second waits for the first");
    const refusal: TextDraftResult = { ok: false, reason: "Geist has no ẹ", field: "words" };
    answer(sent[0]!.requestId, { kind: "drawn", results: [refusal] });
    assert.deepEqual(await first, [refusal]);
    assert.equal(sent.length, 2);
    assert.ok(sent[1]!.ask.kind === "measure" && sent[1]!.ask.items.length === 2);
    mock.timers.tick(5000);
    assert.equal(await second, null, "no answer in time is no answer");
    channel.destroy();
  });
});

describe("the draft as a plan of what to draw", () => {
  const clip = (id: `cl_${string}`, words: string): TimelineClip => ({ id, startFrame: 0, durationFrames: 96, sourceInFrames: 0,
    source: { kind: "text", label: textLabel(words), text: words, look: LOOK }, fade: { inFrames: 12, outFrames: 12 } });
  const production = (structuredClone(FIXTURE_STATE) as ClientState).world!.productions[0]!;
  production.scenes = []; production.spine = null; production.cut = { audio: [], overlays: [] };
  const timeline = applyTimelineCommands(seedEmptyPictureTimeline(production), [
    { kind: "add-track", trackId: "tr_titles", trackKind: "picture", name: "Titles" },
    { kind: "place", trackId: "tr_titles", clip: clip("cl_a", "Harbour") },
    { kind: "place", trackId: "tr_titles", clip: { ...clip("cl_b", "Evening"), startFrame: 120 } },
  ]);

  it("words the record refuses are refused before any ask, in the record's words", () => {
    for (const [typed, reason] of [["\n\n", "Type some words"], [Array.from({ length: 13 }, () => "x").join("\n"), "Text holds at most 12 lines"]] as const) {
      const plan = textDraftPlan(timeline, FRAME, { clipId: "cl_a", text: typed }, null);
      assert.equal(plan.kind, "refused");
      assert.ok(plan.kind === "refused" && plan.reason === reason);
    }
  });

  it("words that come out as the stored words ask for nothing", () => {
    assert.deepEqual(textDraftPlan(timeline, FRAME, { clipId: "cl_a", text: "Harbour\n" }, null), { kind: "stored", timeline: null });
  });
});
