import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ClientState, ManifestModel, ProviderStatus } from "@arke-studio/contracts";
import { MAX_IMAGE_PREVIEWS } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import {
  choiceForModel,
  DispatchBar,
  disabledRecipes,
  resolveModel,
  resolveOutputChoice,
  usableModels,
} from "../src/components/dispatch-bar.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * What the bar may offer, and what it must refuse to offer (Codex review rounds 1–2). Every
 * rule here has the same failure behind it: a model reaches the picker that cannot actually
 * run, the user accepts an estimate for it, and the dispatch dies — or worse, it is charged.
 */

const FAL_IMAGE: ManifestModel = {
  id: "nano-banana-2",
  provider: "fal",
  capability: "image",
  displayName: "Nano Banana 2",
  accepts: { referenceImages: 3, referenceRoles: false, startFrame: false, endFrame: false },
  limits: { tiers: { "1K": "1K", "2K": "2K" } },
  pricing: { kind: "perImage", microUsdPerImage: 80_000 },
};

const OPENAI_IMAGE: ManifestModel = {
  ...FAL_IMAGE,
  id: "gpt-image-2",
  provider: "openai",
  displayName: "GPT Image 2",
};

const provider = (id: ProviderStatus["id"], patch: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id,
  configured: true,
  validation: "valid",
  probes: [
    { capability: "image", available: true },
    { capability: "video", available: true },
  ],
  fault: null,
  ...patch,
});

const stateWith = (patch: {
  providers?: ProviderStatus[];
  disabled?: string[];
  routedImage?: string;
}): ClientState => ({
  ...FIXTURE_STATE,
  app: {
    ...FIXTURE_STATE.app,
    providers: patch.providers ?? [provider("fal")],
    manifest: {
      ...FIXTURE_STATE.app.manifest!,
      models: [...FIXTURE_STATE.app.manifest!.models, FAL_IMAGE, OPENAI_IMAGE],
    },
    models: { disabled: patch.disabled ?? [] },
    presets: [],
    routing: {
      ...FIXTURE_STATE.app.routing,
      defaults: { ...FIXTURE_STATE.app.routing.defaults, image: patch.routedImage ?? FAL_IMAGE.id },
    },
  },
});

const bar = (props: Partial<Parameters<typeof DispatchBar>[0]> = {}) =>
  renderToString(
    <MemoryRouter>
      <DispatchBar
        workflow="main-photo"
        choice={{}}
        onChoice={() => {}}
        onCancel={() => {}}
        primaryLabel="Generate"
        onPrimary={() => {}}
        {...props}
      />
    </MemoryRouter>,
  );

describe("what the picker may offer", () => {
  it("drops a model whose key was tested and rejected", () => {
    const state = stateWith({ providers: [provider("fal", { validation: "invalid" })] });
    // Stored is not the same as working. Settings already says the capability is unavailable;
    // offering its models on the next screen would contradict it.
    assert.deepEqual(usableModels(state, "image").map((m) => m.id), []);
  });

  it("drops a model whose key reports a fault", () => {
    const state = stateWith({ providers: [provider("fal", { fault: "401 from fal" })] });
    assert.deepEqual(usableModels(state, "image").map((m) => m.id), []);
  });

  it("drops a model whose probe says this capability did not unlock", () => {
    const state = stateWith({
      providers: [provider("fal", { probes: [{ capability: "image", available: false, reason: "not entitled" }] })],
    });
    assert.deepEqual(usableModels(state, "image").map((m) => m.id), []);
  });

  it("keeps a working key's models, and only that provider's", () => {
    const ids = usableModels(stateWith({}), "image").map((m) => m.id);
    assert.ok(ids.includes(FAL_IMAGE.id));
    assert.ok(!ids.includes(OPENAI_IMAGE.id), "OpenAI has no key in this state");
  });
});

