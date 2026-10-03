import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ClientMessageSchema,
  BIBLE_EDIT_BOUNDS,
  ModelEditorRequestSchema,
  ModelWorldChatActionSchema,
  worldChatResultShapeGuide,
  type ClientMessageKind,
} from "@arke-studio/contracts";
import { z } from "zod";
import {
  ARKE_AUTHORITY_ACTION_REGISTRY,
  ARKE_BLOCKED_AUTHORITY_SEAMS,
  ARKE_CLIENT_COMMAND_COMPILE_TIME_PARITY,
  ARKE_CLIENT_COMMAND_REGISTRY,
  findArkeClientCommand,
  modelActionCatalogue,
  modelActionCatalogueText,
  worldChatActionDescriptor,
} from "../src/arke-actions/registry.js";
import { actionGuideEntry } from "../src/world-chat/action-guide.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
const compileTimeParity: Equal<keyof typeof ARKE_CLIENT_COMMAND_REGISTRY, ClientMessageKind> = true;
void compileTimeParity;

function optionKind(option: z.ZodDiscriminatedUnionOption<"kind">): ClientMessageKind {
  const discriminator = option.shape.kind as z.ZodLiteral<string>;
  assert.equal(typeof discriminator.value, "string");
  return discriminator.value as ClientMessageKind;
}

