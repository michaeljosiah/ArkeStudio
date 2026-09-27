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
