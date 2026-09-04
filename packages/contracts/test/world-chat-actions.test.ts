import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ModelWorldChatActionSchema,
  WorldAuthoredFieldChangesSchema,
  WorldAuthoredFieldsSchema,
} from "../src/index.js";

const CHECK = "check_01J8F3K2QW9VZX4N7M0RTYB6HC";

describe("World Chat authored action contracts", () => {
  it("inherits every registered authored world field", () => {
    const changes = Object.fromEntries(
      WorldAuthoredFieldsSchema.keyof().options.map((field) => [field, `Changed ${field}`]),
    );
    assert.deepEqual(WorldAuthoredFieldChangesSchema.parse(changes), changes);
  });

  it("accepts every Canon operation", () => {
    const changes = [
      { operation: "create", entryType: "lore", title: "Slack water", statement: "The bells answer.", links: ["CANON-001"] },
      { operation: "amend", entryId: "CANON-001", changes: { entryType: "rule", title: "The bell rule", statement: "Only at slack water.", links: ["maren-kest"] } },
      { operation: "open-thread", title: "Who rang first?", question: "Which keeper began it?", consideredEntryIds: ["CANON-001"] },
      { operation: "settle-thread", entryId: "CANON-002", resolvedType: "timeline", statement: "Maren rang first." },
      { operation: "set-status", entryId: "CANON-001", change: { status: "open" } },
      { operation: "set-status", entryId: "CANON-001", change: { status: "settled", resolvedType: "rule" } },
      { operation: "set-considered-entries", entryId: "CANON-002", consideredEntryIds: ["CANON-001"] },
    ];
    for (const change of changes) {
      assert.doesNotThrow(() => ModelWorldChatActionSchema.parse({ kind: "canon", change, checkReceiptIds: [CHECK] }));
    }
  });

  it("accepts every sheet and relationship operation", () => {
    const changes = [
      { operation: "create", sheetType: "character", name: "Sera Kest", role: "Bell keeper", canonRules: ["CANON-001"], links: ["maren-kest"], sections: [{ heading: "Essence", body: "Patient." }] },
      { operation: "edit", sheetType: "character", sheetId: "maren-kest", changes: { billing: "lead", role: null, sections: [{ heading: "Essence", body: "Changed." }] } },
      { operation: "relationship", from: { sheetType: "character", sheetId: "maren-kest" }, to: { kind: "sheet", sheetId: "sera-kest" }, linkAction: "add", proseEdits: [] },
      { operation: "relationship", from: { sheetType: "character", sheetId: "maren-kest" }, to: { kind: "canon", entryId: "CANON-001" }, linkAction: "remove", proseEdits: [{ sheetType: "character", sheetId: "maren-kest", sectionHeading: "Relationships", body: "No longer bound." }] },
      { operation: "rename", sheetType: "location", sheetId: "the-vigil", name: "The High Vigil" },
      { operation: "set-status", sheetType: "location", sheetId: "the-vigil", status: "locked" },
      { operation: "duplicate", sheetType: "location", sheetId: "the-vigil", newName: "The Lower Vigil" },
      { operation: "promote-guest", sheetType: "character", sheetId: "the-chorister" },
    ];
    for (const change of changes) {
      assert.doesNotThrow(() => ModelWorldChatActionSchema.parse({ kind: "sheet", change, checkReceiptIds: [CHECK] }));
    }
  });

  it("keeps restore versions, nested objects and key-art intent strict", () => {
    assert.throws(() => ModelWorldChatActionSchema.parse({
      kind: "canon-restore",
      entryId: "CANON-001",
      version: 0,
      checkReceiptIds: [CHECK],
    }));
    assert.throws(() => ModelWorldChatActionSchema.parse({
      kind: "art-direction",
      changes: { keyArtIntent: {} },
      checkReceiptIds: [CHECK],
    }));
    assert.throws(() => ModelWorldChatActionSchema.parse({
      kind: "art-direction",
      changes: { keyArtIntent: { stakes: "The city wakes", characters: ["Maren Kest"] } },
      checkReceiptIds: [CHECK],
    }));
    assert.throws(() => ModelWorldChatActionSchema.parse({
      kind: "world-metadata",
      changes: { tone: "quiet", invented: "field" },
      checkReceiptIds: [CHECK],
    }));
  });
});
