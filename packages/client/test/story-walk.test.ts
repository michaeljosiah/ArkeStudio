import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
  exploreStory,
  mountInteractivePlayer,
  storyIdentity,
  storyLoneChoice,
  storyPredicate,
  storyReplay,
  type InteractivePlayerBeat,
  type InteractivePlayerChoice,
  type InteractivePlayerHandle,
  type InteractivePlayerOptions,
  type InteractivePlayerScene,
  type StoryProgram,
} from "@arke-studio/contracts";

/**
 * A story stops only for a choice of two or more (SPEC-063 R-11a; turn 246, Player P19): a closed
 * choice shown with its reason is one of them, and a lone way plays straight through. The rule is
 * tested in contracts; this walks every route of each shared story fixture (SPEC-058 R-81) through
 * the web player itself — the one the Branch map previews and every export inlines — as a viewer
 * reaches each stop: from the start, by a choice, by Choose again on the route, back from an ending,
 * and from a place kept on the device. Every stop must show two choices or more, and the walk must
 * reach every stop the rules say the story has. Arke Player walks the same fixtures through its own
 * story screen.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../contracts/test/fixtures/world-package/story");

const dom = parseHTML("<!doctype html><html><body></body></html>");
const store = new Map<string, string>();
Object.assign(dom.window, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});
Object.assign(dom.HTMLElement.prototype, { focus() {} });

/** A story document as the fixtures hold it (SPEC-058 R-80): a guard names a beat or clip by index. */
interface StoryDocument {
  start: string;
  kind: "movie" | "novel";
  facts: NonNullable<StoryProgram["facts"]>;
  scenes: Array<{ id: string; title: string; clips?: Array<{ asset: string }>; beats?: Array<{ picture: string; line?: string; speaker?: string }> }>;
  presentation: Array<{ scene: string; index: number; when: NonNullable<StoryProgram["presentation"]>[number]["shots"][number]["when"] }>;
  choices: InteractivePlayerChoice[];
  endings: Array<{ scene: string; title: string; variants?: NonNullable<StoryProgram["endings"][number]["variants"]> }>;
}
type Beat = { picture: string; line?: string; speaker?: string };

/**
 * The player's options for a story document. Each beat or clip is a beat with a shot of its own, so
 * the document's guards hide what they hide; a film's clips are pictures here, since the player plays
 * a guarded clip only as a beat, and what a scene plays changes nothing about where it stops.
 */
function playerOptions(document: StoryDocument): InteractivePlayerOptions & { story: StoryProgram } {
  const shot = (scene: string, index: number) => `${scene}#${index}`;
  const story: StoryProgram = {
    start: document.start,
    facts: document.facts,
    choices: document.choices,
    presentation: [...new Set(document.presentation.map((row) => row.scene))].map((sceneId) => ({
      sceneId,
      blocks: [],
      shots: document.presentation.filter((row) => row.scene === sceneId).map((row) => ({ shotId: shot(sceneId, row.index), when: row.when })),
    })),
    endings: document.endings.map((ending) => ({ sceneId: ending.scene, title: ending.title, ...(ending.variants ? { variants: ending.variants } : {}) })),
  };
  const scenes: Record<string, InteractivePlayerScene> = Object.fromEntries(document.scenes.map((scene) => [scene.id, {
    title: scene.title,
    beats: (scene.beats ?? scene.clips!.map((clip): Beat => ({ picture: clip.asset }))).map((beat: Beat, index): InteractivePlayerBeat => ({
      shotId: shot(scene.id, index),
      picture: `media/${beat.picture}.jpg`,
      ...(beat.line ? { text: beat.line } : {}),
      ...(beat.speaker ? { speaker: beat.speaker } : {}),
    })),
  }]));
  return { title: "Story", start: document.start, scenes, story, choices: document.choices, endings: story.endings.map(({ sceneId, title }) => ({ sceneId, title })), storageKey: "walk" };
}

const mounted: InteractivePlayerHandle[] = [];
afterEach(() => {
  for (const handle of mounted.splice(0)) handle.destroy();
  dom.document.body.replaceChildren();
  store.clear();
});

function mount(options: InteractivePlayerOptions) {
  const root = dom.document.createElement("div");
  dom.document.body.append(root);
  mounted.push(mountInteractivePlayer(root, options));
  const all = (selector: string) => [...root.querySelectorAll(selector)] as unknown as HTMLElement[];
  const press = (element: HTMLElement | undefined) => {
    assert.ok(element, "the thing to press is there");
    element.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event);
  };
  const mode = () => root.getAttribute("data-mode");
  /** On until the player stops: a beat's hold ends as its animation would, a clip as its video would. */
  const playOn = () => {
    for (let i = 0; i < 10_000 && mode() === "playing"; i++) {
      const hold = root.querySelector(".aip-hold") as unknown as HTMLElement;
      if (hold.getAttribute("data-beat")) hold.dispatchEvent(new dom.Event("animationend", { bubbles: true }) as unknown as Event);
      else root.querySelector("video")!.dispatchEvent(new dom.Event("ended") as unknown as Event);
    }
    assert.notEqual(mode(), "playing", "the player stops");
  };
  /** The choices on screen, in order: every button, open or closed with its reason. */
  const choices = () => all(".aip-choices button[data-choice]").map((button) => button.getAttribute("data-choice")!);
  const open = () => all(".aip-choices button[data-choice]:not([disabled])").map((button) => button.getAttribute("data-choice")!);
  return { root, all, press, mode, playOn, choices, open };
}

/** The route the viewer has walked, as the player keeps it on the device. */
const route = (): string[] => JSON.parse(store.get("walk")!).route;

