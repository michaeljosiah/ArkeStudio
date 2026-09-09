import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { App } from "../src/App.js";
import { __applyEventForTest, __connectionStatusForTest, __setStateForTest } from "../src/lib/store.js";
import { SCREENS } from "../src/screens/registry.js";
import { stagedReferenceKey } from "@arke-studio/contracts";
import { FIXTURE_STATE } from "./fixture-state.js";
import { legacySceneView } from "@arke-studio/contracts";

/**
 * The navigation test (SPEC-001 R-7): every §2.9 screen mounts at its route, rendering the
 * fixture state, and the inventory itself is complete.
 */

__setStateForTest(FIXTURE_STATE);

function renderAt(path: string): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

/**
 * Every `<button>` that opens while another is still open, as a slice of the outer one.
 *
 * A control inside a control is invalid HTML, and the browser's repair — closing the outer one
 * at the inner tag — is not what the markup said, so React refuses to hydrate it. It cost the
 * world picker its "Create a world" button: clickable by mouse, and absent from the
 * accessibility tree because the parser had already thrown it out of the card.
 */
function nestedButtons(html: string): string[] {
  const found: string[] = [];
  const open: number[] = [];
  const tags = /<button\b|<\/button>/g;
  let tag: RegExpExecArray | null;
  while ((tag = tags.exec(html)) !== null) {
    if (tag[0] === "</button>") open.pop();
    else {
      // The outer tag is the offender; the inner one is usually a shared <Button>.
      if (open.length > 0) found.push(html.slice(open[0]!, open[0]! + 90));
      open.push(tag.index);
    }
  }
  return found;
}

