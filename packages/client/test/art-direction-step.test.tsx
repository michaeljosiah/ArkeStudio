import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { ArtStyleGrid, ArtStyleWords } from "../src/components/art-style-picker.js";
import { ART_STYLE_PRESETS, presetById, seedFrom } from "../src/lib/art-styles.js";
import { proposedMasterLookNote, splitDescription } from "../src/screens/art-direction.js";
import { authoredPrompt } from "../src/components/generation-dialog.js";
import { NewWorldScreen } from "../src/screens/shell.js";
import { App } from "../src/App.js";
import { worldImagePrompt, type BuildReview, type ClientMessage, type GenesisBlueprint } from "@arke-studio/contracts";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }) });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

/**
 * Genesis asks for the look (design turn 38). The rule under test is the one that decides what
 * ends up on disk: a preset seeds words and is then discarded, so only the text is stored and an
 * edited preset is the same record as a hand-written look.
 */

describe("the preset library", () => {
  it("offers nine looks and a custom door, all as cards of equal standing", () => {
    assert.equal(ART_STYLE_PRESETS.length, 9);
    const html = renderToString(<ArtStyleGrid selectedId={null} onSelect={() => {}} />);
    for (const preset of ART_STYLE_PRESETS) assert.ok(html.includes(preset.name), preset.name);
    assert.ok(html.includes("Describe your own"));
    // Custom is the selection when nothing was picked — writing your own is not a fallback.
    assert.match(html.slice(html.indexOf("Describe your own") - 400), /is-selected/);
  });

  it("every preset seeds words about the treatment, and none of them is empty", () => {
    for (const preset of ART_STYLE_PRESETS) {
      assert.ok(preset.description.trim().length > 40, `${preset.id} says something`);
      assert.ok(preset.blurb.trim().length > 0);
    }
    assert.equal(new Set(ART_STYLE_PRESETS.map((p) => p.id)).size, 9, "ids are distinct");
  });

  it("says the words were seeded, and says so differently once they are edited", () => {
    const painterly = presetById("painterly-realism")!;
    const seeded = renderToString(
      <ArtStyleWords selectedId={painterly.id} value={painterly.description} onChange={() => {}} />,
    );
    assert.ok(seeded.includes("SEEDED BY PAINTERLY REALISM"));
    assert.ok(!seeded.includes("EDITED"));

    const edited = renderToString(
      <ArtStyleWords selectedId={painterly.id} value={`${painterly.description} And fog.`} onChange={() => {}} />,
    );
    assert.ok(edited.includes("EDITED"), "an edited preset says so — the text is the record now");

    const own = renderToString(<ArtStyleWords selectedId={null} value="Anything." onChange={() => {}} />);
    assert.ok(own.includes("YOUR OWN WORDS"));
  });
});

describe("the art-direction step of genesis", () => {
  const render = () =>
    renderToString(
      <MemoryRouter>
        <NewWorldScreen />
      </MemoryRouter>,
    );

  it("does not ask for the look until the world has been described", () => {
    __setStateForTest(FIXTURE_STATE);
    const html = render();
    assert.ok(!html.includes("STEP 3 OF 3"), "the look is the last question, not the first");
    assert.ok(html.includes("Begin in this world"));
  });

  it("promises the step rather than springing it, so Begin is not a surprise", () => {
    __setStateForTest(FIXTURE_STATE);
    assert.ok(render().includes("One more question"));
  });
});

const GENESIS_ID = "gen-00";
const BUILD_REQUEST_ID = "01J8E0000000000000000000B1";

function genesisBlueprint(look?: string): GenesisBlueprint {
  return {
    name: "Glass Harbor",
    logline: "A drowned city bargains with the tide.",
    ...(look ? { look } : {}),
    threads: [],
    characters: [],
    locations: [],
    factions: [],
    dropped: [],
  };
}

