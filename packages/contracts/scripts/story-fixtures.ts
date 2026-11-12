// The shared story fixtures (SPEC-058 R-79 – R-81), made here and read by both readers:
//
//   npx tsx packages/contracts/scripts/story-fixtures.ts           write them
//   npx tsx packages/contracts/scripts/story-fixtures.ts --check   fail if one has drifted
//
// The other world-package fixtures are Arke Player's, made by its Python tools. These are the
// Studio's, because what they pin is the Studio's evaluator: each valid document is compiled here
// from a production's routing, and every route through it is walked with SPEC-063's rules
// (`storyRoutes`). arke_world copies packages/contracts/test/fixtures/world-package/story/ verbatim
// to packages/arke_world/test/fixtures/story/ and its Dart port must reproduce every step. The
// contracts test regenerates them in memory and compares bytes, so a change to the rules lands with
// regenerated fixtures or not at all (R-81).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RoutingSchema } from "../src/routing.js";
import { compileStoryDocument, storyRoutes, type StoryCompileInput } from "../src/story-document.js";
import { exploreStory } from "../src/story-state.js";
import { STORY_LIMITS, STORY_MEDIA_TYPE, type StoryDocument, type WorldAsset } from "../src/world-package.js";

export const STORY_FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "world-package", "story");

const ZERO = "0".repeat(64);
const asset = (path: string, mediaType: string): WorldAsset => ({ path, mediaType, byteLength: 1, sha256: ZERO });
const clip = (path: string) => asset(path, "video/mp4");
const jpeg = (path: string) => asset(path, "image/jpeg");
const voice = (path: string) => asset(path, "audio/mp4");

/** The inventory every document is read against: three productions' files, and a story package's own. */
const ASSETS: Record<string, WorldAsset> = {
  story: asset("ring-once/story.json", STORY_MEDIA_TYPE),
  cover: jpeg("ring-once/cover.jpg"),
  "cover-tall": jpeg("ring-once/cover-tall.jpg"),
  "lw-quarter": clip("low-water/clips/sc_quarter.mp4"),
  "lw-causeway": clip("low-water/clips/sc_causeway.mp4"),
  "lw-towers": clip("low-water/clips/sc_towers.mp4"),
  "lw-vigil": clip("low-water/clips/sc_vigil.mp4"),
  "lw-pier": clip("low-water/clips/sc_pier.mp4"),
  "lw-bell": clip("low-water/clips/sc_bell.mp4"),
  "ro-harbour": clip("ring-once/clips/sc_harbour.mp4"),
  "ro-weigh": clip("ring-once/clips/sc_weigh.mp4"),
  "ro-bell": clip("ring-once/clips/sc_bell.mp4"),
  "ro-vault": clip("ring-once/clips/sc_vault.mp4"),
  "ro-end": clip("ring-once/clips/sc_end.mp4"),
  "ro-drowned": clip("ring-once/clips/sc_drowned.mp4"),
  "lr-market": jpeg("the-lantern-road/pictures/market.jpg"),
  "lr-market-tall": jpeg("the-lantern-road/pictures/market-tall.jpg"),
  "lr-stall": jpeg("the-lantern-road/pictures/stall.jpg"),
  "lr-road": jpeg("the-lantern-road/pictures/road.jpg"),
  "lr-road-tall": jpeg("the-lantern-road/pictures/road-tall.jpg"),
  "lr-road-light": jpeg("the-lantern-road/pictures/road-light.jpg"),
  "lr-road-mara": jpeg("the-lantern-road/pictures/road-mara.jpg"),
  "lr-ford": jpeg("the-lantern-road/pictures/ford.jpg"),
  "lr-ford-tall": jpeg("the-lantern-road/pictures/ford-tall.jpg"),
  "lr-bridge": jpeg("the-lantern-road/pictures/bridge.jpg"),
  "lr-home": asset("the-lantern-road/pictures/home.png", "image/png"),
  "lr-home-tall": jpeg("the-lantern-road/pictures/home-tall.jpg"),
  "lr-home-mara": jpeg("the-lantern-road/pictures/home-mara.jpg"),
  "lr-v-market-1": voice("the-lantern-road/voices/market-1.m4a"),
  "lr-v-market-2": voice("the-lantern-road/voices/market-2.m4a"),
  "lr-v-ford": voice("the-lantern-road/voices/ford.m4a"),
  "lr-v-home": voice("the-lantern-road/voices/home.m4a"),
};

/**
 * Low Water, The Undersong's interactive movie as the Studio's own tests draw it: legacy routing,
 * no facts, compiled as it stands. The undertow is excluded and its clip is left out with it; the
 * group is the map's and goes nowhere.
 */
