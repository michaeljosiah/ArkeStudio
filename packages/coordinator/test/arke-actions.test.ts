import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ClientMessageSchema,
  TimelineCommandSchema,
  type ClientMessageKind,
} from "@arke-studio/contracts";
import { z } from "zod";
import {
  ARKE_BLOCKED_AUTHORITY_SEAMS,
  ARKE_CLIENT_COMMAND_COMPILE_TIME_PARITY,
  ARKE_CLIENT_COMMAND_REGISTRY,
  findArkeClientCommand,
  modelActionCatalogue,
  modelActionCatalogueText,
} from "../src/arke-actions/registry.js";

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
      const schema = descriptor.schema as unknown as z.ZodObject<z.ZodRawShape>;
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
    for (const option of TimelineCommandSchema.options) {
      const kind = option.shape.kind as z.ZodLiteral<string>;
      assert.match(commands.type, new RegExp(`\\b${String(kind.value)}\\b`));
    }
  });

  it("names unsafe command seams and the intended audio spine instead of exposing generic payloads", () => {
    for (const kind of ["stage-sheet-edit", "save-routing", "save-audio-tracks", "file-artifact"] as const) {
      const descriptor = ARKE_CLIENT_COMMAND_REGISTRY[kind];
      assert.equal(descriptor.classification, "supported-by-arke");
      if (descriptor.classification !== "supported-by-arke") continue;
      assert.equal(descriptor.support.preparation.state, "blocked");
      assert.deepEqual(modelActionCatalogue().find((entry) => entry.kind === kind)?.fields, []);
    }

    const spine = ARKE_BLOCKED_AUTHORITY_SEAMS["audio-spine-command"];
    assert.equal(spine.authority, "audio-spine");
    assert.equal(spine.support.preparation.state, "blocked");
    assert.equal(spine.support.reads.state, "available", "the typed spine reader now covers this authority");
    assert.match(modelActionCatalogueText(), /audio-spine-command.*typed-audio-spine-command/);
  });
});
