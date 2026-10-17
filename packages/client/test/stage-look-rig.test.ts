import assert from "node:assert/strict";
import { it } from "node:test";
import { Scene, SpotLight, Texture, Vector3 } from "three";
import type { StageLight } from "@arke-studio/contracts";
import { StageLookRig } from "../src/screens/scene-workspace/stage-look.js";

/** The Stage's lights (issue 1825, design turn 229e): a light aimed at a set by name points at that set. */

const spot = (name: string, aim: string): StageLight => ({ name, kind: "spot", colour: "#ffd29a", strength: 8, x: 0, y: 3, z: 0, aim });

it("aims each named spot at its own set, the first light included", () => {
  const scene = new Scene();
  const rig = new StageLookRig(scene, [], () => {});
  rig.apply({ look: "lit", lights: [spot("key", "armchair"), spot("fill", "lifts")], atmosphere: undefined, plate: null });
  const sets: Record<string, Vector3> = { armchair: new Vector3(1.3, 0.4, 0.05), lifts: new Vector3(3.9, 1.2, -2.5) };
  rig.aimAt((name) => sets[name] ?? null);
  const spots: SpotLight[] = [];
  scene.traverse((object) => { if ((object as SpotLight).isSpotLight) spots.push(object as SpotLight); });
  assert.equal(spots.length, 2);
  assert.deepEqual(spots.map((light) => light.target.position.toArray()), [sets.armchair!.toArray(), sets.lifts!.toArray()]);
});

it("holds a Plate export until the plate picture can be drawn", async () => {
  const rig = new StageLookRig(new Scene(), [], () => {});
  let arrive!: () => void;
  (rig as unknown as { loader: unknown }).loader = { load: (_url: string, onLoad: (texture: Texture) => void) => { arrive = () => onLoad(new Texture()); } };
  rig.apply({ look: "plate", lights: [], atmosphere: undefined, plate: { url: "lobby.png", camera: { p: [0, 1, 5], l: [0, 1, 0], focalMm: 24 } } });
  let ready: boolean | null = null;
  void rig.whenPlateReady().then((value) => { ready = value; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ready, null, "not while the set still wears Lit materials");
  arrive();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ready, true);
  rig.apply({ look: "lit", lights: [], atmosphere: undefined, plate: null });
  assert.equal(await rig.whenPlateReady(), true, "Lit waits on nothing");
});