describe("local recipes read the same readiness the coordinator enforces (SPEC-021 §2.12)", () => {
  const RECIPE: ManifestModel = {
    id: "comfyui-draft-image",
    provider: "comfyui",
    capability: "image",
    displayName: "Local · Draft Image",
    accepts: { referenceImages: 0, referenceRoles: false, startFrame: false, endFrame: false },
    limits: { tiers: { "1K": "1024" } },
    pricing: { kind: "unmetered" },
    requires: { vramMb: 6000 },
  };
  const withRecipe = (
    readiness: "ready" | "disabled" | "unknown" | null,
    reason?: string,
  ): ClientState => {
    const base = stateWith({});
    return {
      ...base,
      app: {
        ...base.app,
        manifest: { ...base.app.manifest!, models: [...base.app.manifest!.models, RECIPE] },
        comfyui:
          readiness === null
            ? null
            : {
                engine: {
                  source: "user-path",
                  state: readiness === "disabled" ? "ready" : "ready",
                  locality: "local",
                  location: "C:\\AI\\ComfyUI",
                  version: "0.33.1",
                  instanceId: "abc",
                  detail: null,
                  detected: [],
                },
                recipes: [
                  {
                    recipeId: RECIPE.id,
                    recipeVersion: 1,
                    displayName: RECIPE.displayName,
                    capability: "image",
                    state: readiness,
                    ...(reason !== undefined ? { reason } : {}),
                  },
                ],
                checkedAt: "2026-08-18T00:00:00.000Z",
              },
      },
    };
  };

  // What the picker DRAWS from these two functions is not asserted here: the model list is
  // behind `pickerOpen`, which starts false, and this harness is renderToString with no way to
  // click. So these cover the selection — which model is offered, which is listed disabled and
  // with what words — and the rendering of that list is genuinely uncovered.
  it("a disabled recipe leaves the usable list, and is offered separately with its measured reason (R-10)", () => {
    const state = withRecipe("disabled", "Needs 6 GB VRAM. This machine has 4 GB. Cloud image still works.");
    assert.ok(!usableModels(state, "image").some((m) => m.id === RECIPE.id));
    const rows = disabledRecipes(state, "image");
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.reason, /Needs 6 GB VRAM\. This machine has 4 GB\./);
    // Never a generic "unavailable" — the whole point of R-10.
    assert.doesNotMatch(rows[0]!.reason, /^unavailable$/i);
  });

  it("ready and unknown both dispatch — the unchecked floor is not a refusal (D15)", () => {
    assert.ok(usableModels(withRecipe("ready"), "image").some((m) => m.id === RECIPE.id));
    assert.ok(usableModels(withRecipe("unknown"), "image").some((m) => m.id === RECIPE.id));
    assert.equal(disabledRecipes(withRecipe("ready"), "image").length, 0);
  });

  it("does not offer a local recipe before its readiness snapshot arrives", () => {
    assert.equal(usableModels(withRecipe(null), "image").some((model) => model.id === RECIPE.id), false);
  });

  it("a routed default that lost readiness is shown stranded with the measured reason, never key advice", () => {
    const state = withRecipe("disabled", "2 of 3 model files missing from the models folder");
    __setStateForTest({
      ...state,
      app: { ...state.app, routing: { ...state.app.routing, defaults: { image: RECIPE.id } } },
    });
    const html = bar();
    assert.match(html, /2 of 3 model files missing/);
    assert.doesNotMatch(html, /no ComfyUI key/);
  });
});

describe("a routed default that cannot run", () => {
  it("is shown as unavailable rather than silently submitted", () => {
    __setStateForTest(stateWith({ disabled: [FAL_IMAGE.id] }));
    const html = bar();
    assert.ok(html.includes("UNAVAILABLE"), "the pill says so");
    assert.ok(html.includes("turned off in AI models"), "and names the repair");
    assert.match(html, /<button[^>]*disabled=""[^>]*>Generate<\/button>/, "and cannot be dispatched");
  });

  it("says no key when that is the reason, not turned off", () => {
    __setStateForTest(stateWith({ providers: [provider("fal")], routedImage: OPENAI_IMAGE.id }));
    const html = bar();
    assert.ok(html.includes("no OpenAI key"));
    assert.ok(!html.includes("turned off in AI models"), "the two strands are fixed in different places");
  });

  it("is not called stranded when it is simply usable", () => {
    __setStateForTest(stateWith({}));
    const html = bar();
    assert.ok(!html.includes("UNAVAILABLE"));
    assert.match(html, /<button[^>]*>Generate<\/button>/);
  });
});

