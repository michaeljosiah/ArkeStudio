import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compilePasses, newId, planScene, type ManifestModel, type Prop, type Scene } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const MODEL: ManifestModel = {
  id: "seedance-2.0",
  provider: "fal",
  capability: "video",
  displayName: "Seedance 2.0",
  accepts: { referenceImages: 3, startFrame: true, endFrame: true },
  limits: { maxDurationSec: 15 },
  pricing: { kind: "perSecond", microUsdPerSecond: 21667 },
};

/** Prop state at dispatch (design turn 105, `stateOwner: shot-or-dispatch`; issue 536). */
describe("prop-state resolution", () => {
  it("attaches the cited state's reference, names what is unresolved, carries nothing forward, and freezes the five fields", async () => {
    const store = await WorldStore.open(await makeTempWorld(), { clock: () => "2026-09-05T10:00:00.000Z" });
    closeOnCleanup(() => store.close());
    const bundle = store.getBundle();
    const production = bundle.productions.find((p) => p.meta.id === "saltlight")!;
    const polaroid: Prop = {
      id: newId("prop"),
      name: "Polaroid",
      states: [
        {
          id: newId("pst"),
          name: "on-fridge",
          reference: { id: "psr-1", file: "takes/tk_x/first.png", acceptedAt: "2026-09-05T09:00:00.000Z" },
        },
        { id: newId("pst"), name: "in-hand" },
      ],
    };
    const lantern: Prop = { id: newId("prop"), name: "Storm Lantern", states: [{ id: newId("pst"), name: "lit" }] };
    const [onFridge, inHand] = polaroid.states;
    const scene: Scene = {
      ...production.scenes[0]!,
      shots: [
        {
          id: "sh_1",
          number: 1,
          title: "Fridge",
          description: "She looks at the @polaroid beside the @storm-lantern",
          durationSec: 4,
          propStates: [{ propId: polaroid.id, stateId: onFridge!.id }],
        },
        {
          id: "sh_2",
          number: 2,
          title: "Hand",
          description: "The @polaroid comes down",
          durationSec: 4,
          propStates: [{ propId: polaroid.id, stateId: inHand!.id }],
        },
        { id: "sh_3", number: 3, title: "Drawer", description: "The @polaroid is not where she left it", durationSec: 4 },
      ],
    };
    const input = {
      world: bundle.meta,
      productionId: "saltlight",
      sheets: bundle.sheets,
      kits: bundle.referenceKits,
      props: [polaroid, lantern],
      scene,
      selections: {},
      model: MODEL,
    };
    const plan = planScene(input, "per-shot");

    // A prop mention is not an unknown mention; the accepted reference rides, named by state.
    assert.deepEqual(plan.warnings.unknownMentions, []);
    const fridge = plan.shots[0]!;
    const propRef = fridge.bound.at(-1)!;
    assert.equal(propRef.file, `references/${polaroid.id}/takes/tk_x/first.png`);
    assert.match(propRef.rolePhrase, /Polaroid, on-fridge/);

    // Unresolved and reference-less states are named per shot; the shot still dispatches.
    assert.deepEqual(
      plan.warnings.propStates.map((w) => `${w.shotId}:${w.prop}:${w.state}:${w.issue}`),
      ["sh_1:Storm Lantern:null:unresolved", "sh_2:Polaroid:in-hand:missing-reference", "sh_3:Polaroid:null:unresolved"],
    );
    assert.equal(plan.shots[1]!.bound.some((b) => b.sheetId === polaroid.id), false, "no image stands in for a missing one");

    // The five fields, frozen into the pass the job carries; sh_3 carries nothing forward.
    const passes = compilePasses({ productionId: "saltlight", scene, plan, model: MODEL, world: bundle });
    const frozen = (index: number) => (passes[index]!.params["provenance"] as { propStates?: unknown[] }).propStates;
    assert.deepEqual(frozen(0), [
      { propId: polaroid.id, stateId: onFridge!.id, referenceId: "psr-1", resolutionSource: "shot", overrideSource: null },
      { propId: lantern.id, stateId: null, referenceId: null, resolutionSource: "unresolved", overrideSource: null },
    ]);
    assert.deepEqual(frozen(2), [
      { propId: polaroid.id, stateId: null, referenceId: null, resolutionSource: "unresolved", overrideSource: null },
    ]);

    // A one-shot override before spend is recorded as such, and the shot itself is untouched.
    const overridden = planScene({ ...input, propStateOverrides: { sh_3: { [polaroid.id]: inHand!.id } } }, "per-shot");
    assert.deepEqual(overridden.shots[2]!.propStates.map((p) => [p.stateName, p.resolutionSource, p.overrideSource]), [
      ["in-hand", "override", "manual"],
    ]);
    assert.equal(scene.shots[2]!.propStates, undefined);
  });
});
