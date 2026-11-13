import { THREE_TITLES, blur, button, byLabel, check, choose, focus, installDom, key, mountCut, settle, stateWith, title, type, wordsField, type Respond } from "./cut-text-fixture.js";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { TEXT_PART_DEFAULTS, TEXT_PLACES, type TextDraftCommand, type TextLook, type TimelineClipCommand } from "@arke-studio/contracts";
import { act } from "react";

/**
 * A selected title's Inspector (SPEC-065 R-31, R-32; turn 277 rules 7 – 13): its sections and
 * labels in the turn's order, typing that draws and writes nothing until the field commits, one
 * revision per commit, refusals in one clause under the field that made them, and the per cents
 * the screen shows for the record's fractions.
 */

const { seen } = installDom(1024);
afterEach(() => { document.body.replaceChildren(); seen.focused = null; seen.selected = null; });

const titled = (look: Partial<TextLook> = {}, words = "Harbour lights"): TimelineClipCommand[] => [
  { kind: "add-track", trackId: "tr_titles", trackKind: "picture", name: "Titles" },
  { kind: "place", trackId: "tr_titles", clip: title("cl_title", 0, words, look) },
];

async function open(look: Partial<TextLook> = {}, words?: string) {
  const screen = await mountCut(stateWith(titled(look, words)));
  await screen.click(screen.chip("cl_title"));
  await settle(10);
  return screen;
}
const field = (root: ParentNode, name: string) => byLabel(root, name) as HTMLInputElement;
const alerts = (root: ParentNode) => [...root.querySelectorAll('[role="alert"]')].map(alert => alert.textContent);
const looks = (screen: Awaited<ReturnType<typeof open>>) => screen.timelineCommands().flatMap(batch => batch.commands);

it("the Inspector's sections and labels are turn 277's, in its order", async () => {
  const screen = await open();
  try {
    const inspector = screen.inspector();
    assert.equal(inspector.querySelector(".fy-cutinspect__eyebrow")?.textContent, "TEXT");
    assert.equal(inspector.querySelector("h2")?.textContent, "Harbour lights");
    const headings = [...inspector.querySelectorAll("h3")].map(heading => heading.textContent);
    assert.deepEqual(headings.slice(0, 8), ["Words", "Type", "Place", "Fill", "Edge", "Shadow", "Rule", "Backing"]);
    assert.deepEqual(headings.slice(8, 10), ["Motion", "Appearance"], "then what a still picture shows");
    // The timing rows sit between the look and Motion, with no heading of their own (rule 7).
    const html = inspector.innerHTML;
    assert.ok(html.indexOf('aria-label="Backing"') < html.indexOf("Position") && html.indexOf("Position") < html.indexOf('aria-label="Picture motion"'));
    const type = byLabel(inspector, "Type");
    assert.ok(byLabel(type, "Typeface").getAttribute("aria-haspopup") === "listbox");
    assert.deepEqual([...byLabel(type, "Weight").querySelectorAll("[role=radio]")].map(radio => radio.textContent), ["Regular", "Bold"]);
    assert.deepEqual([...type.querySelectorAll(".tx-check")].map(label => label.textContent), ["Italic", "Capitals"]);
    for (const name of ["Size", "Size slider", "Tracking", "Line distance"]) byLabel(type, name);
    const place = byLabel(inspector, "Place");
    assert.deepEqual([...byLabel(place, "Align").querySelectorAll("[role=radio]")].map(radio => radio.textContent), ["Left", "Centre", "Right"]);
    for (const name of ["X", "Y", "Max width"]) byLabel(place, name);
    const fill = byLabel(inspector, "Fill");
    assert.deepEqual([...fill.querySelectorAll("option")].map(option => option.textContent), ["One colour", "Two colours", "Three colours", "Four colours"]);
    byLabel(fill, "Colour 1");
    // Shadow is on in the first look; Edge and Rule are switched off, and each is its heading alone.
    assert.equal(byLabel(byLabel(inspector, "Edge"), "Edge").getAttribute("aria-checked"), "false");
    for (const name of ["Shadow colour", "Shadow opacity", "Shadow softness", "Shadow offset X", "Shadow offset Y"]) byLabel(inspector, name);
    assert.deepEqual([...byLabel(inspector, "Backing").querySelectorAll("option")].map(option => option.textContent), ["None", "Shade", "Box"]);
    // Every number is a per cent; the screen never shows an em.
    assert.equal(field(type, "Size").value, "8");
    assert.equal(field(type, "Line distance").value, "120");
    assert.equal(field(place, "Max width").value, "90");
  } finally { await screen.close(); }
});

