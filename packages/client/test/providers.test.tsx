import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ClientState, ManifestModel } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { SettingsGeneralScreen } from "../src/screens/shell.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Settings · Providers holds the credential, AI models holds the models (SPEC-042). The rule
 * these guard is the one that costs money when it slips: a model switched off must leave the
 * pickers, and a default pointing at it must be flagged rather than re-routed — and the one that
 * cost the previous split its life: a credential's remedy is rendered on the model's own
 * surface, never as a route back to Providers (R-4).
 */

const HERE = dirname(fileURLToPath(import.meta.url));

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

const at = (path: string) =>
  renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

const providers = (path = "/settings/providers") => at(path);
const models = (path = "/settings/models?half=cloud&kind=image") => at(path);

const cloudAi = () =>
  renderToString(
    <MemoryRouter>
      <SettingsGeneralScreen />
    </MemoryRouter>,
  );

/** SSR splits a text node at every interpolation, so a rendered string is checked without them. */
const plain = (html: string): string => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ");

/** One supplier's section on AI models, from its heading to the next. */
function sectionFor(html: string, name: string): string {
  const marker = 'data-testid="models-section"';
  let start = html.indexOf(marker);
  while (start !== -1) {
    const next = html.indexOf(marker, start + 1);
    const section = html.slice(start, next === -1 ? undefined : next);
    if (section.includes(`>${name}<`)) return section;
    start = next;
  }
  throw new Error(`no section for ${name}`);
}

describe("Providers holds the credential (SPEC-042 R-3, R-9, R-18)", () => {
  it("carries no model, and says one line about them", () => {
    __setStateForTest(stateWith({}));
    const html = providers("/settings/providers?provider=fal");
    assert.match(html, /data-screen="settings-providers"/);
    assert.doesNotMatch(html, /role="switch"/, "the switch is on AI models");
    assert.doesNotMatch(html, /Nano Banana 2/, "and so is the model");
    // The fixture's fal rows are one video model plus the image model added above.
    assert.match(plain(html), /2 FAL models, 2 of them on\.\s+AI models/);
  });

  it("opens on a connected provider, because a pane with no key answers nothing", () => {
    // fal has the fixture's only key but is also first in the column, so it proves nothing on
    // its own. Push it to keyless and give OpenAI the key: the pane must follow the key.
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
    const pane = providers().slice(providers().indexOf('data-testid="provider-pane"'));
    assert.match(plain(pane), /OpenAI\s+Language, Images\s+connected/);
  });

  it("notes only what needs attention beside a name in the column", () => {
    __setStateForTest(stateWith({}));
    const html = providers();
    const column = html.slice(0, html.indexOf('data-testid="provider-pane"'));
    // fal is connected and says nothing beside its name; OpenAI has no key and says so.
    assert.doesNotMatch(column, /FAL<\/span><span class="fy-src__note"/);
    assert.match(column, /OpenAI<\/span><span class="fy-src__note">no key/);
    assert.match(column, /Higgsfield<\/span><span class="fy-src__note">not signed in/);
  });

  it("acts on a fact with a button that says its verb, never an icon alone", () => {
    __setStateForTest(stateWith({}));
    const html = providers("/settings/providers?provider=fal");
    for (const verb of ["Replace", "Remove", "Test again"]) {
      assert.match(html, new RegExp(`class="fy-act[^"]*"[^>]*><svg[^>]*>[\\s\\S]*?</svg><span>${verb}</span>`), verb);
    }
  });

  it("keeps the engine's machinery, and states its models as a count", () => {
    __setStateForTest(stateWith({}));
    const html = plain(providers("/settings/providers?provider=voxa"));
    assert.match(html, /THIS MACHINE/);
    assert.match(html, /Downloads/);
    assert.doesNotMatch(html, /role="switch"/);
  });
});