const BUILD_REVIEW: BuildReview = {
  genesisId: GENESIS_ID,
  requestId: BUILD_REQUEST_ID,
  worldName: "Glass Harbor",
  counts: { characters: 0, locations: 0, factions: 0, threads: 0 },
  generations: 0,
  estimateMicroUsd: 0,
  imageModel: null,
  notes: [],
  dropped: [],
};

interface MountedGenesis {
  container: HTMLElement;
  root: Root;
  messages: ClientMessage[];
}

function bridge(messages: ClientMessage[]): ArkeBridge {
  return {
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json) => messages.push(JSON.parse(json) as ClientMessage),
  };
}

async function mountGenesis(blueprint: GenesisBlueprint, plan?: BuildReview): Promise<MountedGenesis> {
  __setStateForTest(
    {
      ...FIXTURE_STATE,
      app: {
        ...FIXTURE_STATE.app,
        health: { ...FIXTURE_STATE.app.health, harness: { status: "healthy" } },
      },
    },
    {
      genesis: {
        [GENESIS_ID]: {
          turns: [
            { role: "user", text: "A drowned city.", at: "2026-08-31T12:00:00Z" },
            { role: "gate", text: "Should we generate images based on this look?", at: "2026-08-31T12:01:00Z" },
          ],
          blueprint,
          status: "completed",
          working: null,
          runStartedAt: null,
          attachments: [],
          refusals: [],
        },
      },
      ...(plan ? { buildPlans: { [GENESIS_ID]: { requestId: plan.requestId, plan } } } : {}),
    },
  );
  const messages: ClientMessage[] = [];
  __setBridgeForTest(bridge(messages));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const now = Date.now;
  const random = Math.random;
  Date.now = () => 0;
  Math.random = () => 0;
  try {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <NewWorldScreen />
        </MemoryRouter>,
      );
    });
  } finally {
    Date.now = now;
    Math.random = random;
  }
  return { container, root, messages };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  assert.ok(found, `${label} button is rendered`);
  return found;
}

async function unmountGenesis(mounted: MountedGenesis): Promise<void> {
  await act(async () => mounted.root.unmount());
  mounted.container.remove();
  __setBridgeForTest(null);
}

function latestPlanRequest(mounted: MountedGenesis): Extract<ClientMessage, { kind: "plan-founding-build" }> {
  const request = mounted.messages.findLast(
    (message): message is Extract<ClientMessage, { kind: "plan-founding-build" }> =>
      message.kind === "plan-founding-build",
  );
  assert.ok(request, "the build review is requested");
  return request;
}

async function answerPlan(mounted: MountedGenesis): Promise<void> {
  const request = latestPlanRequest(mounted);
  await act(async () => {
    __applyEventForTest({
      type: "build.plan",
      at: "2026-08-31T12:02:00Z",
      genesisId: GENESIS_ID,
      requestId: request.requestId,
      plan: { ...BUILD_REVIEW, requestId: request.requestId },
    });
  });
}

