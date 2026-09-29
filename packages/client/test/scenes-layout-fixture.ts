import { stageShot, type ClientState } from "@arke-studio/contracts";
import { FIXTURE_STATE } from "./fixture-state.js";

/** The master scene, through ordinary coordinator state rather than a substitute component. */
export function scenesLayoutFixture(mode = "normal"): ClientState {
  const state = structuredClone(FIXTURE_STATE);
  const world = state.world!;
  world.proposals = [];
  const production = world.productions[0]!;
  const scene = production.scenes[0]!;
  if (!("shots" in scene)) throw new Error("Expected legacy fixture scene");
  scene.shots[0]!.description = "She leans into the dark, one hand on the rail. Below her the water has gone still enough to hear.";
  scene.shots[0]!.framing = { size: "Medium close-up", angle: "Eye level", lens: "50mm", focus: "Shallow", movement: "Slow push-in", pace: "Slow", lighting: "Blue hour", timeOfDay: "Night" };
  scene.shots[0]!.staging = stageShot(scene.shots[0]!, { cast: ["maren-kest"], sets: ["the-vigil"], durationSec: 4, aspect: "16:9" });
  scene.shots[0]!.beats = [{ span: "0–2s", text: "She listens at the rail." }, { span: "2–4s", text: "The first note rises." }];
  scene.shots.push({ id: "sh_14", number: 14, title: "Bray turns toward the quay", description: "A low note gathers beneath the water.", durationSec: 5 }, { id: "sh_15", number: 15, title: "The Vigil, still", description: "Lanterns fade across the harbour.", durationSec: 4.5 });
  scene.cast = { "maren-kest": { added: "2026-07-29T11:02:00Z" } };
  const frame = production.takes.find(t => t.kind === "frame")!;
  for (const [index, id] of ["sh_12", "sh_13", "sh_15"].entries()) {
    const take = { ...structuredClone(frame), id: `layout-frame-${index}`, coversShots: [id], media: `scene4-shot${id.slice(3)}.png` };
    production.takes.push(take);
    production.selections[id] = { acceptedTakeId: take.id, startFrameTakeId: take.id, trimInSec: 0 };
  }
  for (const [number, title] of [[1,"The harbour wakes"], [2,"Lanterns on the quay"], [3,"The long crossing"], [5,"A voice below"]] as const) {
    production.scenes.push({ ...structuredClone(scene), id: `sc_0${number}`, number, title, shots: [] });
  }
  production.scenes.sort((a,b) => a.number-b.number);
  if (mode === "empty") scene.shots = [];
  if (mode === "portrait") production.meta.aspect = "9:16";
  return state;
}