describe("AI models holds the switch (SPEC-042 R-4, R-8, R-12, R-13)", () => {
  it("draws every kind at once, in its half, with its count", () => {
    __setStateForTest(stateWith({}));
    const html = models("/settings/models");
    assert.match(html, /data-screen="settings-models"/);
    const column = plain(html.slice(0, html.indexOf('class="fy-cols__pane"')));
    assert.match(column, /Cloud\s+Images\s+2\s+Video\s+1/);
  });

  it("groups one kind's models by who supplies them, in the column's order", () => {
    __setStateForTest(stateWith({}));
    const html = models();
    assert.match(sectionFor(html, "FAL"), /Nano Banana 2/);
    assert.match(sectionFor(html, "OpenAI"), /GPT Image 2/);
    assert.ok(html.indexOf(">FAL<") < html.indexOf(">OpenAI<"), "fal before OpenAI, as Providers lists them");
    assert.doesNotMatch(sectionFor(html, "FAL"), /GPT Image 2/, "and not under the wrong supplier");
  });

  it("counts how many of how many at the supplier's heading, so a key's offer is a number", () => {
    __setStateForTest(stateWith({}));
    assert.match(plain(sectionFor(models(), "FAL")), /1 of 1 on/);
    __setStateForTest(stateWith({ disabled: ["nano-banana-2"] }));
    assert.match(plain(sectionFor(models(), "FAL")), /0 of 1 on/);
  });

  it("draws an image model as a tile with a switch, and a switched-off one as a ghost", () => {
    __setStateForTest(stateWith({}));
    const on = sectionFor(models(), "FAL");
    assert.match(on, /data-testid="model-tile"/);
    assert.match(on, /role="switch"[^>]*aria-checked="true"/);
    assert.doesNotMatch(on, /fy-mtile--out/);
    __setStateForTest(stateWith({ disabled: ["nano-banana-2"] }));
    const off = sectionFor(models(), "FAL");
    assert.match(off, /fy-mtile--out/, "off keeps the picture at reduced weight");
    assert.match(off, /role="switch"[^>]*aria-checked="false"/);
    assert.match(off, /Nano Banana 2/, "and is never hidden");
  });

  it("carries the credential's remedy at the heading of a supplier with no key, and leaves its switches inert", () => {
    __setStateForTest(stateWith({}));
    const openai = sectionFor(models(), "OpenAI");
    assert.match(openai, /class="fy-by__fix"[^>]*>Add a key</, "the remedy, once, at the heading");
    assert.doesNotMatch(openai, /\d of \d on/, "no on-count without a key");
    const button = openai.slice(openai.indexOf("<button"), openai.indexOf("</button>"));
    assert.match(openai.slice(openai.indexOf('role="switch"') - 200, openai.indexOf('role="switch"') + 200), /disabled/);
    assert.ok(button.length > 0);
  });

  it("names the sign-in, not a key, for a supplier whose credential is external (issue 137)", () => {
    const base = stateWith({});
    __setStateForTest({
      ...base,
      app: {
        ...base.app,
        manifest: {
          ...base.app.manifest,
          models: [
            ...base.app.manifest.models,
            { ...GPT, id: "soul", provider: "higgsfield", displayName: "Higgsfield Soul" },
          ],
        },
      },
    });
    assert.match(sectionFor(models(), "Higgsfield"), /class="fy-by__fix"[^>]*>Sign in</);
  });

  it("renders the remedy in place, never as a route to Providers (R-4)", async () => {
    // The previous split died of exactly this: Cloud AI shipped an `Open Providers` button
    // because the switch it filtered by lived on another tab. Asserted on the source, because
    // a navigation is a thing the render cannot show and a reviewer would have to spot.
    const source = await readFile(join(HERE, "..", "src", "screens", "settings-models.tsx"), "utf8");
    assert.doesNotMatch(source, /navigate\(["'`]\/settings\/providers/);
    assert.match(source, /ProviderKeyLine/, "the key row is Providers' own component, drawn here");
    assert.match(source, /ProviderToolLine/, "and so is the sign-in row");
  });

  it("does not offer models the key cannot reach, capability by capability", () => {
    // A key can authenticate and still not do images. The pickers already exclude those rows;
    // the section must not count them on or let them be switched.
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
    const image = sectionFor(models("/settings/models?half=cloud&kind=image"), "FAL");
    assert.match(image, /Not unlocked by this key/);
    assert.doesNotMatch(image, /\d of \d on/);
    const video = sectionFor(models("/settings/models?half=cloud&kind=video"), "FAL");
    assert.match(plain(video), /1 of 1 on/, "the capability the key does unlock still counts");
  });

  it("prices each model in the unit it is billed in", () => {
    __setStateForTest(stateWith({}));
    assert.match(models(), /\$0\.08/, "per image");
    assert.match(models("/settings/models?half=cloud&kind=video"), /\$0\.02 \/ second/, "per second, because a bare figure would mislead");
  });

  it("lands a remedy that names a model on that model's kind (R-21)", () => {
    __setStateForTest(stateWith({}));
    const html = models("/settings/models?model=seedance-2.0");
    assert.match(plain(html.slice(html.indexOf('class="fy-cols__pane"'))), /Video\s+Cloud/);
    assert.match(html, /Seedance 2\.0/);
  });
});

describe("General, when a routed model is switched off", () => {
  const STRANDED = {
    ...FIXTURE_STATE.app.routing,
    faults: [
      {
        capability: "video" as const,
        modelId: "seedance-2.0",
        reason: "Seedance 2.0 is routed here but switched off in AI models — pick another model, or turn it back on",
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
    assert.ok(html.includes("turned off in AI models"));
    assert.ok(!html.includes("fal has no key"), "fal has a key; the model is simply off");
  });

  it("never re-routes: the switched-off model is still what the row shows", () => {
    __setStateForTest(stateWith({ disabled: ["seedance-2.0"], faults: STRANDED.faults }));
    const html = cloudAi();
    assert.ok(html.includes("Seedance 2.0"), "shown, flagged, and left exactly where it was");
  });
});