describe("the chat-to-build handoff (issue 666)", () => {
  it("treats Begin as approval of the look already proposed in conversation", async () => {
    const mounted = await mountGenesis(genesisBlueprint("Ink-washed miniatures under cold harbor light."), BUILD_REVIEW);
    try {
      await act(async () => button(mounted.container, "Begin in this world").click());
      assert.ok(mounted.container.textContent?.includes("sizing the build"), "a cached review is not actionable");
      assert.ok(!mounted.container.textContent?.includes("Build Glass Harbor"));
      await answerPlan(mounted);
      assert.ok(mounted.container.textContent?.includes("One press makes Glass Harbor."), "the final build review opens");
      assert.ok(
        !mounted.container.textContent?.includes("The conversation proposed this look."),
        "the duplicate words confirmation is skipped",
      );
    } finally {
      await unmountGenesis(mounted);
    }
  });

  it("returns from art direction to the conversation without discarding it", async () => {
    const mounted = await mountGenesis(genesisBlueprint());
    try {
      await act(async () => button(mounted.container, "Begin in this world").click());
      assert.ok(mounted.container.textContent?.includes("How should Glass Harbor look?"));
      await act(async () => button(mounted.container, "Back to chat").click());
      assert.ok(mounted.container.textContent?.includes("A drowned city."), "the existing conversation is restored");
      assert.ok(mounted.container.textContent?.includes("Begin in this world"));
    } finally {
      await unmountGenesis(mounted);
    }
  });

  it("uses a conversational look that changed after returning to chat", async () => {
    const firstLook = "Ink-washed miniatures under cold harbor light.";
    const latestLook = "Charcoal silhouettes against a warm harbor dawn.";
    const mounted = await mountGenesis(genesisBlueprint(firstLook));
    try {
      await act(async () => button(mounted.container, "Begin in this world").click());
      assert.equal(latestPlanRequest(mounted).look, firstLook);
      await act(async () => button(mounted.container, "Back to chat").click());
      await act(async () => {
        __applyEventForTest({
          type: "genesis.blueprint",
          at: "2026-08-31T12:03:00Z",
          genesisId: GENESIS_ID,
          blueprint: genesisBlueprint(latestLook),
        });
      });
      await act(async () => button(mounted.container, "Begin in this world").click());
      assert.equal(latestPlanRequest(mounted).look, latestLook);
    } finally {
      await unmountGenesis(mounted);
    }
  });
});

describe("the words a card seeds", () => {
  it("empties them for the custom door, so nothing is stored that nobody wrote", () => {
    // Pick Editorial print, change your mind, click Describe your own — the box used to keep
    // Editorial print's sentence while the line under it said nothing was seeded, and accepting
    // from there stored those words as if someone had written them.
    assert.equal(seedFrom(null), "");
    assert.equal(seedFrom(presetById("editorial-print")!), presetById("editorial-print")!.description);
  });
});

/**
 * What the review says the proposal does to the master image.
 *
 * This read `proposed?.masterLook ?? direction.masterLook` and captioned the result "master image
 * retained" — so a proposal carrying no image showed the current one, over a promise to keep it,
 * and accepting removed it. A conversation's look change never carries an image, which made that
 * every one of them. Presence, not fallback: the three cases are genuinely different.
 */
describe("the master image on a proposed look", () => {
  it("says it is retained when the proposal carries the same image", () => {
    assert.equal(proposedMasterLookNote("looks/a.png", "looks/a.png", true), "New style · master image retained");
  });

  it("says it is removed when the proposal carries none", () => {
    assert.equal(proposedMasterLookNote(null, "looks/a.png", true), "New style · master image removed");
  });

  it("says it is new when the proposal carries a different one", () => {
    assert.equal(proposedMasterLookNote("looks/b.png", "looks/a.png", true), "New master image");
  });

  it("borrows the current image only while nothing is staged to misdescribe", () => {
    assert.equal(proposedMasterLookNote(null, "looks/a.png", false), "New style · master image retained");
  });
});

/**
 * The heading over a look is typography, not meaning.
 *
 * It is the description's own opening, promoted to display type — and the whole description is
 * what every generation receives. The rule that matters here is that the split never loses a
 * word: heading plus body reads back as what was written, whichever branch produced it.
 */
