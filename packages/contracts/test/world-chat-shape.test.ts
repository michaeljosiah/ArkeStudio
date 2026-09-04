import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CandidateEvidenceSchema,
  ModelCandidateDraftSchema,
  ModelCandidateOperationSchema,
  ModelGroupOperationSchema,
  SHEET_SHAPES,
  type SheetKind,
  WorldChangeClassificationSchema,
  WorldChatTurnResultSchema,
  WORLD_CHAT_SHAPE_EXAMPLES,
  worldChatResultShapeGuide,
} from "../src/index.js";

/**
 * The shape the model is shown is the shape the coordinator accepts (#70 §8.3).
 *
 * The first live World Chat turn failed deterministically because these two could drift: the
 * brief described an envelope, the strict schema demanded fields the brief never named, and no
 * answer could ever validate. The guide is rendered from the example objects below, so holding
 * every example to its schema holds the prompt to the validator. If a test here fails, the model
 * is being taught a shape the app will reject — fix the example and the guide together.
 */

describe("the shape guide's examples satisfy the schemas they teach", () => {
  it("every evidence example parses", () => {
    for (const [kind, example] of Object.entries(WORLD_CHAT_SHAPE_EXAMPLES.evidence)) {
      const parsed = CandidateEvidenceSchema.safeParse(example);
      assert.ok(parsed.success, `${kind} evidence example: ${parsed.success ? "" : parsed.error.message}`);
    }
  });

  it("the message evidence example obeys the offset rule it teaches", () => {
    const example = WORLD_CHAT_SHAPE_EXAMPLES.evidence.message;
    assert.equal(
      example.end - example.start,
      example.quote.length,
      "the example models quote === text.slice(start, end); an example that breaks its own rule teaches the break",
    );
  });

  it("every classification has a draft example, and each parses", () => {
    assert.deepEqual(
      Object.keys(WORLD_CHAT_SHAPE_EXAMPLES.drafts).sort(),
      [...WorldChangeClassificationSchema.options].sort(),
      "a classification without an example is one the model is told exists and never shown",
    );
    for (const [classification, draft] of Object.entries(WORLD_CHAT_SHAPE_EXAMPLES.drafts)) {
      const parsed = ModelCandidateDraftSchema.safeParse(draft);
      assert.ok(parsed.success, `${classification} draft example: ${parsed.success ? "" : parsed.error.message}`);
    }
  });

  /*
   * Parsing is not enough for a section heading, and that gap cost a real edit.
   *
   * `SectionSchema` takes any string up to 120 characters, so "History" on a character sheet
   * parsed, rendered into the guide, and taught the model a heading no sheet has. `sheetBody`
   * writes the shape's headings and only those, so the section was dropped — after the
   * proposition had been materialised, staged, accepted, versioned and change-logged, leaving a
   * sheet that said exactly what it said before (`king-s-daughter` / `adaeze-working-name`,
   * 2026-08-23). The schema could not catch it; only the shape table can.
   */
  it("every section heading an example teaches is one the sheet shape actually has", () => {
    const kindOf = (draft: Record<string, unknown>): SheetKind | undefined => {
      const payload = (draft["draft"] ?? {}) as Record<string, unknown>;
      if (draft["classification"] === "sheet.create") return payload["type"] as SheetKind;
      return (draft["target"] as { sheetKind?: SheetKind } | undefined)?.sheetKind;
    };
    for (const [classification, example] of Object.entries(WORLD_CHAT_SHAPE_EXAMPLES.drafts)) {
      if (classification !== "sheet.create" && classification !== "sheet.edit") continue;
      const draft = example as unknown as Record<string, unknown>;
      const kind = kindOf(draft);
      assert.ok(kind, `${classification} example names no sheet kind`);
      const headings = SHEET_SHAPES[kind].sections.map((s) => s.heading);
      const sections = ((draft["draft"] as Record<string, unknown>)["sections"] ?? []) as Array<{ heading: string }>;
      for (const section of sections) {
        assert.ok(
          headings.includes(section.heading),
          `${classification} teaches "${section.heading}", which a ${kind} does not have — it would be written nowhere. Use one of: ${headings.join(", ")}`,
        );
      }
    }
  });

  it("the guide names the headings each kind of sheet has", () => {
    const guide = worldChatResultShapeGuide();
    for (const shape of Object.values(SHEET_SHAPES)) {
      for (const section of shape.sections) {
        assert.ok(
          guide.includes(`"${section.heading}"`),
          `the guide never names ${shape.type}'s "${section.heading}", so a model has to guess it`,
        );
      }
    }
  });

  it("every operation example parses", () => {
    for (const [op, example] of Object.entries(WORLD_CHAT_SHAPE_EXAMPLES.operations)) {
      const parsed = ModelCandidateOperationSchema.safeParse(example);
      assert.ok(parsed.success, `${op} operation example: ${parsed.success ? "" : parsed.error.message}`);
    }
    const group = ModelGroupOperationSchema.safeParse(WORLD_CHAT_SHAPE_EXAMPLES.groupOperation);
    assert.ok(group.success, `group operation example: ${group.success ? "" : group.error.message}`);
  });

  it("accepts a temporary same-turn link on a Canon amendment", () => {
    const example = structuredClone(WORLD_CHAT_SHAPE_EXAMPLES.drafts["canon.amend"]) as unknown as {
      draft: { links: unknown[] };
    };
    example.draft.links = [{ kind: "pending-entity", ref: { temporaryId: "t1" } }];
    assert.doesNotThrow(() => ModelCandidateDraftSchema.parse(example));
  });

  it("the complete result example parses", () => {
    const parsed = WorldChatTurnResultSchema.safeParse(WORLD_CHAT_SHAPE_EXAMPLES.turnResult);
    assert.ok(parsed.success, parsed.success ? "" : parsed.error.message);
  });
});

