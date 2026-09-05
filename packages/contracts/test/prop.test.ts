import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newId, PropSchema, ProvenanceSchema } from "../src/index.js";

/** Prop identity and the five provenance fields (design turn 105, Option C; issue 534). */
describe("props", () => {
  it("a prop is a name and ordered states; provenance is explicit about absence and optional for legacy takes", () => {
    const prop = PropSchema.parse({
      id: newId("prop"),
      name: "Polaroid",
      states: [
        { id: newId("pst"), name: "on-fridge" },
        { id: newId("pst"), name: "in-hand", reference: { id: "ref-1", file: "polaroid/in-hand.png", prompt: "held", acceptedAt: "2026-09-05T00:00:00.000Z" } },
      ],
    });
    assert.equal(prop.states.map((state) => state.name).join(","), "on-fridge,in-hand");

    const legacy = ProvenanceSchema.parse({ canonRevision: 3, sheets: {} });
    assert.equal(legacy.propStates, undefined, "a take made before props existed parses unchanged");

    const frozen = ProvenanceSchema.parse({
      canonRevision: 3,
      sheets: {},
      propStates: [
        { propId: prop.id, stateId: prop.states[0]!.id, referenceId: null, resolutionSource: "shot", overrideSource: null },
        { propId: prop.id, stateId: null, referenceId: null, resolutionSource: "unresolved", overrideSource: null },
      ],
    });
    assert.equal(frozen.propStates?.length, 2);
    assert.throws(
      () => ProvenanceSchema.parse({ canonRevision: 3, sheets: {}, propStates: [{ propId: prop.id, resolutionSource: "shot" }] }),
      "absence is written down, never left out",
    );
  });
});