describe("splitting a look into a heading and a body", () => {
  const rejoin = (split: { title: string; body: string }) => `${split.title} ${split.body}`.trim();
  /** Word sequence, so the assertion is about words kept — not about the punctuation at a seam. */
  const words = (text: string) => text.toLowerCase().match(/[a-z0-9-]+/g) ?? [];

  it("promotes a short first sentence and leaves the rest as the body", () => {
    const split = splitDescription("Painterly and cold. Wide lenses, low sun, no gloss.");
    assert.equal(split.title, "Painterly and cold.");
    assert.equal(split.body, "Wide lenses, low sun, no gloss.");
  });

  it("gives a one-sentence look no body rather than printing it twice", () => {
    const split = splitDescription("A quiet, painterly near-future.");
    assert.equal(split.title, "A quiet, painterly near-future.");
    assert.equal(split.body, "");
  });

  it("breaks a run-on first sentence at its own structure instead of setting it all in display type", () => {
    // The shape a look is actually written in: one long line, the real title before the colon.
    const look =
      "Cinematic painterly 3D animation with an Arcane-like visual sensibility: premium French " +
      "animated-drama production quality, hand-painted textures over stylized 3D forms, expressive " +
      "visible brushwork, no photorealism. The world should feel real enough to believe.";
    const split = splitDescription(look);
    assert.equal(split.title, "Cinematic painterly 3D animation with an Arcane-like visual sensibility");
    assert.ok(split.title.length <= 120, "a heading stays a heading");
    assert.ok(split.body.startsWith("premium French"), split.body.slice(0, 40));
    assert.ok(split.body.endsWith("real enough to believe."), "the later sentences are still there");
  });

  it("falls back to the last comma that fits when there is no structural break", () => {
    const look =
      "Hand-painted textures over stylized three-dimensional forms, expressive visible brushwork, " +
      "graphic shadow masses, restrained colour scripting throughout every frame.";
    const split = splitDescription(look);
    assert.ok(split.title.length <= 120, split.title);
    assert.ok(look.startsWith(split.title), "the heading is the opening, verbatim");
    assert.ok(split.body.endsWith("every frame."), split.body);
    assert.deepEqual(words(rejoin(split)), words(look));
  });

  it("keeps every word: heading plus body is the description again", () => {
    for (const look of [
      "One line only",
      "First. Second. Third.",
      "A: B",
      `${"very long opening clause ".repeat(8)}: and the rest of it.`,
      "No terminator, no colon, just a long line of commas, and more commas, running on and on and on",
    ]) {
      assert.deepEqual(words(rejoin(splitDescription(look))), words(look), look.slice(0, 40));
    }
  });
});

/**
 * The world's other picture, on the page about the world's pictures (design 64).
 *
 * Key art had no setter at all between 63a clearing the world hub of controls and this. The rules
 * worth holding are the two that were broken before: it has doors of its own, and neither picture
 * is ever shown under controls that act on the other.
 */

const WORLD = FIXTURE_STATE.world!;
const WORLD_ID = WORLD.meta.worldId;

function renderArtDirection(world: Partial<typeof WORLD> = {}): string {
  __setStateForTest({ ...FIXTURE_STATE, world: { ...WORLD, ...world } });
  try {
    return renderToString(
      <MemoryRouter initialEntries={[`/w/${WORLD_ID}/art-direction`]}>
        <App />
      </MemoryRouter>,
    ).replace(/<!-- -->/g, "");
  } finally {
    __setStateForTest(FIXTURE_STATE);
  }
}