it("a text clip shows no Track and no Source in; Opacity reads Opacity and carries no hint", async () => {
  const screen = await open();
  try {
    const inspector = screen.inspector();
    const labels = [...inspector.querySelectorAll("label, .fy-cutinspect__row > span")].map(label => label.childNodes[0]?.textContent);
    assert.ok(!labels.includes("Track"));
    assert.ok(!labels.includes("Source in"));
    assert.ok(labels.includes("Opacity"));
    assert.ok(!labels.includes("Picture opacity"));
    const appearance = byLabel(inspector, "Picture appearance");
    assert.equal(appearance.querySelector(".fx-inspector__hint"), null, "Appearance carries no hint: a title has no sound");
    assert.ok(appearance.querySelector('[aria-label="Picture protection from AI suggestions"]'), "its protection stays inside it");
  } finally { await screen.close(); }
});

it("typing in Words sends no timeline command until the field commits", async () => {
  const screen = await open();
  try {
    const words = wordsField(screen.inspector());
    await focus(words);
    await type(words, "Harbour");
    await type(words, "Harbour lights at dusk");
    await settle(160);
    assert.equal(screen.timelineCommands().length, 0, "typing writes nothing");
    const paints = screen.drafts().filter(message => message.ask.kind === "paint");
    assert.equal(paints.length, 1, "one draft, once typing paused");
    assert.ok(paints[0]!.ask.kind === "paint" && paints[0]!.ask.item.text === "Harbour lights at dusk");
    assert.equal(screen.inspector().querySelector("h2")?.textContent, "Harbour lights", "the heading keeps the stored words");
    assert.equal(screen.chip("cl_title").textContent?.trim(), "Harbour lights", "and so does the clip");
  } finally { await screen.close(); }
});

it("a committed retype is one text-set naming one clip", async () => {
  const screen = await open();
  try {
    const words = wordsField(screen.inspector());
    await focus(words);
    await type(words, "Harbour\nlights");
    await settle(160);
    await blur(words);
    const batches = screen.timelineCommands();
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0]!.commands, [{ kind: "text-set", clipIds: ["cl_title"], text: "Harbour\nlights" }]);
  } finally { await screen.close(); }
});

it("Escape in Words gives back the stored words and sends nothing", async () => {
  const screen = await open();
  try {
    const words = wordsField(screen.inspector());
    await focus(words);
    await type(words, "Something else");
    await key(words, "Escape");
    assert.equal(words.value, "Harbour lights");
    await blur(words);
    assert.equal(screen.timelineCommands().length, 0);
    assert.equal(screen.chip("cl_title").getAttribute("aria-pressed"), "true", "Escape in the field does not clear the selection");
  } finally { await screen.close(); }
});

it("a refusal shows under Words as one clause, and nothing is sent", async () => {
  const screen = await open({ typeface: "jost" }, "Evening");
  try {
    const refuse: Respond = ask => ask.kind === "paint" && ask.item.text.includes("ẹ")
      ? { kind: "drawn", results: [{ ok: false, reason: "Jost has no ẹ", field: "words" }] }
      : { kind: "drawn", results: (ask.kind === "paint" ? [ask.item] : ask.items).map(item => ({ ok: true as const, drawnSize: item.look.size })) };
    screen.respond(refuse);
    const words = wordsField(screen.inspector());
    await focus(words);
    await type(words, "Alẹ́");
    await settle(160);
    assert.deepEqual(alerts(byLabel(screen.inspector(), "Words")), ["Jost has no ẹ"], "the painter's own words, one clause");
    assert.equal(words.getAttribute("aria-invalid"), "true");
    await blur(words);
    assert.equal(screen.timelineCommands().length, 0, "nothing is saved");
    assert.equal(screen.inspector().querySelector("h2")?.textContent, "Evening", "the heading keeps the old words");
  } finally { await screen.close(); }
});

