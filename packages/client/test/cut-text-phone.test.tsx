import { THREE_TITLES, byLabel, installDom, mountCut, settle, stateWith, wordsField } from "./cut-text-fixture.js";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";

/**
 * Text on a phone (turn 277 rule 15, 277h – 277k): Text is a tool in the foot, a selected title's
 * line names it and its sheet's button reads Edit, the sheet starts under the Viewer so the words
 * stay in sight, and the typeface list takes the sheet with a way back.
 */

const { seen } = installDom(390);
afterEach(() => { document.body.replaceChildren(); seen.focused = null; seen.selected = null; });

const foot = (root: ParentNode) => [...root.querySelectorAll(".fy-cut-tools > button")].map(button => button.querySelector("span")?.textContent ?? button.getAttribute("aria-label"));
const sheet = () => document.querySelector<HTMLDialogElement>("dialog.fy-cut-trim-sheet");

it("the phone's foot reads Library, Text, Split, Undo, Redo, Arke", async () => {
  const screen = await mountCut(stateWith(THREE_TITLES));
  try {
    assert.ok(screen.container.querySelector("[data-phone]"), "the phone's layout");
    assert.deepEqual(foot(screen.container), ["Library", "Text", "Split", "Undo", "Redo", "Arke"]);
    const text = [...screen.container.querySelectorAll<HTMLButtonElement>(".fy-cut-tools > button")].find(button => button.textContent === "Text")!;
    assert.ok(text.querySelector("svg"), "the T over its word");
    await screen.click(text);
    const [batch] = screen.timelineCommands();
    assert.equal(batch?.label, "Add text", "one action, not the Add lane sheet");
    const place = batch.commands.find(command => command.kind === "place");
    assert.ok(place?.kind === "place");
    await screen.apply(batch.commands);
    assert.equal(sheet()?.hasAttribute("open"), true, "the sheet opens on the new title");
    assert.equal(seen.selected, wordsField(sheet()!), "with its words selected, ready to type");
  } finally { await screen.close(); }
});

it("a selected title's line shows its first line and length, and the sheet's button reads Edit", async () => {
  const screen = await mountCut(stateWith(THREE_TITLES));
  try {
    await screen.click(screen.chip("cl_two"));
    const line = screen.container.querySelector(".fy-cut-tools__selection");
    assert.ok(line);
    assert.ok(line.querySelector("svg"), "the T, in Film's place");
    assert.equal(line.textContent, "The coast · 4.0s");
    assert.ok(foot(screen.container).includes("Edit"));
    assert.ok(!foot(screen.container).includes("Trim"));
    await screen.click(screen.chip("cl_harbour"));
    assert.ok(foot(screen.container).includes("Trim"), "a picture's sheet still reads Trim");
  } finally { await screen.close(); }
});

it("the sheet starts at the Viewer's lower edge", async () => {
  const screen = await mountCut(stateWith(THREE_TITLES));
  try {
    const wrap = screen.container.querySelector<HTMLElement>(".fy-cutpreview-wrap")!;
    Object.assign(wrap, { getBoundingClientRect: () => ({ x: 0, y: 52, left: 0, top: 52, right: 390, bottom: 271, width: 390, height: 219 }) });
    await screen.click(screen.chip("cl_one"));
    const edit = [...screen.container.querySelectorAll<HTMLButtonElement>(".fy-cut-tools > button")].find(button => button.textContent === "Edit")!;
    await screen.click(edit);
    const dialog = sheet();
    assert.ok(dialog);
    assert.ok(dialog.hasAttribute("open"));
    assert.ok(dialog.classList.contains("fy-cut-trim-sheet--text"));
    assert.equal(dialog.style.top, "271px", "the words stay in sight above it");
    // Never below half the screen: a tall film's Viewer leaves the sheet room.
    Object.assign(wrap, { getBoundingClientRect: () => ({ x: 0, y: 52, left: 0, top: 52, right: 390, bottom: 700, width: 390, height: 648 }) });
    await settle(1);
    window.dispatchEvent(new Event("resize"));
    await settle(1);
    assert.equal(dialog.style.top, "422px");
  } finally { await screen.close(); }
});

it("Typeface opens the list inside the sheet, and Back returns", async () => {
  const screen = await mountCut(stateWith(THREE_TITLES));
  try {
    await screen.click(screen.chip("cl_one"));
    const edit = [...screen.container.querySelectorAll<HTMLButtonElement>(".fy-cut-tools > button")].find(button => button.textContent === "Edit")!;
    await screen.click(edit);
    const dialog = sheet()!;
    assert.equal(dialog.querySelector("h2")?.textContent, "Harbour lights");
    await screen.click(byLabel(dialog, "Typeface"));
    assert.equal(dialog.querySelector("h2")?.textContent, "Typeface", "the list takes the sheet, not a menu over it");
    const list = dialog.querySelector('[role="listbox"][aria-label="Typeface"]');
    assert.ok(list);
    assert.ok(list.classList.contains("tx-list"));
    assert.equal(list.querySelectorAll("[role=option]").length, 6);
    assert.equal(list.querySelector('[aria-selected="true"]')?.textContent, "Geist");
    assert.equal(dialog.querySelector('textarea[aria-label="Words"]'), null);
    await screen.click(byLabel(dialog, "Back"));
    assert.equal(dialog.querySelector("h2")?.textContent, "Harbour lights");
    assert.ok(wordsField(dialog), "back to the Inspector");
    await screen.click(byLabel(dialog, "Typeface"));
    await screen.click([...dialog.querySelectorAll<HTMLButtonElement>("[role=option]")].find(option => option.textContent === "Jost")!);
    await settle(20);
    assert.deepEqual(screen.timelineCommands().at(-1)?.commands, [{ kind: "text-set", clipIds: ["cl_one"], look: { typeface: "jost" } }]);
    assert.equal(dialog.querySelector("h2")?.textContent, "Harbour lights", "choosing a face returns to the Inspector");
  } finally { await screen.close(); }
});

it("a phone never selects two titles", async () => {
  const screen = await mountCut(stateWith(THREE_TITLES));
  try {
    await screen.click(screen.chip("cl_one"));
    await screen.click(screen.chip("cl_two"), { shiftKey: true });
    await screen.click(screen.chip("cl_three"), { ctrlKey: true });
    assert.deepEqual(["cl_one", "cl_two", "cl_three"].filter(id => screen.chip(id).getAttribute("aria-pressed") === "true"), ["cl_three"]);
  } finally { await screen.close(); }
});