describe("key art on the art-direction page (design 64)", () => {
  it("gives key art a frame and two doors of its own", () => {
    const html = renderArtDirection({ keyArt: "world-art.png" });
    assert.match(html, /WORLD KEY ART/, "it is named, so which picture you are looking at is never a guess");
    const frame = /class="fy-artdirection__keyart[^"]*"[\s\S]*?<\/section>/.exec(html);
    assert.ok(frame, "the frame renders");
    assert.match(frame[0], /Generate</, "the doors are on this picture");
    assert.match(frame[0], /Upload</);
  });

  it("never shows one picture under controls that make the other", () => {
    // The bug this closes: with no master look the hero showed the *key art* under Generate and
    // Upload buttons that made a master look, so the one gesture the picture invited was the one
    // gesture it did not perform.
    const html = renderArtDirection({
      keyArt: "world-art.png",
      artDirection: { ...WORLD.artDirection, masterLook: undefined },
    });
    // The key-art band sits between the master frame and the detail column now (both pictures
    // above the fold), so the master frame ends where that band begins.
    const from = html.indexOf('class="fy-artdirection__master');
    const to = html.indexOf('class="fy-artdirection__keyartband');
    assert.ok(from > 0 && to > from, "the master frame renders, and the key-art band after it");
    const hero = html.slice(from, to);
    assert.ok(!hero.includes("world-art.png"), "the master frame does not borrow the key art");
    assert.match(hero, /NO MASTER LOOK/, "an unset picture says it is unset");
    // And the key art is still on the page — in its own frame, below.
    assert.match(html.slice(to), /world-art\.png/);
  });

  it("says which of the two it is, and that this one is never sent to a model", () => {
    const html = renderArtDirection({ keyArt: "world-art.png" });
    assert.match(html, /Nothing sends it to a model/i, "the distinction that governs everything else");
  });

  it("states the empty case rather than hiding the block", () => {
    const html = renderArtDirection({ keyArt: null });
    assert.match(html, /NO KEY ART/);
    assert.match(html, /fy-artdirection__keyart--empty/, "and the doors are still reachable on it");
  });
});

describe("whose words a key-art generation carries (design 64)", () => {
  const composed = worldImagePrompt(WORLD.meta, WORLD.artDirection);

  it("sends nothing at all when the box was opened and not changed", () => {
    // Identical from this end and opposite at the other: a present prompt tells the coordinator
    // the author has decided, and stops it asking the art director to write one.
    assert.equal(authoredPrompt(composed, composed), undefined);
    assert.equal(authoredPrompt(`  ${composed}\n`, composed), undefined, "whitespace is not an edit");
  });

  it("sends the words the moment they differ", () => {
    assert.equal(authoredPrompt(`${composed} And fog.`, composed), `${composed} And fog.`);
  });

  it("opens the box with exactly what would otherwise have been sent", () => {
    assert.ok(composed.includes(WORLD.meta.name));
    assert.ok(
      composed.includes(WORLD.artDirection.description),
      "the look's own description is folded in, so an edit is an edit of the whole brief",
    );
  });
});

/**
 * The character sheet, on the shared dialog (design 65).
 *
 * This was the last surface drawing its own, and the one that fitted worst: its result is an
 * accept-or-reject over a single composite, not a pick-one-of-four. What the migration must not
 * lose is the reject path and the distinction between a take that arrived already accepted and
 * one still waiting on a decision — and what it deliberately drops is the two-phase wizard, so
 * a result you do not like no longer leaves you on a screen with no words on it.
 */