describe("which model a surface will use", () => {
  const noDefault = (patch: Parameters<typeof stateWith>[0] = {}): ClientState => {
    const state = stateWith(patch);
    return { ...state, app: { ...state.app, routing: { defaults: {}, faults: [] } } };
  };

  it("with no saved default, answers with the first model that can run", () => {
    // The manifest's first image row is fal's. With only an OpenAI key, calling that a stranded
    // route would block a surface on a decision nobody made — file order is not a setting.
    const state = noDefault({ providers: [provider("openai")] });
    const resolved = resolveModel(state, "image");
    assert.equal(resolved.model?.id, OPENAI_IMAGE.id);
    assert.equal(resolved.stranded, null, "nothing was routed, so nothing is stranded");
  });

  it("strands a saved default that cannot run, and only a saved one", () => {
    const off = resolveModel(stateWith({ disabled: [FAL_IMAGE.id] }), "image");
    assert.equal(off.stranded?.id, FAL_IMAGE.id, "a saved default is shown and flagged");
    assert.equal(off.model?.id, FAL_IMAGE.id, "and still shown, never swapped");
  });

  it("an explicit choice outranks the default, and strands when it stops working", () => {
    const state = stateWith({ disabled: [OPENAI_IMAGE.id] });
    assert.equal(resolveModel(state, "image", OPENAI_IMAGE.id).stranded?.id, OPENAI_IMAGE.id);
    assert.equal(resolveModel(state, "image", FAL_IMAGE.id).stranded, null);
  });

  it("answers null when nothing at all can run", () => {
    assert.deepEqual(resolveModel(noDefault({ providers: [] }), "image"), { model: null, stranded: null });
  });
});

describe("with no model at all", () => {
  const noModels = (): ClientState => ({
    ...FIXTURE_STATE,
    app: { ...FIXTURE_STATE.app, providers: [], routing: { defaults: {}, faults: [] } },
  });

  it("keeps the explanation and the way out where the host owns actions", () => {
    __setStateForTest(noModels());
    const html = bar();
    assert.ok(html.includes("add a provider key in Settings"));
    assert.ok(html.includes("Cancel"), "a dialog without a way out is a trap");
  });

  it("draws no dead buttons where the host owns none", () => {
    __setStateForTest(noModels());
    const html = bar({ variant: "controls", onCancel: undefined, primaryLabel: undefined, onPrimary: undefined });
    assert.ok(html.includes("add a provider key in Settings"), "the reason is still said");
    assert.ok(!html.includes("Cancel"), "a Cancel with no handler does nothing but confuse");
  });
});

describe("switching model with a size already chosen", () => {
  const fourKOnly: ManifestModel = { ...FAL_IMAGE, id: "soul-2.0", limits: { tiers: { "1K": "1k", "4K": "4k" } } };

  it("drops a tier the new model cannot reach", () => {
    // 2K on Nano Banana, then a model offering 1K and 4K only: the bar falls back to 1K on
    // screen, so carrying 2K upward would plan and dispatch a size nothing was showing.
    assert.deepEqual(choiceForModel(fourKOnly, { tier: "2K" }), { modelId: "soul-2.0" });
  });

  it("keeps a tier the new model does reach", () => {
    assert.deepEqual(choiceForModel(fourKOnly, { tier: "4K" }), { modelId: "soul-2.0", tier: "4K" });
  });

  it("carries nothing when nothing was chosen", () => {
    assert.deepEqual(choiceForModel(FAL_IMAGE, {}), { modelId: FAL_IMAGE.id });
  });
});

describe("the size control", () => {
  it("is absent where the host's request cannot carry a size", () => {
    __setStateForTest(stateWith({}));
    const withSize = bar();
    const without = bar({ size: false });
    assert.ok(withSize.includes("SIZE"));
    assert.ok(!without.includes("SIZE"), "a control nothing reads is worse than none");
    assert.ok(without.includes("provider default"), "and the detail line says what will run");
  });
});

/**
 * The shape, where the model has said which shapes it takes.
 *
 * Aspect was decided for the user by provider and orientation and never offered — a 16:9 plate
 * was unreachable from any screen. It is offered here on the same terms as size: from the model's
 * own declaration, so the control can never promise a ratio the request would be refused for.
 */