describe("Arke client-command parity (SPEC-041 R-46..R-52)", () => {
  it("names real conversation paths and blocks every command with no model path", () => {
    const kinds = new Set(ModelWorldChatActionSchema.options.map((option) => option.shape.kind.value));
    const channels = new Set(["bibleEdits", "editorRequests", "sceneEdits", "candidateOperations"]);
    const guide = worldChatResultShapeGuide();
    for (const descriptor of Object.values(ARKE_CLIENT_COMMAND_REGISTRY)) {
      if (descriptor.classification !== "supported-by-arke") continue;
      if (descriptor.reachedBy.length === 0) {
        assert.equal(descriptor.support.preparation.state, "blocked", descriptor.kind);
        if (descriptor.support.preparation.state === "blocked") {
          assert.ok(descriptor.support.preparation.blockingSeams.includes("no-model-action"), descriptor.kind);
          assert.match(descriptor.support.preparation.reason, new RegExp(descriptor.kind));
        }
      }
      for (const path of descriptor.reachedBy) {
        if (channels.has(path)) assert.ok(guide.includes(path), `${descriptor.kind}'s typed result channel is told`);
        else {
          assert.ok(kinds.has(path as (typeof ModelWorldChatActionSchema.options)[number]["shape"]["kind"]["value"]), `${descriptor.kind} names a real model kind`);
          assert.ok(worldChatActionDescriptor(path), `${path} has a prepared descriptor`);
          assert.ok(actionGuideEntry(path), `${path} has a guide entry`);
        }
      }
    }
    for (const kind of ["frame-run-start", "bench-accept", "timeline-assemble", "derive-continuity", "read-audiobook-chapter", "export-manuscript"] as const) {
      const descriptor = ARKE_CLIENT_COMMAND_REGISTRY[kind];
      assert.equal(descriptor.classification, "supported-by-arke");
      if (descriptor.classification === "supported-by-arke") assert.deepEqual(descriptor.reachedBy, [], kind);
    }
    assert.match(modelActionCatalogueText(), /timeline-assemble.*no-model-action/);
    assert.match(modelActionCatalogueText(), /timeline-command.*reached by: editorRequests/);
  });

  it("does not borrow nearby actions for different chapter, import or review effects", () => {
    const paths = (kind: ClientMessageKind) => {
      const descriptor = ARKE_CLIENT_COMMAND_REGISTRY[kind];
      assert.ok(descriptor.classification === "supported-by-arke", kind);
      return descriptor.reachedBy;
    };
    for (const kind of ["restore-chapter", "retire-chapter", "restore-chapter-retired", "import-shot-frame", "upload-world-image", "record-review"] as const) {
      const descriptor = ARKE_CLIENT_COMMAND_REGISTRY[kind];
      assert.ok(descriptor.classification === "supported-by-arke", kind);
      assert.deepEqual(descriptor.reachedBy, [], kind);
      assert.equal(descriptor.support.preparation.state, "blocked", kind);
      if (descriptor.support.preparation.state === "blocked") assert.ok(descriptor.support.preparation.blockingSeams.includes("no-model-action"), kind);
    }
    assert.deepEqual(paths("retire-entity"), ["canon-retire", "sheet-retire"], "chapter edits do not retire an entity");
    assert.deepEqual(paths("save-chapter"), ["production-chapter"], "authored chapter edits remain reachable");
    assert.deepEqual(paths("accept-take"), ["production-take-review"], "accept-and-select remains reachable");
    assert.deepEqual(paths("scene-command"), ["production-scene-command"], "the scene rename channel cannot perform shot commands");
  });

  it("classifies every ClientMessage option exactly once and uses that option's strict schema", () => {
    assert.equal(ARKE_CLIENT_COMMAND_COMPILE_TIME_PARITY, true);
    const options = new Map(ClientMessageSchema.options.map((option) => [optionKind(option), option]));
    assert.deepEqual(new Set(Object.keys(ARKE_CLIENT_COMMAND_REGISTRY)), new Set(options.keys()));

    const classifications = new Set<string>();
    for (const [kind, descriptor] of Object.entries(ARKE_CLIENT_COMMAND_REGISTRY)) {
      assert.equal(descriptor.kind, kind);
      assert.equal(descriptor.schema, options.get(kind as ClientMessageKind));
      classifications.add(descriptor.classification);

      const unknownField = descriptor.schema.safeParse({ kind, __unregisteredField: true });
      assert.equal(unknownField.success, false);
      if (!unknownField.success) {
        assert.ok(
          unknownField.error.issues.some((issue) => issue.code === z.ZodIssueCode.unrecognized_keys),
          `${kind} must remain strict`,
        );
      }
    }
    assert.deepEqual(
      classifications,
      new Set(["supported-by-arke", "human-only-control-plane", "read-only", "out-of-scope-global"]),
    );
  });

  it("fails closed for unknown kinds and keeps control-plane commands out of the model catalogue", () => {
    assert.equal(findArkeClientCommand("generic-patch"), undefined);
    assert.equal(findArkeClientCommand("proposal-accept")?.classification, "human-only-control-plane");

    const catalogue = modelActionCatalogue();
    const clientEntries = catalogue.filter((entry) => entry.kind in ARKE_CLIENT_COMMAND_REGISTRY);
    const supported = Object.values(ARKE_CLIENT_COMMAND_REGISTRY).filter(
      (descriptor) => descriptor.classification === "supported-by-arke",
    );
    assert.deepEqual(new Set(clientEntries.map((entry) => entry.kind)), new Set(supported.map((entry) => entry.kind)));
    assert.equal(catalogue.some((entry) => entry.kind === "proposal-accept"), false);
    assert.equal(catalogue.some((entry) => entry.kind.split("-").includes("patch")), false);
  });

  it("derives catalogue fields and nested timeline options from the validating schemas", () => {
    const catalogue = modelActionCatalogue();
    for (const entry of catalogue) {
      const descriptor = findArkeClientCommand(entry.kind);
      if (descriptor?.classification !== "supported-by-arke") continue;
      if (descriptor.support.preparation.state === "blocked") {
        assert.deepEqual(entry.fields, [], `${entry.kind} must not advertise its unsafe legacy payload`);
        continue;
      }
      const schema = descriptor.conversationSchema as unknown as z.ZodObject<z.ZodRawShape>;
      assert.deepEqual(
        entry.fields.map((field) => field.name),
        Object.keys(schema.shape).filter((field) => field !== "kind"),
        `${entry.kind} fields come from its schema option`,
      );
    }

    const timeline = catalogue.find((entry) => entry.kind === "timeline-command");
    assert.ok(timeline);
    const commands = timeline.fields.find((field) => field.name === "commands");
    assert.ok(commands);
    for (const option of ModelEditorRequestSchema.shape.commands.element.options) {
      const kind = option.shape.kind as z.ZodLiteral<string>;
      assert.match(commands.type, new RegExp(`\\b${String(kind.value)}\\b`));
    }
    assert.doesNotMatch(commands.type, /detach-audio/);
  });

  it("offers only conversation variants while preserving the human transport schemas", () => {
    const worldId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const timeline = ARKE_CLIENT_COMMAND_REGISTRY["timeline-command"];
    const upload = ARKE_CLIENT_COMMAND_REGISTRY["upload-artifacts"];
    assert.ok(timeline.classification === "supported-by-arke" && upload.classification === "supported-by-arke");
    const command = { kind: "timeline-command", worldId, productionId: "saltlight", baseRevision: 1, sourceFingerprint: "story-picture-v1:0123456789abcdef",
      commands: [{ kind: "detach-audio", clipId: "cl_picture", newClipId: "cl_audio" }] };
    assert.equal(timeline.schema.safeParse(command).success, true, "the human editor still owns detachment");
    assert.equal(timeline.conversationSchema.safeParse(command).success, false, "request ghosts cannot detach live-source audio");
    assert.equal(timeline.conversationSchema.safeParse({ ...command, commands: [{ kind: "set-clip-audio", clipId: "cl_picture", audio: "mute" }] }).success, true);
    const files = { kind: "upload-artifacts", worldId, requestId: worldId };
    const editor = { productionId: "saltlight", baseRevision: 1, sourceFingerprint: command.sourceFingerprint, destination: "library" };
    assert.equal(upload.schema.safeParse({ ...files, editor }).success, true);
    assert.equal(upload.conversationSchema.safeParse({ ...files, editor }).success, false, "plain filing cannot populate the editor");
    assert.equal(upload.schema.safeParse({ ...files, sourcePaths: ["chosen.mp4"] }).success, true);
    assert.equal(upload.conversationSchema.safeParse({ ...files, sourcePaths: ["chosen.mp4"] }).success, false, "the host chooses paths for conversation imports");
    assert.equal(upload.conversationSchema.safeParse(files).success, true);
    const fields = modelActionCatalogue().find((entry) => entry.kind === "upload-artifacts")!.fields;
    assert.equal(fields.some((field) => field.name === "editor" || field.name === "sourcePaths"), false);
    const scene = ARKE_CLIENT_COMMAND_REGISTRY["scene-command"];
    assert.ok(scene.classification === "supported-by-arke");
    const offeredScene = scene.conversationSchema as unknown as z.ZodObject<z.ZodRawShape>;
    assert.equal(offeredScene.shape["command"]!.safeParse({ kind: "edit-shot", shotId: "sh_12", change: { visualFacts: { onScreenCharacters: [], composition: "wide", confirmedAt: "2026-09-04T12:00:00.000Z" } } }).success, false);
    const staged = modelActionCatalogue().find((entry) => entry.kind === "pick-staged-reference")!.fields;
    assert.equal(staged.some((field) => field.name === "image" || field.name === "worldFile"), false);
    const clone = ARKE_CLIENT_COMMAND_REGISTRY["clone-voice"];
    assert.ok(clone.classification === "supported-by-arke");
    const frenchClone = { kind: "clone-voice", worldId, clipId: "chosen-clip", name: "Voice", description: "The speaker", consent: true, language: "fr" };
    assert.equal(clone.schema.safeParse(frenchClone).success, true);
    assert.equal(clone.conversationSchema.safeParse(frenchClone).success, false, "the current chat clone does not carry a language override");
    const stagedClone = { kind: "clone-voice", worldId, clipId: "chosen-clip", name: "Voice", description: "The speaker", consent: true };
    assert.equal(clone.schema.safeParse(stagedClone).success, true);
    assert.equal(clone.conversationSchema.safeParse(stagedClone).success, false, "the person chooses the recording and consents after approval");
    assert.equal(clone.conversationSchema.safeParse({ kind: "clone-voice", worldId, name: "Voice", description: "The speaker" }).success, true);
    const cloneFields = modelActionCatalogue().find((entry) => entry.kind === "clone-voice")!.fields;
    assert.equal(cloneFields.some((field) => field.name === "clipId" || field.name === "consent" || field.name === "language"), false);
    const bench = modelActionCatalogue().find((entry) => entry.kind === "bench-dispatch")!.fields;
    assert.equal(bench.some((field) => field.name === "confirmedSpeechMicroUsd" || field.name === "voiceUploadConfirmedFor"), false, "direct speech acknowledgements are not fields on bench-generation");
    const art = ARKE_CLIENT_COMMAND_REGISTRY["set-art-direction"];
    assert.ok(art.classification === "supported-by-arke");
    const direction = { kind: "set-art-direction", worldId, requestId: worldId, description: "Quiet" };
    assert.equal(art.schema.safeParse({ ...direction, masterLook: "references/master-look.png" }).success, true);
    assert.equal(art.conversationSchema.safeParse({ ...direction, masterLook: "references/master-look.png" }).success, false, "chat adopts a named candidate through result-use rather than assigning a path");
    assert.equal(art.conversationSchema.safeParse({ ...direction, masterLook: null }).success, true, "chat can still clear the master look");
    const stagedArt = ARKE_CLIENT_COMMAND_REGISTRY["stage-art-direction-change"];
    assert.ok(stagedArt.classification === "supported-by-arke");
    const stagedDirection = { kind: "stage-art-direction-change", worldId, description: "Quiet" };
    assert.equal(stagedArt.schema.safeParse({ ...stagedDirection, masterLook: "references/master-look.png" }).success, true);
    assert.equal(stagedArt.conversationSchema.safeParse({ ...stagedDirection, masterLook: "references/master-look.png" }).success, false);
    assert.equal(stagedArt.conversationSchema.safeParse({ ...stagedDirection, masterLook: null }).success, true);
    assert.equal(stagedArt.conversationSchema.safeParse(stagedDirection).success, true);
    const thread = ARKE_CLIENT_COMMAND_REGISTRY["open-thread"];
    assert.ok(thread.classification === "supported-by-arke");
    const question = { kind: "open-thread", worldId, title: "Motive", question: "Why did she leave?" };
    assert.equal(thread.schema.safeParse({ ...question, candidates: ["To find her sister"] }).success, true);
    assert.equal(thread.conversationSchema.safeParse({ ...question, candidates: ["To find her sister"] }).success, false);
    assert.equal(thread.conversationSchema.safeParse({ ...question, candidates: ["CANON-001"] }).success, true);
    assert.equal(thread.conversationSchema.safeParse(question).success, true);
    const bible = ARKE_CLIENT_COMMAND_REGISTRY["save-bible"];
    assert.ok(bible.classification === "supported-by-arke");
    const oversizedBible = { kind: "save-bible", worldId, text: "x".repeat(BIBLE_EDIT_BOUNDS.text + 1) };
    assert.equal(bible.schema.safeParse(oversizedBible).success, true, "the human editor keeps its unbounded transport");
    assert.equal(bible.conversationSchema.safeParse(oversizedBible).success, false, "a whole-document chat replacement is bounded");
    assert.equal(bible.conversationSchema.safeParse({ ...oversizedBible, text: "x".repeat(BIBLE_EDIT_BOUNDS.text) }).success, true);
  });

  it("names unsafe command seams and exposes strict authority actions", () => {
    for (const kind of ["stage-sheet-edit", "save-routing", "save-audio-tracks", "file-artifact"] as const) {
      const descriptor = ARKE_CLIENT_COMMAND_REGISTRY[kind];
      assert.equal(descriptor.classification, "supported-by-arke");
      if (descriptor.classification !== "supported-by-arke") continue;
      assert.equal(descriptor.support.preparation.state, "blocked");
      assert.deepEqual(modelActionCatalogue().find((entry) => entry.kind === kind)?.fields, []);
    }

    const spine = ARKE_AUTHORITY_ACTION_REGISTRY["audio-spine-command"];
    assert.equal(spine.authority, "audio-spine");
    assert.equal(spine.support.preparation.state, "available");
    assert.equal(spine.support.reads.state, "available", "the typed spine reader now covers this authority");
    assert.equal(spine.support.execution.state, "available");
    assert.match(modelActionCatalogueText(), /audio-spine-command.*command:/);

    const routing = ARKE_AUTHORITY_ACTION_REGISTRY["production-routing"];
    assert.equal(routing.authority, "routing");
    assert.equal(routing.support.execution.state, "available");
    assert.match(modelActionCatalogueText(), /production-routing.*command:/);
    const delivery = ARKE_AUTHORITY_ACTION_REGISTRY["production-cut-export"];
    assert.equal(delivery.authority, "export");
    assert.deepEqual(delivery.requiredReads, ["timeline", "episodes", "exports"]);
    assert.equal(modelActionCatalogue().find((entry) => entry.kind === "production-cut-export")?.fields.some(
      (field) => /path|destination/i.test(field.name),
    ), false);

    assert.equal(ARKE_BLOCKED_AUTHORITY_SEAMS["world-release-target"]?.authority, "release-target");
    assert.equal(ARKE_BLOCKED_AUTHORITY_SEAMS["production-release-target"]?.support.execution.state, "blocked");
    assert.match(modelActionCatalogueText(), /release-target-connector/);
  });
});
