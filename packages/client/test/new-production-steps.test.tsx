import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { App } from "../src/App.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DOOR_CHOICES, FRAME_RATE_CHOICES, INTERACTIVE_KIND_CHOICES, KINDS_BY_DOOR, KIND_PLATES,
} from "../src/screens/world-productions.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * Creation is two steps: a door of four pictures, then the screen that asks whatever the card
 * left unanswered and takes the name (design turns 83, 99, 113, and 238a's fourth, Listen).
 *
 * Step two cannot be reached by `renderToString` — it needs a card pressed — so what is asserted
 * of it here is the shape of the constants it renders from, plus the plates on disk. The copy is
 * the binding, so the copy is what is checked.
 */

function render(path: string): string {
  __setStateForTest(FIXTURE_STATE);
  try {
    return renderToString(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    ).replace(/<!-- -->/g, "");
  } finally {
    __setStateForTest(FIXTURE_STATE);
  }
}

describe("the door is four pictures and nothing else (design turns 113, 238a)", () => {
  const NEW = `/w/${FIXTURE_WORLD_ID}/productions/new`;

  it("asks what the world should become, and offers the four cards to answer with", () => {
    const html = render(NEW);
    assert.match(html, /What should this world become next\?/, "the question is the title");
    for (const door of DOOR_CHOICES) {
      assert.match(html, new RegExp(door.label), `${door.label} is offered`);
      assert.match(html, new RegExp(door.eyebrow), `${door.eyebrow} labels it`);
      assert.match(html, new RegExp(door.affordance), "and the card says what pressing it opens");
    }
    assert.doesNotMatch(html, /What are you making\?/, "the old question is gone");
  });

  /**
   * The name moved to step two (turn 113). A field here would be the thing this turn set out to
   * remove — and worse than before, because step two asks for the name too, so a person would
   * name the same production twice.
   */
  it("does not ask for a name, and does not count a step it no longer has", () => {
    const html = render(NEW);
    assert.doesNotMatch(html, /Name it · working titles are fine/, "no name field on the door");
    assert.doesNotMatch(html, /step 1 of 2/, "the door is a choice, not a numbered form step");
    assert.doesNotMatch(html, /Continue · what kind of video\?/, "pressing a card is the continue");
  });

  it("each card carries its picture, by a relative path the packaged app can load", () => {
    const html = render(NEW);
    for (const door of DOOR_CHOICES) {
      // Absolute would resolve to the filesystem root under file:// and 404 in the packaged app.
      assert.match(html, new RegExp(`\\./doors/${door.id}\\.webp`), `${door.id} names its picture`);
    }
    assert.doesNotMatch(html, /src="\/doors/, "never a leading slash");
  });

  /**
   * The door is a page, so it is dressed like one: the world's hero, the page background. It
   * briefly wore the creation dialog's treatment — the key art blurred behind a panel — which
   * on a full page reads as a grey band that stops partway down rather than as a backdrop.
   * That treatment still belongs to step two, which is still a dialog.
   */
  it("is dressed like every other page in the world, not like a dialog", () => {
    const html = render(NEW);
    assert.doesNotMatch(html, /blur\(7px\) saturate\(\.8\)/, "no dialog backdrop on a page");
    assert.doesNotMatch(html, /fy-dialogwrap/, "and no dialog wrapper");
    assert.match(html, /fy-hero__title/, "the same hero every other screen opens with");
    assert.match(html, /fy-hero__eyebrow/);
    assert.match(html, /fy-hero__lede/);
  });
});

describe("what the door writes (turn 113a)", () => {
  it("four cards, in the drawn order, and Audio is not among them", () => {
    assert.deepEqual(
      DOOR_CHOICES.map((d) => d.label),
      ["Tell a story", "Make a film", "Make it interactive", "Make music"],
      "write · watch · choose · listen (design turn 238a)",
    );
    // Turn 99 claimed Audio as a medium and nothing ever shipped behind it; the audiobook rides
    // under WRITE until there is something to open.
    assert.doesNotMatch(DOOR_CHOICES.map((d) => d.label).join(" "), /audio/i);
    assert.match(DOOR_CHOICES[0]!.body, /audiobook/, "and WRITE says so in its examples");
  });

  /**
   * Turn 100's first sentence still stands: interactive video is a kind of video, not a medium.
   * The card is a door into the same production the kind row used to write — if this ever became
   * `medium: "interactive"`, every screen that reads a production would have a third case.
   */
  it("Choose writes a video production with the interactive kind, not a third medium", () => {
    const choose = DOOR_CHOICES.find((d) => d.id === "choose")!;
    assert.equal(choose.medium, "video");
    assert.equal("productionKind" in choose && choose.productionKind, "interactive");
    for (const door of DOOR_CHOICES) {
      assert.ok(["story", "video", "music"].includes(door.medium), `${door.id} keeps a shipped medium`);
    }
  });

  /**
   * The door is the picture: a card whose image is missing falls back to nothing at all, and the
   * screen still looks deliberate — three cards, one with a blank rectangle where the reason to
   * press it should be.
   */
  it("every card has its picture on disk", () => {
    const doors = fileURLToPath(new URL("../public/doors/", import.meta.url));
    for (const door of DOOR_CHOICES) {
      assert.ok(
        existsSync(`${doors}${door.id}.webp`),
        `${door.id} points at ./doors/${door.id}.webp, which is not there`,
      );
    }
  });
});

describe("CHOOSE asks which interactive (design turn 174)", () => {
  it("offers an interactive movie and a visual novel, named for what the viewer does", () => {
    assert.deepEqual(
      INTERACTIVE_KIND_CHOICES.map((k) => [k.id, k.label]),
      [
        ["interactive", "Interactive movie"],
        ["visual-novel", "Visual novel"],
      ],
    );
    assert.equal(KINDS_BY_DOOR.choose, INTERACTIVE_KIND_CHOICES);
    // "Illustrated" already names an art direction; a label that says the technique rather than
    // what the viewer does is what the turn replaced.
    for (const k of INTERACTIVE_KIND_CHOICES) assert.doesNotMatch(k.label, /Illustrated|Moving pictures/);
  });

  it("the card's own kind is the row's first answer, so an untouched step writes what it always did", () => {
    const choose = DOOR_CHOICES.find((d) => d.id === "choose")!;
    assert.equal("productionKind" in choose && choose.productionKind, INTERACTIVE_KIND_CHOICES[0]!.id);
  });

  it("both interactive kinds have their plate on disk", () => {
    const plates = fileURLToPath(new URL("../public/video-kinds/", import.meta.url));
    for (const kind of INTERACTIVE_KIND_CHOICES) {
      assert.ok(KIND_PLATES.has(kind.id), `${kind.id} asks for a plate`);
      assert.ok(existsSync(`${plates}${kind.id}.webp`), `${kind.id}.webp is shipped`);
    }
  });
});

describe("step two's defaults (design turn 53)", () => {
  it("offers every supported production frame rate and defaults to the first one", () => {
    assert.deepEqual(FRAME_RATE_CHOICES, [24, 25, 30]);
    assert.equal(FRAME_RATE_CHOICES[0], 24);
  });

  it("how a season ends is not a default the door can ask (turn 99)", () => {
    const html = render(`/w/${FIXTURE_WORLD_ID}/productions/new`);
    assert.doesNotMatch(html, /ENDING/, "ending is storytelling, and belongs in the conversation");
    assert.doesNotMatch(html, /Cliffhanger/);
  });
});
