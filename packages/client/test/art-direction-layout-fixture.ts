import { ClientStateSchema } from "@arke-studio/contracts";
import { FIXTURE_STATE } from "./fixture-state.js";

export function artDirectionLayoutFixture(mode = "normal") {
  const state = structuredClone(FIXTURE_STATE), world = state.world!;
  world.problems = []; world.externalEdits = [];
  world.artDirection.masterLook = "master-look.png";
  const proposal = structuredClone(world.proposals[0]!);
  world.proposals = [];
  world.masterLookCandidates = ["preview-a.png", "preview-b.png", "preview-c.png", "preview-d.png"];
  world.keyArtCandidates = ["key-art-a.png", "key-art-b.png"];
  if (mode === "empty") { delete world.artDirection.masterLook; world.keyArt = null; world.masterLookCandidates = []; world.keyArtCandidates = []; }
  if (mode === "long") {
    world.artDirection.description = "A very long and carefully described visual language with weathered stones and cold harbour light ".repeat(8);
    for (const entry of world.artDirection.history) entry.description = "UnbrokenHistoryTitle".repeat(20);
  }
  if (mode === "staged") {
    proposal.proposal.kind = "art-direction";
    proposal.proposal.targets = [{ path: "art-direction.json", baseVersion: world.artDirection.version, baseHash: "sha256:abcdef12" }];
    proposal.artDirection = { version: world.artDirection.version + 1, description: "Weathered maritime realism. Slate and sea-glass colour; one warm practical light.", masterLook: world.artDirection.masterLook, acceptedAt: "2026-07-30T18:00:00Z", history: world.artDirection.history, audio: world.artDirection.audio, failureModes: world.artDirection.failureModes };
    world.proposals = [proposal];
  }
  return ClientStateSchema.parse(state);
}