function walk(document: StoryDocument) {
  const options = playerOptions(document);
  const { story } = options;
  const where = (at: readonly string[]) => storyIdentity([storyReplay(story, at).sceneId, storyReplay(story, at).state]);
  const stops = new Map<string, number>();
  let endings = 0;
  let backs = 0;

  const atStop = (p: ReturnType<typeof mount>, how: string): void => {
    const at = route();
    const shown = p.choices();
    const point = storyReplay(story, at);
    const label = `${point.sceneId} after [${at.join(", ")}] (${how})`;
    assert.ok(shown.length >= 2, `${label} shows ${shown.length}`);
    assert.equal(storyLoneChoice(story.choices, point.sceneId, point.state), undefined, `${label} stopped at a lone way`);
    if (stops.has(where(at))) return;
    stops.set(where(at), shown.length);
    // Where the viewer left it: a player opened on the place this device kept, Continue, these choices.
    const kept = store.get("walk")!;
    const resumed = mount(options);
    resumed.press(resumed.all('[data-act="continue"]')[0]);
    resumed.playOn();
    assert.deepEqual(resumed.choices(), shown, `${label}, continued`);
    mounted.pop()!.destroy();
    resumed.root.remove();
    store.set("walk", kept);

    for (const [k, id] of p.open().entries()) {
      // Back here from an ending already, or else Choose again on the route at this decision (the
      // route's next step): the same choices.
      if (k > 0 && route().length > at.length) {
        p.press(p.all('[data-act="route"]')[0]);
        p.press(p.all(`.aip-panel [data-again="${at.length}"]`)[0]);
        p.playOn();
        assert.deepEqual(route(), at, `${label}: Choose again`);
        assert.deepEqual(p.choices(), shown, `${label}, chosen again`);
      }
      p.press(p.all(`.aip-choices button[data-choice="${id}"]`)[0]);
      p.playOn();
      const next = route();
      assert.deepEqual(next.slice(0, at.length + 1), [...at, id], `${label}: ${id} pressed`);
      if (p.mode() === "choice") {
        atStop(p, "chosen");
        continue;
      }
      endings++;
      // Back to last choice: the decision just made, its choices again.
      p.press(p.all('[data-act="last"]')[0]);
      p.playOn();
      backs++;
      assert.deepEqual(route(), at, `${label}: back from the ending`);
      assert.deepEqual(p.choices(), shown, `${label}, back from the ending`);
    }
  };

  const first = mount({ ...options, autoplay: true });
  first.playOn();
  if (first.mode() === "choice") atStop(first, "from the start");

  // Every stop the rules say the story has: each reachable state with a choice to make.
  const graph = exploreStory(story);
  const expected = new Set(graph.points
    .filter((point) => !storyLoneChoice(story.choices, point.sceneId, point.state) && story.choices.some((choice) => choice.from === point.sceneId && storyPredicate(choice.when, point.state)))
    .map((point) => storyIdentity([point.sceneId, point.state])));
  assert.deepEqual(new Set(stops.keys()), expected, "every stop walked");
  return { stops, endings, backs };
}

const read = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as StoryDocument;

describe("every stop of every shared story shows two choices or more (SPEC-063 R-11a)", () => {
  for (const [name, file] of [["Low Water", "low-water.json"], ["Ring Once", "synthetic.json"], ["The Lantern Road", "lantern-road.json"]] as const) {
    it(name, () => {
      const walked = walk(read(file));
      assert.ok(walked.stops.size > 0);
      assert.ok(walked.endings > 0 && walked.backs === walked.endings);
    });
  }

  // R-11: a scene with nothing to play on this route goes straight to its choices, or through its one way.
  it("a scene that plays nothing on the route", () => {
    const dark = { op: "eq" as const, fact: "lit", value: true };
    const walked = walk({
      start: "sc_door",
      kind: "novel",
      facts: [{ id: "lit", type: "boolean", default: false }],
      scenes: [
        { id: "sc_door", title: "The door", beats: [{ picture: "door", line: "It is dark." }] },
        { id: "sc_hall", title: "The hall", beats: [{ picture: "hall", line: "The lamp shows the hall." }] },
        { id: "sc_stair", title: "The stair", beats: [{ picture: "stair", line: "Up or down." }] },
        { id: "sc_cellar", title: "The cellar", beats: [{ picture: "cellar", line: "The lamp finds two doors." }] },
        { id: "sc_out", title: "Out", beats: [{ picture: "out" }] },
        { id: "sc_up", title: "Up", beats: [{ picture: "up" }] },
      ],
      presentation: [{ scene: "sc_hall", index: 0, when: dark }, { scene: "sc_cellar", index: 0, when: dark }],
      choices: [
        { id: "ch_dark", from: "sc_door", to: "sc_hall", label: "Go in", effects: [] },
        { id: "ch_light", from: "sc_door", to: "sc_hall", label: "Light the lamp", effects: [{ fact: "lit", value: true }] },
        { id: "ch_on", from: "sc_hall", to: "sc_stair", label: "On", effects: [] },
        { id: "ch_down", from: "sc_stair", to: "sc_cellar", label: "Down", effects: [] },
        { id: "ch_up", from: "sc_stair", to: "sc_up", label: "Up", effects: [] },
        { id: "ch_left", from: "sc_cellar", to: "sc_out", label: "The left door", effects: [] },
        { id: "ch_right", from: "sc_cellar", to: "sc_up", label: "The right door", effects: [] },
      ],
      endings: [{ scene: "sc_out", title: "Out" }, { scene: "sc_up", title: "Up" }],
    });
    // The door, the stair and the cellar, lit and dark; the hall is never a stop.
    assert.equal(walked.stops.size, 5);
  });
});
