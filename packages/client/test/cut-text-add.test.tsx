import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { textAddCommands, TEXT_DEFAULT_LOOK, type TimelineClipCommand } from "@arke-studio/contracts";
import { byLabel, focus, installDom, key, mountCut, stateWith, title, type, wordsField } from "./cut-text-fixture.js";
import { setWidth } from "./cut-text-dom.js";

/**
 * Add text (SPEC-065 R-29, R-30; turn 277 rules 2 and 6): one press places a four-second title at
 * the playhead, in one revision, and it arrives selected with its words selected, ready to type.
 * Where it lands and what look it takes are the record's rules (contracts' editor-text-add test);
 * these hold that the Cut asks them and sends what they answer as one batch.
 */

const { seen } = installDom(1024);
afterEach(() => { document.body.replaceChildren(); seen.focused = null; seen.selected = null; });

const TITLES: TimelineClipCommand[] = [
  { kind: "add-track", trackId: "tr_titles", trackKind: "picture", name: "Titles" },
  { kind: "place", trackId: "tr_titles", clip: title("cl_later", 200, "Later", {}) },
];

it("Add text sits after Add audio track with the tip \"Add text · T\"", async () => {
  const screen = await mountCut(stateWith());
  try {
    const buttons = [...screen.container.querySelectorAll<HTMLButtonElement>(".fy-timeline__toolbar button")].map(found => found.getAttribute("aria-label"));
    const audio = buttons.indexOf("Add audio track");
    assert.ok(audio >= 0, "Add audio track is in the strip");
    assert.equal(buttons[audio + 1], "Add text", "the two add actions sit together");
    const add = byLabel(screen.container, "Add text");
    assert.equal(add.getAttribute("data-tip"), "Add text · T");
    assert.ok(add.querySelector("svg"), "a T, in the strip's one register of glyphs");
  } finally { await screen.close(); }
});

it("on a tablet, where the timeline's header is hidden, Text is a tool in the foot after Library", async () => {
  // 600 – 1099px is compact without being a phone: a tablet upright, an unfolded Fold, a narrow window.
  setWidth(800);
  const screen = await mountCut(stateWith(TITLES));
  try {
    assert.ok(screen.container.querySelector("[data-compact]") && !screen.container.querySelector("[data-phone]"), "the compact layout, not the phone's");
    const tools = () => [...screen.container.querySelectorAll<HTMLButtonElement>(".fy-cut-tools > button")];
    const foot = () => tools().map(found => found.textContent || found.getAttribute("aria-label"));
    assert.deepEqual(foot(), ["Library", "Text", "Split", "Duplicate", "Ripple delete", "Undo", "Redo", "Zoom out", "Zoom in"]);
    // A tablet's foot keeps its tools with a clip selected, as the header it stands in for does.
    await screen.click(screen.chip("cl_later"));
    assert.deepEqual(foot().slice(0, 2), ["Library", "Text"]);
    await screen.click(tools().find(found => found.textContent === "Text")!);
    const batches = screen.timelineCommands();
    assert.equal(batches.length, 1, "one press, one batch");
    assert.equal(batches[0]!.label, "Add text");
  } finally { await screen.close(); setWidth(1024); }
});

it("Add places one text clip at the playhead in one revision", async () => {
  const state = stateWith(TITLES);
  const screen = await mountCut(state);
  try {
    await screen.click(byLabel(screen.container, "Add text"));
    const batches = screen.timelineCommands();
    assert.equal(batches.length, 1, "one batch: one revision, one Undo");
    const [batch] = batches;
    assert.equal(batch!.label, "Add text");
    // The same answer the record's rule gives for this timeline and this playhead.
    const place = batch!.commands.find(command => command.kind === "place");
    assert.ok(place?.kind === "place");
    assert.deepEqual(batch!.commands, textAddCommands(screen.timeline(), { playheadFrame: 0, clipId: place.clip.id }));
    assert.equal(place.clip.startFrame, 0);
    assert.equal(place.clip.source.kind === "text" && place.clip.source.text, "Text");
  } finally { await screen.close(); }
});

it("Add places the title where the playhead stands, not at the start", async () => {
  const screen = await mountCut(stateWith(TITLES));
  try {
    // Two seconds in, by the ruler's own keys, as a person steps it.
    const ruler = byLabel(screen.container, "Seek");
    await key(ruler, "ArrowRight");
    await key(ruler, "ArrowRight");
    assert.equal(ruler.getAttribute("aria-valuenow"), "2");
    await screen.click(byLabel(screen.container, "Add text"));
    const [batch] = screen.timelineCommands();
    const place = batch!.commands.find(command => command.kind === "place");
    assert.ok(place?.kind === "place");
    const playheadFrame = 2 * screen.timeline().frameRate;
    assert.equal(place.clip.startFrame, playheadFrame);
    assert.deepEqual(batch!.commands, textAddCommands(screen.timeline(), { playheadFrame, clipId: place.clip.id }));
  } finally { await screen.close(); }
});