it("a face chosen that cannot draw the words refuses under Typeface, and nothing is sent", async () => {
  const screen = await open({ typeface: "eb-garamond" }, "Alẹ́");
  try {
    screen.respond(ask => ask.kind === "measure" && ask.items.some(item => item.look.typeface === "jost")
      ? { kind: "drawn", results: ask.items.map(() => ({ ok: false as const, reason: "Jost has no ẹ", field: "words" as const })) }
      : { kind: "drawn", results: (ask.kind === "paint" ? [ask.item] : ask.items).map(item => ({ ok: true as const, drawnSize: item.look.size })) });
    const inspector = screen.inspector();
    await screen.click(byLabel(inspector, "Typeface"));
    const menu = inspector.querySelector('[role="listbox"][aria-label="Typeface"]');
    assert.ok(menu, "the menu opens");
    assert.deepEqual([...menu.querySelectorAll("[role=option]")].map(option => option.textContent), ["Geist", "Jost", "Comic Neue", "Bangers", "EB Garamond", "Cinzel"]);
    assert.equal(menu.querySelector('[aria-selected="true"]')?.textContent, "EB Garamond", "the current one checked");
    await screen.click(button(menu, "Jost"));
    await settle(20);
    assert.equal(screen.timelineCommands().length, 0, "nothing is sent");
    assert.deepEqual(alerts(byLabel(screen.inspector(), "Type")), ["Jost has no ẹ"]);
    assert.equal(byLabel(screen.inspector(), "Typeface").getAttribute("aria-invalid"), "true");
  } finally { await screen.close(); }
});

it("Place lists TEXT_PLACES; choosing Lower third sends x 0.5, y 0.75, centre in one text-set", async () => {
  const screen = await open();
  try {
    const place = byLabel(screen.inspector(), "Place").querySelector<HTMLSelectElement>("select")!;
    assert.deepEqual([...place.querySelectorAll("option")].map(option => option.textContent), TEXT_PLACES.map(entry => entry.name));
    assert.equal(place.value, "Middle");
    await choose(place, "Lower third");
    assert.deepEqual(looks(screen), [{ kind: "text-set", clipIds: ["cl_title"], look: { x: 0.5, y: 0.75, align: "center" } }]);
  } finally { await screen.close(); }
});

it("a hand-moved Y makes Place read Custom, listed only then", async () => {
  const screen = await open({ y: 0.7 });
  try {
    const place = byLabel(screen.inspector(), "Place").querySelector<HTMLSelectElement>("select")!;
    assert.equal(place.value, "Custom");
    assert.deepEqual([...place.querySelectorAll("option")].map(option => option.textContent), [...TEXT_PLACES.map(entry => entry.name), "Custom"]);
    assert.equal(field(screen.inspector(), "Y").value, "70");
  } finally { await screen.close(); }
});

it("Bangers disables Bold and Italic; choosing Bangers on a bold clip sets Regular in the same text-set", async () => {
  const banged = await open({ typeface: "bangers" });
  try {
    const type = byLabel(banged.inspector(), "Type");
    assert.equal(button(type, "Bold").disabled, true, "a weight the face lacks cannot be chosen");
    assert.equal(type.querySelector<HTMLInputElement>(".tx-check input")!.disabled, true, "nor a slant");
  } finally { await banged.close(); }
  const screen = await open({ typeface: "jost", weight: "bold", italic: true });
  try {
    const type = byLabel(screen.inspector(), "Type");
    assert.equal(button(type, "Bold").disabled, false);
    await screen.click(byLabel(type, "Typeface"));
    await screen.click(button(screen.inspector().querySelector('[role="listbox"]')!, "Bangers"));
    await settle(20);
    assert.deepEqual(looks(screen), [{ kind: "text-set", clipIds: ["cl_title"], look: { typeface: "bangers", weight: "regular", italic: false } }]);
  } finally { await screen.close(); }
});