export const LOW_WATER: StoryCompileInput = {
  routing: RoutingSchema.parse({
    version: 12,
    start: "sc_quarter",
    choices: [
      { id: "ch_follow", from: "sc_quarter", label: "Follow the lantern", to: "sc_causeway" },
      { id: "ch_stay", from: "sc_quarter", label: "Stay with the boat", to: "sc_towers" },
      { id: "ch_cross", from: "sc_causeway", label: "Cross before the tide", to: "sc_towers" },
      { id: "ch_wait", from: "sc_causeway", label: "Wait for low water", to: "sc_vigil" },
      { id: "ch_sleep", from: "sc_towers", label: "Let it sleep", to: "sc_pier" },
      { id: "ch_ring", from: "sc_towers", label: "Ring the bell", to: "sc_bell" },
      { id: "ch_climb", from: "sc_vigil", label: "Climb to the lamp", to: "sc_pier" },
    ],
    endings: [
      { sceneId: "sc_pier", title: "The harbour, level" },
      { sceneId: "sc_bell", title: "The Bell Rings Twice" },
    ],
    excluded: [{ sceneId: "sc_undertow", reason: "Cut for length" }],
    groups: [{ id: "grp_harbour", title: "The harbour", scenes: ["sc_quarter", "sc_pier"] }],
  }),
  kind: "movie",
  shape: "16:9",
  scenes: {
    sc_quarter: { title: "The drowned quarter", clips: [{ asset: "lw-quarter", from: 0, to: 72_000 }] },
    sc_causeway: { title: "The causeway", clips: [{ asset: "lw-causeway", from: 0, to: 48_000 }] },
    // One pass cut into two shots' windows, as the export's cut plays it.
    sc_towers: { title: "The bell towers", clips: [{ asset: "lw-towers", from: 1_200, to: 31_200, shotId: "sh_towers-1" }, { asset: "lw-towers", from: 31_200, to: 64_000, shotId: "sh_towers-2" }] },
    sc_vigil: { title: "The Vigil", clips: [{ asset: "lw-vigil", from: 0, to: 55_000 }] },
    sc_pier: { title: "The pier at dusk", clips: [{ asset: "lw-pier", from: 0, to: 90_000 }] },
    sc_bell: { title: "The bell", clips: [{ asset: "lw-bell", from: 0, to: 41_000 }] },
    sc_undertow: { title: "The undertow", clips: [{ asset: "lw-undertow", from: 0, to: 30_000 }] },
  },
};

const eq = (fact: string, value: boolean | string) => ({ op: "eq" as const, fact, value });

/**
 * Ring Once, a synthetic 9:16 movie that exercises every rule a document carries: Boolean and enum
 * facts; `eq`, `not`, `all` and `any`; effects of each type and two in one choice; a closed choice
 * with its reason, one with its own closed label, and guarded choices with neither, which hide;
 * clips shown only in some states; and an ending with variants and a fallback beside one without.
 */
