import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mentionSpans, newId, parseMentions, PropSchema, ProvenanceSchema, withoutMention } from "../src/index.js";

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

  it("a prop uncited by its chip loses its mention by the parser's own grammar, wherever it sits (SPEC-036 R-10)", () => {
    // `@car` is never the start of `@carter`, and punctuation is as good a boundary as a space.
    assert.equal(withoutMention("@car and @carter, (@car) again", "car"), "and @carter, () again");
    assert.equal(withoutMention("@carter only", "car"), "@carter only");
    assert.equal(withoutMention("The @the-vigil at dusk", "the-vigil"), "The at dusk");
    for (const text of ["(@car)", "@car, then", "then @car"]) {
      assert.ok(parseMentions(text).includes("car"), `${text} cites the prop`);
      assert.ok(!parseMentions(withoutMention(text, "car")).includes("car"), `${text} no longer does`);
    }
  });

  it("the spans a screen draws are the mentions the parser reads, in place (issue 1114)", () => {
    const text = "(@car) beside @the-vigil, @car again; @Car and @ never";
    assert.deepEqual(mentionSpans(text), [
      { slug: "car", start: 1, end: 5 },
      { slug: "the-vigil", start: 14, end: 24 },
      { slug: "car", start: 26, end: 30 },
    ]);
    assert.deepEqual(parseMentions(text), ["car", "the-vigil"]);
    assert.deepEqual(mentionSpans("no mention here"), []);
  });
});
