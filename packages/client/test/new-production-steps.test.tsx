import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { App } from "../src/App.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DOOR_CHOICES,
  EPISODE_COUNT_CHOICES,
  EPISODE_LENGTH_CHOICES,
  KIND_PLATES,
  MICRODRAMA_DEFAULTS,
  VIDEO_KIND_CHOICES,
  parseEpisodeLength,
} from "../src/screens/world.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * Creation is two steps: a door of three pictures, then the screen that asks whatever the card
 * left unanswered and takes the name (design turns 83, 99, 113).
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

describe("the door is three pictures and nothing else (design turn 113)", () => {
  const NEW = `/w/${FIXTURE_WORLD_ID}/productions/new`;

  it("asks what the world should become, and offers the three cards to answer with", () => {
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

  it("the world stands behind the decision, blurred back", () => {
    const html = render(NEW);
    assert.match(html, /blur\(7px\) saturate\(\.8\)/, "the key art is the backdrop, not a repeated line of text");
  });
});

describe("what the door writes (turn 113a)", () => {
  it("three cards, in the drawn order, and Audio is not among them", () => {
    assert.deepEqual(
      DOOR_CHOICES.map((d) => d.label),
      ["Tell a story", "Make a film", "Make it interactive"],
      "write · watch · choose",
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
      assert.ok(["story", "video"].includes(door.medium), `${door.id} keeps a shipped medium`);
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

  it("nothing is offered twice: Interactive is a card, so it is not also a kind", () => {
    const carriedByADoor = DOOR_CHOICES.flatMap((d) =>
      "productionKind" in d ? [d.productionKind as string] : [],
    );
    for (const kind of VIDEO_KIND_CHOICES) {
      assert.ok(
        !carriedByADoor.includes(kind.id),
        `${kind.id} is offered by a card and by the kind row`,
      );
    }
  });
});

describe("step two offers every kind and every default (design turn 53)", () => {
  it("four kinds are offered, Other among them, in the drawn order", () => {
    assert.deepEqual(
      VIDEO_KIND_CHOICES.map((k) => k.label),
      ["Micro drama", "Film · short", "Music video", "Other"],
      "four kinds, in the drawn order — Interactive left for the door (turn 113a)",
    );
    assert.equal(VIDEO_KIND_CHOICES[0]!.body, "Episodes, vertical.");
    // "· series" was dropped when the row went from five columns to four: it wrapped to two lines
    // and stood the card taller than the three beside it.
    assert.doesNotMatch(VIDEO_KIND_CHOICES[0]!.label, /series/);
  });

  /**
   * The kinds are chosen by looking, so a plate that is named but not shipped costs the whole
   * point of the step — and it fails quietly: the box falls back to bare `--muted`, which is
   * exactly what an unpicked card already looks like. Nothing on screen says the art is missing.
   */
  it("every kind that offers a plate has one on disk, and Other deliberately has none", () => {
    const plates = fileURLToPath(new URL("../public/video-kinds/", import.meta.url));
    for (const kind of VIDEO_KIND_CHOICES) {
      const shipped = existsSync(`${plates}${kind.id}.webp`);
      assert.equal(
        shipped,
        KIND_PLATES.has(kind.id),
        shipped
          ? `${kind.id} ships a plate the screen never asks for`
          : `${kind.id} points at ./video-kinds/${kind.id}.webp, which is not there`,
      );
    }
    assert.ok(!KIND_PLATES.has("other"), "nothing assumed is drawn as an empty box, not as a picture");
  });

  it("each kind carries the frame it delivers in, and only a micro drama is vertical", () => {
    // Before turn 99 the aspect travelled for a micro drama alone, so a film could not be made
    // vertical until after it existed — and the state defaulted to 9:16 for everything.
    const byId = new Map(VIDEO_KIND_CHOICES.map((k) => [k.id, k.aspect]));
    assert.equal(byId.get("microdrama"), "9:16");
    for (const id of ["film", "music-video", "other"] as const) {
      assert.equal(byId.get(id), "16:9", `${id} delivers landscape unless told otherwise`);
    }
  });

  it("how a season ends is not a default the door can ask (turn 99)", () => {
    const html = render(`/w/${FIXTURE_WORLD_ID}/productions/new`);
    assert.doesNotMatch(html, /ENDING/, "ending is storytelling, and belongs in the conversation");
    assert.doesNotMatch(html, /Cliffhanger/);
  });


  /**
   * A season can be as long as the form actually runs (2026-08-23).
   *
   * This offered 5 to 12, which is a short film in slices. Vertical series run 60 to 100, and a
   * season written to eight has a different spine from one written to eighty — the reveal sits at
   * four instead of forty. A door that cannot say eighty makes every season it opens the wrong
   * shape, and the author finds out where changing it is expensive.
   */
  it("offers the lengths a vertical series is actually written to", () => {
    assert.ok(EPISODE_COUNT_CHOICES.includes(80), "eighty is sayable");
    assert.ok(
      EPISODE_COUNT_CHOICES.some((n) => n >= 60 && n <= 100),
      "the platform range is reachable, not just its edges",
    );
    assert.ok(EPISODE_COUNT_CHOICES.includes(8), "and a short sample cut to sell the run still is");
    assert.deepEqual([...EPISODE_COUNT_CHOICES].sort((a, b) => a - b), [...EPISODE_COUNT_CHOICES], "in order");
  });

  it("starts on a count that is one of the choices", () => {
    // The default used to be 7, which stopped being in the list. A select whose value is absent
    // from its options silently shows the first one instead — a door that lies about what it did.
    assert.ok(
      EPISODE_COUNT_CHOICES.includes(MICRODRAMA_DEFAULTS.episodeCount),
      `the default ${MICRODRAMA_DEFAULTS.episodeCount} is selectable`,
    );
  });

  it("episode length is a range a season can be written from", () => {
    assert.ok(EPISODE_LENGTH_CHOICES.length >= 2, "a choice with one answer would be a toll");
    for (const choice of EPISODE_LENGTH_CHOICES) {
      const range = parseEpisodeLength(choice.id);
      assert.ok(range, `${choice.id} parses`);
      assert.ok(range.min > 0 && range.max >= range.min, `${choice.id} is a real range`);
    }
    assert.deepEqual(parseEpisodeLength("45-75"), { min: 45, max: 75 }, "the Microdrama default");
  });

  it("a range that cannot be read is refused rather than written to the season", () => {
    // The value travels from a select into season.json. A season nobody can read back is worse
    // than a creation that leaves the defaults alone.
    for (const bad of ["", "-", "abc", "75-45", "0-0", "45"]) {
      assert.equal(parseEpisodeLength(bad), null, `"${bad}" is refused`);
    }
  });
});
