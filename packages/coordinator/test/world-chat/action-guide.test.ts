import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModelEditorRequestSchema, ModelWorldChatActionSchema, WORLD_CHAT_SHAPE_EXAMPLES, type WorldChatContext } from "@arke-studio/contracts";
import {
  ACTION_GUIDE_ENTRIES,
  actionGuideScopes,
  describeAction,
  renderActionGuide,
} from "../../src/world-chat/action-guide.js";
import { TARGET_READ_TOOL_NAMES, TARGET_READ_TOOLS } from "../../src/world-chat/target-tool-catalog.js";

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

it("ordinary Cut chat receives effect vocabulary and a scoped proposal example without selecting a form", () => {
  const entry = describeAction("production-effects-propose")!;
  assert.ok("example" in entry && entry.example?.kind === "production-effects-propose");
  assert.equal(entry.example.scope?.kind, "effects-only");
  assert.ok(entry.fields?.some(field => field.startsWith("scope?")));
  for (const budget of [HUGE, 1000]) {
    const guide = renderActionGuide(["world", "production"], budget, { kind: "cut", productionId: "saltlight" }).text;
    assert.match(guide, /ordinary chat/); assert.match(guide, /Otherwise include action.scope/);
    assert.match(guide, /Applied and discarded families are history/);
    assert.match(guide, /Prior releases or review grants never transfer/);
    assert.match(guide, /build-with-energy/);
    assert.doesNotMatch(guide, /Only prepare production-effects-propose when/);
  }
});

it("advertises every complete receipt enforced by whole-cut actions", () => {
  const entry = ACTION_GUIDE_ENTRIES.find(value => value.kind === "production-timeline-operation")!;
  assert.deepEqual(entry.reads, ["get_timeline", "list_scenes", "get_scene", "list_takes", "list_artifacts"]);
  assert.equal(ModelWorldChatActionSchema.safeParse({ kind: "production-timeline-operation", productionId: "saltlight",
    request: { operation: "transcribe", trackId: "tr_subtitles", language: "English" }, checkReceiptIds: ["check_01J8G0000000000000000000C1"] }).success, false);
});

it("advertises available audio actions, dependent cues, spine verbs and the human audition boundary", () => {
  for (const kind of ["production-audio-generation", "production-performance-command", "production-audio-cue", "production-audio-edit"]) {
    const entry = describeAction(kind)!;
    assert.ok("example" in entry && !("unavailable" in entry), kind);
  }
  const guide = renderActionGuide(["world", "production"], 1000, { kind: "cut", productionId: "saltlight" }).text;
  assert.match(guide, /source.actionRef/); assert.match(guide, /after containing it/);
  assert.match(guide, /sample rights and purge remain human/); assert.match(guide, /attach\/detach/); assert.match(guide, /Refuse sound effects\/SFX/);
});

it("tells Arke how a spine is created, how markers are named and when they can follow (issue 3081)", () => {
  const entry = describeAction("audio-spine-command")!;
  assert.match(entry.description, /create \{trackArtifactId\} with baseRevision null/);
  assert.match(entry.description, /mk_ and a 26-character ULID/);
  // Chained in one turn since issue 3103; before it, they had to wait for a later turn.
  assert.match(entry.description, /chain with after, each naming the revision the card before it leaves: a create leaves 1/);
  for (const budget of [HUGE, 1000]) {
    const guide = renderActionGuide(["world", "production"], budget, { kind: "cut", productionId: "saltlight" }).text;
    assert.match(guide, /The first master is create with baseRevision null/);
    assert.match(guide, /may follow in the same turn as cards chained with after/);
  }
});

/**
 * What a reply may say about a change (issue 3137). Asked to drop two scenes' shots, Arke replied
 * "I've dropped the intro and verse 1 shots we'd drafted" with no card in the turn, and the shots
 * were still there. Nothing after the turn can tell a false reply from a true one, so the wording
 * is the fix and these assertions are what keeps it.
 */
