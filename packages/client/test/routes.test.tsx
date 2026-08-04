import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { SCREENS } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

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

describe("screen inventory", () => {
  it("covers the full screen inventory (45 screens)", () => {
    assert.equal(SCREENS.length, 45);
    assert.equal(new Set(SCREENS.map((s) => s.id)).size, 45, "screen ids are unique");
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

  it("smoke-renders the root router", () => {
    const html = renderAt("/");
    // The launch screen, by what it is rather than by a wordmark: the reel, and — with nothing
    // left to fetch — a door and a version number. The progress line, the byte counts and the
    // note about where worlds live all answered "what is it doing", which nobody is asking
    // once it is done.
    assert.ok(html.includes('data-screen="launch"'), "the root route mounts the launch screen");
    assert.ok(html.includes("setup-reel.mp4"), "the reel plays while the runtimes come down");
    assert.ok(html.includes("Continue"), "and when it is ready, the way in");
    assert.ok(html.includes("fy-launch__version"), "with the version under it");
    for (const chatter of ["Setting up your studio.", "One-time setup", "everything ready"]) {
      assert.ok(!html.includes(chatter), `"${chatter}" is not shown once there is nothing to wait for`);
    }
  });

  it("renders the degraded reasons when children are unavailable (R-6)", () => {
    const html = renderAt(SCREENS.find((s) => s.id === "character-edit")!.samplePath);
    assert.ok(html.includes("OpenCode is not configured"), "harness reason is stated, not silent");
    const voiceHtml = renderAt(SCREENS.find((s) => s.id === "voice-picker")!.samplePath);
    assert.ok(voiceHtml.includes("Voxa is not configured"));
  });

  it("renders fixture content, not lorem ipsum", () => {
    const cast = renderAt(`/w/${FIXTURE_STATE.world!.meta.worldId}/cast`);
    assert.ok(cast.includes("Maren Kest"));
    const canon = renderAt(`/w/${FIXTURE_STATE.world!.meta.worldId}/canon`);
    assert.ok(canon.includes("Tide-calling"));
  });

  it("uses the accepted immutable main photo on World overview and Cast", () => {
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
      ]) {
        const html = renderAt(path);
        assert.ok(html.includes(expected), `${path} uses the accepted identity`);
        assert.ok(!html.includes("references/maren-kest/head-front.png"));
      }
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("renders the complete art-direction surface from its resolved record", () => {
    const html = renderAt(`/w/${FIXTURE_STATE.world!.meta.worldId}/art-direction`);
    for (const copy of [
      "WORLD ART DIRECTION",
      "WHAT FOLLOWS THIS LOOK",
      "NOT FOLLOWING IT",
      "HISTORY",
      "24 visual assets",
      "The Chorister",
      "Cold-water realism",
    ]) {
      assert.ok(html.includes(copy), `art direction names ${copy}`);
    }
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
      "reference set",
    ]) {
      assert.ok(generator.includes(copy), `Sheet generator states ${copy}`);
    }

    const replace = renderAt(`${base}/main-photo`);
    assert.ok(replace.includes("Replacing the main photo makes the current character sheet stale."));
    assert.ok(replace.includes("World look · v"));

    const looks = renderAt(`${base}/looks`);
    assert.ok(looks.includes("Optional visual exploration, outside the identity package."));
    assert.ok(looks.includes("Explorations do not automatically join the identity package."));
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
        manifest: { ...FIXTURE_STATE.app.manifest!, models: [first, routed, ...FIXTURE_STATE.app.manifest!.models] },
        routing: { ...FIXTURE_STATE.app.routing, defaults: { ...FIXTURE_STATE.app.routing.defaults, image: routed.id } },
      },
    });
    try {
      const base = `/w/${FIXTURE_STATE.world!.meta.worldId}/cast/maren-kest`;
      const sheet = renderAt(`${base}/model-sheet`).replace(/<!-- -->/g, "");
      const main = renderAt(`${base}/main-photo`).replace(/<!-- -->/g, "");
      const looks = renderAt(`${base}/looks`).replace(/<!-- -->/g, "");
      for (const html of [sheet, main, looks]) {
        assert.ok(html.includes("FAL · Routed Flux · refs ×4"));
        assert.ok(!html.includes("First Image"));
        assert.doesNotMatch(html, /\$0\.00/);
      }
      assert.ok(main.includes("$0.16"), "four portrait previews show four times the per-image estimate");
      assert.ok(looks.includes("$0.16"), "four looks show the same batch estimate");
      assert.ok(sheet.includes("$0.05"), "one landscape sheet shows its one-image estimate");
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("blocks identity-dependent generation when the routed model cannot receive the main photo", () => {
    const model = {
      id: "text-only-image",
      provider: "openai" as const,
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
        routing: { ...FIXTURE_STATE.app.routing, defaults: { ...FIXTURE_STATE.app.routing.defaults, image: model.id } },
      },
    });
    try {
      const base = `/w/${FIXTURE_STATE.world!.meta.worldId}/cast/maren-kest`;
      const sheet = renderAt(`${base}/model-sheet`).replace(/<!-- -->/g, "");
      const looks = renderAt(`${base}/looks`).replace(/<!-- -->/g, "");
      assert.ok(sheet.includes("main photo cannot be sent"));
      assert.ok(sheet.includes("identity conditioning unavailable"));
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
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("names the inherited world look on the remaining visual generation surfaces", () => {
    const worldId = FIXTURE_STATE.world!.meta.worldId;
    const workspace = renderAt(`/w/${worldId}/p/saltlight/generate`);
    const dispatch = renderAt(`/w/${worldId}/p/saltlight/generate/dispatch`);
    assert.ok(workspace.includes("World look · v"));
    assert.ok(workspace.includes("carries as text"));
    assert.ok(dispatch.includes("World look · v"));
    assert.ok(dispatch.includes("carried in the prompt"));
  });
});