it("the drawn-size chip shows only when Fit draws smaller", async () => {
  const fitted = await mountCut(stateWith(titled({ size: 0.09, room: 0.5 })));
  try {
    fitted.respond(ask => ({ kind: "drawn", results: (ask.kind === "paint" ? [ask.item] : ask.items).map(() => ({ ok: true as const, drawnSize: 0.084 })) }));
    await fitted.click(fitted.chip("cl_title"));
    await settle(20);
    assert.equal(byLabel(fitted.inspector(), "Type").querySelector(".tx-drawn")?.textContent, "drawn 8.4 %");
    assert.equal(field(fitted.inspector(), "Size").value, "9", "the stored size never changes");
  } finally { await fitted.close(); }
  const screen = await open();
  try {
    await settle(20);
    assert.equal(byLabel(screen.inspector(), "Type").querySelector(".tx-drawn"), null, "absent when Fit does nothing");
  } finally { await screen.close(); }
});

it("a percent typed is stored as a fraction, and the value already held sends nothing", async () => {
  const screen = await open();
  try {
    const size = field(screen.inspector(), "Size");
    await focus(size);
    await type(size, "8");
    await key(size, "Enter");
    assert.equal(screen.timelineCommands().length, 0, "8 % is held already");
    await type(size, "7.1");
    await key(size, "Enter");
    assert.deepEqual(looks(screen), [{ kind: "text-set", clipIds: ["cl_title"], look: { size: 0.071 } }]);
  } finally { await screen.close(); }
});

it("a value out of range refuses under its field and is not clamped", async () => {
  const screen = await open();
  try {
    const size = field(screen.inspector(), "Size");
    await focus(size);
    await type(size, "50");
    await key(size, "Enter");
    assert.equal(screen.timelineCommands().length, 0, "nothing is sent");
    assert.equal(size.value, "50", "the typed value stays; it is not clamped to 40");
    assert.ok(alerts(byLabel(screen.inspector(), "Type")).includes("1 to 40 %"));
    const tracking = field(screen.inspector(), "Tracking");
    await focus(tracking);
    await type(tracking, "-9");
    await blur(tracking);
    assert.ok(alerts(byLabel(screen.inspector(), "Type")).includes("−5 to 50 %"));
    assert.equal(screen.timelineCommands().length, 0);
  } finally { await screen.close(); }
});

it("switching Edge on sends the default edge; off sends null", async () => {
  const screen = await open();
  try {
    await screen.click(byLabel(byLabel(screen.inspector(), "Edge"), "Edge"));
    assert.deepEqual(looks(screen), [{ kind: "text-set", clipIds: ["cl_title"], look: { edge: { ...TEXT_PART_DEFAULTS.edge } } }]);
  } finally { await screen.close(); }
  const edged = await open({ edge: { color: "#1c1408", width: 0.022 } });
  try {
    const edge = byLabel(edged.inspector(), "Edge");
    assert.equal(byLabel(edge, "Edge").getAttribute("aria-checked"), "true");
    assert.equal(field(edge, "Edge width").value, "2.2");
    await edged.click(byLabel(edge, "Edge"));
    assert.deepEqual(looks(edged), [{ kind: "text-set", clipIds: ["cl_title"], look: { edge: null } }]);
  } finally { await edged.close(); }
});

it("Capitals is checked by the painter before it commits", async () => {
  const screen = await open({ typeface: "jost" }, "Alẹ́");
  try {
    screen.respond(ask => ask.kind === "measure" && ask.items.some(item => item.look.capitals)
      ? { kind: "drawn", results: ask.items.map(() => ({ ok: false as const, reason: "Jost has no Ẹ", field: "words" as const })) }
      : { kind: "drawn", results: (ask.kind === "paint" ? [ask.item] : ask.items).map(item => ({ ok: true as const, drawnSize: item.look.size })) });
    const capitals = [...byLabel(screen.inspector(), "Type").querySelectorAll<HTMLInputElement>(".tx-check input")][1]!;
    await check(capitals, true);
    await settle(20);
    assert.equal(screen.timelineCommands().length, 0);
    assert.ok(alerts(byLabel(screen.inspector(), "Type")).includes("Jost has no Ẹ"));
  } finally { await screen.close(); }
});

it("the Viewer's Play button gives way while a text clip is selected", async () => {
  const screen = await mountCut(stateWith(titled()));
  try {
    assert.ok(screen.container.querySelector(".fy-playbtn"), "Play is drawn with nothing selected");
    await screen.click(screen.chip("cl_title"));
    assert.equal(screen.container.querySelector(".fy-playbtn"), null, "a centred title is not drawn under it");
    await screen.click(screen.chip("cl_harbour"));
    assert.ok(screen.container.querySelector(".fy-playbtn"), "a picture clip keeps it");
  } finally { await screen.close(); }
});