export const RING_ONCE: StoryCompileInput = {
  routing: RoutingSchema.parse({
    schemaVersion: 2,
    version: 7,
    start: "sc_harbour",
    facts: [
      { id: "key", label: "The tenth key", type: "enum", values: ["held", "left", "lost"], default: "held" },
      { id: "lamp", label: "Lamp lit", type: "boolean", default: false },
      { id: "ledger", label: "Ledger taken", type: "boolean", default: false },
    ],
    choices: [
      { id: "ch_light", from: "sc_harbour", label: "Light the lamp", to: "sc_weigh", effects: [{ fact: "lamp", value: true }] },
      { id: "ch_dark", from: "sc_harbour", label: "Go on in the dark", to: "sc_weigh" },
      { id: "ch_leave", from: "sc_weigh", label: "Leave the key", to: "sc_bell", effects: [{ fact: "key", value: "left" }] },
      { id: "ch_keep", from: "sc_weigh", label: "Keep the key", to: "sc_bell", effects: [] },
      { id: "ch_drop", from: "sc_weigh", label: "Drop it in the water", to: "sc_bell", when: eq("lamp", false), effects: [{ fact: "key", value: "lost" }] },
      { id: "ch_ring", from: "sc_bell", label: "Ring once", to: "sc_end" },
      { id: "ch_key", from: "sc_bell", label: "Use the tenth key", to: "sc_vault", when: eq("key", "held"), unavailable: { reason: "Left at the weigh house" } },
      { id: "ch_signal", from: "sc_bell", label: "Signal with the lamp", to: "sc_end", when: eq("lamp", true), unavailable: { label: "Signal the boats", reason: "No light to signal with" } },
      { id: "ch_wait", from: "sc_bell", label: "Wait for the tide", to: "sc_end" },
      { id: "ch_swim", from: "sc_bell", label: "Swim for the vault", to: "sc_drowned", when: { op: "any", args: [eq("key", "lost"), { op: "not", arg: eq("lamp", true) }] } },
      { id: "ch_take", from: "sc_vault", label: "Take the ledger", to: "sc_end", effects: [{ fact: "ledger", value: true }, { fact: "key", value: "lost" }] },
      { id: "ch_seal", from: "sc_vault", label: "Leave it sealed", to: "sc_end" },
    ],
    presentation: [
      { sceneId: "sc_weigh", blocks: [], shots: [{ shotId: "sh_weigh-lamp", when: eq("lamp", true) }] },
      { sceneId: "sc_bell", blocks: [], shots: [{ shotId: "sh_bell-key", when: eq("key", "held") }, { shotId: "sh_bell-lamp", when: { op: "all", args: [eq("lamp", true), { op: "not", arg: eq("key", "lost") }] } }] },
      { sceneId: "sc_end", blocks: [], shots: [{ shotId: "sh_end-ledger", when: eq("ledger", true) }] },
    ],
    endings: [
      {
        sceneId: "sc_end",
        title: "The bell",
        variants: [
          { id: "ev_ledger", title: "The ledger, saved", text: "The weigh house keeps its count.", when: eq("ledger", true) },
          { id: "ev_boats", title: "The boats come in", text: "The lamp brings them home.", when: { op: "all", args: [eq("lamp", true), eq("ledger", false)] } },
          { id: "ev_twice", title: "The Bell Rings Twice", text: "Someone below answers.", fallback: true },
        ],
      },
      { sceneId: "sc_drowned", title: "Under the harbour" },
    ],
    excluded: [{ sceneId: "sc_cellar", reason: "Saved for a later cut" }],
    groups: [],
  }),
  kind: "movie",
  shape: "9:16",
  scenes: {
    sc_harbour: { title: "The harbour at dusk", clips: [{ asset: "ro-harbour", from: 0, to: 18_000, shotId: "sh_harbour-wide" }, { asset: "ro-harbour", from: 18_000, to: 30_000, shotId: "sh_harbour-boats" }] },
    sc_weigh: { title: "The weigh house", clips: [{ asset: "ro-weigh", from: 0, to: 22_000, shotId: "sh_weigh-door" }, { asset: "ro-weigh", from: 22_000, to: 31_000, shotId: "sh_weigh-lamp" }] },
    sc_bell: {
      title: "The bell tower",
      clips: [
        { asset: "ro-bell", from: 0, to: 15_000, shotId: "sh_bell-climb" },
        { asset: "ro-bell", from: 15_000, to: 24_000, shotId: "sh_bell-key" },
        { asset: "ro-bell", from: 24_000, to: 33_000, shotId: "sh_bell-lamp" },
      ],
    },
    sc_vault: { title: "The vault under the tower", clips: [{ asset: "ro-vault", from: 0, to: 40_000, shotId: "sh_vault" }] },
    sc_end: { title: "The bell", clips: [{ asset: "ro-end", from: 0, to: 20_000, shotId: "sh_end-tower" }, { asset: "ro-end", from: 20_000, to: 36_000, shotId: "sh_end-ledger" }] },
    sc_drowned: { title: "Under the harbour", clips: [{ asset: "ro-drowned", from: 0, to: 25_000, shotId: "sh_drowned" }] },
  },
};

/**
 * The Lantern Road, a small 16:9 visual novel: beats with and without a Tall picture, voiced and
 * read, narration, dialogue and a picture held alone, a beat that keeps the picture before it, and
 * a line guarded by both its shot and its block, which compiles to `all`.
 */
