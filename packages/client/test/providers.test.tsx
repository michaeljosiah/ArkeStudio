import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ClientState, ManifestModel } from "@arke-studio/contracts";
import { SettingsGeneralScreen, SettingsProvidersScreen } from "../src/screens/shell.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Settings · Providers, master and detail (design turn 40a), and the stranded routing it can
 * cause (40d). The rule these guard is the one that costs money when it slips: a model switched
 * off must leave the pickers, and a default pointing at it must be flagged rather than re-routed.
 */

const NANO: ManifestModel = {
  id: "nano-banana-2",
  provider: "fal",
  capability: "image",
  displayName: "Nano Banana 2",
  accepts: { referenceImages: 3, referenceRoles: false, startFrame: false, endFrame: false },
  limits: { tiers: { "1K": "1K", "2K": "2K" } },
  pricing: { kind: "perImage", microUsdPerImage: 80_000 },
};

const GPT: ManifestModel = {
  id: "gpt-image-2",
  provider: "openai",
  capability: "image",
  displayName: "GPT Image 2",
  accepts: { referenceImages: 16, referenceRoles: false, startFrame: false, endFrame: false },
  limits: { tiers: { "1K": "1024x1024" } },
  pricing: { kind: "perImage", microUsdPerImage: 40_000 },
};

const stateWith = (patch: { disabled?: string[]; faults?: ClientState["app"]["routing"]["faults"] }) => ({
  ...FIXTURE_STATE,
  app: {
    ...FIXTURE_STATE.app,
    manifest: {
      ...FIXTURE_STATE.app.manifest!,
      models: [...FIXTURE_STATE.app.manifest!.models, NANO, GPT],
    },
    models: { disabled: patch.disabled ?? [] },
    recipes: [],
    routing: {
      defaults: FIXTURE_STATE.app.routing.defaults,
      faults: patch.faults ?? [],
    },
  },
});

const providers = () =>
  renderToString(
    <MemoryRouter>
      <SettingsProvidersScreen />
    </MemoryRouter>,
  );

const cloudAi = () =>
  renderToString(
    <MemoryRouter>
      <SettingsGeneralScreen />
    </MemoryRouter>,
  );

describe("Settings · Providers, one provider at a time", () => {
  it("shows one provider's models, not every provider's", () => {
    __setStateForTest(stateWith({}));
    const html = providers();
    assert.ok(html.includes("Nano Banana 2"), "the selected provider's models are listed");
    assert.ok(!html.includes("GPT Image 2"), "another provider's models are not");
  });

  it("opens on a connected provider, because a pane with no key answers nothing", () => {
    // fal has the fixture's only key but is also first in the rail, so it proves nothing on its
    // own. Push it to keyless and give OpenAI the key: the pane must follow the key.
    const base = stateWith({});
    __setStateForTest({
      ...base,
      app: {
        ...base.app,
        providers: [
          { id: "fal", configured: false, validation: "untested", probes: [], fault: null },
          { id: "openai", configured: true, validation: "valid", probes: [], fault: null },
        ],
      },
    });
    const html = providers();
    assert.ok(html.includes("GPT Image 2"), "the pane opened on the provider that has a key");
    assert.ok(!html.includes("Nano Banana 2"));
  });

  it("counts how many of how many, so a key's offer is a number", () => {
    __setStateForTest(stateWith({}));
    assert.ok(providers().includes("2 OF 2 ON"));
    __setStateForTest(stateWith({ disabled: ["nano-banana-2"] }));
    assert.ok(providers().includes("1 OF 2 ON"));
  });

  it("does not call a keyless provider's models on, in the rail or the pane", () => {
    // The switches below are disabled and the rail says "—"; a pane reading "2 OF 2 ON" two
    // inches away describes models that cannot appear in any picker.
    const base = stateWith({});
    __setStateForTest({ ...base, app: { ...base.app, providers: [] } });
    const html = providers();
    assert.ok(!/\dOF|OF \d+ ON/.test(html.replace(/<[^>]+>/g, "")), "no on-count without a key");
    assert.ok(html.includes("UNAVAILABLE"));
  });

  it("does not offer models the key cannot reach, capability by capability", () => {
    // A key can authenticate and still not do images. The pickers already exclude those rows;
    // the pane counted them ON and let them be switched, which is the same contradiction in the
    // other direction.
    const base = stateWith({});
    __setStateForTest({
      ...base,
      app: {
        ...base.app,
        providers: [
          {
            id: "fal",
            configured: true,
            validation: "valid",
            probes: [
              { capability: "image", available: false, reason: "not entitled" },
              { capability: "video", available: true },
            ],
            fault: null,
          },
        ],
      },
    });
    const html = providers();
    // The fixture's fal rows are one video model plus the two image models added above.
    assert.ok(html.includes("1 OF 2 ON"), "only the video row counts as on");
    assert.ok(html.includes("1 on"), "and the rail agrees with the pane");
  });

  it("says an em dash, not a count, for a provider with no key", () => {
    __setStateForTest(stateWith({}));
    const html = providers();
    const openai = html.slice(html.indexOf("OpenAI"));
    assert.ok(openai.includes("—"), "no key means the question of how many are on does not arise");
  });

  it("prices each model in the unit it is billed in", () => {
    __setStateForTest(stateWith({}));
    const html = providers();
    assert.ok(html.includes("$0.08"), "per image");
    assert.ok(html.includes("$0.02 / second"), "per second, because a bare figure would mislead");
  });

  it("leaves a keyless provider's switches inert rather than offering a choice that cannot run", () => {
    const base = stateWith({});
    __setStateForTest({ ...base, app: { ...base.app, providers: [] } });
    const html = providers();
    assert.ok(html.includes("become switchable once it is connected"), "the reason is said, not implied");
    const upToFirstSwitch = html.slice(0, html.indexOf("fy-prov__switch"));
    const button = upToFirstSwitch.slice(upToFirstSwitch.lastIndexOf("<button"));
    assert.ok(button.includes("disabled"), "and the switch itself cannot be thrown");
  });
});

describe("Cloud AI, when a routed model is switched off", () => {
  const STRANDED = {
    ...FIXTURE_STATE.app.routing,
    faults: [
      {
        capability: "video" as const,
        modelId: "seedance-2.0",
        reason: "Seedance 2.0 is routed here but switched off in Providers — pick another model, or turn it back on",
      },
    ],
  };

  it("flags the strand at the top and names the repair", () => {
    __setStateForTest(stateWith({ disabled: ["seedance-2.0"], faults: STRANDED.faults }));
    const html = cloudAi();
    assert.ok(html.includes("has nowhere to go"));
    assert.ok(html.includes("turn it back on"));
  });

  it("says turned off, not needs a key — the two strands have different repairs", () => {
    __setStateForTest(stateWith({ disabled: ["seedance-2.0"], faults: STRANDED.faults }));
    const html = cloudAi();
    assert.ok(html.includes("turned off in Providers"));
    assert.ok(!html.includes("fal has no key"), "fal has a key; the model is simply off");
  });

  it("never re-routes: the switched-off model is still what the row shows", () => {
    __setStateForTest(stateWith({ disabled: ["seedance-2.0"], faults: STRANDED.faults }));
    const html = cloudAi();
    assert.ok(html.includes("Seedance 2.0"), "shown, flagged, and left exactly where it was");
  });
});