describe("the rendered guide", () => {
  const guide = worldChatResultShapeGuide();

  it("shows every classification's payload", () => {
    for (const classification of WorldChangeClassificationSchema.options) {
      assert.ok(guide.includes(`"classification":"${classification}"`), `guide shows ${classification}`);
    }
  });

  it("shows the complete result and the evidence kinds as real JSON", () => {
    assert.ok(guide.includes(JSON.stringify(WORLD_CHAT_SHAPE_EXAMPLES.evidence.message)));
    assert.ok(guide.includes(JSON.stringify(WORLD_CHAT_SHAPE_EXAMPLES.evidence.world)));
    assert.ok(guide.includes(JSON.stringify(WORLD_CHAT_SHAPE_EXAMPLES.evidence.attachment)));
    assert.ok(guide.includes(JSON.stringify(WORLD_CHAT_SHAPE_EXAMPLES.turnResult, null, 1)));
  });

  it("states the rules the validator actually enforces", () => {
    assert.match(guide, /no markdown fences/, "fenced JSON fails JSON.parse before anything else runs");
    assert.match(guide, /\[msg_\.\.\.\]/, "message ids are cited from the conversation, never invented");
    assert.match(guide, /end exclusive/, "offsets are the exact slice the verifier takes");
  });

  it("says Bible, scene and timeline changes wait for permission", () => {
    assert.match(guide, /Each edit is shown on a permission card/);
    assert.match(guide, /scene edit proposes a rename on a permission card/);
    assert.match(guide, /editor request prepares exact timeline commands for a permission card/);
    assert.doesNotMatch(guide, /lands at once|land immediately|no accept step/);
  });

  /**
   * Each of these is a rule the model cannot discover by trying: the turn either fails whole, or
   * — worse, before the intent rule moved into the validator — succeeds and is dropped at wrap-up.
   */
  it("states that intent evidence is required and cannot be substituted", () => {
    assert.match(guide, /"purpose": "intent"/, "the required purpose is named");
    assert.match(guide, /no other kind substitutes/, "and that supporting evidence does not stand in");
  });

  /**
   * The one classification a model will reach past without being told to.
   *
   * "Make the world painterly" reads like a fact about the world, and canon.create accepts it
   * happily — which is how a real conversation produced a Canon entry titled "Visual art
   * direction" that was accepted, applied, and read by nothing that generates an image. The world
   * looked exactly as it had. Choosing between the two is not something the schema can enforce,
   * so the guide has to say it outright.
   */
  it("sends a change of look to the world look, not to Canon", () => {
    assert.match(guide, /"classification":"art-direction\.change"/);
    assert.match(guide, /never canon\.create/, "the wrong-but-plausible choice is named");
    assert.match(guide, /changes nothing anyone can see/, "and why it is wrong is said, not implied");
  });

  it("says the Studio's own replies are never evidence", () => {
    assert.match(guide, /never cite your own replies/);
  });

  it("says where an attachment's id and hash come from", () => {
    assert.match(guide, /What they handed you/, "the section that prints them");
    assert.match(guide, /Copy both exactly/);
  });

  /**
   * A payload enum the guide shows only one value of is a field the model has to guess at — the
   * same deterministic schema failure the guide exists to remove, one field further in.
   */
  it("spells out every payload enum, not only the one the example happens to use", () => {
    for (const value of ["add", "remove", "unchanged"]) {
      assert.ok(guide.includes(value), `linkAction option ${value} is named`);
    }
    for (const value of ["world-key-art", "character-main-photo", "character-look"]) {
      assert.ok(guide.includes(value), `image purpose option ${value} is named`);
    }
    for (const value of ["image", "video", "concept-image", "concept-video", "shot-video"]) {
      assert.ok(guide.includes(value), `media option ${value} is named`);
    }
  });

  it("keeps old image opportunities readable", () => {
    const legacy = structuredClone(WORLD_CHAT_SHAPE_EXAMPLES.drafts["media.image-opportunity"]) as Record<string, unknown>;
    const draft = legacy["draft"] as Record<string, unknown>;
    delete draft["medium"];
    const parsed = ModelCandidateDraftSchema.parse(legacy);
    assert.equal(parsed.classification, "media.image-opportunity");
    if (parsed.classification === "media.image-opportunity") assert.equal(parsed.draft.medium, "image");
  });

  /**
   * An example is one instance, not the limit of the shape. Without the catalogue, a model asked
   * to rename a sheet or clear its role reads a sheet.edit example carrying only `sections` and
   * has to guess a field name — the whole-turn rejection this guide exists to prevent.
   */
  it("lists every field a draft accepts, not only the ones its example uses", () => {
    for (const field of ["name", "role", "billing", "region", "canonRules", "links", "sections"]) {
      assert.ok(guide.includes(field), `sheet.edit field ${field} is named`);
    }
    assert.match(guide, /or null to clear it/, "and says which may be nulled rather than omitted");
    assert.match(guide, /optional/);
  });

  it("renders the split operation whole, since one wrong field rejects the turn", () => {
    assert.ok(guide.includes(JSON.stringify(WORLD_CHAT_SHAPE_EXAMPLES.operations.split)));
  });

  it("says which units an offset is counted in", () => {
    assert.match(guide, /UTF-16 code units/, "String.slice indexes code units, not code points");
  });

  it("says where a world citation's version, hash and receipt id come from", () => {
    assert.match(guide, /checkReceiptId/, "the citation block beside every tool result");
    assert.match(guide, /citable/);
    assert.match(guide, /Never invent one/, "an invented receipt is refused as foreign");
  });
});