// What a stale revision is refused with: another window changed the timeline first.
const STALE = "The timeline moved from revision 2 to 3 while this edit was being made.";

it("a refused commit of any look control shows its clause under that control", async () => {
  const cases: { name: string; section: string; look?: Partial<TextLook>; press: (screen: Awaited<ReturnType<typeof open>>, inspector: HTMLElement) => Promise<void>; control: (inspector: HTMLElement) => Element }[] = [
    { name: "Bold", section: "Type", press: (screen, inspector) => screen.click(button(byLabel(inspector, "Weight"), "Bold")), control: inspector => byLabel(inspector, "Weight") },
    { name: "Align", section: "Place", press: (screen, inspector) => screen.click(button(byLabel(inspector, "Align"), "Left")), control: inspector => byLabel(inspector, "Align") },
    { name: "Place", section: "Place", press: (_, inspector) => choose(byLabel(inspector, "Place").querySelector("select")!, "Lower third"), control: inspector => byLabel(inspector, "Place").querySelector("select")! },
    { name: "Fill", section: "Fill", press: (_, inspector) => choose(byLabel(inspector, "Fill").querySelector("select")!, "2"), control: inspector => byLabel(inspector, "Fill").querySelector("select")! },
    { name: "a colour", section: "Fill", press: async (_, inspector) => {
      const swatch = field(inspector, "Colour 1");
      await act(async () => { swatch.value = "#336699"; swatch.dispatchEvent(new Event("change")); });
      await settle();
    }, control: inspector => byLabel(inspector, "Colour 1") },
    { name: "a part's switch", section: "Edge", press: (screen, inspector) => screen.click(byLabel(byLabel(inspector, "Edge"), "Edge")), control: inspector => byLabel(byLabel(inspector, "Edge"), "Edge") },
    { name: "Faded ends", section: "Rule", look: { rule: { ...TEXT_PART_DEFAULTS.rule } },
      press: (_, inspector) => check(byLabel(inspector, "Rule").querySelector<HTMLInputElement>(".tx-check input")!, false),
      control: inspector => byLabel(inspector, "Rule").querySelector(".tx-check input")! },
    { name: "Backing", section: "Backing", press: (_, inspector) => choose(byLabel(inspector, "Backing").querySelector("select")!, "box"), control: inspector => byLabel(inspector, "Backing").querySelector("select")! },
    // The control for the rest: a number has always shown its refusal.
    { name: "Size", section: "Type", press: async (_, inspector) => { const size = field(inspector, "Size"); await focus(size); await type(size, "12"); await key(size, "Enter"); }, control: inspector => field(inspector, "Size") },
  ];
  for (const { name, section, look, press, control } of cases) {
    const screen = await open(look);
    try {
      await press(screen, screen.inspector());
      assert.equal(screen.timelineCommands().length, 1, `${name} sent its change`);
      await screen.refuse(STALE);
      assert.deepEqual(alerts(byLabel(screen.inspector(), section)), [STALE], `${name}'s refusal is said under it, in ${section}`);
      assert.equal(control(screen.inspector()).getAttribute("aria-invalid"), "true", `${name} is marked`);
      assert.equal(screen.container.querySelector(".fy-timeline__refusal"), null, `${name}'s refusal is not the editor's line as well`);
    } finally { await screen.close(); }
  }
});

it("a refusal that lands after the selection moved is said on the editor's line, not under another title's field", async () => {
  const screen = await mountCut(stateWith(THREE_TITLES));
  try {
    // Words left by pressing the next title before their draft came back: they are sent once the
    // painter has checked them, by which time the next title's Words is in the Inspector.
    await screen.press(screen.chip("cl_one"));
    const words = wordsField(screen.inspector());
    await focus(words);
    await type(words, "Harbour lights at dusk");
    await screen.press(screen.chip("cl_two"), {}, "pointerdown");
    await settle(20);
    assert.equal(screen.timelineCommands().length, 1);
    assert.equal(screen.inspector().querySelector("h2")?.textContent, "The coast");
    await screen.refuse(STALE);
    assert.deepEqual(alerts(screen.inspector()), [], "not under the words of a title they were not typed for");
    assert.equal(screen.container.querySelector(".fy-timeline__refusal")?.textContent, `Edit refused · ${STALE}`, "but on the editor's line");
  } finally { await screen.close(); }
});