it("Add on a full picture track adds Overlay 1 and the clip in the same batch", async () => {
  // The video covers the base track from frame 0, and nothing else is a Picture track.
  const screen = await mountCut(stateWith());
  try {
    await screen.click(byLabel(screen.container, "Add text"));
    const [batch] = screen.timelineCommands();
    assert.ok(batch);
    assert.deepEqual(batch.commands.map(command => command.kind), ["add-track", "place"]);
    const [track, place] = batch.commands;
    assert.ok(track?.kind === "add-track" && place?.kind === "place");
    assert.equal(track.name, "Overlay 1");
    assert.equal(track.trackKind, "picture");
    assert.equal(place.trackId, track.trackId);
  } finally { await screen.close(); }
});

it("the T key adds text, and a T typed in Words does not", async () => {
  const screen = await mountCut(stateWith(TITLES));
  try {
    await key(document.body, "t");
    assert.equal(screen.timelineCommands().length, 1, "T adds a title");
    assert.equal(screen.timelineCommands()[0]!.label, "Add text");
    // Applied, so the gate one command in flight holds lifts, then the title is selected.
    await screen.apply(screen.timelineCommands()[0]!.commands);
    const words = wordsField(screen.inspector());
    await focus(words);
    await key(words, "T");
    await key(words, "t");
    assert.equal(screen.timelineCommands().length, 1, "a T typed into Words is a letter, not Add");
  } finally { await screen.close(); }
});

it("the placed clip arrives selected with its words selected in Words", async () => {
  const screen = await mountCut(stateWith(TITLES));
  try {
    await screen.click(byLabel(screen.container, "Add text"));
    const [batch] = screen.timelineCommands();
    const place = batch!.commands.find(command => command.kind === "place");
    assert.ok(place?.kind === "place");
    await screen.apply(batch!.commands);
    assert.equal(screen.chip(place.clip.id).getAttribute("aria-pressed"), "true", "the new title is selected");
    const inspector = screen.inspector();
    assert.equal(inspector.querySelector(".fy-cutinspect__eyebrow")?.textContent, "TEXT");
    const words = wordsField(inspector);
    assert.equal(words.value, "Text");
    assert.equal(seen.focused, words, "Words has the focus");
    assert.equal(seen.selected, words, "and its words are selected, so typing replaces them");
  } finally { await screen.close(); }
});

it("the second Add copies the first's look, not its words", async () => {
  const screen = await mountCut(stateWith(TITLES));
  try {
    await screen.click(byLabel(screen.container, "Add text"));
    const first = screen.timelineCommands()[0]!;
    const placed = first.commands.find(command => command.kind === "place");
    assert.ok(placed?.kind === "place");
    await screen.apply(first.commands);
    // The first is retyped and restyled, as one change each, as the Inspector would send them.
    await screen.apply([{ kind: "text-set", clipIds: [placed.clip.id], text: "ADE", look: { typeface: "jost", capitals: true, tracking: 0.2 } }]);
    await screen.click(byLabel(screen.container, "Add text"));
    const second = screen.timelineCommands().at(-1)!;
    const place = second.commands.find(command => command.kind === "place");
    assert.ok(place?.kind === "place" && place.clip.source.kind === "text");
    assert.equal(place.clip.source.text, "Text", "the words are always Text");
    assert.equal(place.clip.source.look.typeface, "jost");
    assert.equal(place.clip.source.look.capitals, true);
    assert.equal(place.clip.source.look.tracking, 0.2);
    assert.notDeepEqual(place.clip.source.look, TEXT_DEFAULT_LOOK);
    assert.deepEqual(place.clip.fade, { inFrames: 12, outFrames: 12 }, "four seconds with half-second fades, whatever the last title's were");
    assert.equal(place.clip.durationFrames, 96);
  } finally { await screen.close(); }
});

it("Words typed after Add draw without a revision", async () => {
  const screen = await mountCut(stateWith(TITLES));
  try {
    await screen.click(byLabel(screen.container, "Add text"));
    await screen.apply(screen.timelineCommands()[0]!.commands);
    await type(wordsField(screen.inspector()), "Harbour");
    assert.equal(screen.timelineCommands().length, 1, "typing writes nothing");
  } finally { await screen.close(); }
});