export const LANTERN_ROAD: StoryCompileInput = {
  routing: RoutingSchema.parse({
    schemaVersion: 2,
    version: 3,
    start: "sc_market",
    facts: [
      { id: "lantern", label: "Has a lantern", type: "boolean", default: false },
      { id: "company", label: "Who walks with you", type: "enum", values: ["mara", "alone"], default: "mara" },
    ],
    choices: [
      { id: "ch_buy", from: "sc_market", label: "Buy a lantern", to: "sc_road", effects: [{ fact: "lantern", value: true }] },
      { id: "ch_walk", from: "sc_market", label: "Walk on without one", to: "sc_road" },
      { id: "ch_ford", from: "sc_road", label: "Wade the ford", to: "sc_ford" },
      { id: "ch_bridge", from: "sc_road", label: "Take the old bridge", to: "sc_bridge", when: eq("lantern", true), unavailable: { reason: "Too dark to find it" } },
      { id: "ch_part", from: "sc_ford", label: "Let Mara go ahead", to: "sc_home", effects: [{ fact: "company", value: "alone" }] },
      { id: "ch_together", from: "sc_ford", label: "Go on together", to: "sc_home" },
      { id: "ch_cross", from: "sc_bridge", label: "Cross the bridge", to: "sc_home" },
    ],
    presentation: [
      { sceneId: "sc_road", blocks: [{ blockId: "blk_road-light", when: eq("lantern", true) }, { blockId: "blk_road-close", when: eq("lantern", false) }], shots: [{ shotId: "sh_road-3", when: eq("company", "mara") }] },
      { sceneId: "sc_home", blocks: [], shots: [{ shotId: "sh_home-2", when: eq("company", "mara") }] },
    ],
    endings: [
      {
        sceneId: "sc_home",
        title: "The lantern road home",
        variants: [
          { id: "ev_together", title: "Together", text: "Mara sets the lantern on the sill.", when: eq("company", "mara") },
          { id: "ev_alone", title: "The last lamp", text: "You walk the last mile alone.", fallback: true },
        ],
      },
    ],
    excluded: [],
    groups: [],
  }),
  kind: "novel",
  shape: "16:9",
  scenes: {
    sc_market: {
      title: "The lamp market",
      beats: [
        { shotId: "sh_market-1", pictureShotId: "sh_market-1", blockId: "blk_market-open", picture: "lr-market", tall: "lr-market-tall", text: "The lamp market opens at dusk, a hundred small fires on the water.", audio: "lr-v-market-1" },
        { shotId: "sh_market-1", pictureShotId: "sh_market-1", blockId: "blk_market-mara", picture: "lr-market", tall: "lr-market-tall", speaker: "Mara", text: "You came back. I said you would.", audio: "lr-v-market-2" },
        { shotId: "sh_market-2", pictureShotId: "sh_market-2", picture: "lr-stall" },
      ],
    },
    sc_road: {
      title: "The road out",
      beats: [
        { shotId: "sh_road-1", pictureShotId: "sh_road-1", blockId: "blk_road-dark", picture: "lr-road", tall: "lr-road-tall", text: "The road runs dark between the reeds." },
        { shotId: "sh_road-2", pictureShotId: "sh_road-2", blockId: "blk_road-light", picture: "lr-road-light", text: "The lantern throws your shadow long across the water." },
        { shotId: "sh_road-3", pictureShotId: "sh_road-3", blockId: "blk_road-close", picture: "lr-road-mara", speaker: "Mara", text: "Stay close. I can't see the edge." },
      ],
    },
    sc_ford: {
      title: "The ford",
      beats: [
        { shotId: "sh_ford-1", pictureShotId: "sh_ford-1", blockId: "blk_ford-cold", picture: "lr-ford", tall: "lr-ford-tall", text: "The water is colder than it looks.", audio: "lr-v-ford" },
        { shotId: "sh_ford-2", pictureShotId: "sh_ford-1", blockId: "blk_ford-mara", picture: "lr-ford", tall: "lr-ford-tall", speaker: "Mara", text: "Go on. I'll find the stones." },
      ],
    },
    sc_bridge: { title: "The old bridge", beats: [{ shotId: "sh_bridge-1", pictureShotId: "sh_bridge-1", blockId: "blk_bridge-boards", picture: "lr-bridge", text: "Half the boards are gone. The lantern finds the rest." }] },
    sc_home: {
      title: "Home",
      beats: [
        { shotId: "sh_home-1", pictureShotId: "sh_home-1", blockId: "blk_home-door", picture: "lr-home", tall: "lr-home-tall", text: "The door is where you left it.", audio: "lr-v-home" },
        { shotId: "sh_home-2", pictureShotId: "sh_home-2", blockId: "blk_home-mara", picture: "lr-home-mara", speaker: "Mara", text: "We made it, then." },
      ],
    },
  },
};

/** The three public stories, by the file their document is written to. */
export const STORY_SOURCES: ReadonlyArray<{ file: string; source: StoryCompileInput }> = [
  { file: "low-water.json", source: LOW_WATER },
  { file: "synthetic.json", source: RING_ONCE },
  { file: "lantern-road.json", source: LANTERN_ROAD },
];

type Json = Record<string, unknown>;
type Case = { file: string; reader: "story" | "manifest"; expect: "ok" | "notAPackage" | "newerArke" } & Json;

const ROUTES_NOTE =
  "SPEC-058 R-81: every complete route through the document, depth first in authored order, as contracts' storyRoutes walks it with SPEC-063's evaluator. " +
  "Replaying a route's choices from the facts' defaults must give each step exactly: the scene entered; every declared fact and its value; the open choices in authored order; " +
  "the closed choices that carry unavailable, in authored order, each with unavailable.label or else its own label, and the reason (a closed choice without one is hidden); " +
  "and the indices of the scene's clips or beats that play, ascending. The ending is the variant resolved at the last scene, or the ending itself, variant and text null, when it has none. " +
  "complete is false only when a route was stopped at bound, and then that route's ending is null.";