/**
 * A nested field says its type, not just its name (driven 2026-08-22).
 *
 * `continuity ({openOnPrevious, keepOut}, optional)` told the story author what the key is called
 * and nothing about what goes in it. Writing a season, it filled the boolean with a sentence
 * describing what the shot opens on — and the whole turn was refused after all the work was done,
 * with no way for the model to have known better from the guide it was given.
 */
describe("nested shapes in the guide", () => {
  const guide = worldChatResultShapeGuide();

  it("gives every key in a nested object a type", () => {
    assert.match(
      guide,
      /continuity \(\{openOnPrevious: boolean\?, continuesPrevious: boolean\?, keepOut: string\?\}/,
    );
    assert.match(guide, /beats \(array of \{span: string, text: string\}/);
  });

  it("leaves no nested object rendered as bare names", () => {
    // The failure this protects against is a shape that reads as a list of words. Any brace group
    // holding two or more comma-separated bare identifiers is that shape coming back.
    const bare = [...guide.matchAll(/\{([a-zA-Z]+(?:, [a-zA-Z]+)+)\}/g)].map((m) => m[0]);
    assert.deepEqual(bare, [], `these say names without types: ${bare.join(" | ")}`);
  });

  it("stays a guide rather than becoming a schema dump", () => {
    assert.ok(guide.length < 26_000, `the shape guide is ${guide.length} characters`);
  });
});