describe("generating a character sheet (design 65)", () => {
  const sheetHtml = (): string => {
    __setStateForTest(FIXTURE_STATE);
    return renderToString(
      <MemoryRouter initialEntries={[`/w/${WORLD_ID}/cast/maren-kest/model-sheet`]}>
        <App />
      </MemoryRouter>,
    ).replace(/<!-- -->/g, "");
  };

  it("asks for it in the shared dialog rather than a scrim of its own", () => {
    const html = sheetHtml();
    assert.match(html, /<dialog class="fy-gendialog/, "the standard dialog");
    assert.ok(!html.includes("fy-sheet-dialog"), "and not the retired two-phase one");
    assert.ok(!html.includes("fy-generation-scrim"));
  });

  it("shows the inherited look in the box instead of hiding it behind Override", () => {
    const html = sheetHtml();
    assert.match(html, />Art direction<\/label>/, "the box is the art direction");
    assert.ok(
      html.includes(WORLD.artDirection.description),
      "and it opens as the words this generation will actually be made under",
    );
    assert.ok(!html.includes(">Override<"), "the toggle over an unreadable default is gone");
  });

  it("keeps the composer on screen beside the result, so a re-run is not a restart", () => {
    const html = sheetHtml();
    const compose = html.indexOf("fy-gendialog__compose");
    const previews = html.indexOf("fy-gendialog__previews");
    assert.ok(compose > 0 && previews > compose);
    assert.ok(!html.includes("Back to generation settings"), "there is no phase to go back to");
  });

  it("still says what arrives and what identity it is conditioned on", () => {
    const html = sheetHtml();
    assert.ok(html.includes("turnaround + expressions + details in one image"));
    assert.match(html, /MAIN PHOTO/, "the identity source is named on the reference it carries");
  });
});

/**
 * The last two surfaces (design 66).
 *
 * Both were panels on a page rather than dialogs, and both keep their page: a look is accepted,
 * promoted or attached in the gallery, and a view is named and accepted among the candidates. So
 * both dialogs are ask-only — `previews` undefined, which turn 65 already defines as "this offer
 * is answered elsewhere" and is exactly true here.
 */
describe("the looks gallery asks in the dialog (design 66)", () => {
  const looksHtml = (): string => {
    __setStateForTest(FIXTURE_STATE);
    return renderToString(
      <MemoryRouter initialEntries={[`/w/${WORLD_ID}/cast/maren-kest/looks`]}>
        <App />
      </MemoryRouter>,
    ).replace(/<!-- -->/g, "");
  };

  it("keeps the gallery on the page and puts the ask behind a door", () => {
    const html = looksHtml();
    assert.match(html, /<dialog class="fy-gendialog/, "the standard dialog is in the document");
    assert.ok(html.includes("fy-looks-results"), "and the gallery is still the page");
  });

  it("carries the type and direction choices into the dialog rather than dropping them", () => {
    const html = looksHtml();
    const at = html.indexOf('<dialog class="fy-gendialog');
    const dialog = html.slice(at);
    assert.ok(dialog.includes("Pose / expression"), "type survives the move");
    assert.ok(dialog.includes("Push it"), "and so does direction");
  });

  it("draws no preview column, because the gallery behind it is the answer", () => {
    const html = looksHtml();
    const dialog = html.slice(html.indexOf('<dialog class="fy-gendialog'));
    assert.ok(!dialog.includes("fy-gendialog__previews"), "one column: this offer is answered on the page");
    assert.ok(!html.includes("fy-gendialog--wide"));
  });
});

describe("location views ask in the dialog (design 66)", () => {
  const locationHtml = (): string => {
    __setStateForTest(FIXTURE_STATE);
    return renderToString(
      <MemoryRouter initialEntries={[`/w/${WORLD_ID}/locations/the-vigil/reference`]}>
        <App />
      </MemoryRouter>,
    ).replace(/<!-- -->/g, "");
  };

  it("replaces the inline form with the standard dialog", () => {
    const html = locationHtml();
    assert.match(html, /<dialog class="fy-gendialog/);
    assert.ok(!html.includes("fy-locref__form"), "the hand-rolled form is gone");
    assert.ok(html.includes("fy-locref__candidate") || html.includes("Accepted views"), "the page keeps its answers");
  });

  it("keeps the angle's name, which is what gates the generation", () => {
    const html = locationHtml();
    const dialog = html.slice(html.indexOf('<dialog class="fy-gendialog'));
    assert.ok(dialog.includes("What is this angle called?"));
    assert.ok(dialog.includes("An angle needs a name"), "and says so while it is empty");
  });

  it("lets the camera line be empty, because the brief is composed without it", () => {
    // The one surface where the prompt adds to a brief rather than being it. Refusing an empty
    // box here would demand a sentence nobody needs to write.
    const shared = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/components/generation-dialog.tsx"),
      "utf8",
    );
    assert.match(shared, /!promptOptional && prompt\.trim\(\)\.length === 0/, "the block is opt-out, not removed");
    const locations = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/screens/location-reference.tsx"),
      "utf8",
    );
    assert.match(locations, /promptOptional/, "and location views are the surface that opts out");
  });
});
