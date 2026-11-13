import { THREE_TITLES, byLabel, installDom, mountCut, settle, stateWith } from "./cut-text-fixture.js";
import { setWidth } from "./cut-text-dom.js";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { computed, stylesheets, type Screen } from "./css-cascade.js";

/**
 * Where turn 277's controls meet the Cut shell's own rules (SPEC-065 R-33, R-34). The tests render
 * without a style engine, so these read the cascade itself: a sheet's 44px floor on every button
 * must not stretch a part's switch into a square, a selected title on an overlay lane must wear
 * the outline a selected picture wears, and the phone's foot must hold its tools at 320px.
 */

installDom(1024);
afterEach(() => { document.body.replaceChildren(); setWidth(1024); });

// In the order main.tsx imports them, so a later sheet wins a tie as it does in the bundle.
const SHEETS = stylesheets("fidelity.css", "editor-responsive.css", "editor-text-inspector.css");
const PHONE: Screen = { width: 375, height: 812, pointer: "coarse" };
const DESK: Screen = { width: 1280, height: 800, pointer: "fine" };
const px = (value: string | undefined) => Number.parseFloat(value ?? "0") || 0;

it("an optional part's switch keeps its own shape in the phone's sheet and under a coarse pointer", async () => {
  setWidth(390);
  const screen = await mountCut(stateWith(THREE_TITLES));
  try {
    await screen.click(screen.chip("cl_one"));
    const dialog = document.querySelector<HTMLDialogElement>("dialog.fy-cut-trim-sheet");
    assert.ok(dialog, "the phone's sheet");
    assert.ok(dialog.classList.contains("fy-cut-sheet"));
    const toggle = byLabel(byLabel(dialog, "Edge"), "Edge");
    assert.equal(toggle.getAttribute("role"), "switch");
    for (const where of [PHONE, { ...DESK, pointer: "coarse" } satisfies Screen]) {
      // The sheet's and the Inspector's floor of 44px on every button would make the 26px track a square.
      assert.ok(px(computed(toggle, "min-height", where, SHEETS)) <= px(computed(toggle, "height", where, SHEETS)), `the track is not stretched at ${where.width}px`);
    }
    assert.equal(computed(toggle, "height", PHONE, SHEETS), "26px");
    assert.equal(computed(toggle, "width", PHONE, SHEETS), "44px");
    // The touch target is reached around the track, not by stretching it (rule 17: 44px or more).
    const reach = computed(toggle, "inset", PHONE, SHEETS, "before");
    assert.ok(reach, "a hit area around the track");
    const [vertical] = reach.split(/\s+/);
    assert.ok(26 - 2 * px(vertical) >= 44, `the hit area is 44px tall (${reach})`);
  } finally { await screen.close(); }
});

it("a selected title on an overlay lane wears the foreground outline a selected picture wears", async () => {
  const screen = await mountCut(stateWith(THREE_TITLES));
  try {
    await screen.click(screen.chip("cl_one"));
    await settle(5);
    const chip = screen.chip("cl_one");
    assert.ok(chip.classList.contains("fy-typedclip") && chip.classList.contains("fy-typedclip--selected"), "drawn by the typed lanes, selected");
    assert.equal(computed(chip, "border-color", DESK, SHEETS), "var(--foreground)");
    assert.equal(computed(screen.chip("cl_two"), "border-color", DESK, SHEETS)?.startsWith("color-mix("), true, "an unselected title keeps its faint edge");
  } finally { await screen.close(); }
});

it("the phone's six tools fit a 320px screen, each 44px or more", async () => {
  setWidth(320);
  const screen = await mountCut(stateWith(THREE_TITLES));
  try {
    const foot = screen.container.querySelector<HTMLElement>(".fy-cut-tools")!;
    const tools = [...foot.querySelectorAll<HTMLButtonElement>(":scope > button")];
    assert.deepEqual(tools.map(tool => tool.textContent), ["Library", "Text", "Split", "Undo", "Redo", "Arke"]);
    const narrow: Screen = { width: 320, height: 640, pointer: "coarse" };
    const floors = tools.map(tool => px(computed(tool, "min-width", narrow, SHEETS)));
    for (const floor of floors) assert.ok(floor >= 44, `a tool is a 44px target (${floor}px)`);
    const room = 320 - px(computed(foot, "padding-left", narrow, SHEETS)) - px(computed(foot, "padding-right", narrow, SHEETS));
    assert.ok(floors.reduce((sum, floor) => sum + floor, 0) <= room, `${floors.join(" + ")} fits in ${room}px`);
    assert.notEqual(computed(tools[0]!, "flex-shrink", narrow, SHEETS), "0", "and the tools give way to it");
  } finally { await screen.close(); }
});