describe("screen inventory", () => {
  it("covers the full screen inventory (63 screens)", () => {
    // The number is written three times on purpose — it is a tripwire, not a fact being derived,
    // so `SCREENS.length` on both sides would assert nothing. It does mean two branches that each
    // add a screen merge cleanly and land a count that was right for neither: #268 and #243 did
    // exactly that, and this is where it surfaced.
    // 63 with the production's own artifacts page (design 134).
    assert.equal(SCREENS.length, 63);
    assert.equal(new Set(SCREENS.map((s) => s.id)).size, 63, "screen ids are unique");
  });

  for (const screen of SCREENS) {
    it(`reaches ${screen.id} at ${screen.samplePath}`, () => {
      const html = renderAt(screen.samplePath);
      assert.ok(
        html.includes(`data-screen="${screen.id}"`),
        `expected ${screen.samplePath} to mount data-screen="${screen.id}"`,
      );
    });
  }

  it("never nests one control inside another (SPEC-001 R-7)", () => {
    for (const screen of SCREENS) {
      const hits = nestedButtons(renderAt(screen.samplePath));
      assert.equal(hits.length, 0, `${screen.id} nests a <button> inside — ${hits.join(" · ")}`);
    }
  });

  it("smoke-renders the startup screen", () => {
    const html = renderAt("/starting");
    // The screen that waits, by what it is rather than by a wordmark: the reel, and — with nothing
    // left to fetch — a door and a version number. The progress line, the byte counts and the
    // note about where worlds live all answered "what is it doing", which nobody is asking
    // once it is done.
    assert.ok(html.includes('data-screen="startup"'), "/starting mounts the screen that waits");
    assert.ok(html.includes("setup-reel.mp4"), "the reel plays while the runtimes come down");
    assert.ok(html.includes("Continue"), "and when it is ready, the way in");
    assert.ok(html.includes("fy-startup__version"), "with the version under it");
    for (const chatter of ["Setting up your studio.", "One-time setup", "everything ready"]) {
      assert.ok(!html.includes(chatter), `"${chatter}" is not shown once there is nothing to wait for`);
    }
  });

  it("waits behind one control on a launch with nothing to fetch", () => {
    // Setup runs once. Every launch after it only waits for the coordinator to open, and the
    // panel says so with the same control the whole way through — no title, no step line, no
    // bar creeping under a sentence about a one-time download that already happened.
    __connectionStatusForTest("connecting");
    try {
      const html = renderAt("/starting");
      assert.ok(html.includes("Loading…"), "the door is there from the first frame, and says it is opening");
      assert.ok(html.includes("fy-startup__version"), "with the version still under it");
      assert.ok(!html.includes("fy-setupbar"), "nothing is being fetched, so there is no bar");
      for (const chatter of ["Setting up your studio.", "One-time setup", "checking studio core"]) {
        assert.ok(!html.includes(chatter), `"${chatter}" belongs to the launch that is actually setting up`);
      }
    } finally {
      __connectionStatusForTest("open");
    }
  });

  it("keeps the progress panel for the launch that is actually fetching", () => {
    __setStateForTest({
      ...FIXTURE_STATE,
      app: {
        ...FIXTURE_STATE.app,
        setup: {
          running: true,
          diskFreeMb: 100_000,
      diskCheckedAt: null,
          components: [
            {
              id: "voxa-kokoro",
              displayName: "Kokoro voice",
              purpose: "Speaks on this machine",
              sizeMb: 88,
              installLocation: "C:\\ArkeStudio\\models\\kokoro",
              state: "downloading",
              bytesDone: 44 * 1024 * 1024,
              bytesTotal: 88 * 1024 * 1024,
              bytesPerSecond: 2 * 1024 * 1024,
              pauseSupported: false,
            },
          ],
        },
      },
    });
    try {
      const html = renderAt("/starting");
      assert.ok(html.includes("Setting up your studio."), "a real download still says what it is");
      assert.ok(html.includes("fy-setupbar"), "and still shows how far along it is");
      assert.ok(html.includes("downloading kokoro voice"), "in the product's words, one line");
      assert.ok(html.includes("One-time setup"), "with the promise that this happens once");
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("keeps retained paused setup progress visible and resumable", () => {
    __setStateForTest({
      ...FIXTURE_STATE,
      app: {
        ...FIXTURE_STATE.app,
        setup: {
          running: false,
          diskFreeMb: 100_000,
          diskCheckedAt: null,
          components: [
            {
              id: "voxa-kokoro",
              displayName: "Kokoro voice",
              purpose: "Speaks on this machine",
              sizeMb: 88,
              installLocation: "C:\\ArkeStudio\\models\\kokoro",
              state: "paused",
              bytesDone: 44 * 1024 * 1024,
              bytesTotal: 88 * 1024 * 1024,
              bytesPerSecond: null,
              pauseSupported: true,
            },
          ],
        },
      },
    });
    try {
      const html = renderAt("/starting");
      assert.match(html, /paused kokoro voice/);
      assert.match(html, />Resume<\/button>/);
      assert.match(html, /44 MB of (?:<!-- -->)?88 MB/);
      assert.match(html, /fy-setupbar__fill/);
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("offers recovery actions when desktop startup fails", () => {
    const previous = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        arke: {
          startupState: () => ({ status: "failed", detail: "Startup failed safely." }),
        },
      },
    });
    try {
      const html = renderAt("/starting");
      assert.ok(html.includes("The studio could not start"));
      assert.ok(html.includes("Startup failed safely."));
      for (const action of ["Retry", "Open data folder", "Quit"]) assert.ok(html.includes(action));
    } finally {
      if (previous === undefined) delete (globalThis as { window?: Window }).window;
      else Object.defineProperty(globalThis, "window", { configurable: true, value: previous });
    }
  });

  it("renders the degraded reasons when children are unavailable (R-6)", () => {
    const html = renderAt(SCREENS.find((s) => s.id === "character-edit")!.samplePath);
    assert.ok(html.includes("OpenCode is not configured"), "harness reason is stated, not silent");
    const voiceHtml = renderAt(SCREENS.find((s) => s.id === "character-voice")!.samplePath);
    assert.ok(voiceHtml.includes("Voxa is not configured"));
  });

  it("renders fixture content, not lorem ipsum", () => {
    const cast = renderAt(`/w/${FIXTURE_STATE.world!.meta.worldId}/cast`);
    assert.ok(cast.includes("Maren Kest"));
    const canon = renderAt(`/w/${FIXTURE_STATE.world!.meta.worldId}/canon`);
    assert.ok(canon.includes("Tide-calling"));
  });

  it("keeps a downloaded update actionable after snapshot hydration", () => {
    __setStateForTest({
      ...FIXTURE_STATE,
      app: {
        ...FIXTURE_STATE.app,
        update: {
          status: "ready",
          targetVersion: "0.2.8",
          progressPercent: 100,
          flow: null,
          detail: null,
        },
      },
    });
    const ready = renderAt("/settings/about");
    assert.ok(ready.includes("Arke Studio v0.2.8 is ready to install."));
    assert.ok(ready.includes("Install and restart"));
    assert.ok(ready.includes("Install when I close"));

    __setStateForTest({
      ...FIXTURE_STATE,
      app: {
        ...FIXTURE_STATE.app,
        update: {
          status: "shutting-down",
          targetVersion: "0.2.8",
          progressPercent: 100,
          flow: "restart",
          detail: null,
        },
      },
    });
    const shuttingDown = renderAt("/settings/about");
    assert.ok(shuttingDown.includes("Finishing local work..."));
    assert.ok(shuttingDown.includes("install the update and"));
    assert.ok(shuttingDown.includes("reopen"));
    __setStateForTest(FIXTURE_STATE);
  });

  it("uses the accepted immutable main photo on World overview and both Cast surfaces", () => {
    const world = FIXTURE_STATE.world!;
    const nested = "takes/tk_01J8A0000000000000000000P9/new-main.webp";
    const referenceKits = world.referenceKits.map((kit) =>
      kit.sheetId === "maren-kest"
        ? {
            ...kit,
            anchor: nested,
            mainPhoto: { ...kit.mainPhoto!, file: nested },
          }
        : kit,
    );
    __setStateForTest({ ...FIXTURE_STATE, world: { ...world, referenceKits } });
    try {
      const expected = "references/maren-kest/takes/tk_01J8A0000000000000000000P9/new-main.webp";
      for (const path of [
        `/w/${world.meta.worldId}`,
        `/w/${world.meta.worldId}/cast`,
        `/w/${world.meta.worldId}/cast/maren-kest`,
        `/w/${world.meta.worldId}/p/${world.productions[0]!.meta.id}/cast`,
      ]) {
        const html = renderAt(path);
        assert.ok(html.includes(expected), `${path} uses the accepted identity`);
        assert.ok(!html.includes("references/maren-kest/head-front.png"));
      }
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("shows guest identities and location views, with New guest inside the cast page", () => {
    const state = structuredClone(FIXTURE_STATE);
    const world = state.world!;
    const productionId = world.productions[0]!.meta.id;
    world.sheets.find((sheet) => sheet.id === "maren-kest")!.production = productionId;
    world.referenceKits.find((kit) => kit.sheetId === "maren-kest")!.mainPhoto!.file = "main-photo.png";
    world.referenceKits.push({ sheetId: "the-vigil", tiles: [], looks: [], compilations: [], establishingViewId: "lv_01", locationViews: [
      { id: "lv_01", name: "Establishing", file: "views/establishing.webp", status: "active",
        sourceTakeId: "tk_01J8F0000000000000000000B2",
        sheetVersion: 2, artDirectionVersion: 3, acceptedAt: "2026-08-02T10:00:00Z" },
    ] });
    __setStateForTest(state);
    try {
      const { document } = parseHTML(renderAt(`/w/${world.meta.worldId}/p/${productionId}/cast`));
      const page = document.querySelector('[data-screen="production-cast"]')!;
      assert.ok(page.querySelector('img[src*="references/maren-kest/main-photo.png"]'));
      assert.ok(page.querySelector('img[src*="references/the-vigil/views/establishing.webp"]'));
      assert.equal(page.querySelector(".fy-hero button")?.textContent, "New guest");
      assert.equal(page.querySelector(".fy-corner"), null);
      assert.ok(!page.textContent?.includes("chandlery"));
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("draws production tiles from accepted video posters and keeps media fallbacks usable", () => {
    const state = structuredClone(FIXTURE_STATE);
    const world = state.world!;
    const production = world.productions[0]!;
    // A board and an earlier unselected still must not hide the accepted clip's hook frame.
    production.takes.reverse();
    const image = () => {
      __setStateForTest(state);
      return parseHTML(renderAt(`/w/${world.meta.worldId}/productions`)).document
        .querySelector(".fy-prodcard__frame img")?.getAttribute("src");
    };
    try {
      assert.ok(image()?.includes("takes/tk_01J8F0000000000000000000B2/frame.png"));
      production.selections = {};
      production.reviews = [];
      assert.ok(image()?.endsWith("productions/saltlight/board-v2.png"));
      delete production.scenes[0]!.board;
      production.takes.reverse();
      assert.ok(image()?.includes("takes/tk_01J8F0000000000000000000B2/frame.png"), "unselected video also uses its poster");
      production.takes = [];
      assert.ok(image()?.endsWith(world.keyArt!), "the world art remains the last fallback");
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("keeps Props under Cast with the shared entity navigation and a bounded creation form", () => {
    __setStateForTest(FIXTURE_STATE);
    const world = FIXTURE_STATE.world!;
    const { document } = parseHTML(renderAt(`/w/${world.meta.worldId}/props`));
    const page = document.querySelector('[data-screen="props"]')!;
    assert.equal(document.querySelector('.fy-pillnav__item--active')?.textContent, "Cast");
    assert.equal(document.querySelector('.fy-pillnav__item--active')?.getAttribute("aria-current"), "page");
    assert.equal(page.querySelector('.fy-sheetkinds [aria-current="page"]')?.textContent, "Props · 0");
    for (const slug of ["cast", "locations", "factions"]) {
      assert.ok(page.querySelector(`.fy-sheetkinds a[href="/w/${world.meta.worldId}/${slug}"]`));
    }
    assert.ok(page.querySelector('.scr-form input.ui-input[aria-label="Prop name"]'));
    assert.ok(page.querySelector('.scr-form')?.textContent?.includes("No props yet."));
  });

  it("renders the canonical Cast ledger copy, reach, actions, and direct rows", () => {
    const world = FIXTURE_STATE.world!;
    __setStateForTest(FIXTURE_STATE);
    __applyEventForTest({
      at: "2026-08-04T12:00:00Z",
      type: "sheet.refs",
      worldId: world.meta.worldId,
      sheetId: "maren-kest",
      tiles: 14,
      productions: ["saltlight", "hymnal", "undertow"],
      artifacts: [],
      scenes: [],
      takesByVersion: {},
      incomingLinks: [],
    });
    const html = renderAt(`/w/${world.meta.worldId}/cast`).replace(/<!-- -->/g, "");
    assert.ok(html.includes("The cast · 1"));
    assert.ok(html.includes("Tide-caller · lead — She hears the verse under the harbour."));
    assert.ok(html.includes("14 refs · 3 productions"));
    assert.ok(html.includes("Open sheet"));
    assert.ok(html.includes("More looks"));
    assert.ok(html.includes("ui-btn--primary ui-btn--sm"));
    assert.ok(html.includes("ui-btn--outline ui-btn--sm"));
    assert.ok(html.includes("canon locked, 14 refs · 3 productions, featured. Open sheet"));
    assert.ok(!html.includes("Generate looks"));
  });

  it("bounds verbose Cast feature copy without changing short copy", () => {
    const world = FIXTURE_STATE.world!;
    const featured = world.sheets.find((sheet) => sheet.id === "maren-kest")!;
    const longEssence = `She carries ${"a tide-worn secret ".repeat(20)}beneath the harbour.`;
    const fullCopy = `${featured.role} · ${featured.billing} — ${longEssence}`;
    const expected = `${Array.from(fullCopy).slice(0, 179).join("").trimEnd()}…`;
    const sheets = world.sheets.map((sheet) =>
      sheet.id === featured.id
        ? {
            ...sheet,
            sections: sheet.sections.map((section) =>
              section.heading === "Essence" ? { ...section, body: longEssence } : section,
            ),
          }
        : sheet,
    );
    __setStateForTest({ ...FIXTURE_STATE, world: { ...world, sheets } });
    try {
      const html = renderAt(`/w/${world.meta.worldId}/cast`).replace(/<!-- -->/g, "");
      assert.ok(html.includes(expected), "feature copy is capped at 180 characters including the ellipsis");
      assert.ok(!html.includes(fullCopy), "the full verbose copy is not rendered on the listing");
      assert.ok(!html.includes("beneath the harbour."), "content beyond the limit is omitted from the listing");
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("renders an accessible enlarged portrait dialog on Cast", () => {
    const world = FIXTURE_STATE.world!;
    const html = renderAt(`/w/${world.meta.worldId}/cast`);
    assert.match(html, /<button[^>]*aria-label="View larger portrait of Maren Kest"[^>]*aria-haspopup="dialog"/);
    assert.ok(html.includes('<dialog class="fy-portrait-dialog"'));
    // The id is generated, so assert the relationship rather than the string: whatever the
    // dialog points aria-labelledby at, a heading with that id has to exist.
    const labelledBy = /<dialog[^>]*aria-labelledby="([^"]+)"/.exec(html)?.[1];
    assert.ok(labelledBy, "the dialog names its own heading");
    assert.ok(html.includes(`id="${labelledBy}"`), "and that heading is in the document");
    assert.ok(html.includes('aria-label="Close portrait"'));
    assert.ok(html.includes('alt="Maren Kest portrait"'));
  });

  it("renders the art-direction surface from its resolved record", () => {
    const html = renderAt(`/w/${FIXTURE_STATE.world!.meta.worldId}/art-direction`);
    for (const copy of ["WORLD ART DIRECTION", "HISTORY", "Cold-water realism"]) {
      assert.ok(html.includes(copy), `art direction names ${copy}`);
    }
  });

  /*
   * The door into the editor states its own act (issue 747). What is behind it accepts on the
   * press — `Set the look · v2` writes the record and queues nothing — so a door labelled
   * "Propose a change" promised a review step the screen then had nowhere to send anyone.
   */
  it("opens the look editor with a label that matches what committing there does", () => {
    const html = renderAt(`/w/${FIXTURE_STATE.world!.meta.worldId}/art-direction`);
    assert.ok(html.includes("Change the look"), "the door says what pressing it does");
    assert.ok(!html.includes("Propose a change"), "and no longer promises a review that never comes");
  });

  /*
   * The page was three inventories and a look. Two of the inventories counted work that this page
   * changes nothing about, and the third was a whole second image with its own controls; between
   * them they pushed the look — the reason to be here — into a third of the column.
   */
  it("no longer carries the reach, the overrides or the second image", () => {
    const html = renderAt(`/w/${FIXTURE_STATE.world!.meta.worldId}/art-direction`);
    for (const gone of [
      "WHAT FOLLOWS THIS LOOK",
      "NOT FOLLOWING IT",
      "THE WORLD&#x27;S KEY ART",
      "Generate key art from the logline",
      "24 visual assets",
      "The Chorister",
    ]) {
      assert.ok(!html.includes(gone), `art direction has stopped saying ${gone}`);
    }
  });

  /*
   * The verb next to its object: the picture being replaced is the large one on the left, and the
   * two doors onto it are now on it rather than a third of the way down the other column.
   */
  it("offers Generate and Upload on the picture, and a dialog behind Generate", () => {
    const html = renderAt(`/w/${FIXTURE_STATE.world!.meta.worldId}/art-direction`);
    const at = html.indexOf("fy-artdirection__hover");
    assert.ok(at > 0, "the hover controls are in the document rather than mounted on hover");
    assert.ok(html.indexOf("fy-artdirection__master") < at, "and they are inside the picture");
    assert.ok(html.includes('<dialog class="fy-gendialog'), "Generate opens the standard dialog");
    // The three decisions the standard dialog is for. The prompt starts as the look's own words.
    assert.ok(html.includes("Generate the master look"));
    assert.ok(html.includes("Add a reference image"));
    assert.ok(html.includes('data-testid="dispatch-bar"'), "and the model is picked in the dialog");
    const labelledBy = /<dialog[^>]*class="fy-gendialog[^"]*"[^>]*aria-labelledby="([^"]+)"/.exec(html)?.[1];
    assert.ok(labelledBy, "the dialog names its own heading");
    assert.ok(html.includes(`id="${labelledBy}"`), "and that heading is in the document");
  });

  it("renders the approved two-image character workflow", () => {
    const base = `/w/${FIXTURE_STATE.world!.meta.worldId}/cast/maren-kest`;
    const reference = renderAt(`${base}/kit`);
    for (const copy of [
      "Main photo",
      "ACCEPTED · IDENTITY ANCHOR",
      "Character sheet",
      "multiple views · one composite image",
      "1 reference: Character sheet",
      "multiple: Main photo + Character sheet",
    ]) {
      assert.ok(reference.includes(copy), `Reference matches the approved frame: ${copy}`);
    }

    const generator = renderAt(`${base}/model-sheet`);
    for (const copy of [
      "Generate character sheet",
      "one composite identity reference",
      "World look · v",
      // What this generation completes (SPEC-017 R-23) and where the result lands, in the
      // fewest words that carry both.
      "reference set",
      "lands here and in Activity",
    ]) {
      assert.ok(generator.includes(copy), `Sheet generator states ${copy}`);
    }

    const replace = renderAt(`${base}/main-photo`);
    assert.ok(replace.includes("Replacing the main photo makes the current character sheet stale."));
    assert.ok(replace.includes("World look · v"));

    const looks = renderAt(`${base}/looks`);
    assert.ok(looks.includes("Explore more looks"), "the page names what it is for");
    // The word "optional" was on this screen three ways — a heading's subtitle, the dialog's
    // lede and the empty state — and none of the three is left (issue 1008). The reference
    // slot still says it, because there it labels the slot rather than arguing for the page.
    for (const said of [
      "Optional visual exploration, outside the identity package.",
      "optional visual exploration, outside the identity package",
      "Looks remain optional until you accept one.",
    ]) {
      assert.ok(!looks.includes(said), `the screen no longer says: ${said}`);
    }
  });

  it("shows the routed image model and the same non-zero batch estimate on every character dialog", () => {
    const first = {
      id: "first-image",
      provider: "openai" as const,
      capability: "image" as const,
      displayName: "First Image",
      accepts: { referenceImages: 0, referenceRoles: false, startFrame: false, endFrame: false },
      limits: {},
      pricing: { kind: "perImage" as const, microUsdPerImage: 1 },
    };
    const routed = {
      id: "routed-flux",
      provider: "fal" as const,
      capability: "image" as const,
      displayName: "Routed Flux",
      accepts: { referenceImages: 4, referenceRoles: false, startFrame: false, endFrame: false },
      limits: { resolutions: ["1MP"] },
      pricing: { kind: "perMegapixel" as const, microUsdPerMegapixel: 30000 },
    };
    __setStateForTest({
      ...FIXTURE_STATE,
      app: {
        ...FIXTURE_STATE.app,
        manifest: {
          ...FIXTURE_STATE.app.manifest!,
          models: [first, routed, ...FIXTURE_STATE.app.manifest!.models],
        },
        routing: {
          ...FIXTURE_STATE.app.routing,
          defaults: { ...FIXTURE_STATE.app.routing.defaults, image: routed.id },
        },
      },
    });
    try {
      const base = `/w/${FIXTURE_STATE.world!.meta.worldId}/cast/maren-kest`;
      const sheet = renderAt(`${base}/model-sheet`).replace(/<!-- -->/g, "");
      const main = renderAt(`${base}/main-photo`).replace(/<!-- -->/g, "");
      const looks = renderAt(`${base}/looks`).replace(/<!-- -->/g, "");
      for (const html of [sheet, main, looks]) {
        // The bar names the routed model and says what it carries, once the choice is made.
        assert.ok(html.includes("Routed Flux"), "the routed model is named on every dialog");
        assert.ok(html.includes("up to 4 references"), "and what it will carry is stated");
        assert.ok(!html.includes("First Image"), "the manifest's first image model is not the default");
        assert.doesNotMatch(html, /\$0\.00/);
      }
      assert.ok(main.includes("$0.16"), "four portrait previews show four times the per-image estimate");
      assert.ok(looks.includes("$0.16"), "four looks show the same batch estimate");
      assert.ok(sheet.includes("$0.05"), "one landscape sheet shows its one-image estimate");
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  /*
   * The one clause the reference slot owes (codex, 2026-09-09). Identity is never displaced:
   * `withStaged` fills the model's budget with what the surface must carry first, so on a model
   * with room for one image a staged reference is left behind. That used to be a standing
   * sentence in the hint, said whether or not it applied; issue 1008 cut it, and cutting it
   * left the attachment on screen with Generate live and nothing saying it would not be sent.
   */
  it("says a staged reference will not ride, and only on a model with no room for it", () => {
    const roomy = {
      id: "roomy-image",
      provider: "fal" as const,
      capability: "image" as const,
      displayName: "Roomy Image",
      accepts: { referenceImages: 4, referenceRoles: false, startFrame: false, endFrame: false },
      limits: { resolutions: ["1MP"] },
      pricing: { kind: "perMegapixel" as const, microUsdPerMegapixel: 30000 },
    };
    const oneSlot = { ...roomy, id: "one-slot-image", displayName: "One Slot Image",
      accepts: { referenceImages: 1, referenceRoles: false, startFrame: false, endFrame: false } };
    const world = FIXTURE_STATE.world!;
    const staged = {
      ...world,
      stagedReferences: {
        ...world.stagedReferences,
        [stagedReferenceKey("character-sheet", "maren-kest")]: "artifacts/pose-sheet.png",
      },
    };
    const at = (model: typeof roomy): string => {
      __setStateForTest({
        ...FIXTURE_STATE,
        world: staged,
        app: {
          ...FIXTURE_STATE.app,
          manifest: { ...FIXTURE_STATE.app.manifest!, models: [model, ...FIXTURE_STATE.app.manifest!.models] },
          routing: { ...FIXTURE_STATE.app.routing, defaults: { ...FIXTURE_STATE.app.routing.defaults, image: model.id } },
        },
      });
      return renderAt(`/w/${world.meta.worldId}/cast/maren-kest/model-sheet`).replace(/<!-- -->/g, "");
    };
    try {
      const tight = at(oneSlot);
      assert.match(tight, /One Slot Image carries 1 image/, "the model and its budget");
      assert.match(tight, /this one is not sent/, "and what that means for the staged image");
      assert.doesNotMatch(at(roomy), /is not sent/, "a model with room says nothing");
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  /* SPEC-017 R-23: the character-creation path says when a generation completes the set. */
  it("says the character sheet completes the reference set", () => {
    const html = renderAt(`/w/${FIXTURE_STATE.world!.meta.worldId}/cast/maren-kest/model-sheet`).replace(/<!-- -->/g, "");
    assert.match(html, /Completes Maren Kest.{0,12}s reference set/, "R-23, in the waiting copy");
  });

  it("blocks identity-dependent generation when the routed model cannot receive the main photo", () => {
    const model = {
      id: "text-only-image",
      // fal, because that is the provider the fixture has a working key for. Routed to a
      // provider with no key this would be blocked for a different reason — no key — and the
      // test would pass while proving nothing about reference support.
      provider: "fal" as const,
      capability: "image" as const,
      displayName: "Text Only Image",
      accepts: { referenceImages: 0, referenceRoles: false, startFrame: false, endFrame: false },
      limits: {},
      pricing: { kind: "perImage" as const, microUsdPerImage: 40000 },
    };
    __setStateForTest({
      ...FIXTURE_STATE,
      app: {
        ...FIXTURE_STATE.app,
        manifest: { ...FIXTURE_STATE.app.manifest!, models: [model, ...FIXTURE_STATE.app.manifest!.models] },
        routing: {
          ...FIXTURE_STATE.app.routing,
          defaults: { ...FIXTURE_STATE.app.routing.defaults, image: model.id },
        },
      },
    });
    try {
      const base = `/w/${FIXTURE_STATE.world!.meta.worldId}/cast/maren-kest`;
      const sheet = renderAt(`${base}/model-sheet`).replace(/<!-- -->/g, "");
      const looks = renderAt(`${base}/looks`).replace(/<!-- -->/g, "");
      assert.ok(sheet.includes("main photo cannot be sent"));
      assert.ok(sheet.includes("no references"), "the bar states what the model will carry");
      assert.match(sheet, /<button[^>]*disabled=""[^>]*>Generate<\/button>/);
      assert.match(looks, /<button[^>]*disabled=""[^>]*>Explore<\/button>/);
      assert.ok(!sheet.includes("translated into the prompt"));
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("grounds the main-photo prompt in the active character rather than the fixture lead", () => {
    const world = FIXTURE_STATE.world!;
    const other = {
      ...world.sheets.find((sheet) => sheet.id === "maren-kest")!,
      id: "iona-vale",
      name: "Iona Vale",
      role: "Lockkeeper",
      sections: [
        { heading: "Essence", body: "Keeps the western locks through winter." },
        { heading: "Appearance", body: "Cropped copper hair, a brass lock badge, and an ink-dark coat." },
      ],
    };
    __setStateForTest({ ...FIXTURE_STATE, world: { ...world, sheets: [...world.sheets, other] } });
    try {
      const html = renderAt(`/w/${world.meta.worldId}/cast/iona-vale/main-photo`);
      assert.ok(html.includes("Iona Vale"));
      assert.ok(html.includes("Cropped copper hair"));
      assert.ok(html.includes("Reset from character sheet"));
      assert.ok(!html.includes("Maren Kest"));
      assert.ok(!html.includes("Refine with AI"));
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("shows every pending character sheet take in deterministic order", () => {
    const world = FIXTURE_STATE.world!;
    const take = (id: string, completedAt: string) => ({
      id,
      coversShots: [],
      kind: "sheet" as const,
      reference: { sheetId: "maren-kest" },
      provider: "fal",
      model: "flux",
      provenance: { canonRevision: 42, sheets: { "maren-kest": 4 } },
      references: [],
      params: {},
      cost: { estimatedMicroUsd: 40000, actualMicroUsd: null },
      dispatchedAt: "2026-08-04T06:00:00Z",
      completedAt,
      media: "character-sheet.png",
    });
    const older = take("tk_01J8A0000000000000000000R1", "2026-08-04T06:01:00Z");
    const newer = take("tk_01J8A0000000000000000000R2", "2026-08-04T06:02:00Z");
    __setStateForTest({ ...FIXTURE_STATE, world: { ...world, referenceTakes: [older, newer] } });
    try {
      const html = renderAt(`/w/${world.meta.worldId}/cast/maren-kest/kit`);
      const text = html.replace(/<!-- -->/g, "");
      assert.ok(text.includes("2 new composites are ready for review."));
      assert.ok(html.includes(older.id) && html.includes(newer.id));
      assert.ok(html.indexOf(newer.id) < html.indexOf(older.id), "newest completion is presented first");
      assert.ok(
        html.includes(`references/maren-kest/takes/${newer.id}/character-sheet.png`),
        "the newest generated sheet is visible for review",
      );
      assert.match(html, /aria-label="View larger character sheet for Maren Kest"[^>]*aria-haspopup="dialog"/);
      assert.ok(html.includes('aria-label="Close character sheet"'));
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("shows an in-place character sheet loader while generation is active", () => {
    const world = FIXTURE_STATE.world!;
    const running = {
      id: "jb_01J8E0000000000000000000J6",
      idempotencyKey: "01J8E1000000000000000000K6",
      worldId: world.meta.worldId,
      target: { kind: "character-sheet", id: "maren-kest/g1" },
      capability: "image" as const,
      provider: "fal",
      model: "flux",
      params: { characterName: "Maren Kest" },
      estimatedMicroUsd: 40000,
      status: "running" as const,
      providerJobId: "remote-sheet-1",
      attempt: 1,
      error: null,
      createdAt: "2026-08-04T09:00:00Z",
      updatedAt: "2026-08-04T09:00:00Z",
    };
    __setStateForTest({
      ...FIXTURE_STATE,
      app: { ...FIXTURE_STATE.app, jobs: [...FIXTURE_STATE.app.jobs, running] },
    });
    try {
      const html = renderAt(`/w/${world.meta.worldId}/cast/maren-kest/kit`);
      assert.ok(html.includes("Generating character sheet for Maren Kest"));
      assert.ok(html.includes("You can leave this page"));
      assert.ok(html.includes("GENERATING"));
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("names the inherited world look on the remaining visual generation surface", () => {
    const worldId = FIXTURE_STATE.world!.meta.worldId;
    // The workspace opens on the takes now (turn 102) and the bench is behind Advanced. The
    // retired dispatch dialog no longer owns another copy of these generation settings.
    const workspace = renderAt(`/w/${worldId}/p/saltlight/generate?view=bench`);
    assert.ok(workspace.includes("World look · v"));
    assert.ok(workspace.includes("carries as text"));
  });

  it("names a production look instead of claiming the world look is inherited", () => {
    const world = FIXTURE_STATE.world!;
    __setStateForTest({
      ...FIXTURE_STATE,
      world: {
        ...world,
        productions: world.productions.map((production) =>
          production.meta.id === "saltlight"
            ? { ...production, meta: { ...production.meta, styleOverride: "Bleached documentary realism" } }
            : production,
        ),
      },
    });
    try {
      const worldId = world.meta.worldId;
      const workspace = renderAt(`/w/${worldId}/p/saltlight/generate?view=bench`);
      assert.ok(workspace.includes("Production look"));
      assert.ok(workspace.includes("Bleached documentary realism"));

      const overriddenWorld = {
        ...world,
        productions: world.productions.map((production) =>
          production.meta.id === "saltlight"
            ? {
                ...production,
                meta: { ...production.meta, styleOverride: "Bleached documentary realism" },
                scenes: production.scenes.map((record) => legacySceneView(record)).map((scene) => ({
                  ...scene,
                  shots: scene.shots.map((shot, index) =>
                    index === 0
                      ? { ...shot, promptOverride: { text: "Hand-tuned shot prompt", sheetVersions: {} } }
                      : shot,
                  ),
                })),
              }
            : production,
        ),
      };
      __setStateForTest({ ...FIXTURE_STATE, world: overriddenWorld });
      const overriddenWorkspace = renderAt(`/w/${worldId}/p/saltlight/generate?view=bench`);
      assert.ok(overriddenWorkspace.includes("Shot prompt override"));
      assert.ok(overriddenWorkspace.includes("edited by you"));
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });
});

describe("the dispatch bar (design-system turn 39)", () => {
  const tiered = {
    id: "tiered-image",
    provider: "fal" as const,
    capability: "image" as const,
    displayName: "Tiered Image",
    accepts: { referenceImages: 4, referenceRoles: false, startFrame: false, endFrame: false },
    limits: { resolutions: ["1K", "2K"], tiers: { "1K": "1K", "2K": "2K" } },
    pricing: { kind: "perImage" as const, microUsdPerImage: 50000 },
  };
  const unverified = {
    id: "unverified-image",
    provider: "fal" as const,
    capability: "image" as const,
    displayName: "Unverified Image",
    accepts: { referenceImages: 8, referenceRoles: false, startFrame: false, endFrame: false },
    limits: {},
    unverified: true,
    pricing: { kind: "perImage" as const, microUsdPerImage: 40000 },
  };

  function withModels(models: unknown[], routed: string, disabled: string[] = []) {
    __setStateForTest({
      ...FIXTURE_STATE,
      app: {
        ...FIXTURE_STATE.app,
        manifest: { ...FIXTURE_STATE.app.manifest!, models: models as never },
        models: { disabled },
    presets: [],
        routing: { ...FIXTURE_STATE.app.routing, defaults: { image: routed } },
      },
    });
  }

  it("offers only the tiers a model can reach, and disables the rest rather than hiding them", () => {
    withModels([tiered], tiered.id);
    try {
      const html = renderAt(`/w/${FIXTURE_STATE.world!.meta.worldId}/cast/maren-kest/main-photo`);
      assert.ok(html.includes(">1K<") && html.includes(">2K<"), "reachable tiers are offered");
      assert.match(html, /<button[^>]*disabled=""[^>]*>4K<\/button>/, "4K is shown, and unusable");
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("an unverified model carries nothing and says so, with no tier list to offer", () => {
    withModels([unverified], unverified.id);
    try {
      const html = renderAt(`/w/${FIXTURE_STATE.world!.meta.worldId}/cast/maren-kest/main-photo`);
      assert.ok(html.includes("UNVERIFIED"), "marked wherever it appears");
      assert.ok(html.includes("provider default"), "it declares no tiers, so none are claimed");
      assert.ok(html.includes("no references"), "the floor is stated, not the row's own claim of 8");
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("a model switched off in AI models is not offered at all", () => {
    withModels([tiered, unverified], tiered.id, [unverified.id]);
    try {
      const html = renderAt(`/w/${FIXTURE_STATE.world!.meta.worldId}/cast/maren-kest/main-photo`);
      assert.ok(html.includes("Tiered Image"));
      assert.ok(!html.includes("Unverified Image"), "switched off is not a choice");
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });
});
