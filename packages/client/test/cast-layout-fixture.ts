import { ClientStateSchema } from "@arke-studio/contracts";
import { FIXTURE_STATE } from "./fixture-state.js";

export function castLayoutFixture() {
  const state = structuredClone(FIXTURE_STATE);
  const world = state.world!;
  world.proposals = []; world.problems = []; world.externalEdits = [];
  const character = world.sheets[0]!;
  character.sections = [
    { heading: "Essence", body: "A tide-caller who hears the harbour's memory. Keeps her own counsel, and makes the boats come home." },
    { heading: "Appearance", body: "Salt-crusted braids, pale grey eyes. A dark oilskin coat with copper fastenings, worn soft at the cuffs." },
    { heading: "Relationships", body: "Oren taught her the old soundings. The Ebb Council calls her when the water will not answer." },
    { heading: "Voice · written", body: "Low and even. Speaks to the water before she speaks to people." },
  ];
  character.voice = { provider: "kokoro", model: "kokoro-82m", voiceId: "bf_emma", label: "Low tide", assignedAtVersion: 4 };
  for (const [i, name] of ["Oren Voss", "The Chorister", "Ada Rook", "Ilya Flint", "Nessa Vale", "Tomas Reed", "The Bell Keeper"].entries()) {
    world.sheets.push({ ...structuredClone(character), id: `character-${i}`, name, status: i === 6 ? "sketch" : "locked" });
  }
  const location = world.sheets.find(s => s.type === "location")!;
  const faction = world.sheets.find(s => s.type === "faction")!;
  for (let i = 0; i < 3; i++) {
    world.sheets.push({ ...structuredClone(location), id: `place-${i}`, name: ["The Drowned Quarter", "Saltmarket", "Bellwater Steps"][i]! });
    world.sheets.push({ ...structuredClone(faction), id: `faction-${i}`, name: ["The Watch", "Harbour Guild", "The Callers"][i]! });
  }
  world.props = ["The bell", "Polaroid", "Compass", "Old key"].map((name, i) => ({ id: `prop_01J8P0000000000000000000P${i}`, name, states: [] }));
  return ClientStateSchema.parse(state);
}
