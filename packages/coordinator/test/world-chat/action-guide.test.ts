import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModelWorldChatActionSchema, TimelineCommandSchema, type WorldChatContext } from "@arke-studio/contracts";
import {
  ACTION_GUIDE_ENTRIES,
  actionGuideScopes,
  describeAction,
  renderActionGuide,
} from "../../src/world-chat/action-guide.js";
import { TARGET_READ_TOOL_NAMES } from "../../src/world-chat/target-tool-catalog.js";

/**
 * The actions the model is told it can prepare (SPEC-050 R-1..R-6, issue 1404).
 *
 * The guide used to be handwritten and covered four domains; about thirty actions that worked end
 * to end were never mentioned, so a person asking for them was told they could not be done. These
 * tests are the guard that a new action cannot ship untold, and that the model is never told it
 * may prepare something the coordinator cannot approve.
 */

const SCHEMA_KINDS = ModelWorldChatActionSchema.options.map(
  (option) => (option.shape.kind as { value: string }).value,
);
const HUGE = 10_000_000;

it("advertises available audio actions, dependent cues, spine verbs and the human audition boundary", () => {
  for (const kind of ["production-audio-generation", "production-performance-command", "production-audio-cue", "production-audio-edit"]) {
    const entry = describeAction(kind)!;
    assert.ok("example" in entry && !("unavailable" in entry), kind);
  }
  const guide = renderActionGuide(["world", "production"], 1000, { kind: "cut", productionId: "saltlight" }).text;
  assert.match(guide, /source.actionRef/); assert.match(guide, /after containing it/);
  assert.match(guide, /sample rights and purge remain human/); assert.match(guide, /attach\/detach/); assert.match(guide, /Refuse sound effects\/SFX/);
});

/** The kinds a rendered guide names, read back out of its entry lines. */
it("names every timeline command in full and compact guides and explicitly excludes live detachment", () => {
  for (const budget of [HUGE, 1000]) {
    const text = renderActionGuide(["world", "production"], budget).text;
    for (const option of TimelineCommandSchema.options) assert.ok(text.includes(option.shape.kind.value), option.shape.kind.value);
    assert.match(text, /detach-audio is excluded from editorRequests/);
    assert.match(text, /set-performance-source \(clipId, sourceClipId\)/);
    assert.match(text, /import-cues \(trackId, cues, replace, provenance\)/);
  }
});

function namedKinds(text: string): string[] {
  return [...text.matchAll(/^- ([a-z-]+) ·/gm)].map((match) => match[1]!);
}

describe("the action guide", () => {
  it("names every model action kind, and only those, in the full production-scope guide", () => {
    const named = namedKinds(renderActionGuide(["world", "production"], HUGE).text);
    assert.deepEqual([...named].sort(), [...SCHEMA_KINDS].sort());
  });

  it("names every kind in the collapsed guide too, so running short of room never hides one", () => {
    const guide = renderActionGuide(["world", "production"], 1_000);
    assert.equal(guide.mode, "compact");
    assert.deepEqual([...namedKinds(guide.text)].sort(), [...SCHEMA_KINDS].sort());
    assert.match(guide.text, /describe_action/, "and says how to get the fields back");
  });

  it("gives an available kind its fields and an example that the schema accepts", () => {
    for (const entry of ACTION_GUIDE_ENTRIES.filter((one) => one.unavailable === null)) {
      assert.ok(entry.description.length > 0, `${entry.kind} says what it does`);
      assert.ok(entry.fields.length > 0 || entry.kind === "world-archive" || entry.kind === "world-export", `${entry.kind} lists its fields`);
      assert.ok(!entry.fields.some((field) => field.startsWith("checkReceiptIds")), "the shared field is said once, not per entry");
      assert.equal(ModelWorldChatActionSchema.safeParse(entry.example).success, true, `${entry.kind} example parses`);
      assert.equal(entry.example.kind, entry.kind);
    }
  });

  it("names only real read tools", () => {
    const tools = new Set<string>(TARGET_READ_TOOL_NAMES);
    for (const entry of ACTION_GUIDE_ENTRIES) {
      for (const read of entry.reads) assert.ok(tools.has(read), `${entry.kind} names ${read}`);
    }
  });

  it("marks a kind whose approval is blocked as unavailable and gives it no example to copy", () => {
    const blocked = ACTION_GUIDE_ENTRIES.filter((entry) => entry.unavailable !== null).map((entry) => entry.kind);
    // Today these become cards nobody can approve (SPEC-050 G-3); the guide must not invite them.
    assert.ok(!blocked.includes("reference-generation"));
    assert.ok(!blocked.includes("image-generation"));
    assert.ok(!blocked.includes("build-item-run"));
    assert.ok(blocked.includes("voice-audition"));
    const text = renderActionGuide(["world"], HUGE).text;
    const entry = text.slice(text.indexOf("- voice-audition ·"), text.indexOf("\n- ", text.indexOf("- voice-audition ·") + 1));
    assert.match(entry, /Unavailable: .+ Do not prepare it/);
    assert.doesNotMatch(entry, /example:/);
  });

  it("tells a world thread world actions, a production thread both, and production setup none", () => {
    const world = namedKinds(renderActionGuide(actionGuideScopes({ kind: "world" }), HUGE).text);
    assert.ok(world.includes("canon"));
    assert.ok(world.includes("production-create"), "creating a production is a world act");
    assert.ok(!world.includes("production-scene-command"));
    assert.ok(!world.includes("voice-clip-review"), "a shot's voice take belongs to a production");

    const scene = { kind: "scene", productionId: "saltlight", sceneId: "sc_04" } as WorldChatContext;
    const both = namedKinds(renderActionGuide(actionGuideScopes(scene), HUGE).text);
    assert.ok(both.includes("canon") && both.includes("production-scene-command"));

    const setup = { kind: "production-setup" } as WorldChatContext;
    assert.deepEqual(renderActionGuide(actionGuideScopes(setup), HUGE), { text: "", mode: "none" });
  });

  it("stays whole on a large window and collapses on a small local one", () => {
    // 200k-token and 32k-token windows, through the same budget the turn uses.
    assert.equal(renderActionGuide(["world", "production"], 595_000).mode, "full");
    assert.equal(renderActionGuide(["world", "production"], 70_000).mode, "compact");
  });
});

describe("describe_action", () => {
  it("returns an entry's fields and example", () => {
    const described = describeAction("artifact-import");
    assert.ok(described && "example" in described);
    assert.equal(described.card, "host-action");
    assert.deepEqual(described.reads, ["list_artifacts"]);
  });

  it("returns the refusal, not a payload, for an unavailable kind", () => {
    const described = describeAction("voice-audition");
    assert.ok(described && "unavailable" in described);
    assert.ok(!("example" in described));
  });

  it("knows nothing about a kind the schema does not take", () => {
    assert.equal(describeAction("delete-everything"), null);
    assert.equal(describeAction("world-chat-canon"), null, "the prepared kind is not what the model sends");
  });
});
