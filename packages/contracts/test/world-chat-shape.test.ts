import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CandidateEvidenceSchema,
  ModelCandidateDraftSchema,
  ModelCandidateOperationSchema,
  ModelGroupOperationSchema,
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

  it("every operation example parses", () => {
    for (const [op, example] of Object.entries(WORLD_CHAT_SHAPE_EXAMPLES.operations)) {
      const parsed = ModelCandidateOperationSchema.safeParse(example);
      assert.ok(parsed.success, `${op} operation example: ${parsed.success ? "" : parsed.error.message}`);
    }
    const group = ModelGroupOperationSchema.safeParse(WORLD_CHAT_SHAPE_EXAMPLES.groupOperation);
    assert.ok(group.success, `group operation example: ${group.success ? "" : group.error.message}`);
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
});