const CASES_NOTE =
  "SPEC-058 R-79 – R-81: the story cases both readers run, ArkeStudio contracts (TypeScript), which writes this folder with packages/contracts/scripts/story-fixtures.ts, and Arke Player arke_world (Dart), which copies it. " +
  "A \"story\" case is a story document read against assets.json: \"kind\", \"shape\", \"start\", \"facts\", \"scenes\" and \"choices\" are what an ok case reads, by id, and \"routes\" names its route fixture. " +
  "A \"manifest\" case is a world.json: \"alone\", \"story\" and \"tall\" are what an ok one names. " +
  "\"limits\" are the bounds every reader keeps: a condition's depth counts its root as 1 and its nodes count every op; text bounds count UTF-16 code units, as both languages measure a string, and every text but a variant's text must be more than blanks. " +
  "A key a reader does not know is newerArke, wherever it is; an op it does not know is notAPackage. The fingerprint is read, never recomputed, so a refused copy keeps its base's.";

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function compiled(source: StoryCompileInput): StoryDocument {
  // A fixture is a story an author could export: every state reaches an ending and no ending is ambiguous.
  const explored = exploreStory(source.routing);
  if (!explored.complete || explored.problems.length > 0) throw new Error(`a fixture story has problems: ${explored.problems.map((problem) => problem.detail).join("; ")}`);
  const result = compileStoryDocument(source);
  if (!result.ok) throw new Error(`a fixture story does not compile: ${result.problems.map((problem) => problem.detail).join("; ")}`);
  return result.document;
}

type Mutable = Json & { scenes: Json[]; choices: Json[]; facts: Json[]; presentation: Json[]; endings: Json[] };
const scene = (document: Mutable, id: string) => document.scenes.find((candidate) => candidate["id"] === id)!;
const choice = (document: Mutable, id: string) => document.choices.find((candidate) => candidate["id"] === id)!;
const ending = (document: Mutable, id: string) => document.endings.find((candidate) => candidate["scene"] === id)!;
const variant = (document: Mutable, sceneId: string, id: string) => (ending(document, sceneId)["variants"] as Json[]).find((candidate) => candidate["id"] === id)!;
const fact = (document: Mutable, id: string) => document.facts.find((candidate) => candidate["id"] === id)!;

