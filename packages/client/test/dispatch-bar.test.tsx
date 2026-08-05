import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ClientState, ManifestModel, ProviderStatus } from "@arke-studio/contracts";
import { DispatchBar, usableModels } from "../src/components/dispatch-bar.js";
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

describe("a routed default that cannot run", () => {
  it("is shown as unavailable rather than silently submitted", () => {
    __setStateForTest(stateWith({ disabled: [FAL_IMAGE.id] }));
    const html = bar();
    assert.ok(html.includes("UNAVAILABLE"), "the pill says so");
    assert.ok(html.includes("turned off in Providers"), "and names the repair");
    assert.match(html, /<button[^>]*disabled=""[^>]*>Generate<\/button>/, "and cannot be dispatched");
  });

  it("says no key when that is the reason, not turned off", () => {
    __setStateForTest(stateWith({ providers: [provider("fal")], routedImage: OPENAI_IMAGE.id }));
    const html = bar();
    assert.ok(html.includes("no OpenAI key"));
    assert.ok(!html.includes("turned off in Providers"), "the two strands are fixed in different places");
  });

  it("is not called stranded when it is simply usable", () => {
    __setStateForTest(stateWith({}));
    const html = bar();
    assert.ok(!html.includes("UNAVAILABLE"));
    assert.match(html, /<button[^>]*>Generate<\/button>/);
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
