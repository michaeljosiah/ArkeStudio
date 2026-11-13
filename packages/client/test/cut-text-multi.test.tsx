import { PICTURE_TRACK_ID, THREE_TITLES, byLabel, focus, installDom, key, mountCut, settle, stateWith, title, type } from "./cut-text-fixture.js";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import type { TimelineClipCommand } from "@arke-studio/contracts";

/**
 * Several titles selected at once (SPEC-065 R-31; turn 277 rule 14, 277g): new to the Cut, which
 * selected one clip at a time. Shift, Ctrl or Cmd adds a title; the Inspector shows the look
 * without Words, headed by the count, Mixed where the titles differ, and a change reaches them all
 * in one revision.
 */

installDom(1024);
afterEach(() => { document.body.replaceChildren(); });

// Pressed as a mouse presses: the lanes select on pointerdown, so a bare click would skip the step
// that collapses the selection when a modifier is not respected there.
async function threeSelected() {
  const screen = await mountCut(stateWith(THREE_TITLES));
  await screen.press(screen.chip("cl_one"));
  await screen.press(screen.chip("cl_two"), { shiftKey: true });
  await screen.press(screen.chip("cl_three"), { ctrlKey: true });
  await settle(10);
  return screen;
}
const pressed = (screen: Awaited<ReturnType<typeof threeSelected>>, ids = ["cl_one", "cl_two", "cl_three", "cl_harbour"]) =>
  ids.filter(id => screen.chip(id).getAttribute("aria-pressed") === "true");

it("Shift-click adds a second title to the selection; a plain click selects one", async () => {
  const screen = await mountCut(stateWith(THREE_TITLES));
  try {
    await screen.press(screen.chip("cl_one"));
    await screen.press(screen.chip("cl_two"), { shiftKey: true });
    assert.deepEqual(pressed(screen), ["cl_one", "cl_two"]);
    // Shift on a title already selected takes it out again.
    await screen.press(screen.chip("cl_two"), { metaKey: true });
    assert.deepEqual(pressed(screen), ["cl_one"]);
    await screen.press(screen.chip("cl_two"), { shiftKey: true });
    await screen.press(screen.chip("cl_three"));
    assert.deepEqual(pressed(screen), ["cl_three"], "a plain click selects that title alone");
  } finally { await screen.close(); }
});

it("Shift-click adds titles on the base Picture track too", async () => {
  // The base track is drawn by its own lane, with its own press: both must leave a modifier to the click.
  const BASE: TimelineClipCommand[] = [
    { kind: "place", trackId: PICTURE_TRACK_ID, clip: title("cl_base_one", 120, "Dawn") },
    { kind: "place", trackId: PICTURE_TRACK_ID, clip: title("cl_base_two", 216, "Dusk") },
  ];
  const screen = await mountCut(stateWith(BASE));
  try {
    assert.ok(screen.chip("cl_base_one").classList.contains("fy-pictclip"), "drawn by the base lane");
    await screen.press(screen.chip("cl_base_one"));
    await screen.press(screen.chip("cl_base_two"), { ctrlKey: true });
    assert.deepEqual(pressed(screen, ["cl_base_one", "cl_base_two"]), ["cl_base_one", "cl_base_two"]);
    assert.equal(screen.inspector().querySelector("h2")?.textContent, "2 clips");
  } finally { await screen.close(); }
});

it("three titles selected show the look without Words, headed \"3 clips\"", async () => {
  const screen = await threeSelected();
  try {
    assert.deepEqual(pressed(screen), ["cl_one", "cl_two", "cl_three"]);
    const inspector = screen.inspector();
    assert.equal(inspector.querySelector(".fy-cutinspect__eyebrow")?.textContent, "TEXT");
    assert.equal(inspector.querySelector("h2")?.textContent, "3 clips");
    assert.equal(inspector.querySelector('textarea[aria-label="Words"]'), null, "words are set on one title at a time (R-25)");
    const headings = [...inspector.querySelectorAll("h3")].map(heading => heading.textContent);
    assert.deepEqual(headings, ["Type", "Place", "Fill", "Edge", "Shadow", "Rule", "Backing"], "no timing, Motion or Appearance: each is one clip's");
  } finally { await screen.close(); }
});

it("a value that differs reads Mixed", async () => {
  const screen = await threeSelected();
  try {
    const inspector = screen.inspector();
    // 277g: the sizes are 9, 7 and 9; Evening was moved by hand to Y 70, so Place and Y are Mixed.
    const size = byLabel(inspector, "Size") as HTMLInputElement;
    assert.equal(size.value, "");
    assert.equal(size.getAttribute("placeholder"), "Mixed");
    const slider = byLabel(inspector, "Size slider");
    assert.ok(slider.classList.contains("tx-mixed"), "the slider has no thumb");
    assert.equal(slider.getAttribute("aria-valuetext"), "Mixed");
    assert.equal(byLabel(inspector, "Place").querySelector("select")!.value, "Mixed");
    assert.equal((byLabel(inspector, "Y") as HTMLInputElement).getAttribute("placeholder"), "Mixed");
    assert.equal((byLabel(inspector, "X") as HTMLInputElement).value, "50", "what they share reads as itself");
    assert.equal(byLabel(inspector, "Typeface").textContent, "Geist");
  } finally { await screen.close(); }
});