describe("choosing the shape", () => {
  const SHAPED: ManifestModel = { ...FAL_IMAGE, id: "shaped-row", limits: { ...FAL_IMAGE.limits, aspects: ["16:9", "1:1"] } };
  const MUTE: ManifestModel = { ...FAL_IMAGE, id: "mute-row" };
  const shapedState = (routed: string) => {
    const base = stateWith({ routedImage: routed });
    return {
      ...base,
      app: { ...base.app, manifest: { ...base.app.manifest!, models: [...base.app.manifest!.models, SHAPED, MUTE] } },
    };
  };

  it("is not asked for unless the host wants it asked", () => {
    __setStateForTest(shapedState(SHAPED.id));
    assert.ok(!bar().includes("ASPECT"), "most surfaces have a shape the work decides");
    assert.ok(bar({ aspect: true }).includes("ASPECT"));
  });

  it("offers exactly what the model declares, in its own order", () => {
    __setStateForTest(shapedState(SHAPED.id));
    const html = bar({ aspect: true });
    const at = (value: string) => html.indexOf(`>${value}<`);
    assert.ok(at("16:9") > 0 && at("1:1") > 0, "both of this row's shapes");
    assert.ok(at("16:9") < at("1:1"), "in the order the manifest lists them");
    assert.ok(at("4:3") < 0, "and nothing it never claimed");
  });

  it("draws no control at all for a model that never said", () => {
    __setStateForTest(shapedState(MUTE.id));
    // Absent, not empty: a row with no declared shapes has not been checked, and a picker over it
    // would be inventing a capability rather than reporting one.
    assert.ok(!bar({ aspect: true }).includes("ASPECT"));
  });

  it("drops a shape the model being switched to does not take", () => {
    assert.deepEqual(choiceForModel(SHAPED, { aspect: "16:9" }), { modelId: SHAPED.id, aspect: "16:9" });
    // 4:3 is neither in this row's curated list nor either of its derived defaults, so it goes.
    assert.deepEqual(choiceForModel(SHAPED, { aspect: "4:3" }), { modelId: SHAPED.id });
    assert.deepEqual(choiceForModel(MUTE, { aspect: "4:3" }), { modelId: MUTE.id });
  });

  it("sends what the bar is showing after such a drop", () => {
    // The bug this exists to stop: the segment falls back to the new model's own default while a
    // host reading its own state still sends the old one, so the request and the screen disagree.
    assert.deepEqual(
      resolveOutputChoice(SHAPED, { aspect: "4:3" }, { aspect: true, landscape: true }),
      { tier: "1K", aspect: "16:9" },
      "an unreachable shape falls back to this row's landscape default",
    );
    // A row that offers nothing sends nothing, whatever was carried in.
    assert.deepEqual(resolveOutputChoice(MUTE, { aspect: "16:9" }, { aspect: true }), { tier: "1K" });
  });

  /*
   * The default a picker opens on is the shape that surface already produced.
   *
   * These two rows share a curated list and differ only in orientation, which is exactly the
   * case that was broken: the picker took the curated list's first entry regardless, so opening
   * a dialog and changing nothing generated a different shape than pressing Generate had.
   */
  it("opens on the shape the surface would have used anyway", () => {
    __setStateForTest(shapedState(SHAPED.id));
    // fal + per-image derives 16:9 landscape and 9:16 portrait; the curated list leads with 16:9.
    assert.equal(resolveOutputChoice(SHAPED, {}, { aspect: true, landscape: true }).aspect, "16:9");
    assert.equal(
      resolveOutputChoice(SHAPED, {}, { aspect: true, landscape: false }).aspect,
      "9:16",
      "a portrait surface opens on the portrait default, not the list's first entry",
    );
    // And the offered list leads with it, so the highlighted segment agrees.
    const portraitHtml = bar({ aspect: true, landscape: false });
    const at = (value: string) => portraitHtml.indexOf(`>${value}<`);
    assert.ok(at("9:16") > 0 && at("9:16") < at("16:9"), "the default is offered first");
  });
});

/**
 * That the model is a choice at all.
 *
 * The pill has always opened a listbox and always looked like a badge — no chevron, no count —
 * so a routed default read as a fixed property of the screen. The stylesheet had even left space
 * for a chevron that was never drawn.
 */
describe("the model reads as a choice", () => {
  it("shows the count and the chevron when there is more than one", () => {
    __setStateForTest(stateWith({ providers: [provider("fal"), provider("openai")] }));
    const html = bar();
    assert.ok(html.includes("fy-dispatchbar__chevron"), "an affordance that says it opens");
    assert.match(html, /fy-dispatchbar__more[^>]*>\d+ models/, "and how many there are");
    assert.match(html, /aria-label="Model: [^"]* · \d+ available"/, "said to the screen reader too");
  });

  it("claims neither when there is only one model to pick", () => {
    __setStateForTest(stateWith({}));
    const html = bar();
    assert.ok(!html.includes("fy-dispatchbar__chevron"), "an affordance opening a list of one is a lie");
    assert.ok(!html.includes("fy-dispatchbar__more"));
  });
});

/**
 * The three controls, on the surface that asked for them.
 *
 * Asserted through the whole composition — screen, dialog, bar — rather than on the bar alone,
 * because the bug this guards against is a host forgetting to turn a control on. The dialog is
 * the one place a picture is asked for, so it is the one place all three have to appear.
 */
