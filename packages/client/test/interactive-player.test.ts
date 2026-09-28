import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { mountInteractivePlayer, type InteractivePlayerHandle, type InteractivePlayerOptions } from "@arke-studio/contracts";

/**
 * The interactive player (design turn 156), driven as a viewer and an author drive it: the one
 * module the branch map's preview mounts and every exported package inlines. The DOM is linkedom;
 * the <video> is told its clip ended the way a browser would tell it.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
const store = new Map<string, string>();
Object.assign(dom.window, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});
// linkedom keeps no focus; this does, so the tests can ask where it went.
const focusLog: unknown[] = [];
Object.assign(dom.HTMLElement.prototype, {
  focus(this: unknown) {
    focusLog.push(this);
  },
});
const focused = () => focusLog[focusLog.length - 1] ?? null;
Object.defineProperty(dom.document, "activeElement", { get: focused, configurable: true });

const OPTIONS: InteractivePlayerOptions = {
  title: "Low Water",
  eyebrow: "The Undersong",
  start: "sc_quarter",
  scenes: {
    sc_quarter: { title: "The drowned quarter", clips: ["media/sc_quarter.mp4"] },
    sc_causeway: { title: "The causeway", clips: [] },
    sc_towers: { title: "The bell towers", clips: ["media/sh_1.mp4", "media/sh_2.mp4"] },
    sc_pier: { title: "The pier at dusk", clips: ["media/sc_pier.mp4"] },
  },
  choices: [
    { id: "ch_follow", from: "sc_quarter", label: "Follow the lantern", to: "sc_causeway" },
    { id: "ch_stay", from: "sc_quarter", label: "Stay with the boat", to: "sc_towers" },
    { id: "ch_cross", from: "sc_causeway", label: "Cross before the tide", to: "sc_towers" },
    { id: "ch_sleep", from: "sc_towers", label: "Let it sleep", to: "sc_pier" },
  ],
  endings: [{ sceneId: "sc_pier", title: "The harbour, level" }],
};

const mounted: InteractivePlayerHandle[] = [];
function mount(over: Partial<InteractivePlayerOptions> = {}) {
  const root = dom.document.createElement("div");
  dom.document.body.append(root);
  const handle = mountInteractivePlayer(root, { ...OPTIONS, ...over });
  mounted.push(handle);
  const q = (selector: string) => root.querySelector(selector) as unknown as HTMLElement | null;
  const all = (selector: string) => [...root.querySelectorAll(selector)] as unknown as HTMLElement[];
  const text = (selector = ".aip-stage") => (q(selector)?.textContent ?? "").replace(/\s+/g, " ").trim();
  const video = () => q("video") as unknown as HTMLVideoElement;
  const ended = () => video().dispatchEvent(new dom.Event("ended") as unknown as Event);
  const click = (el: HTMLElement | null | undefined) => {
    assert.ok(el, "the thing to press exists");
    el.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event);
  };
  const button = (label: string) => all("button").find((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim() === label);
  const key = (name: string) => {
    const event = new dom.Event("keydown", { bubbles: true }) as unknown as KeyboardEvent;
    Object.assign(event, { key: name });
    root.dispatchEvent(event);
  };
  return { root, handle, q, all, text, video, ended, click, button, key };
}

afterEach(() => {
  for (const handle of mounted.splice(0)) handle.destroy();
  dom.document.body.replaceChildren();
  store.clear();
});

describe("the player, as the author previews it (156g)", () => {
  it("plays at once from the scene asked, with the author's strip over it", () => {
    const p = mount({ from: "sc_quarter", author: { unwalked: ["ch_stay", "ch_cross"] } });
    assert.equal(p.root.getAttribute("data-mode"), "playing");
    assert.equal(p.video().getAttribute("src"), "media/sc_quarter.mp4");
    assert.match(p.text(".aip-strip"), /Preview\s*from The drowned quarter/);
    assert.match(p.text(".aip-strip"), /2 choices not walked/);
    assert.match(p.text(".aip-top"), /The drowned quarter/, "the scene's title is the only place the player names where you are");
  });

  it("offers the choices when the scene ends, marks the unwalked, and records the walk", () => {
    const walks: Array<[string, string[]]> = [];
    const p = mount({ author: { unwalked: ["ch_stay"], onChoice: (choice, walked) => walks.push([choice.id, walked]) } });
    assert.equal(p.all(".aip-choice").length, 0, "no choices while the scene plays");
    p.ended();
    assert.equal(p.root.getAttribute("data-mode"), "choice");
    const cards = p.all(".aip-choice").map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());
    assert.deepEqual(cards, ["1Follow the lantern", "2Stay with the boatnot walked"], "authored order, a key each, the unwalked marked");
    assert.ok(p.button("Replay scene"), "the scene can be seen again before choosing");
    p.click(p.all(".aip-choice")[1]);
    assert.deepEqual(walks, [["ch_stay", ["sc_quarter"]]], "the evidence route is the scenes walked, by id");
    assert.equal(p.video().getAttribute("src"), "media/sh_1.mp4", "the next scene's first clip");
  });

  it("chooses by number from the keyboard, and nothing counts down", () => {
    const p = mount({ author: { unwalked: [] } });
    p.ended();
    p.key("1");
    assert.match(p.text(".aip-top"), /The causeway/);
  });

  it("plays a scene with no footage as a slate, its choices at once", () => {
    const p = mount({ from: "sc_causeway", author: { unwalked: [] } });
    assert.equal(p.root.getAttribute("data-mode"), "choice");
    assert.match(p.text(".aip-slate"), /The causeway\s*No accepted take/);
    assert.deepEqual(p.all(".aip-choice").map((el) => el.getAttribute("data-choice")), ["ch_cross"]);
    assert.equal(p.button("Replay scene"), undefined, "nothing to replay");
  });

  it("plays a scene's clips in order before its choices", () => {
    const p = mount({ from: "sc_towers", author: { unwalked: [] } });
    assert.equal(p.video().getAttribute("src"), "media/sh_1.mp4");
    assert.equal(p.all(".aip-seg").length, 2, "one segment per clip in the scene's bar");
    p.ended();
    assert.equal(p.video().getAttribute("src"), "media/sh_2.mp4", "the second shot, not the choices");
    assert.equal(p.root.getAttribute("data-mode"), "playing");
    p.ended();
    assert.equal(p.root.getAttribute("data-mode"), "choice");
  });

  it("seeks into another shot where its segment was clicked, not at its start", () => {
    const p = mount({ from: "sc_towers", author: { unwalked: [] } });
    const second = p.all(".aip-seg")[1]!;
    Object.assign(second, { getBoundingClientRect: () => ({ left: 0, width: 100 }) });
    const event = new dom.Event("click", { bubbles: true }) as unknown as MouseEvent;
    Object.assign(event, { clientX: 75 });
    second.dispatchEvent(event);
    assert.equal(p.video().getAttribute("src"), "media/sh_2.mp4", "the shot whose segment was clicked");
    Object.defineProperty(p.video(), "duration", { value: 40, configurable: true });
    p.video().dispatchEvent(new dom.Event("loadedmetadata") as unknown as Event);
    assert.equal(p.video().currentTime, 30, "three quarters of the way in, where the click was");
  });

  it("keeps focus in the player when a choice replaces the button that had it", () => {
    const p = mount({ author: { unwalked: [] } });
    p.ended();
    const pressed = p.all(".aip-choice")[1]!;
    pressed.focus();
    p.click(pressed);
    assert.ok(!p.root.contains(pressed as unknown as Node), "the pressed choice is gone with the scene it was offered at");
    assert.equal(focused(), p.root, "focus comes back to the player, so its keys still work and Tab stays inside");
  });

  it("passes over a clip that will not load, so the scene still reaches its choices", () => {
    const p = mount({ from: "sc_towers", author: { unwalked: [] } });
    const failed = () => p.video().dispatchEvent(new dom.Event("error") as unknown as Event);
    failed();
    assert.equal(p.video().getAttribute("src"), "media/sh_2.mp4", "on to the next shot");
    failed();
    assert.equal(p.root.getAttribute("data-mode"), "choice", "then the choices, not a player stuck playing");
  });

  it("plays a clip's window, not its whole file: from its in-point, on at its out-point", () => {
    const p = mount({
      from: "sc_towers",
      author: { unwalked: [] },
      scenes: { ...OPTIONS.scenes, sc_towers: { title: "The bell towers", clips: [{ src: "media/pass.mp4", from: 4, to: 9 }, { src: "media/pass.mp4", from: 12, to: 15 }] } },
    });
    Object.defineProperty(p.video(), "duration", { value: 30, configurable: true });
    p.video().dispatchEvent(new dom.Event("loadedmetadata") as unknown as Event);
    assert.equal(p.video().currentTime, 4, "the window's in-point, not the file's start");
    assert.match(p.text(".aip-time"), /0:00 \/ 0:05/, "the shot's own length, not the file's");
    p.video().currentTime = 9;
    p.video().dispatchEvent(new dom.Event("timeupdate") as unknown as Event);
    assert.match(p.text(".aip-time"), /Shot 2 of 2/, "the out-point ends the shot; the footage after it is not played");
    p.video().dispatchEvent(new dom.Event("loadedmetadata") as unknown as Event);
    assert.equal(p.video().currentTime, 12);
  });

  it("carries a long step across as many cuts as it covers", () => {
    const p = mount({
      from: "sc_towers",
      author: { unwalked: [] },
      scenes: {
        ...OPTIONS.scenes,
        sc_towers: {
          title: "The bell towers",
          clips: [{ src: "media/a.mp4", to: 8 }, { src: "media/b.mp4", to: 6 }, { src: "media/c.mp4", to: 6 }, { src: "media/d.mp4", to: 20 }],
        },
      },
    });
    const scrub = p.q("[data-ref=scrub]")!;
    Object.defineProperty(p.video(), "duration", { value: 60, configurable: true });
    p.video().dispatchEvent(new dom.Event("loadedmetadata") as unknown as Event);
    p.video().currentTime = 2;
    const event = new dom.Event("keydown", { bubbles: true }) as unknown as KeyboardEvent;
    Object.assign(event, { key: "PageUp" });
    scrub.dispatchEvent(event);
    // 2s into an 8s shot, 30s on: past the rest of it (6), the next two (6 and 6), 12s into the fourth.
    assert.equal(p.video().getAttribute("src"), "media/d.mp4", "three cuts crossed, not one");
    p.video().dispatchEvent(new dom.Event("loadedmetadata") as unknown as Event);
    assert.equal(p.video().currentTime, 12);
  });

  it("holds the last shot at its window's end while the choices open", () => {
    const p = mount({ author: { unwalked: [] }, scenes: { ...OPTIONS.scenes, sc_quarter: { title: "The drowned quarter", clips: [{ src: "media/q.mp4", to: 6 }] } } });
    let paused = false;
    Object.assign(p.video(), { pause: () => { paused = true; } });
    Object.defineProperty(p.video(), "duration", { value: 20, configurable: true });
    p.video().currentTime = 6;
    p.video().dispatchEvent(new dom.Event("timeupdate") as unknown as Event);
    assert.equal(p.root.getAttribute("data-mode"), "choice");
    assert.ok(paused, "the 14s after the window do not play on behind the choices");
  });

  it("keeps focus on the strip's button when new walk evidence redraws the strip", () => {
    const p = mount({ author: { unwalked: ["ch_stay"], onClose() {}, onBranchMap() {} } });
    p.q("[data-act=close]")!.focus();
    p.handle.setUnwalked([]);
    assert.equal(focused(), p.q("[data-act=close]"), "the redrawn Close preview, not the page behind the player");
  });

  it("fills the resume bar over the whole scene, not its first shot", () => {
    store.set("arke-iv-bar", JSON.stringify({ sceneId: "sc_towers", positionSec: 9, route: ["ch_stay"], updatedAt: "2026-09-27T10:00:00Z" }));
    const scenes = { ...OPTIONS.scenes, sc_towers: { title: "The bell towers", clips: [{ src: "media/sh_1.mp4", to: 8 }, { src: "media/sh_2.mp4", to: 10 }] } };
    const p = mount({ storageKey: "arke-iv-bar", scenes });
    const width = p.q(".aip-place b")!.getAttribute("style") ?? "";
    assert.match(width, /width:50%/, "9s of 18s, not 9s of the first shot's 8");
  });

  it("keeps focus in the player when the Route panel is closed from its own button", () => {
    const p = mount({ author: { unwalked: [] } });
    p.key("r");
    const close = p.q('[data-ref=panel] [data-act="route"]')!;
    close.focus();
    p.click(close);
    assert.equal(p.q("[data-ref=panel]")!.hasAttribute("hidden"), true);
    assert.equal(focused(), p.root, "focus comes back to the player, not out of it");
  });

  it("takes new walk evidence while it runs", () => {
    const p = mount({ author: { unwalked: ["ch_stay", "ch_cross"] } });
    p.handle.setUnwalked(["ch_cross"]);
    assert.match(p.text(".aip-strip"), /1 choice not walked/);
  });

  it("closes on Esc and returns to the map on its button", () => {
    let closed = 0;
    let map = 0;
    const p = mount({ author: { unwalked: [], onClose: () => (closed += 1), onBranchMap: () => (map += 1) } });
    p.key("Escape");
    p.click(p.button("Branch map"));
    assert.deepEqual([closed, map], [1, 1]);
  });
});

describe("the player, as a viewer meets the package (156a–156f)", () => {
  it("opens on its poster with Play when nothing is saved", () => {
    const p = mount({ storageKey: "arke-iv-low-water-v12" });
    assert.equal(p.root.getAttribute("data-mode"), "poster");
    assert.match(p.text("[data-ref=hero]"), /The Undersong\s*Low Water\s*Play/);
    p.click(p.button("Play"));
    assert.equal(p.root.getAttribute("data-mode"), "playing");
  });

  it("offers to continue from the saved place, and only that place", () => {
    store.set("arke-iv-low-water-v12", JSON.stringify({ sceneId: "sc_pier", positionSec: 31, route: ["ch_stay", "ch_sleep"], updatedAt: "2026-09-27T10:00:00Z" }));
    const p = mount({ storageKey: "arke-iv-low-water-v12" });
    assert.match(p.text("[data-ref=hero]"), /Continue\s*Start over\s*The pier at dusk · 0:31/);
    p.click(p.button("Continue"));
    assert.equal(p.video().getAttribute("src"), "media/sc_pier.mp4");
    const kept = JSON.parse(store.get("arke-iv-low-water-v12")!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(kept).sort(), ["positionSec", "route", "sceneId", "updatedAt"], "the viewer's place and nothing else");
  });

  it("resumes near the end of a take shorter than the one the place was saved against", () => {
    store.set("arke-iv-low-water-v12", JSON.stringify({ sceneId: "sc_pier", positionSec: 31, route: ["ch_stay", "ch_sleep"], updatedAt: "2026-09-27T10:00:00Z" }));
    const p = mount({ storageKey: "arke-iv-low-water-v12" });
    p.click(p.button("Continue"));
    Object.defineProperty(p.video(), "duration", { value: 20, configurable: true });
    p.video().dispatchEvent(new dom.Event("loadedmetadata") as unknown as Event);
    assert.ok(p.video().currentTime > 19 && p.video().currentTime < 20, "held just short of the end, not sent back to the start");
  });

  it("saves a place in the scene, not in the shot, and resumes in the shot it was in", () => {
    const scenes = { ...OPTIONS.scenes, sc_towers: { title: "The bell towers", clips: [{ src: "media/sh_1.mp4", to: 8 }, { src: "media/sh_2.mp4", to: 10 }] } };
    const first = mount({ storageKey: "arke-iv-towers", from: "sc_towers", autoplay: true, scenes });
    Object.defineProperty(first.video(), "duration", { value: 30, configurable: true });
    first.video().dispatchEvent(new dom.Event("loadedmetadata") as unknown as Event);
    first.ended();
    first.video().dispatchEvent(new dom.Event("loadedmetadata") as unknown as Event);
    first.video().currentTime = 4;
    first.video().dispatchEvent(new dom.Event("timeupdate") as unknown as Event);
    const kept = JSON.parse(store.get("arke-iv-towers")!) as { sceneId: string; positionSec: number };
    assert.deepEqual([kept.sceneId, kept.positionSec], ["sc_towers", 12], "8s of the first shot and 4s into the second");
    first.handle.destroy();
    mounted.splice(mounted.indexOf(first.handle), 1);

    const again = mount({ storageKey: "arke-iv-towers", scenes });
    again.click(again.button("Continue"));
    assert.equal(again.video().getAttribute("src"), "media/sh_2.mp4", "back in the second shot, not 12s into the first");
    Object.defineProperty(again.video(), "duration", { value: 30, configurable: true });
    again.video().dispatchEvent(new dom.Event("loadedmetadata") as unknown as Event);
    assert.equal(again.video().currentTime, 4);
  });

  it("keeps the preview's way out on a phone: the strip's buttons fold to their icons", () => {
    const p = mount({ author: { unwalked: ["ch_stay"], onClose() {}, onBranchMap() {} } });
    const css = p.q("style")?.textContent ?? "";
    assert.match(css, /@media \(max-width:640px\)\{[^@]*\.aip-strip \.t[^}]*display:none/, "labels hidden below 640, icons kept");
    const close = p.all("[data-act=close]")[0]!;
    assert.equal(close.getAttribute("aria-label"), "Close preview", "still named when only its icon shows");
    assert.ok(close.querySelector("svg"), "an icon to press");
  });

  it("returns to the choice it was left at, not the start of the scene before it", () => {
    const p = mount({ storageKey: "arke-iv-low-water-v12", autoplay: true });
    p.ended();
    const kept = JSON.parse(store.get("arke-iv-low-water-v12")!) as { sceneId: string; positionSec: number };
    assert.deepEqual([kept.sceneId, kept.positionSec], ["sc_quarter", -1], "saved as over, at its choice");
    p.handle.destroy();
    mounted.splice(mounted.indexOf(p.handle), 1);

    const again = mount({ storageKey: "arke-iv-low-water-v12" });
    assert.match(again.text("[data-ref=hero]"), /The drowned quarter · the choice/);
    again.click(again.button("Continue"));
    assert.equal(again.root.getAttribute("data-mode"), "choice", "the choice, not a replay of the scene");
    assert.equal(again.all(".aip-choice").length, 2);
  });

  it("ignores a saved scene this package does not have", () => {
    store.set("arke-iv-low-water-v12", JSON.stringify({ sceneId: "sc_gone", positionSec: 4, route: [], updatedAt: "x" }));
    const p = mount({ storageKey: "arke-iv-low-water-v12" });
    assert.ok(p.button("Play"), "it starts from the start rather than playing blind");
    assert.equal(p.button("Continue"), undefined);
  });

  it("ends on the ending's title and the route that reached it, with no tally", () => {
    const p = mount({ autoplay: true });
    p.ended();
    p.click(p.button("Stay with the boat")?.closest?.("button") ?? p.all(".aip-choice")[1]);
    p.ended();
    p.ended();
    p.click(p.all(".aip-choice")[0]);
    p.ended();
    assert.equal(p.root.getAttribute("data-mode"), "ending");
    const hero = p.text("[data-ref=hero]");
    assert.match(hero, /Ending\s*The harbour, level/);
    assert.match(hero, /The drowned quarter.*Stay with the boat.*The bell towers.*Let it sleep.*The pier at dusk/);
    assert.doesNotMatch(hero, /of \d+ endings|%/, "no count of endings found, no percentage seen");
    p.click(p.button("Back to last choice"));
    assert.equal(p.root.getAttribute("data-mode"), "choice");
    assert.match(p.text(".aip-top"), /The bell towers/, "back at the choice that led here");
  });

  it("opens the route with R, and goes back to a past choice from it", () => {
    const p = mount({ autoplay: true });
    p.ended();
    p.click(p.all(".aip-choice")[1]);
    p.key("r");
    const panel = p.q("[data-ref=panel]")!;
    assert.equal(panel.hasAttribute("hidden"), false);
    assert.match(p.text("[data-ref=panel]"), /1\s*The drowned quarter\s*Stay with the boat\s*Choose again\s*2\s*The bell towers\s*Playing/);
    assert.equal(p.video().getAttribute("src"), "media/sh_1.mp4", "the bell towers playing");
    p.click(p.button("Choose again"));
    assert.equal(p.root.getAttribute("data-mode"), "choice");
    assert.match(p.text(".aip-top"), /The drowned quarter/);
    assert.equal(p.video().getAttribute("src"), "media/sc_quarter.mp4", "its choices over its own last frame, not the later scene's");
  });

  it("puts the scene's scrubber in the tab order and gives it a slider's keys", () => {
    const p = mount({ from: "sc_pier", author: { unwalked: [] } });
    const scrub = p.q("[data-ref=scrub]")!;
    assert.equal(scrub.getAttribute("tabindex"), "0");
    Object.defineProperty(p.video(), "duration", { value: 40, configurable: true });
    const press = (name: string) => {
      const event = new dom.Event("keydown", { bubbles: true }) as unknown as KeyboardEvent;
      Object.assign(event, { key: name });
      scrub.dispatchEvent(event);
    };
    press("End");
    assert.ok(p.video().currentTime > 39, "End goes to the end of the scene");
    press("Home");
    assert.equal(p.video().currentTime, 0);
    press("ArrowUp");
    assert.equal(p.video().currentTime, 5);
  });

  it("keeps a long list of choices, and a long route to an ending, inside the player", () => {
    const p = mount();
    const css = p.q("style")?.textContent ?? "";
    assert.match(css, /\.aip-choices\{[^}]*max-height:[^}]*overflow-y:auto/);
    assert.match(css, /\.aip-hero\{[^}]*max-height:[^}]*overflow-y:auto/, "the ending's route scrolls rather than pushing its title off screen");
  });

  it("makes the scrubber the whole scene: its value and its keys cross the cuts", () => {
    const p = mount({ from: "sc_towers", author: { unwalked: [] } });
    const scrub = p.q("[data-ref=scrub]")!;
    const length = (sec: number) => {
      Object.defineProperty(p.video(), "duration", { value: sec, configurable: true });
      p.video().dispatchEvent(new dom.Event("loadedmetadata") as unknown as Event);
    };
    const press = (name: string) => {
      const event = new dom.Event("keydown", { bubbles: true }) as unknown as KeyboardEvent;
      Object.assign(event, { key: name });
      scrub.dispatchEvent(event);
    };
    length(40);
    p.video().currentTime = 38;
    press("ArrowRight");
    assert.equal(p.video().getAttribute("src"), "media/sh_2.mp4", "past the end of the first shot, into the second");
    length(20);
    assert.equal(p.video().currentTime, 3, "the seconds left over carry across the cut");
    p.video().dispatchEvent(new dom.Event("timeupdate") as unknown as Event);
    assert.equal(scrub.getAttribute("aria-valuenow"), "57", "the second of two shots, 3s of 20s in: past halfway through the scene");
    press("Home");
    assert.equal(p.video().getAttribute("src"), "media/sh_1.mp4", "Home is the scene's start, not this shot's");
    press("End");
    assert.equal(p.video().getAttribute("src"), "media/sh_2.mp4", "End is the scene's last shot");
  });

  it("carries no author strip, and records nothing, without an author", () => {
    const p = mount({ autoplay: true });
    assert.equal(p.q(".aip-strip"), null);
    p.ended();
    assert.equal(p.all(".aip-chip").length, 0, "no walk marks in a package");
  });
});

/**
 * A visual novel's scenes (design turn 174, 174d–174g): the same player reads a scene of beats —
 * a picture and a line each — at the viewer's pace. What moves a beat on by itself is a voice
 * ending or a CSS animation ending, so the tests tell the player those the way a browser would.
 */