it("a change to the look sends one text-set naming every selected title", async () => {
  const screen = await threeSelected();
  try {
    const size = byLabel(screen.inspector(), "Size") as HTMLInputElement;
    await focus(size);
    await type(size, "9");
    await key(size, "Enter");
    const batches = screen.timelineCommands();
    assert.equal(batches.length, 1, "one batch: one revision");
    // Two already hold 9 %: the command names all three and the record moves only the one that differs (R-25).
    assert.deepEqual(batches[0]!.commands, [{ kind: "text-set", clipIds: ["cl_one", "cl_two", "cl_three"], look: { size: 0.09 } }]);
    await screen.apply(batches[0]!.commands);
    await settle(10);
    const typeface = byLabel(screen.inspector(), "Typeface");
    await screen.click(typeface);
    await screen.click([...screen.inspector().querySelectorAll<HTMLButtonElement>("[role=option]")].find(option => option.textContent === "Jost")!);
    await settle(20);
    const last = screen.timelineCommands().at(-1)!;
    assert.deepEqual(last.commands, [{ kind: "text-set", clipIds: ["cl_one", "cl_two", "cl_three"], look: { typeface: "jost" } }]);
  } finally { await screen.close(); }
});

it("Delete with several titles selected deletes them in one batch", async () => {
  const screen = await threeSelected();
  try {
    const remove = byLabel(screen.container, "Delete") as HTMLButtonElement;
    assert.equal(remove.disabled, false);
    for (const action of ["Split", "Duplicate", "Ripple delete"]) assert.equal((byLabel(screen.container, action) as HTMLButtonElement).disabled, true, `${action} acts on one clip`);
    await screen.click(remove);
    const batches = screen.timelineCommands();
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0]!.commands, [
      { kind: "delete", clipId: "cl_one" }, { kind: "delete", clipId: "cl_two" }, { kind: "delete", clipId: "cl_three" },
    ]);
  } finally { await screen.close(); }
});

it("a modifier-click on a picture clip selects that clip alone", async () => {
  const screen = await threeSelected();
  try {
    await screen.click(screen.chip("cl_harbour"), { shiftKey: true });
    assert.deepEqual(pressed(screen), ["cl_harbour"]);
    assert.notEqual(screen.inspector().querySelector("h2")?.textContent, "3 clips");
  } finally { await screen.close(); }
});

it("Delete pressed on one of several selected titles deletes them all in one batch", async () => {
  const screen = await threeSelected();
  try {
    // The last title pressed has the focus: a browser focuses a pressed button, and a keyboard is always on a chip.
    await key(screen.chip("cl_three"), "Delete");
    const batches = screen.timelineCommands();
    assert.equal(batches.length, 1, "one batch: one revision, one Undo");
    assert.deepEqual(batches[0]!.commands, [
      { kind: "delete", clipId: "cl_one" }, { kind: "delete", clipId: "cl_two" }, { kind: "delete", clipId: "cl_three" },
    ]);
  } finally { await screen.close(); }
});

it("the keys that act on one clip do nothing on one of several selected titles", async () => {
  const screen = await threeSelected();
  try {
    for (const name of ["s", "d", "[", "]"]) await key(screen.chip("cl_two"), name);
    assert.deepEqual(screen.timelineCommands(), [], "no split, duplicate or move of one title while three are marked");
    assert.deepEqual(pressed(screen), ["cl_one", "cl_two", "cl_three"], "and the selection stands");
  } finally { await screen.close(); }
});

it("a change inside a part the titles hold differently keeps each title's own colour", async () => {
  // Two titles whose edges differ in colour, the same width: a width typed for both must not make one's colour the other's.
  const EDGED: TimelineClipCommand[] = [
    { kind: "add-track", trackId: "tr_titles", trackKind: "picture", name: "Titles" },
    { kind: "place", trackId: "tr_titles", clip: title("cl_gold", 0, "Gold", { edge: { color: "#c8a040", width: 0.02 } }) },
    { kind: "place", trackId: "tr_titles", clip: title("cl_ink", 120, "Ink", { edge: { color: "#101820", width: 0.02 } }) },
  ];
  const screen = await mountCut(stateWith(EDGED));
  try {
    await screen.press(screen.chip("cl_gold"));
    await screen.press(screen.chip("cl_ink"), { shiftKey: true });
    await settle(10);
    const inspector = screen.inspector();
    assert.equal(inspector.querySelector("h2")?.textContent, "2 clips");
    const width = byLabel(inspector, "Edge width") as HTMLInputElement;
    assert.equal(width.value, "2", "the width they share");
    await focus(width);
    await type(width, "3");
    await key(width, "Enter");
    const batches = screen.timelineCommands();
    assert.equal(batches.length, 1, "one batch: one revision, one Undo");
    assert.deepEqual(batches[0]!.commands, [
      { kind: "text-set", clipIds: ["cl_gold"], look: { edge: { color: "#c8a040", width: 0.03 } } },
      { kind: "text-set", clipIds: ["cl_ink"], look: { edge: { color: "#101820", width: 0.03 } } },
    ]);
    await screen.apply(batches[0]!.commands);
    // A value that does not depend on the title is one command naming both.
    const size = byLabel(screen.inspector(), "Size") as HTMLInputElement;
    await focus(size);
    await type(size, "10");
    await key(size, "Enter");
    assert.deepEqual(screen.timelineCommands().at(-1)!.commands, [{ kind: "text-set", clipIds: ["cl_gold", "cl_ink"], look: { size: 0.1 } }]);
  } finally { await screen.close(); }
});