describe("the standard generation dialog offers all three decisions", () => {
  const SHAPED: ManifestModel = {
    ...FAL_IMAGE,
    id: "shaped-row",
    limits: { ...FAL_IMAGE.limits, aspects: ["16:9", "1:1"] },
  };

  it("asks for the model, the size and the shape", () => {
    const base = stateWith({ routedImage: SHAPED.id });
    __setStateForTest({
      ...base,
      app: { ...base.app, manifest: { ...base.app.manifest!, models: [...base.app.manifest!.models, SHAPED] } },
    });
    const world = FIXTURE_STATE.world!;
    const html = renderToString(
      <MemoryRouter initialEntries={[`/w/${world.meta.worldId}/art-direction`]}>
        <App />
      </MemoryRouter>,
    ).replace(/<!-- -->/g, "");

    // The class prefix, not the whole attribute: a dialog showing previews carries a modifier
    // beside it, and this assertion is about which dialog it is, not how wide it is drawn.
    const at = html.indexOf('<dialog class="fy-gendialog');
    assert.ok(at > 0, "the dialog is in the document");
    const dialog = html.slice(at);
    // Sentence case in the markup; the mono eyebrow styling uppercases it.
    assert.ok(dialog.includes(">Prompt</label>"), "the words");
    assert.ok(dialog.includes("Add a reference image"), "something to look at");
    assert.ok(dialog.includes("SIZE"), "how big");
    assert.ok(dialog.includes("ASPECT"), "what shape");
    assert.ok(dialog.includes(">16:9<") && dialog.includes(">1:1<"), "this row's own shapes");
    assert.ok(dialog.includes("fy-dispatchbar__chevron"), "and the model reads as a choice");
  });
});

/**
 * The preview count, and the column it fills (design 65).
 *
 * The count is money: every preview is a separate job, separately priced and separately charged.
 * So it is asserted through the whole composition — screen, dialog, bar — the same way the other
 * three controls are, because the failure mode is a host forgetting to turn it on.
 */
describe("the dialog asks how many, and shows what came back", () => {
  const withModels = () => {
    const base = stateWith({ routedImage: FAL_IMAGE.id });
    __setStateForTest(base);
    return FIXTURE_STATE.world!;
  };

  const dialogHtml = (world: (typeof FIXTURE_STATE)["world"]): string => {
    const html = renderToString(
      <MemoryRouter initialEntries={[`/w/${world!.meta.worldId}/art-direction`]}>
        <App />
      </MemoryRouter>,
    ).replace(/<!-- -->/g, "");
    const at = html.indexOf('<dialog class="fy-gendialog');
    assert.ok(at > 0, "the dialog is in the document");
    return html.slice(at);
  };

  it("offers every count up to the cap, and no more", () => {
    const dialog = dialogHtml(withModels());
    assert.ok(dialog.includes("PREVIEWS"), "the control names what it is counting");
    for (let value = 1; value <= MAX_IMAGE_PREVIEWS; value += 1) {
      assert.ok(dialog.includes(`>${value}</button>`), `${value} is offered`);
    }
    assert.ok(!dialog.includes(`>${MAX_IMAGE_PREVIEWS + 1}</button>`), "and nothing past the cap");
  });

  it("draws the preview column beside the composer, not under it", () => {
    const dialog = dialogHtml(withModels());
    assert.ok(dialog.includes("fy-gendialog--wide"), "the dialog widens to hold both columns");
    const compose = dialog.indexOf("fy-gendialog__compose");
    const previews = dialog.indexOf("fy-gendialog__previews");
    assert.ok(compose > 0 && previews > compose, "what you ask for, then what came back");
  });

  it("says nothing has come back rather than pretending it is ready", () => {
    // The fixture world has no candidates waiting, and nothing running.
    const dialog = dialogHtml(withModels());
    assert.ok(dialog.includes("Nothing yet"));
    assert.ok(dialog.includes(">waiting<"), "and the header agrees with the body");
  });

  it("shows a candidate on the disk as a preview, and offers to keep it", () => {
    const base = stateWith({ routedImage: FAL_IMAGE.id });
    const world = FIXTURE_STATE.world!;
    __setStateForTest({
      ...base,
      world: { ...world, masterLookCandidates: ["incoming/master-look/candidate-1.png"] },
    });
    const dialog = dialogHtml({ ...world, masterLookCandidates: ["incoming/master-look/candidate-1.png"] });
    assert.ok(dialog.includes("fy-gendialog__previews-grid"), "the set is a grid, not an empty state");
    assert.ok(dialog.includes("Master look preview 1"));
    assert.ok(dialog.includes(">ready<"), "the header says so");
    assert.ok(dialog.includes("Use this · v"), "and there is a way to keep one");
  });
});