describe("what a reply may say about a change (issue 3137)", () => {
  const scene = { kind: "scene", productionId: "saltlight", sceneId: "sc_04" } as WorldChatContext;
  const threads: readonly (WorldChatContext | undefined)[] = [
    undefined, { kind: "world" }, { kind: "production", productionId: "saltlight" }, scene, { kind: "cut", productionId: "saltlight" },
  ];
  const guides = threads.flatMap(context => [HUGE, 1000].map(budget => renderActionGuide(actionGuideScopes(context), budget, context).text));

  it("a change exists only as a card, and a card only for what the result carries", () => {
    for (const guide of guides) {
      assert.match(guide, /a change to the world or a production exists only as a card the person approves/);
      assert.match(guide, /this turn prepares a card only for what this result carries in actions, candidateOperations, bibleEdits, sceneEdits or editorRequests/);
      assert.match(guide, /Check what the result carries before writing reply/);
    }
  });

  it("a change the result carries is prepared for approval, never done", () => {
    for (const guide of guides) {
      assert.match(guide, /A change it carries is prepared for their approval, and reply says so/);
      assert.match(guide, /"Dropping the intro shots is prepared for your approval", never "I've dropped the intro shots"/);
      assert.match(guide, /A change of yours has been made only when its card is recorded as completed under Recorded action outcomes/);
    }
  });

  it("a change asked for and not carried is said as not done, with why", () => {
    for (const guide of guides) {
      assert.match(guide, /A change they asked for that the result does not carry is not done: say so plainly in reply, and why/);
    }
  });

  it("names every list of the result that carries a change", () => {
    // A group only says which candidates land together, so it is no change of its own.
    const lists = Object.keys(WORLD_CHAT_SHAPE_EXAMPLES.turnResult).filter(key => key !== "reply" && key !== "groupOperations");
    assert.deepEqual(lists.sort(), ["actions", "bibleEdits", "candidateOperations", "editorRequests", "sceneEdits"]);
    const said = guides[0]!.split("\n").find(line => line.startsWith("What reply may say about a change"))!;
    for (const list of lists) assert.ok(said.includes(list), `${list} is named`);
  });

  it("is said before the reads and the kinds, and not at all where nothing can be prepared", () => {
    for (const guide of guides) {
      const at = guide.indexOf("What reply may say about a change");
      assert.ok(at > 0 && at < guide.indexOf("Before drafting a change") && at < guide.indexOf("\n- "));
    }
    assert.equal(renderActionGuide(actionGuideScopes({ kind: "production-setup" } as WorldChatContext), HUGE).text, "");
  });
});

