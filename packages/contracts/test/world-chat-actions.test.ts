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

  it("keeps host paths, private bytes, and implicit voice consent out of shared-resource intents", () => {
    assert.throws(() => ModelWorldChatActionSchema.parse({
      kind: "artifact-import",
      source: "files",
      sourcePath: "C:\\private\\source.txt",
      checkReceiptIds: [CHECK],
    }));
    assert.doesNotThrow(() => ModelWorldChatActionSchema.parse({
      kind: "artifact-import",
      source: "files",
      supersedes: "ar_01J8F3K2QW9VZX4N7M0RTYB6HC",
      allowLarge: true,
      checkReceiptIds: [CHECK],
    }));
    assert.throws(() => ModelWorldChatActionSchema.parse({
      kind: "reference-import",
      change: { operation: "main-photo", sheetId: "maren-kest", path: "/private/portrait.png" },
      checkReceiptIds: [CHECK],
    }));
    assert.doesNotThrow(() => ModelWorldChatActionSchema.parse({
      kind: "reference-image-import",
      target: { surface: "staged-reference", key: "main-photo--maren-kest" },
      checkReceiptIds: [CHECK],
    }));
    assert.throws(() => ModelWorldChatActionSchema.parse({
      kind: "reference-image-import",
      target: { surface: "world-image", sourcePath: "C:\\private\\key-art.png" },
      checkReceiptIds: [CHECK],
    }));
    assert.throws(() => ModelWorldChatActionSchema.parse({
      kind: "voice-clone",
      name: "Maren",
      description: "Low and measured",
      recordingGesture: "required",
      recordingBytes: "private-audio",
      checkReceiptIds: [CHECK],
    }));
    assert.throws(() => ModelWorldChatActionSchema.parse({
      kind: "voice-clone",
      name: "Maren",
      description: "Low and measured",
      checkReceiptIds: [CHECK],
    }));
    assert.throws(() => ModelWorldChatActionSchema.parse({
      kind: "world-export",
      targetPath: "/private/export",
      checkReceiptIds: [CHECK],
    }));
  });

  it("separates generated reference intent from selection of an observed result", () => {
    assert.doesNotThrow(() => ModelWorldChatActionSchema.parse({
      kind: "reference-generation",
      request: {
        operation: "main-photo",
        sheetId: "maren-kest",
        prompt: "Salt-lit portrait",
        count: 2,
        identityReferenceIds: [],
      },
      checkReceiptIds: [CHECK],
    }));
    assert.throws(() => ModelWorldChatActionSchema.parse({
      kind: "reference-generation",
      request: {
        operation: "main-photo",
        sheetId: "maren-kest",
        prompt: "Salt-lit portrait",
        count: 2,
        identityReferenceIds: [],
        chooseTakeId: "tk_01J8F3K2QW9VZX4N7M0RTYB6HC",
      },
      checkReceiptIds: [CHECK],
    }));
    assert.doesNotThrow(() => ModelWorldChatActionSchema.parse({
      kind: "reference-result-use",
      change: {
        operation: "choose-anchor",
        sheetId: "maren-kest",
        selection: { source: "take", takeId: "tk_01J8F3K2QW9VZX4N7M0RTYB6HC" },
      },
      checkReceiptIds: [CHECK],
    }));
    assert.doesNotThrow(() => ModelWorldChatActionSchema.parse({
      kind: "reference-result-use",
      change: {
        operation: "choose-anchor",
        sheetId: "maren-kest",
        selection: { source: "candidate", candidateIndex: 1 },
      },
      checkReceiptIds: [CHECK],
    }));
    assert.throws(() => ModelWorldChatActionSchema.parse({
      kind: "reference-result-use",
      change: {
        operation: "choose-anchor",
        sheetId: "maren-kest",
        selection: { source: "candidate", file: "private.png" },
      },
      checkReceiptIds: [CHECK],
    }));
    assert.doesNotThrow(() => ModelWorldChatActionSchema.parse({
      kind: "reference-world-image-result-use",
      candidateIndex: 2,
      checkReceiptIds: [CHECK],
    }));
    assert.doesNotThrow(() => ModelWorldChatActionSchema.parse({
      kind: "reference-master-look-result-use",
      candidateIndex: 1,
      checkReceiptIds: [CHECK],
    }));
    assert.doesNotThrow(() => ModelWorldChatActionSchema.parse({
      kind: "reference-image-discard",
      target: { surface: "master-look" },
      checkReceiptIds: [CHECK],
    }));
  });

  it("admits the complete Production Development operation shapes", () => {
    const actions = [
      {
        kind: "production-series",
        productionId: "bell-watch-season-one",
        change: { operation: "create", title: "Bell Watch", seasons: ["bell-watch-season-one"] },
      },
      {
        kind: "production-episode",
        productionId: "bell-watch-season-one",
        change: { operation: "create", title: "The Missing Night", scenes: [], release: { tags: ["harbour"] } },
      },
      {
        kind: "production-chapter",
        productionId: "saltlight",
        change: { operation: "create", title: "The Vigil", order: 1, body: "The ledger opens." },
      },
      {
        kind: "production-scene",
        productionId: "saltlight",
        change: { operation: "create", title: "The Ledger", scriptBlocks: [{ id: "blk_opening", kind: "action", text: "The ledger opens." }] },
      },
    ];
    for (const action of actions) {
      assert.doesNotThrow(() => ModelWorldChatActionSchema.parse({ ...action, checkReceiptIds: [CHECK] }));
    }
  });

  it("requires unique stable ids in a complete scene-script replacement", () => {
    assert.throws(() => ModelWorldChatActionSchema.parse({
      kind: "production-scene",
      productionId: "saltlight",
      change: {
        operation: "replace-script",
        sceneId: "sc_01",
        blocks: [
          { id: "blk_same", kind: "action", text: "The ledger opens." },
          { id: "blk_same", kind: "dialogue", speaker: "maren-kest", text: "One night is missing." },
        ],
      },
      checkReceiptIds: [CHECK],
    }), /script block ids must be unique/i);
  });

  it("admits every scene, board, and take action without admitting host paths or generic scene payloads", () => {
    const actions = [
      {
        kind: "production-scene-command",
        productionId: "saltlight",
        sceneId: "sc_04",
        command: { kind: "set-prompt-override", shotId: "sh_12", text: "Hold on the listening face." },
      },
      { kind: "production-board-compile", productionId: "saltlight", sceneId: "sc_04" },
      { kind: "production-board-export", productionId: "saltlight", sceneId: "sc_04" },
      { kind: "production-take-import", productionId: "saltlight", sceneId: "sc_04", shotId: "sh_12" },
      {
        kind: "production-take-generation",
        productionId: "saltlight",
        sceneId: "sc_04",
        target: { kind: "board", memberShotIds: ["sh_12", "sh_13"] },
        mode: "video",
        retakeOf: "tk_01J8F3K2QW9VZX4N7M0RTYB6HC",
        instruction: "Keep the bell reflection stable.",
      },
      {
        kind: "production-take-review",
        productionId: "saltlight",
        takeId: "tk_01J8F3K2QW9VZX4N7M0RTYB6HC",
        review: { decision: "reject", shotId: "sh_12", citation: { sheet: "maren-kest", field: "appearance" } },
      },
      {
        kind: "production-take-trim",
        productionId: "saltlight",
        shotId: "sh_12",
        takeId: "tk_01J8F3K2QW9VZX4N7M0RTYB6HC",
        trimInSec: 0.5,
      },
      { kind: "production-stage-playblast", productionId: "saltlight", sceneId: "sc_04", shotId: "sh_12" },
    ];
    for (const action of actions) {
      assert.doesNotThrow(() => ModelWorldChatActionSchema.parse({ ...action, checkReceiptIds: [CHECK] }));
    }

    assert.throws(() => ModelWorldChatActionSchema.parse({
      ...actions[3],
      sourcePath: "C:\\private\\frame.png",
      checkReceiptIds: [CHECK],
    }));
    assert.throws(() => ModelWorldChatActionSchema.parse({
      kind: "production-scene-command",
      productionId: "saltlight",
      sceneId: "sc_04",
      command: { kind: "replace-graph", graph: {} },
      checkReceiptIds: [CHECK],
    }));
    assert.throws(() => ModelWorldChatActionSchema.parse({
      kind: "production-take-review",
      productionId: "saltlight",
      takeId: "tk_01J8F3K2QW9VZX4N7M0RTYB6HC",
      review: { decision: "reject", shotId: "sh_12" },
      checkReceiptIds: [CHECK],
    }));
  });

  it("admits every semantic routing operation and path-free delivery option", () => {
    const commands = [
      { operation: "set-start", sceneId: "sc_01" },
      { operation: "add-choice", choice: { id: "ch_wait", from: "sc_01", label: "Wait", to: "sc_02" } },
      { operation: "edit-choice", choiceId: "ch_wait", changes: { label: "Keep waiting" } },
      { operation: "remove-choice", choiceId: "ch_wait" },
      { operation: "set-ending", sceneId: "sc_02", title: "The quiet ending" },
      { operation: "clear-ending", sceneId: "sc_02" },
      { operation: "exclude-scene", sceneId: "sc_03", reason: "Alternate draft" },
      { operation: "include-scene", sceneId: "sc_03" },
      { operation: "add-group", group: { id: "grp_harbour", title: "Harbour", scenes: ["sc_01", "sc_02"] } },
      { operation: "edit-group", groupId: "grp_harbour", changes: { scenes: ["sc_02"] } },
      { operation: "remove-group", groupId: "grp_harbour" },
    ];
    for (const command of commands) {
      assert.doesNotThrow(() => ModelWorldChatActionSchema.parse({
        kind: "production-routing",
        productionId: "saltlight",
        command,
        checkReceiptIds: [CHECK],
      }));
    }

    assert.doesNotThrow(() => ModelWorldChatActionSchema.parse({
      kind: "production-cut-export",
      productionId: "saltlight",
      scope: { kind: "episode", episodeId: "ep_opening" },
      preset: "review-cut",
      subtitles: { trackId: "tr_subtitles", mode: "burn-in+sidecar", sidecar: "srt" },
      checkReceiptIds: [CHECK],
    }));
    assert.throws(() => ModelWorldChatActionSchema.parse({
      kind: "production-cut-export",
      productionId: "saltlight",
      scope: { kind: "production" },
      preset: "review-cut",
      destination: "C:\\private\\delivery.mp4",
      checkReceiptIds: [CHECK],
    }));
  });
});