/** Every fixture, by file name, as the generator writes it. */
export function storyFixtures(): Map<string, string> {
  const files = new Map<string, string>();
  const cases: Case[] = [];
  files.set("assets.json", pretty(ASSETS));

  const documents = new Map<string, StoryDocument>();
  for (const { file, source } of STORY_SOURCES) {
    const document = compiled(source);
    documents.set(file, document);
    const routesFile = file.replace(/\.json$/, ".routes.json");
    files.set(file, pretty(document));
    const routes = storyRoutes(document);
    files.set(routesFile, pretty({ note: ROUTES_NOTE, document: file, complete: routes.complete, bound: routes.bound, routes: routes.routes }));
    cases.push({
      file,
      reader: "story",
      expect: "ok",
      kind: document.kind,
      shape: document.shape,
      start: document.start,
      facts: document.facts.map((entry) => entry.id),
      scenes: document.scenes.map((entry) => entry.id),
      choices: document.choices.map((entry) => entry.id),
      routes: routesFile,
    });
  }

  // Every refusal is one change to a valid document, so the case names exactly what is wrong.
  const derived = (file: string, base: string, expect: Case["expect"], change: (document: Mutable) => void) => {
    const document = clone(documents.get(base)!) as unknown as Mutable;
    change(document);
    files.set(file, pretty(document));
    cases.push({ file, reader: "story", expect });
  };
  const synthetic = "synthetic.json";
  const novel = "lantern-road.json";

  derived("metadata.json", synthetic, "ok", (document) => {
    document["metadata"] = { studio: "0.5.92" };
    fact(document, "key")["metadata"] = { note: "set at the weigh house" };
    scene(document, "sc_bell")["metadata"] = { take: "pass 3" };
    ((scene(document, "sc_bell")["clips"] as Json[])[0]!)["metadata"] = { shot: "sh_bell-climb" };
    document.presentation[0]!["metadata"] = { shot: "sh_weigh-lamp" };
    choice(document, "ch_key")["metadata"] = { map: "left" };
    (choice(document, "ch_key")["unavailable"] as Json)["metadata"] = { reviewed: true };
    ending(document, "sc_end")["metadata"] = { family: "bell" };
    variant(document, "sc_end", "ev_twice")["metadata"] = { fallback: "yes" };
  });
  derived("metadata-novel.json", novel, "ok", (document) => {
    ((scene(document, "sc_market")["beats"] as Json[])[1]!)["metadata"] = { line: "blk_market-mara" };
  });

  derived("scene-repeats.json", synthetic, "notAPackage", (document) => void document.scenes.push(clone(scene(document, "sc_vault"))));
  derived("choice-repeats.json", synthetic, "notAPackage", (document) => void (choice(document, "ch_seal")["id"] = "ch_take"));
  derived("fact-repeats.json", synthetic, "notAPackage", (document) => void document.facts.push({ id: "lamp", type: "boolean", default: true }));
  derived("value-repeats.json", synthetic, "notAPackage", (document) => void (fact(document, "key")["values"] = ["held", "left", "lost", "left"]));
  derived("presentation-repeats.json", synthetic, "notAPackage", (document) => void document.presentation.push(clone(document.presentation[0]!)));
  derived("ending-repeats.json", synthetic, "notAPackage", (document) => void document.endings.push(clone(ending(document, "sc_drowned"))));
  derived("variant-repeats.json", synthetic, "notAPackage", (document) => void (variant(document, "sc_end", "ev_boats")["id"] = "ev_ledger"));
  derived("choice-to-nowhere.json", synthetic, "notAPackage", (document) => void (choice(document, "ch_seal")["to"] = "sc_cellar"));
  derived("choice-from-nowhere.json", synthetic, "notAPackage", (document) => void (choice(document, "ch_seal")["from"] = "sc_cellar"));
  derived("presentation-nowhere.json", synthetic, "notAPackage", (document) => void (document.presentation[0]!["scene"] = "sc_cellar"));
  derived("presentation-past-end.json", synthetic, "notAPackage", (document) => void (document.presentation[0]!["index"] = 2));
  derived("ending-nowhere.json", synthetic, "notAPackage", (document) => void (ending(document, "sc_drowned")["scene"] = "sc_cellar"));
  derived("start-nowhere.json", synthetic, "notAPackage", (document) => void (document["start"] = "sc_cellar"));
  derived("ending-with-choice.json", synthetic, "notAPackage", (document) => void document.choices.push({ id: "ch_again", from: "sc_end", to: "sc_harbour", label: "Ring again", effects: [] }));
  derived("when-unknown-fact.json", synthetic, "notAPackage", (document) => void (choice(document, "ch_key")["when"] = eq("bell", "held")));
  derived("when-unknown-value.json", synthetic, "notAPackage", (document) => void (choice(document, "ch_key")["when"] = eq("key", "found")));
  derived("when-wrong-type.json", synthetic, "notAPackage", (document) => void (choice(document, "ch_drop")["when"] = eq("lamp", "false")));
  derived("effect-unknown-fact.json", synthetic, "notAPackage", (document) => void (choice(document, "ch_light")["effects"] = [{ fact: "candle", value: true }]));
  derived("effect-unknown-value.json", synthetic, "notAPackage", (document) => void (choice(document, "ch_leave")["effects"] = [{ fact: "key", value: "stolen" }]));
  derived("effect-twice.json", synthetic, "notAPackage", (document) => void (choice(document, "ch_take")["effects"] = [{ fact: "ledger", value: true }, { fact: "key", value: "lost" }, { fact: "ledger", value: false }]));
  derived("presentation-unknown-fact.json", synthetic, "notAPackage", (document) => void (document.presentation[0]!["when"] = eq("candle", true)));
  derived("variant-unknown-fact.json", synthetic, "notAPackage", (document) => void (variant(document, "sc_end", "ev_ledger")["when"] = eq("book", true)));
  derived("default-not-a-value.json", synthetic, "notAPackage", (document) => void (fact(document, "key")["default"] = "found"));
  derived("variant-both.json", synthetic, "notAPackage", (document) => void (variant(document, "sc_end", "ev_twice")["when"] = eq("lamp", false)));
  derived("variant-neither.json", synthetic, "notAPackage", (document) => void delete variant(document, "sc_end", "ev_twice")["fallback"]);
  derived("two-fallbacks.json", synthetic, "notAPackage", (document) => {
    const boats = variant(document, "sc_end", "ev_boats");
    delete boats["when"];
    boats["fallback"] = true;
  });
  derived("condition-too-deep.json", synthetic, "notAPackage", (document) => {
    // Eight nots around an eq: the eq sits at depth 9.
    let when: Json = eq("lamp", true);
    for (let level = 0; level < 8; level++) when = { op: "not", arg: when };
    choice(document, "ch_swim")["when"] = when;
  });
  derived("condition-too-large.json", synthetic, "notAPackage", (document) => {
    // An any of 128: 129 nodes, though no list is longer than 128.
    choice(document, "ch_wait")["when"] = { op: "any", args: Array.from({ length: STORY_LIMITS.conditionNodes }, (_, index) => eq("key", index % 2 === 0 ? "held" : "left")) };
  });
  derived("condition-empty.json", synthetic, "notAPackage", (document) => void (choice(document, "ch_wait")["when"] = { op: "all", args: [] }));
  derived("condition-unknown-op.json", synthetic, "notAPackage", (document) => void (choice(document, "ch_wait")["when"] = { op: "gt", fact: "lamp", value: true }));
  derived("too-many-facts.json", synthetic, "notAPackage", (document) => {
    for (let index = document.facts.length; index <= STORY_LIMITS.facts; index++) document.facts.push({ id: `flag-${index}`, type: "boolean", default: false });
  });
  derived("too-many-values.json", synthetic, "notAPackage", (document) => {
    fact(document, "key")["values"] = ["held", "left", "lost", ...Array.from({ length: STORY_LIMITS.values - 2 }, (_, index) => `spare-${index + 1}`)];
  });
  derived("clip-missing.json", synthetic, "notAPackage", (document) => void (((scene(document, "sc_vault")["clips"] as Json[])[0]!)["asset"] = "ro-nowhere"));
  derived("clip-not-video.json", synthetic, "notAPackage", (document) => void (((scene(document, "sc_vault")["clips"] as Json[])[0]!)["asset"] = "cover"));
  derived("clip-backwards.json", synthetic, "notAPackage", (document) => {
    const window = (scene(document, "sc_vault")["clips"] as Json[])[0]!;
    window["to"] = window["from"];
  });
  derived("scene-no-clips.json", synthetic, "notAPackage", (document) => void (scene(document, "sc_drowned")["clips"] = []));
  derived("movie-with-beats.json", synthetic, "notAPackage", (document) => {
    const drowned = scene(document, "sc_drowned");
    delete drowned["clips"];
    drowned["beats"] = [{ picture: "cover", line: "The water closes over." }];
  });
  derived("picture-missing.json", novel, "notAPackage", (document) => void (((scene(document, "sc_road")["beats"] as Json[])[0]!)["picture"] = "lr-nowhere"));
  derived("tall-not-picture.json", novel, "notAPackage", (document) => void (((scene(document, "sc_road")["beats"] as Json[])[0]!)["tall"] = "lr-v-home"));
  derived("voice-not-audio.json", novel, "notAPackage", (document) => void (((scene(document, "sc_market")["beats"] as Json[])[0]!)["voice"] = "lr-market"));
  derived("kind-unknown.json", synthetic, "notAPackage", (document) => void (document["kind"] = "game"));
  derived("shape-unknown.json", synthetic, "notAPackage", (document) => void (document["shape"] = "4:3"));
  derived("fingerprint-malformed.json", synthetic, "notAPackage", (document) => void (document["fingerprint"] = "sha256:0bad"));
  derived("wrong-format.json", synthetic, "notAPackage", (document) => void (document["format"] = "arke-music"));
  derived("newer-version.json", synthetic, "newerArke", (document) => void (document["version"] = 2));
  derived("requires.json", synthetic, "newerArke", (document) => void (document["requires"] = ["story-v2"]));
  derived("unknown-key.json", synthetic, "newerArke", (document) => void (scene(document, "sc_harbour")["loop"] = true));
  derived("fact-label.json", synthetic, "newerArke", (document) => void (fact(document, "key")["label"] = "The tenth key"));
  derived("condition-unknown-key.json", synthetic, "newerArke", (document) => void (choice(document, "ch_key")["when"] = { ...eq("key", "held"), weight: 2 }));
  derived("effect-unknown-key.json", synthetic, "newerArke", (document) => void (choice(document, "ch_light")["effects"] = [{ fact: "lamp", value: true, once: true }]));

  // world.json, schema 6 (R-79): Ring Once as a story package, and what such a package may not be.
  const ringAssets = Object.fromEntries(Object.entries(ASSETS).filter(([id]) => ["story", "cover", "cover-tall"].includes(id) || id.startsWith("ro-")));
  const world = {
    format: "arke-world-package",
    schemaVersion: 6,
    id: "the-undersong",
    edition: "2026-10-28",
    name: "The Undersong",
    logline: "A drowned god still sings beneath the harbour of Saltmouth.",
    alone: true,
    productions: [{ id: "ring-once", title: "Ring Once", picture: "cover", tall: "cover-tall", story: "story" }],
    assets: ringAssets,
  };
  type World = Json & { productions: Json[]; assets: Json };
  const manifest = (file: string, expect: Case["expect"], change: (manifest: World) => void, read: Json = {}) => {
    const value = clone(world) as unknown as World;
    change(value);
    files.set(file, pretty(value));
    cases.push({ file, reader: "manifest", expect, ...read });
  };
  manifest("world-story.json", "ok", () => {}, { alone: true, story: "story", tall: "cover-tall" });
  manifest("world-story-no-tall.json", "ok", (value) => void delete value.productions[0]!["tall"], { alone: true, story: "story" });
  manifest("world-story-not-alone.json", "notAPackage", (value) => void delete value["alone"]);
  manifest("world-story-with-key-art.json", "notAPackage", (value) => void (value["keyArt"] = "cover"));
  manifest("world-story-with-guide.json", "notAPackage", (value) => {
    value["guide"] = "guide";
    value.assets["guide"] = asset("guide.json", "application/vnd.arke.guide+json");
  });
  manifest("world-story-with-part.json", "notAPackage", (value) => void (value["part"] = { follows: "2026-10-24", fingerprint: "a".repeat(64), number: 1 }));
  manifest("world-story-two-productions.json", "notAPackage", (value) => void value.productions.push({ id: "ring-twice", title: "Ring Twice", story: "story" }));
  manifest("world-story-beside-music.json", "notAPackage", (value) => {
    value.productions[0]!["music"] = "music";
    value.assets["music"] = asset("ring-once/music.json", "application/vnd.arke.music+json");
  });
  manifest("world-story-wrong-media.json", "notAPackage", (value) => void (value.productions[0]!["story"] = "cover"));
  manifest("world-tall-wrong-media.json", "notAPackage", (value) => void (value.productions[0]!["tall"] = "ro-bell"));
  manifest("world-music-in-schema-6.json", "notAPackage", (value) => {
    value.productions[0] = { id: "songs-of-the-drowned-quarter", title: "Songs of the Drowned Quarter", picture: "cover", music: "music" };
    value.assets = { music: asset("songs-of-the-drowned-quarter/music.json", "application/vnd.arke.music+json"), cover: ASSETS["cover"]! };
  });
  manifest("world-story-in-schema-5.json", "newerArke", (value) => {
    value["schemaVersion"] = 5;
    delete value.productions[0]!["tall"];
  });
  manifest("world-tall-in-schema-5.json", "newerArke", (value) => {
    value["schemaVersion"] = 5;
    value.productions[0] = { id: "songs-of-the-drowned-quarter", title: "Songs of the Drowned Quarter", picture: "cover", tall: "cover-tall", music: "music" };
    value.assets = { music: asset("songs-of-the-drowned-quarter/music.json", "application/vnd.arke.music+json"), cover: ASSETS["cover"]!, "cover-tall": ASSETS["cover-tall"]! };
  });
  // Schema 7 is a graphic novel (SPEC-064 R-50): a story at 7 is not one, and 8 is the newer one.
  manifest("world-story-in-schema-7.json", "notAPackage", (value) => void (value["schemaVersion"] = 7));
  manifest("world-schema-8.json", "newerArke", (value) => void (value["schemaVersion"] = 8));

  files.set(
    "cases.json",
    pretty({
      note: CASES_NOTE,
      limits: {
        ...STORY_LIMITS,
        text: { sceneId: 128, choiceId: 128, factId: 64, value: 64, variantId: 64, sceneTitle: 500, label: 600, closedLabel: 256, reason: 600, endingTitle: 256, variantText: 20_000, speaker: 200, line: 20_000 },
      },
      cases,
    }),
  );
  return files;
}

/** The files in the fixture folder that differ from the generator's, or are missing from it, or are extra. */
export function storyFixtureDrift(dir = STORY_FIXTURES_DIR): string[] {
  const expected = storyFixtures();
  let present: string[] = [];
  try {
    present = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    // An absent folder drifts by every file.
  }
  const drift = present.filter((name) => !expected.has(name)).map((name) => `${name} is not the generator's`);
  for (const [name, text] of expected) {
    let written: string | null = null;
    try {
      written = readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n");
    } catch {
      // Reported below.
    }
    if (written === null) drift.push(`${name} is missing`);
    else if (written !== text) drift.push(`${name} has drifted`);
  }
  return drift;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const drift = storyFixtureDrift();
    for (const line of drift) console.error(line);
    process.exit(drift.length > 0 ? 1 : 0);
  }
  mkdirSync(STORY_FIXTURES_DIR, { recursive: true });
  for (const [name, text] of storyFixtures()) writeFileSync(join(STORY_FIXTURES_DIR, name), text);
  console.log(`wrote ${storyFixtures().size} files to ${STORY_FIXTURES_DIR}`);
}