// Arke cannot hear the song, and asked the author where each verse and chorus starts (issue 3099).
it("tells Arke to read the song's sections rather than ask the person to time it", () => {
  const read = TARGET_READ_TOOLS.find(tool => tool.name === "get_spine")!;
  assert.match(read.description, /spine-song row gives the song's length, its tempo where it keeps one, and its sections/);
  assert.match(read.description, /Proposed starts are boundaries without names and are not on the spine/);
  for (const budget of [HUGE, 1000]) {
    const guide = renderActionGuide(["world", "production"], budget, { kind: "cut", productionId: "saltlight" }).text;
    assert.match(guide, /Never ask the person to time the song: get_spine's spine-song row gives its length, its tempo and its sections/);
    assert.match(guide, /say they are proposed, call them Section 1, Section 2 unless the person or the lyrics name them/);
  }
});

// Direct editor commands include human-only effect/protection operations. The model guide
// must follow the narrower request schema rather than advertise those commands (SPEC-053 R-36).
it("names only generic editor request commands in full and compact guides and states the effect review boundary", () => {
  const allowed = ModelEditorRequestSchema.shape.commands.element.options.map(option => option.shape.kind.value);
  for (const budget of [HUGE, 1000]) {
    const text = renderActionGuide(["world", "production"], budget).text;
    const vocabulary = text.split("\n").find(line => line.startsWith("Timeline command vocabulary: "))!;
    const advertised = [...vocabulary.matchAll(/(?:Timeline command vocabulary: | \| )([a-z-]+) \(/g)].map(match => match[1]);
    assert.deepEqual(advertised, allowed);
    assert.match(text, /detach-audio is excluded from editorRequests/);
    assert.match(text, /procedural effects and protection require their dedicated reviewed-version flow/);
    assert.match(text, /generic editorRequests cannot change effect tracks/);
    assert.match(text, /Generic Accept cannot apply effects or release protection/);
    assert.match(text, /set-performance-source \(clipId, sourceClipId\)/);
    assert.match(text, /import-cues \(trackId, cues, replace, provenance\)/);
  }
});

it("tells Arke how to propose a title in both guides: one typeface id, the look's bounds, Capitals, the named places and text-set (SPEC-065 R-35)", () => {
  for (const budget of [HUGE, 1000]) {
    const text = renderActionGuide(["world", "production"], budget).text;
    for (const said of ["text-set (clipIds, text, look)", "typeface is one id: geist regular, bold;", "size 0.01 to 0.4 of the frame's height",
      "capitals true draws upper case", "Lower third x 0.5, y 0.75, center", "only eb-garamond draws ẹ, ọ and ṣ"]) {
      assert.ok(text.includes(said), `${budget}: ${said}`);
    }
  }
});

function namedKinds(text: string): string[] {
  return [...text.matchAll(/^- ([a-z-]+) ·/gm)].map((match) => match[1]!);
}

describe("the action guide", () => {
  it("puts read prerequisites before drafting in full and compact guides (#1911)", () => {
    for (const budget of [HUGE, 1_000]) {
      const text = renderActionGuide(["world", "production"], budget).text;
      assert.match(text, /Before drafting a change, obtain all of its required reads/);
      assert.match(text, /Prop authoring needs both list_references and list_sheets/);
      assert.match(text, /include draws also need list_sheets and list_canon/);
      assert.match(text, /Cite only reads required or actually relied on by that action/);
      assert.match(text, /production-chapter-order needs only the final list_chapters receipt for that production/);
    }
    assert.deepEqual(describeAction("prop-authoring")?.reads, ["list_references", "list_sheets"]);
  });
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

it("details only the thread's prioritised kinds and keeps the rest discoverable (#2802)", () => {
  const production = renderActionGuide(["world", "production"], HUGE, { kind: "production", productionId: "saltlight" });
  const scene = renderActionGuide(["world", "production"], HUGE, { kind: "scene", productionId: "saltlight", sceneId: "sc_test" });
  assert.equal(production.mode, "focused"); assert.equal(scene.mode, "focused");
  assert.deepEqual(namedKinds(production.text).sort(), [...SCHEMA_KINDS].sort());
  assert.match(production.text, /call describe_action for its full requirements/);
  const entry = (text: string, kind: string) => text.slice(text.indexOf(`- ${kind} ·`)).split(/\n(?=- )/)[0]!;
  assert.match(entry(production.text, "production-episode"), /fields:.*\n  example:/);
  assert.doesNotMatch(entry(production.text, "production-scene-command"), /fields:|example:/);
  assert.match(entry(scene.text, "production-scene-command"), /fields:.*\n  example:/);
  assert.doesNotMatch(entry(scene.text, "production-episode"), /fields:|example:/);
  assert.ok(production.text.length < renderActionGuide(["world", "production"], HUGE).text.length / 2);
  assert.equal(renderActionGuide(["world", "production"], 1000, { kind: "production", productionId: "saltlight" }).mode, "compact");
  for (const refused of ACTION_GUIDE_ENTRIES.filter(item => item.unavailable !== null)) assert.ok(production.text.includes(refused.unavailable!));
});

it("tells Arke where a new shot can go and how several go in order on one card (issue 3084)", () => {
  const entry = describeAction("production-scene-command")!;
  assert.match(entry.description, /\{"atStart":true\}, \{"after":shotId\} or \{"before":shotId\}, nothing else: there is no end or index/);
  assert.match(entry.description, /one production-scene-command per new shot on the same scene, each with its own ref and no after/);
  assert.match(entry.description, /each next at \{"after":"ref:<previous ref>"\}/);
  assert.ok("example" in entry && entry.example?.kind === "production-scene-command" && entry.example.command?.kind === "insert-shot");
});
