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
Object.assign(dom.HTMLElement.prototype, { focus() {} });

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
    p.click(p.button("Choose again"));
    assert.equal(p.root.getAttribute("data-mode"), "choice");
    assert.match(p.text(".aip-top"), /The drowned quarter/);
  });

  it("carries no author strip, and records nothing, without an author", () => {
    const p = mount({ autoplay: true });
    assert.equal(p.q(".aip-strip"), null);
    p.ended();
    assert.equal(p.all(".aip-chip").length, 0, "no walk marks in a package");
  });
});