it("words typed and left by pressing another title are committed for the title they were typed in", async () => {
  for (const answered of [true, false]) {
    const screen = await mountCut(stateWith(THREE_TITLES));
    try {
      await screen.press(screen.chip("cl_one"));
      const words = wordsField(screen.inspector());
      await focus(words);
      await type(words, "Harbour lights at dusk");
      // Answered: the draft's own verdict commits them. Not yet: the painter is asked once more, briefly.
      if (answered) await settle(160);
      // The lanes select on pointerdown, before the browser moves focus: the field goes with no blur.
      await screen.press(screen.chip("cl_two"), {}, "pointerdown");
      assert.equal(screen.inspector().querySelector("h2")?.textContent, "The coast", "the next title is in the Inspector");
      assert.equal(words.isConnected, false, "the field typed in has gone");
      await settle(20);
      assert.deepEqual(screen.timelineCommands().map(batch => batch.commands), [[{ kind: "text-set", clipIds: ["cl_one"], text: "Harbour lights at dusk" }]],
        answered ? "committed on the draft's answer" : "committed once the painter has checked them");
    } finally { await screen.close(); }
  }
});

it("a number typed and left by pressing another title is committed for the title it was typed in", async () => {
  const screen = await mountCut(stateWith(THREE_TITLES));
  try {
    await screen.press(screen.chip("cl_one"));
    const size = field(screen.inspector(), "Size");
    await focus(size);
    await type(size, "12");
    await screen.press(screen.chip("cl_three"), {}, "pointerdown");
    assert.equal(size.isConnected, false);
    assert.deepEqual(screen.timelineCommands().map(batch => batch.commands), [[{ kind: "text-set", clipIds: ["cl_one"], look: { size: 0.12 } }]]);
  } finally { await screen.close(); }
});

it("words left before their draft is answered are checked by the painter, and refused words send nothing", async () => {
  const screen = await open({ typeface: "jost" }, "Evening");
  try {
    // The paint never comes back in time; the measure a commit asks for refuses the ẹ.
    screen.respond(ask => ask.kind === "paint" ? null
      : ask.items.some(item => item.text.includes("ẹ"))
        ? { kind: "drawn", results: ask.items.map(() => ({ ok: false as const, reason: "Jost has no ẹ", field: "words" as const })) }
        : { kind: "drawn", results: ask.items.map(item => ({ ok: true as const, drawnSize: item.look.size })) });
    const words = wordsField(screen.inspector());
    await focus(words);
    await type(words, "Alẹ́");
    // Tab at once, inside the pause before a draft is asked for: the common case.
    await blur(words);
    await settle(20);
    const checked = screen.drafts().filter((message: TextDraftCommand) => message.ask.kind === "measure" && message.ask.items.some(item => item.text === "Alẹ́"));
    assert.equal(checked.length, 1, "the painter was asked about the words before they were sent");
    assert.equal(screen.timelineCommands().length, 0, "nothing is saved");
    assert.deepEqual(alerts(byLabel(screen.inspector(), "Words")), ["Jost has no ẹ"]);
  } finally { await screen.close(); }
});

it("a revision from elsewhere drops the draft with the words it sets back", async () => {
  const screen = await open({ size: 0.09 });
  try {
    const words = wordsField(screen.inspector());
    await focus(words);
    await type(words, "Hello there");
    await settle(160);
    const asked = () => screen.drafts().filter(message => message.ask.kind === "paint" && message.ask.item.text === "Hello there").length;
    assert.equal(asked(), 1);
    // Another window resizes the title: the field goes back to the record's words.
    await screen.apply([{ kind: "text-set", clipIds: ["cl_title"], look: { size: 0.1 } }]);
    assert.equal(words.value, "Harbour lights");
    await settle(160);
    assert.equal(asked(), 1, "words in no field are not painted again on the new record");
    await blur(words);
    assert.equal(screen.timelineCommands().length, 0, "and nothing is saved");
  } finally { await screen.close(); }
});
