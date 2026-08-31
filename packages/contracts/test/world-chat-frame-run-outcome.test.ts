import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  newId,
  WorldChatStoredEventSchema,
  WorldChatTranscriptMessageSchema,
} from "../src/index.js";

const AT = "2026-08-31T12:00:00.000Z";

describe("frame-run conversation outcomes", () => {
  it("keeps only the causal frame-run anchor in the durable event and transcript", () => {
    const runId = newId("fr");
    const message = {
      id: newId("msg"),
      turnId: newId("turn"),
      role: "studio" as const,
      text: "The frame run finished with frames filed for 3 shots.",
      attachmentIds: [],
      createdAt: AT,
    };
    const report = { runId, productionId: "saltlight", sceneId: "sc_04" };
    const event = WorldChatStoredEventSchema.parse({
      type: "frame-run.outcome-recorded",
      message,
      report,
    });
    assert.deepEqual(event, { type: "frame-run.outcome-recorded", message, report });
    assert.deepEqual(
      WorldChatTranscriptMessageSchema.parse({
        id: message.id,
        role: message.role,
        text: message.text,
        receipts: [],
        frameRunOutcome: report,
        createdAt: AT,
      }).frameRunOutcome,
      report,
    );
  });

  it("rejects snapshot rows and unknown fields from the strict event shape", () => {
    const message = {
      id: newId("msg"),
      turnId: newId("turn"),
      role: "studio" as const,
      text: "The frame run was cancelled before any frames were filed.",
      attachmentIds: [],
      createdAt: AT,
    };
    assert.throws(() => WorldChatStoredEventSchema.parse({
      type: "frame-run.outcome-recorded",
      message,
      report: {
        runId: newId("fr"),
        productionId: "saltlight",
        sceneId: "sc_04",
        rows: [],
      },
    }), /unrecognized_keys/);
    assert.throws(() => WorldChatStoredEventSchema.parse({
      type: "frame-run.outcome-recorded",
      message,
      report: { runId: newId("fr"), productionId: "saltlight", sceneId: "sc_04" },
      status: "completed",
    }), /unrecognized_keys/);
  });
});