describe("the player reading beats (turn 174)", () => {
  const NOVEL: Partial<InteractivePlayerOptions> = {
    title: "The Lantern Road",
    start: "sc_quarter",
    scenes: {
      sc_quarter: {
        title: "The drowned quarter",
        beats: [
          { picture: "media/quarter.png", text: "They hung the washing out the morning the water came.", audio: "media/wash.mp3", advance: "voice" },
          { picture: "media/rail.png", text: "Somebody lit a window down there.", speaker: "Maren", motion: "drift" },
          { picture: "media/rail.png", text: "Then it isn't somebody.", speaker: "Bray", advance: "hold", holdSec: 3 },
        ],
      },
      sc_causeway: { title: "The causeway", beats: [{ picture: "media/causeway.png", text: "The tide came in." }] },
      sc_towers: { title: "The bell towers", beats: [{ picture: "media/towers.png" }] },
      sc_pier: { title: "The pier at dusk", beats: [{ picture: "media/pier.png", text: "Level." }] },
    },
  };
  const animationEnd = (target: HTMLElement | null) => {
    assert.ok(target);
    target.dispatchEvent(new dom.Event("animationend", { bubbles: true }) as unknown as Event);
  };
  const tap = (p: ReturnType<typeof mount>) => p.click(p.q(".aip-stage"));

  it("shows a beat's picture and its line, narration without a name, a line under its speaker", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    assert.equal(p.root.getAttribute("data-kind"), "beats");
    assert.equal(p.q(".aip-pic img")?.getAttribute("src"), "media/quarter.png");
    assert.equal(p.q(".aip-box")?.getAttribute("data-kind"), "narration");
    assert.equal(p.q(".aip-who")?.hidden, true, "narration has no name tab");
    assert.equal(p.text(".aip-line"), "They hung the washing out the morning the water came.");
    assert.equal(p.all(".aip-ticks > i").length, 3, "a tick a beat");
    assert.equal(p.q("audio")?.getAttribute("src"), "media/wash.mp3", "its voice");
    assert.ok(p.button("Auto") && p.button("Log") && p.button("Route"), "the reader's chrome replaces the transport");
  });

  it("a tap shows the rest of the line first, then reads on; a voice's end moves an after-the-voice beat on", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    tap(p);
    assert.equal(p.q(".aip-box")?.hasAttribute("data-typed"), true, "the first tap completes the line");
    assert.equal(p.q(".aip-pic img")?.getAttribute("src"), "media/quarter.png", "and does not move on");
    p.q("audio")!.dispatchEvent(new dom.Event("ended") as unknown as Event);
    const hold = p.q(".aip-hold")!;
    assert.match(hold.style.animation, /aip-hold 1\.2s/, "a breath after the voice, as an animation, not a timer");
    animationEnd(hold);
    assert.equal(p.text(".aip-line"), "Somebody lit a window down there.");
    assert.equal(p.text(".aip-who"), "Maren");
    assert.equal(p.q(".aip-pic img")?.className, "m-drift");
    assert.equal(JSON.parse(store.get("k") ?? "null"), null, "no key, nothing kept");
  });

  it("a tap beat waits for the reader; a hold beat moves on after its hold; the last beat opens the choices over its line", () => {
    const p = mount({ ...NOVEL, autoplay: true, from: "sc_quarter" });
    animationEnd(p.q(".aip-hold"));
    assert.equal(p.text(".aip-line"), "They hung the washing out the morning the water came.", "no hold was set, so nothing moves it on");
    p.key("ArrowRight"); p.key("ArrowRight");
    assert.equal(p.text(".aip-who"), "Maren");
    p.key("ArrowRight"); p.key(" ");
    assert.equal(p.text(".aip-who"), "Bray");
    assert.match(p.q(".aip-hold")!.style.animation, /aip-hold 3s/, "the hold starts when the beat shows");
    animationEnd(p.q(".aip-hold"));
    assert.equal(p.root.getAttribute("data-mode"), "choice");
    assert.equal(p.q(".aip-box")?.hidden, false, "the last line stays under the choices");
    assert.deepEqual(p.all(".aip-choice .l").map((el) => el.textContent), ["Follow the lantern", "Stay with the boat"]);
    p.key("1");
    assert.equal(p.text(".aip-scene"), "The causeway");
  });

  it("a beat with no picture shows none, rather than holding the last one as if kept", () => {
    const p = mount({
      ...NOVEL,
      autoplay: true,
      scenes: { ...NOVEL.scenes, sc_quarter: { title: "Q", beats: [{ picture: "media/quarter.png", text: "One." }, { text: "Two." }] } },
    });
    assert.equal(p.q(".aip-pic img")?.getAttribute("src"), "media/quarter.png");
    p.key("ArrowRight"); p.key("ArrowRight");
    assert.equal(p.text(".aip-line"), "Two.");
    assert.equal(p.q(".aip-pic img")?.hasAttribute("src"), false);
  });

  it("a voice that will not play reads as text and waits, rather than moving on as if heard", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    p.q("audio")!.dispatchEvent(new dom.Event("error") as unknown as Event);
    assert.equal(p.q(".aip-hold")!.style.animation, "none", "an after-the-voice beat whose voice failed waits for the reader");
    assert.equal(p.q(".aip-box")?.getAttribute("data-kind"), "narration", "still on the first beat");
  });

  it("a kept picture goes on moving; the same file shown by another shot moves as its own", () => {
    const beats = (keep: boolean) => ({
      ...NOVEL,
      autoplay: true,
      scenes: { ...NOVEL.scenes, sc_quarter: { title: "Q", beats: [
        { picture: "media/rail.png", text: "One.", motion: "push" as const },
        { picture: "media/rail.png", text: "Two.", motion: "none" as const, ...(keep ? { keep: true } : {}) },
      ] } },
    });
    const kept = mount(beats(true));
    kept.key("ArrowRight"); kept.key("ArrowRight");
    assert.equal(kept.q(".aip-pic img")?.className, "m-push", "kept: the first beat's movement goes on");
    const own = mount(beats(false));
    own.key("ArrowRight"); own.key("ArrowRight");
    assert.equal(own.q(".aip-pic img")?.className, "m-none", "not kept: its own movement");
  });

  it("Auto off takes back the hold Auto started on a beat whose voice failed", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    p.key("a");
    p.q("audio")!.dispatchEvent(new dom.Event("error") as unknown as Event);
    assert.match(p.q(".aip-hold")!.style.animation, /aip-hold/, "Auto reads the unvoiced line on after a reading time");
    p.key("a");
    assert.equal(p.q(".aip-hold")!.style.animation, "none", "off again, it waits for the reader");
  });

  it("a voice the browser holds back for a gesture plays on the next tap, rather than being read as text (codex round 12)", async () => {
    const audioProto = Object.getPrototypeOf(dom.document.createElement("audio")) as { play?: () => Promise<void> };
    const had = Object.prototype.hasOwnProperty.call(audioProto, "play");
    const before = audioProto.play;
    let plays = 0;
    audioProto.play = () => {
      plays += 1;
      // The first start comes with no gesture behind it; the tap's is allowed.
      return plays === 1 ? Promise.reject(Object.assign(new Error("no gesture"), { name: "NotAllowedError" })) : Promise.resolve();
    };
    try {
      const p = mount({
        ...NOVEL,
        autoplay: true,
        scenes: { ...NOVEL.scenes, sc_quarter: { title: "Q", beats: [
          { picture: "media/a.png", text: "One.", audio: "media/one.mp3", advance: "voice" as const },
          { picture: "media/a.png", text: "Two." },
        ] } },
      });
      await new Promise((resolve) => setImmediate(resolve));
      p.key("ArrowRight");
      assert.equal(plays, 2, "the tap starts the voice");
      assert.equal(p.text(".aip-line"), "One.", "and does not move on past it");
      p.q("audio")!.dispatchEvent(new dom.Event("ended") as unknown as Event);
      assert.match(p.q(".aip-hold")!.style.animation, /aip-hold 1\.2s/, "heard, so it moves on after its breath");
    } finally {
      if (had) audioProto.play = before; else delete audioProto.play;
    }
  });

  it("a start refused after the reader moved on does not mark the next beat's voice lost", async () => {
    const audioProto = Object.getPrototypeOf(dom.document.createElement("audio")) as { play?: () => Promise<void> };
    const had = Object.prototype.hasOwnProperty.call(audioProto, "play");
    const before = audioProto.play;
    const rejects: Array<() => void> = [];
    audioProto.play = () => new Promise<void>((_, reject) => { rejects.push(() => reject(new Error("aborted"))); });
    try {
      const p = mount({
        ...NOVEL,
        autoplay: true,
        scenes: { ...NOVEL.scenes, sc_quarter: { title: "Q", beats: [
          { picture: "media/a.png", text: "One.", audio: "media/one.mp3", advance: "voice" as const },
          { picture: "media/a.png", text: "Two.", audio: "media/two.mp3", advance: "voice" as const },
        ] } },
      });
      p.key("ArrowRight"); p.key("ArrowRight");
      assert.equal(p.text(".aip-line"), "Two.");
      rejects[0]!();
      await new Promise((resolve) => setImmediate(resolve));
      p.q("audio")!.dispatchEvent(new dom.Event("ended") as unknown as Event);
      assert.match(p.q(".aip-hold")!.style.animation, /aip-hold 1\.2s/, "beat two's voice was heard, so it moves on after its breath");
    } finally {
      if (had) audioProto.play = before; else delete audioProto.play;
    }
  });

  it("back one beat with the left arrow, never across a choice", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    p.key("ArrowRight"); p.key("ArrowRight");
    assert.equal(p.text(".aip-who"), "Maren");
    p.key("ArrowLeft");
    assert.equal(p.q(".aip-box")?.getAttribute("data-kind"), "narration");
    p.key("ArrowLeft");
    assert.equal(p.q(".aip-box")?.getAttribute("data-kind"), "narration", "the scene's first beat is as far back as it goes");
  });

  it("Auto moves a tap beat on after a reading time, and off again waits", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    p.key("ArrowRight"); p.key("ArrowRight");
    assert.equal(p.q(".aip-hold")!.style.animation, "none", "a tap beat waits");
    p.click(p.button("Auto"));
    assert.equal(p.button("Auto")?.getAttribute("aria-pressed"), "true");
    assert.match(p.q(".aip-hold")!.style.animation, /aip-hold 3\.3s/, "1.5s and 0.3s a word");
    p.key("a");
    assert.equal(p.q(".aip-hold")!.style.animation, "none", "Auto off, it waits again");
  });

  it("the log lists the scene's lines so far and plays one again without moving the story", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    p.key("ArrowRight"); p.key("ArrowRight");
    p.key("l");
    const log = p.q('[aria-label="Log"]')!;
    assert.equal(log.hidden, false);
    assert.deepEqual(p.all(".aip-log-line .t").map((el) => el.textContent), ["They hung the washing out the morning the water came.", "Somebody lit a window down there."]);
    p.click(log.querySelector('[aria-label="Play line"]') as unknown as HTMLElement);
    assert.equal(p.all("audio")[1]?.getAttribute("src"), "media/wash.mp3", "heard on its own player");
    assert.equal(p.text(".aip-who"), "Maren", "the story has not moved");
    p.key("Escape");
    assert.equal(log.hidden, true, "Escape closes the log first");
  });

  it("dialogue still waiting for its speaker reads as dialogue, never as narration (codex round 8)", () => {
    const p = mount({
      ...NOVEL,
      autoplay: true,
      scenes: { ...NOVEL.scenes, sc_quarter: { title: "Draft", beats: [{ picture: "media/quarter.png", text: "Who said this?", dialogue: true }] } },
    });
    assert.equal(p.q(".aip-box")?.getAttribute("data-kind"), "dialogue");
    assert.equal(p.q(".aip-who")?.hidden, true, "no name to show on the tab");
    p.key("l");
    assert.equal(p.all(".aip-log-line.narration").length, 0, "nor as narration in the log");
  });

  it("R opens the route over an open log by closing the log, one panel at a time (codex round 10)", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    p.key("l");
    assert.equal(p.q('[aria-label="Log"]')!.hidden, false);
    p.key("r");
    assert.equal(p.q("[data-ref=panel]")!.hasAttribute("hidden"), false, "the route opens");
    assert.equal(p.q('[aria-label="Log"]')!.hidden, true, "and the log steps aside");
    assert.equal(p.button("Log")?.getAttribute("aria-pressed"), "false");
  });

  it("a line replayed from the log stops when the scene ends, never sounding over the choice (codex round 11)", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    // On to the last beat, the log open, the first line played again on its own player.
    for (let i = 0; i < 4; i += 1) p.key("ArrowRight");
    p.key("l");
    const logVoice = p.all("audio")[1]! as unknown as HTMLMediaElement;
    let stopped = false;
    Object.assign(logVoice, { play: () => Promise.resolve(), pause: () => { stopped = true; } });
    p.click(p.q('[aria-label="Log"] [aria-label="Play line"]') as unknown as HTMLElement);
    assert.equal(logVoice.getAttribute("src"), "media/wash.mp3");
    p.key("Escape");
    p.key("ArrowRight"); p.key("ArrowRight");
    assert.ok(stopped, "the log's voice stops with the scene");
  });

  it("a line played again from the log stops the beat's own voice: one voice at a time (codex round 15)", () => {
    const p = mount({
      ...NOVEL,
      autoplay: true,
      scenes: { ...NOVEL.scenes, sc_quarter: { title: "Q", beats: [
        { picture: "media/a.png", text: "One.", audio: "media/one.mp3", advance: "voice" as const },
        { picture: "media/a.png", text: "Two.", audio: "media/two.mp3", advance: "voice" as const },
      ] } },
    });
    // Beat one heard to its end; beat two's voice is still speaking when its log line is pressed.
    p.q("audio")!.dispatchEvent(new dom.Event("ended") as unknown as Event);
    p.key("ArrowRight"); p.key("ArrowRight");
    assert.equal(p.text(".aip-line"), "Two.");
    const voice = p.all("audio")[0]! as unknown as HTMLMediaElement;
    let stopped = false;
    Object.assign(voice, { pause: () => { stopped = true; } });
    p.key("l");
    p.click(p.q('[aria-label="Log"] [data-line="0"]') as unknown as HTMLElement);
    assert.ok(stopped, "the beat's voice stops for the line heard again");
    assert.equal(p.q(".aip-hold")!.style.animation, "none", "and the beat waits for the reader rather than moving on");
  });

  it("keeps the focus on the open log's control when the reader moves on beneath it", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    p.key("ArrowRight"); p.key("ArrowRight");
    p.key("l");
    const log = p.q('[aria-label="Log"]')!;
    const close = log.querySelector('[data-act="log"]') as unknown as HTMLElement;
    close.focus();
    p.key("a");
    assert.equal(focused(), close, "a redraw that changes nothing replaces nothing");
    (log.querySelector('[aria-label="Play line"]') as unknown as HTMLElement).focus();
    // The first press finishes the line typing; the second reads on, and the log gains a line.
    p.key("ArrowRight"); p.key("ArrowRight");
    assert.equal(p.all(".aip-log-line").length, 3, "the next line joined the log");
    const again = focused() as HTMLElement;
    assert.ok(log.contains(again), "focus stays in the log, inside the player");
    assert.equal(again.getAttribute("data-line"), "0", "on the same line's Play button");
  });

  it("keeps the place as a beat, in the same four fields, and reopens on it", () => {
    const KEY = "arke-iv-test-beats";
    const p = mount({ ...NOVEL, autoplay: true, storageKey: KEY });
    p.key("ArrowRight"); p.key("ArrowRight");
    const saved = JSON.parse(store.get(KEY)!);
    assert.deepEqual(Object.keys(saved).sort(), ["positionSec", "route", "sceneId", "updatedAt"]);
    assert.equal(saved.positionSec, 1, "the second beat");
    p.handle.destroy();
    const again = mount({ ...NOVEL, storageKey: KEY });
    assert.equal(again.root.getAttribute("data-mode"), "poster");
    assert.match(again.text(".aip-place"), /beat 2 of 3/);
    assert.equal(again.q(".aip-pic img")?.getAttribute("src"), "media/rail.png", "the poster is the saved beat's picture");
    again.click(again.button("Continue"));
    assert.equal(again.text(".aip-who"), "Maren");
  });
});
