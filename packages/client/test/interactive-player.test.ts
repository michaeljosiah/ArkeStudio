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
    const p = mount({
      from: "sc_causeway",
      author: { unwalked: [] },
      choices: [...OPTIONS.choices, { id: "ch_back", from: "sc_causeway", label: "Go back for the boat", to: "sc_quarter" }],
    });
    assert.equal(p.root.getAttribute("data-mode"), "choice");
    assert.match(p.text(".aip-slate"), /The causeway\s*No accepted take/);
    assert.deepEqual(p.all(".aip-choice").map((el) => el.getAttribute("data-choice")), ["ch_cross", "ch_back"]);
    assert.equal(p.button("Replay scene"), undefined, "nothing to replay");
  });

  it("holds a slate with one way on for a breath, then plays through it (turn 246)", () => {
    const p = mount({ from: "sc_causeway", author: { unwalked: [] } });
    assert.equal(p.root.getAttribute("data-mode"), "playing", "a lone way is never offered");
    assert.equal(p.all(".aip-choice").length, 0);
    assert.match(p.text(".aip-slate"), /The causeway\s*No accepted take/, "the title card shows while it holds");
    const hold = p.q(".aip-hold")!;
    assert.match(hold.style.animation, /aip-hold 1\.5s/, "a breath as an animation, so a run of slates never spins");
    hold.dispatchEvent(new dom.Event("animationend", { bubbles: true }) as unknown as Event);
    assert.equal(p.video().getAttribute("src"), "media/sh_1.mp4", "then on into the scene its one way leads to");
    assert.match(p.text(".aip-top"), /The bell towers/);
  });

  it("plays a scene's clips in order, then straight through its one way on (turn 246)", () => {
    const p = mount({ from: "sc_towers", author: { unwalked: [] } });
    assert.equal(p.video().getAttribute("src"), "media/sh_1.mp4");
    assert.equal(p.all(".aip-seg").length, 2, "one segment per clip in the scene's bar");
    assert.equal(p.q(".aip-fork"), null, "no choice waits at the end of a scene with one way on");
    p.ended();
    assert.equal(p.video().getAttribute("src"), "media/sh_2.mp4", "the second shot, not the next scene");
    assert.equal(p.root.getAttribute("data-mode"), "playing");
    p.ended();
    assert.equal(p.root.getAttribute("data-mode"), "playing", "no stop for a lone way");
    assert.equal(p.all(".aip-choice").length, 0, "and no button for it");
    assert.equal(p.video().getAttribute("src"), "media/sc_pier.mp4", "the scene it leads to plays");
    assert.match(p.text(".aip-top"), /The pier at dusk/);
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

  it("passes over a clip that will not load, so the scene still moves on", () => {
    const p = mount({ from: "sc_towers", author: { unwalked: [] } });
    const failed = () => p.video().dispatchEvent(new dom.Event("error") as unknown as Event);
    failed();
    assert.equal(p.video().getAttribute("src"), "media/sh_2.mp4", "on to the next shot");
    failed();
    assert.equal(p.video().getAttribute("src"), "media/sc_pier.mp4", "then on through its one way, not a player stuck playing");
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
    const p = mount({ autoplay: true, storageKey: "arke-iv-ending" });
    p.ended();
    p.click(p.all(".aip-choice")[1]);
    p.ended();
    p.ended();
    // The bell towers have one way on: it plays straight through, unseen (turn 246).
    p.ended();
    assert.equal(p.root.getAttribute("data-mode"), "ending");
    const hero = p.text("[data-ref=hero]");
    assert.match(hero, /Ending\s*The harbour, level/);
    assert.match(hero, /The drowned quarter.*Stay with the boat.*The bell towers.*The pier at dusk/);
    assert.doesNotMatch(hero, /Let it sleep/, "a link's label is the author's note, never shown to a listener");
    assert.deepEqual(JSON.parse(store.get("arke-iv-ending")!).route, ["ch_stay", "ch_sleep"], "the link is still a step of the route");
    assert.doesNotMatch(hero, /of \d+ endings|%/, "no count of endings found, no percentage seen");
    p.click(p.button("Back to last choice"));
    assert.equal(p.root.getAttribute("data-mode"), "choice");
    assert.match(p.text(".aip-top"), /The drowned quarter/, "back at the last choice made, past the link played through");
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
 * A visual novel's scenes (design turn 174, 174d–174g), playing themselves (turn 246): the same
 * player reads a scene of beats — a picture and a line each — and moves on once each is heard. What
 * moves a beat on is a voice ending or a CSS animation ending, so the tests tell the player those
 * the way a browser would. A tap shows the controls; nothing a listener presses moves the story on.
 */
describe("the player reading beats (turns 174 and 246)", () => {
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
  const TWO_VOICES: Partial<InteractivePlayerOptions> = {
    ...NOVEL,
    scenes: { ...NOVEL.scenes, sc_quarter: { title: "Q", beats: [
      { picture: "media/a.png", text: "One.", audio: "media/one.mp3", advance: "voice" as const },
      { picture: "media/a.png", text: "Two.", audio: "media/two.mp3", advance: "voice" as const },
    ] } },
  };
  const animationEnd = (target: HTMLElement | null, animationName = "aip-hold") => {
    assert.ok(target);
    const event = new dom.Event("animationend", { bubbles: true });
    Object.assign(event, { animationName });
    target.dispatchEvent(event as unknown as Event);
  };
  const tap = (p: ReturnType<typeof mount>) => p.click(p.q(".aip-stage"));
  const hold = (p: ReturnType<typeof mount>) => p.q(".aip-hold")!;
  const heard = (p: ReturnType<typeof mount>) => p.q("audio")!.dispatchEvent(new dom.Event("ended") as unknown as Event);
  /** On to the next beat as a browser moves it: the beat's voice heard to its end, then its hold run out. */
  const onward = (p: ReturnType<typeof mount>) => {
    if (!hold(p).hasAttribute("data-beat")) heard(p);
    animationEnd(hold(p));
  };
  const shown = (p: ReturnType<typeof mount>) => p.root.classList.contains("aip-shown");

  it("shows a beat's picture and its line, narration without a name, a line under its speaker, and a film's bar", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    assert.equal(p.root.getAttribute("data-kind"), "beats");
    assert.equal(p.q(".aip-pic img")?.getAttribute("src"), "media/quarter.png");
    assert.equal(p.q(".aip-box")?.getAttribute("data-kind"), "narration");
    assert.equal(p.q(".aip-who")?.hidden, true, "narration has no name tab");
    assert.equal(p.text(".aip-line"), "They hung the washing out the morning the water came.");
    assert.equal(p.all(".aip-ticks > i").length, 3, "a tick a beat");
    assert.equal(p.q("audio")?.getAttribute("src"), "media/wash.mp3", "its voice");
    // 156a's film bar at the foot (246b): Pause, Back and Narration, then Log, Route and Full screen.
    const bar = p.q(".aip-beatbar")!;
    assert.deepEqual(
      [...bar.querySelectorAll("button")].map((button) => button.getAttribute("aria-label") ?? (button.textContent ?? "").trim()),
      ["Pause", "Back", "Narration", "Log", "Route", "Full screen"],
    );
    assert.equal(p.button("Auto"), undefined, "Auto is gone: Play/Pause replaces it");
    assert.doesNotMatch(p.text(), /\btap\b/, "nothing asks for a tap");
  });

  it("no tap moves on: a click shows the controls, another hides them, and Enter moves nothing", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    animationEnd(p.q(".aip-beatbar"), "aip-rest");
    assert.equal(shown(p), false, "the controls rest while the story plays");
    tap(p);
    assert.equal(shown(p), true, "a click shows them");
    assert.equal(p.text(".aip-line"), "They hung the washing out the morning the water came.", "and does not move on");
    tap(p);
    assert.equal(shown(p), false, "another hides them");
    p.key("Enter");
    p.key(" ");
    p.key(" ");
    assert.equal(p.text(".aip-line"), "They hung the washing out the morning the water came.", "Enter no longer moves on; Space pauses and plays");
    // Pressed where the resting bar was, a control nobody could see shows the bar rather than acting.
    tap(p);
    tap(p);
    assert.equal(shown(p), false);
    p.click(p.q('[data-ref="beatToggle"]'));
    assert.equal(p.root.hasAttribute("data-paused"), false, "the hidden Pause was not pressed");
    assert.equal(shown(p), true, "the bar shows instead");
    p.click(p.q('[data-ref="beatToggle"]'));
    assert.equal(p.root.hasAttribute("data-paused"), true, "shown, it is a button");
  });

  it("a tap on the resting bar shows it, though the tap's own touch woke the bar first (codex on PR 2228)", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    animationEnd(p.q(".aip-beatbar"), "aip-rest");
    assert.equal(shown(p), false);
    const pause = p.q('[data-ref="beatToggle"]')!;
    const touch = (target: EventTarget, type: string) => {
      const event = new dom.Event(type, { bubbles: true });
      Object.assign(event, { pointerType: "touch", pointerId: 7 });
      target.dispatchEvent(event as unknown as Event);
    };
    touch(pause as unknown as EventTarget, "pointerdown");
    touch(dom.window as unknown as EventTarget, "pointerup");
    p.click(pause);
    assert.equal(p.root.hasAttribute("data-paused"), false, "the unseen Pause was not pressed");
    assert.equal(shown(p), true, "the bar shows");
    touch(pause as unknown as EventTarget, "pointerdown");
    touch(dom.window as unknown as EventTarget, "pointerup");
    p.click(pause);
    assert.equal(p.root.hasAttribute("data-paused"), true, "seen, the next tap presses it");
  });

  it("pauses a line heard again from the Log with the story, and plays it on after (codex on PR 2228)", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    onward(p);
    p.key("l");
    const logVoice = p.all("audio")[1]! as unknown as HTMLMediaElement;
    const calls: string[] = [];
    Object.assign(logVoice, { paused: true, play: () => { calls.push("play"); Object.assign(logVoice, { paused: false }); return Promise.resolve(); }, pause: () => { calls.push("pause"); Object.assign(logVoice, { paused: true }); } });
    p.click(p.q('[aria-label="Log"] [aria-label="Play line"]') as unknown as HTMLElement);
    assert.deepEqual(calls, ["play"]);
    p.key(" ");
    assert.equal(p.root.hasAttribute("data-paused"), true);
    assert.deepEqual(calls, ["play", "pause"], "the line heard again pauses with the story");
    p.key(" ");
    assert.deepEqual(calls, ["play", "pause", "play"], "and goes on with Play");
    p.key(" ");
    p.key("ArrowLeft");
    p.key(" ");
    assert.deepEqual(calls.slice(-2), ["pause", "pause"], "moved off its beat while paused, it is not taken up again");
  });

  it("plays itself: a voiced beat 1.2 s after its voice, an unvoiced one for its reading time, a Hold beat its own seconds", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    assert.equal(hold(p).style.animation, "none", "a voiced beat waits for its voice");
    heard(p);
    assert.match(hold(p).style.animation, /aip-hold 1\.2s/, "a breath after the voice, as an animation, not a timer");
    animationEnd(hold(p));
    assert.equal(p.text(".aip-who"), "Maren");
    assert.equal(p.q(".aip-pic img")?.className, "m-drift");
    assert.match(hold(p).style.animation, /aip-hold 3\.3s/, "unvoiced: 1.5 s and 0.3 s a word, six words");
    animationEnd(hold(p));
    assert.equal(p.text(".aip-who"), "Bray");
    assert.match(hold(p).style.animation, /aip-hold 3s/, "a Hold beat holds its own seconds, from when it shows");
    animationEnd(hold(p));
    assert.equal(p.root.getAttribute("data-mode"), "choice", "it stops only for a choice of two");
    assert.equal(p.q(".aip-box")?.hidden, false, "the last line stays under the choices");
    assert.deepEqual(p.all(".aip-choice .l").map((el) => el.textContent), ["Follow the lantern", "Stay with the boat"]);
    assert.equal(p.button("Replay scene"), undefined, "a visual novel's Back replays the beat; 246e has no Replay scene");
    p.key("1");
    assert.equal(p.text(".aip-scene"), "The causeway");
    assert.equal(JSON.parse(store.get("k") ?? "null"), null, "no key, nothing kept");
  });

  it("reads a long line for at most 12 s, and a beat saved On tap as after the line", () => {
    const long = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
    const p = mount({
      ...NOVEL,
      autoplay: true,
      scenes: { ...NOVEL.scenes, sc_quarter: { title: "Q", beats: [
        { picture: "media/a.png", text: long, advance: "tap" as const },
        { picture: "media/a.png", text: "Three small words.", audio: "media/three.mp3", advance: "tap" as const },
        { picture: "media/a.png", text: "Three small words.", advance: "tap" as const },
      ] } },
    });
    assert.match(hold(p).style.animation, /aip-hold 12s/, "an On tap beat plays after its line; a long one holds 12 s at most");
    animationEnd(hold(p));
    assert.equal(hold(p).style.animation, "none", "a voiced On tap beat waits for its voice");
    heard(p);
    assert.match(hold(p).style.animation, /aip-hold 1\.2s/, "then moves on after its breath");
    animationEnd(hold(p));
    assert.match(hold(p).style.animation, /aip-hold 2\.4s/, "three words: 1.5 s and 0.9 s");
  });

  it("fills the current beat's tick as it plays: over its voice, then over a reading time", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    const audio = p.q("audio")! as unknown as HTMLMediaElement;
    Object.defineProperty(audio, "duration", { value: 4, configurable: true });
    Object.assign(audio, { currentTime: 1 });
    audio.dispatchEvent(new dom.Event("timeupdate") as unknown as Event);
    assert.equal(p.q(".aip-ticks b")?.style.width, "25%", "a quarter of the voice heard, a quarter of the tick");
    heard(p);
    assert.equal(p.q(".aip-ticks b")?.style.width, "100%", "full through the breath after it");
    animationEnd(hold(p));
    assert.equal(p.all(".aip-ticks > i.done").length, 1, "the beat read is full");
    assert.match(p.q(".aip-ticks b")!.style.animation, /aip-fill 3\.3s/, "the next fills over its reading time");
    const css = p.q("style")?.textContent ?? "";
    assert.match(css, /\.aip\[data-kind="beats"\]\.aip-shown \.aip-ticks[^{]*\{bottom:37px\}/, "in the bar's centre while it shows");
  });

  it("reads a voice that will not play as text for its reading time", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    p.q("audio")!.dispatchEvent(new dom.Event("error") as unknown as Event);
    assert.match(hold(p).style.animation, /aip-hold 4\.5s/, "ten words, read rather than heard");
    assert.equal(p.q(".aip-box")?.getAttribute("data-kind"), "narration", "still on the first beat");
  });

  it("reads a voice the browser will not start before a gesture as text, never waiting for a tap (turn 246)", async () => {
    const audioProto = Object.getPrototypeOf(dom.document.createElement("audio")) as { play?: () => Promise<void> };
    const had = Object.prototype.hasOwnProperty.call(audioProto, "play");
    const before = audioProto.play;
    let plays = 0;
    audioProto.play = () => {
      plays += 1;
      return Promise.reject(Object.assign(new Error("no gesture"), { name: "NotAllowedError" }));
    };
    try {
      const p = mount({ ...TWO_VOICES, autoplay: true });
      await new Promise((resolve) => setImmediate(resolve));
      assert.match(hold(p).style.animation, /aip-hold 1\.8s/, "One. is read for its reading time");
      tap(p);
      assert.equal(plays, 1, "a tap shows the controls; it is not asked to start the voice");
      animationEnd(hold(p));
      assert.equal(p.text(".aip-line"), "Two.", "and the story moved on by itself");
    } finally {
      if (had) audioProto.play = before; else delete audioProto.play;
    }
  });

  it("a start refused after the author moved on does not mark the next beat's voice lost", async () => {
    const audioProto = Object.getPrototypeOf(dom.document.createElement("audio")) as { play?: () => Promise<void> };
    const had = Object.prototype.hasOwnProperty.call(audioProto, "play");
    const before = audioProto.play;
    const rejects: Array<() => void> = [];
    audioProto.play = () => new Promise<void>((_, reject) => { rejects.push(() => reject(new Error("aborted"))); });
    try {
      const p = mount({ ...TWO_VOICES, autoplay: true, author: { unwalked: [] } });
      p.key("ArrowRight");
      assert.equal(p.text(".aip-line"), "Two.");
      rejects[0]!();
      await new Promise((resolve) => setImmediate(resolve));
      heard(p);
      assert.match(hold(p).style.animation, /aip-hold 1\.2s/, "beat two's voice was heard, so it moves on after its breath");
    } finally {
      if (had) audioProto.play = before; else delete audioProto.play;
    }
  });

  it("keeps → for the author: the next beat in Preview, nothing in a listener's package", () => {
    const viewer = mount({ ...NOVEL, autoplay: true });
    viewer.key("ArrowRight");
    assert.equal(viewer.q(".aip-box")?.getAttribute("data-kind"), "narration", "a listener never needs it");
    const author = mount({ ...NOVEL, autoplay: true, author: { unwalked: [] } });
    author.key("ArrowRight");
    assert.equal(author.text(".aip-who"), "Maren", "the author skips ahead, mid-voice");
  });

  it("goes back one beat with ← or Back, never across a choice; at a choice, Back plays its beat again", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    onward(p);
    assert.equal(p.text(".aip-who"), "Maren");
    p.key("ArrowLeft");
    assert.equal(p.q(".aip-box")?.getAttribute("data-kind"), "narration");
    p.click(p.q('[data-act="prev"]'));
    assert.equal(p.q(".aip-box")?.getAttribute("data-kind"), "narration", "the scene's first beat is as far back as it goes");
    onward(p);
    onward(p);
    onward(p);
    assert.equal(p.root.getAttribute("data-mode"), "choice");
    p.key("ArrowLeft");
    assert.equal(p.root.getAttribute("data-mode"), "playing");
    assert.equal(p.text(".aip-who"), "Bray", "the beat the choice was offered over, again");
    assert.match(hold(p).style.animation, /aip-hold 3s/, "and it plays on to the choice by itself");
  });

  it("pauses where it is, and plays on from there (246c)", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    const voice = p.q("audio")! as unknown as HTMLMediaElement;
    let stopped = 0;
    let started = 0;
    Object.assign(voice, { pause: () => { stopped += 1; }, play: () => { started += 1; return Promise.resolve(); } });
    p.key(" ");
    assert.equal(p.root.hasAttribute("data-paused"), true);
    assert.equal(stopped, 1, "the voice waits");
    assert.equal(p.q('[data-ref="beatToggle"]')?.getAttribute("aria-label"), "Play");
    assert.equal(p.q(".aip-big")?.hidden, false, "a Play at the centre");
    const css = p.q("style")?.textContent ?? "";
    assert.match(css, /\[data-paused\] \.aip-hold,[^{]*\{animation-play-state:paused!important\}/, "the hold, the tick and the picture wait too, by CSS");
    tap(p);
    tap(p);
    assert.equal(shown(p), true, "paused, the controls stay");
    animationEnd(p.q(".aip-beatbar"), "aip-rest");
    assert.equal(shown(p), true);
    p.click(p.q(".aip-big"));
    assert.equal(p.root.hasAttribute("data-paused"), false);
    assert.equal(started, 1, "the voice goes on");
    assert.equal(p.q(".aip-big")?.hidden, true);
  });

  it("turns Narration off and on where the story has voices: off, each beat holds for its reading time", () => {
    const p = mount({ ...TWO_VOICES, autoplay: true });
    const voice = p.q("audio")! as unknown as HTMLMediaElement;
    let stopped = false;
    Object.assign(voice, { pause: () => { stopped = true; } });
    const narration = p.button("Narration")!;
    assert.equal(narration.hidden, false);
    assert.equal(narration.getAttribute("aria-pressed"), "true", "on where the story carries voices");
    p.click(narration);
    assert.equal(narration.getAttribute("aria-pressed"), "false");
    assert.ok(stopped, "the voice stops");
    assert.match(hold(p).style.animation, /aip-hold 1\.8s/, "and the beat holds for its reading time");
    animationEnd(hold(p));
    assert.equal(p.text(".aip-line"), "Two.");
    assert.equal(voice.hasAttribute("src"), false, "with Narration off the next beat is not read out");
    assert.match(hold(p).style.animation, /aip-hold 1\.8s/);
    p.key("n");
    assert.equal(voice.getAttribute("src"), "media/two.mp3", "on again, the line not yet heard is read out");
    assert.equal(hold(p).style.animation, "none", "and the beat waits for it");
    const silent = mount({ ...NOVEL, autoplay: true, scenes: { sc_quarter: { title: "Q", beats: [{ picture: "media/a.png", text: "One." }] } } });
    assert.equal(silent.button("Narration")?.hidden, true, "no Narration in a story without voices (246f)");
  });

  it("stops a line heard again from the Log when Narration comes back on: one voice at a time (codex on PR 2228)", () => {
    const run = (pauseFirst: boolean) => {
      const p = mount({ ...TWO_VOICES, autoplay: true });
      const voice = p.all("audio")[0]! as unknown as HTMLMediaElement;
      const logVoice = p.all("audio")[1]! as unknown as HTMLMediaElement;
      const calls: string[] = [];
      Object.assign(voice, { play: () => { calls.push("voice play"); return Promise.resolve(); }, pause: () => calls.push("voice pause") });
      Object.assign(logVoice, { paused: true, play: () => { calls.push("log play"); Object.assign(logVoice, { paused: false }); return Promise.resolve(); }, pause: () => { calls.push("log pause"); Object.assign(logVoice, { paused: true }); } });
      p.key("n");
      p.key("l");
      p.click(p.q('[aria-label="Log"] [data-line="0"]') as unknown as HTMLElement);
      if (pauseFirst) p.key(" ");
      calls.length = 0;
      p.key("n");
      assert.equal(calls[0], "log pause", "the line heard again stops first");
      if (pauseFirst) {
        assert.ok(!calls.includes("voice play"), "paused, the beat's voice waits for Play");
        p.key(" ");
        assert.ok(!calls.includes("log play"), "and Play brings back the beat's voice, not the Log's");
      }
      assert.ok(calls.includes("voice play"), "then the beat's own voice reads");
      assert.equal(voice.getAttribute("src"), "media/one.mp3");
    };
    run(false);
    run(true);
  });

  it("opens Log and Route over a playing story without pausing it", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    onward(p);
    assert.match(hold(p).style.animation, /aip-hold 3\.3s/);
    p.key("l");
    assert.equal(p.q('[aria-label="Log"]')!.hidden, false);
    assert.equal(p.root.hasAttribute("data-paused"), false, "the story is not paused");
    assert.match(hold(p).style.animation, /aip-hold 3\.3s/, "its hold runs on");
    p.key("r");
    assert.equal(p.q("[data-ref=panel]")!.hasAttribute("hidden"), false);
    assert.equal(p.root.hasAttribute("data-paused"), false);
    animationEnd(hold(p));
    assert.equal(p.text(".aip-who"), "Bray", "and moves on beneath the panel");
  });

  it("the log lists the scene's lines so far and plays one again without moving the story", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    onward(p);
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
    onward(p);
    onward(p);
    p.key("l");
    const logVoice = p.all("audio")[1]! as unknown as HTMLMediaElement;
    let stopped = false;
    Object.assign(logVoice, { play: () => Promise.resolve(), pause: () => { stopped = true; } });
    p.click(p.q('[aria-label="Log"] [aria-label="Play line"]') as unknown as HTMLElement);
    assert.equal(logVoice.getAttribute("src"), "media/wash.mp3");
    p.key("Escape");
    logVoice.dispatchEvent(new dom.Event("ended") as unknown as Event);
    animationEnd(hold(p));
    assert.equal(p.root.getAttribute("data-mode"), "choice");
    assert.ok(stopped, "the log's voice stops with the scene");
  });

  it("a line played again from the log stops the beat's own voice: one voice at a time (codex round 15)", () => {
    const p = mount({ ...TWO_VOICES, autoplay: true });
    // Beat one heard to its end; beat two's voice is still speaking when its log line is pressed.
    onward(p);
    assert.equal(p.text(".aip-line"), "Two.");
    const voice = p.all("audio")[0]! as unknown as HTMLMediaElement;
    let stopped = false;
    Object.assign(voice, { pause: () => { stopped = true; } });
    p.key("l");
    p.click(p.q('[aria-label="Log"] [data-line="0"]') as unknown as HTMLElement);
    assert.ok(stopped, "the beat's voice stops for the line heard again");
    assert.equal(hold(p).style.animation, "none", "and the beat waits for it rather than moving on");
  });

  it("a line heard again from the log is heard out before the story reads on (codex round 17)", () => {
    const p = mount({ ...TWO_VOICES, autoplay: true });
    onward(p);
    p.key("l");
    p.click(p.q('[aria-label="Log"] [data-line="0"]') as unknown as HTMLElement);
    assert.equal(hold(p).style.animation, "none", "the story does not read on over the line being heard");
    p.all("audio")[1]!.dispatchEvent(new dom.Event("ended") as unknown as Event);
    assert.match(hold(p).style.animation, /aip-hold 1\.8s/, "and reads on once it has been heard: beat two read, not heard");
  });

  it("a line that cannot be heard again hands the beat back at once (codex round 18)", () => {
    const p = mount({ ...TWO_VOICES, autoplay: true });
    onward(p);
    p.key("l");
    p.click(p.q('[aria-label="Log"] [data-line="0"]') as unknown as HTMLElement);
    assert.equal(hold(p).style.animation, "none");
    p.all("audio")[1]!.dispatchEvent(new dom.Event("error") as unknown as Event);
    assert.match(hold(p).style.animation, /aip-hold/, "the story reads on rather than waiting for an end that never comes");
  });

  it("a beat's own hold waits while a line is heard again from the log, and starts over after (codex round 19)", () => {
    const p = mount({
      ...NOVEL,
      autoplay: true,
      scenes: { ...NOVEL.scenes, sc_quarter: { title: "Q", beats: [
        { picture: "media/a.png", text: "One.", audio: "media/one.mp3", advance: "voice" as const },
        { picture: "media/a.png", text: "Two.", advance: "hold" as const, holdSec: 3 },
      ] } },
    });
    onward(p);
    assert.equal(p.text(".aip-line"), "Two.");
    assert.match(hold(p).style.animation, /aip-hold 3s/, "the authored hold runs");
    p.key("l");
    p.click(p.q('[aria-label="Log"] [data-line="0"]') as unknown as HTMLElement);
    assert.equal(hold(p).style.animation, "none", "and waits for the line being heard");
    p.all("audio")[1]!.dispatchEvent(new dom.Event("ended") as unknown as Event);
    assert.match(hold(p).style.animation, /aip-hold 3s/, "then holds again");
  });

  it("keeps the focus on the open log's control when the story moves on beneath it", () => {
    const p = mount({ ...NOVEL, autoplay: true });
    onward(p);
    p.key("l");
    const log = p.q('[aria-label="Log"]')!;
    const close = log.querySelector('[data-act="log"]') as unknown as HTMLElement;
    close.focus();
    p.key("n");
    assert.equal(focused(), close, "a redraw that changes nothing replaces nothing");
    (log.querySelector('[aria-label="Play line"]') as unknown as HTMLElement).focus();
    animationEnd(hold(p));
    assert.equal(p.all(".aip-log-line").length, 3, "the next line joined the log");
    const again = focused() as HTMLElement;
    assert.ok(log.contains(again), "focus stays in the log, inside the player");
    assert.equal(again.getAttribute("data-line"), "0", "on the same line's Play button");
  });

  it("keeps the place as a beat, in the same four fields, and reopens on it", () => {
    const KEY = "arke-iv-test-beats";
    const p = mount({ ...NOVEL, autoplay: true, storageKey: KEY });
    onward(p);
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

  it("plays straight through a lone way: no pause, no label, a step of the route, walked in preview (turn 246)", () => {
    const walks: Array<[string, string[]]> = [];
    const KEY = "arke-iv-test-links";
    const p = mount({ ...NOVEL, autoplay: true, storageKey: KEY, author: { unwalked: ["ch_cross", "ch_sleep"], onChoice: (choice, walked) => walks.push([choice.id, walked]) } });
    onward(p);
    onward(p);
    onward(p);
    p.key("1");
    assert.equal(p.text(".aip-scene"), "The causeway");
    animationEnd(hold(p));
    assert.equal(p.all(".aip-choice").length, 0, "Cross before the tide is never offered");
    assert.equal(p.root.getAttribute("data-mode"), "playing", "the last beat moved on into the next scene's first");
    assert.equal(p.text(".aip-scene"), "The bell towers", "the scene title is the only change");
    animationEnd(hold(p));
    assert.equal(p.text(".aip-scene"), "The pier at dusk");
    animationEnd(hold(p));
    assert.equal(p.root.getAttribute("data-mode"), "ending");
    assert.deepEqual(walks, [
      ["ch_follow", ["sc_quarter"]],
      ["ch_cross", ["sc_quarter", "sc_causeway"]],
      ["ch_sleep", ["sc_quarter", "sc_causeway", "sc_towers"]],
    ], "playing through a link walks it, as a press would");
    assert.deepEqual(JSON.parse(store.get(KEY)!).route, ["ch_follow", "ch_cross", "ch_sleep"], "each link a step of the route, so it replays");
    assert.doesNotMatch(p.text("[data-ref=hero]"), /Cross before the tide|Let it sleep/, "a link's label is never shown to a listener");
    p.key("r");
    assert.match(p.text("[data-ref=panel]"), /1\s*The drowned quarter\s*Follow the lantern\s*Choose again\s*2\s*The causeway\s*3\s*The bell towers\s*4\s*The pier at dusk\s*Playing/);
    assert.equal(p.all("[data-ref=panel] [data-again]").length, 1, "only a choice made is offered again");
  });
});

it('touch chrome stays held until every active pointer has released, including cancel',()=>{
 const p=mount();const emit=(target:EventTarget,type:string,pointerId:number)=>{const e=new dom.Event(type,{bubbles:true});Object.assign(e,{pointerType:'touch',pointerId});target.dispatchEvent(e as unknown as Event);};
 emit(p.root as unknown as EventTarget,'pointerdown',1);emit(p.root as unknown as EventTarget,'pointerdown',2);assert.ok(p.root.hasAttribute('data-held'));
 emit(dom.window as unknown as EventTarget,'pointerup',1);assert.ok(p.root.hasAttribute('data-held'));
 emit(dom.window as unknown as EventTarget,'pointercancel',2);assert.equal(p.root.hasAttribute('data-held'),false);
 p.handle.destroy();emit(p.root as unknown as EventTarget,'pointerdown',3);assert.equal(p.root.hasAttribute('data-held'),false);
});


describe("remembered facts in the shared player (turn 240)", () => {
  function storyOptions(): Partial<InteractivePlayerOptions> {
    const story = {
      start: "sc_quarter",
      facts: [{ id: "elsie", label: "Elsie Ward", type: "boolean" as const, default: true }],
      choices: [
        { id: "ch_rescue", from: "sc_quarter", to: "sc_causeway", label: "Rescue Elsie" },
        { id: "ch_seal", from: "sc_quarter", to: "sc_causeway", label: "Seal the bore", effects: [{ fact: "elsie", value: false }] },
        { id: "ch_aux", from: "sc_causeway", to: "sc_pier", label: "Ask Elsie", when: { op: "eq" as const, fact: "elsie", value: true } },
        { id: "ch_manual", from: "sc_causeway", to: "sc_pier", label: "Manual release" },
      ],
      presentation: [{ sceneId: "sc_causeway", blocks: [{ blockId: "blk_elsie", when: { op: "eq" as const, fact: "elsie", value: true } }], shots: [] }],
      endings: [{ sceneId: "sc_pier", title: "Above the Quiet", variants: [
        { id: "together", title: "Together", text: "Elsie is aboard.", when: { op: "eq" as const, fact: "elsie", value: true } },
        { id: "empty", title: "An empty seat", text: "Elsie was lost at the bore.", fallback: true as const },
      ] }],
    };
    return { start: story.start, story, choices: story.choices, endings: story.endings, scenes: {
      sc_quarter: { title: "The bore", clips: [] },
      sc_causeway: { title: "The collar", beats: [{ blockId: "blk_elsie", text: "Elsie speaks", audio: "elsie.mp3" }] },
      sc_pier: { title: "Above the Quiet", clips: [] },
    }, autoplay: true };
  }
  it("filters unavailable choices and voices, selects the ending, and restores facts on rewind", () => {
    const walks: Array<[string, unknown]> = [];
    const p = mount({ ...storyOptions(), author: { unwalked: [], onChoice: (choice, _walked, story) => walks.push([choice.id, story]) } });
    p.click(p.all(".aip-choice").find(el => el.textContent?.includes("Seal the bore")));
    // Ask Elsie is closed with no reason shown, so Manual release is a lone way: never offered (turn 246).
    assert.equal(p.all(".aip-choice").length, 0);
    assert.equal(p.root.getAttribute("data-mode"), "playing");
    assert.doesNotMatch(p.root.textContent ?? "", /Elsie speaks|Ask Elsie|Manual release/);
    assert.ok(!p.all("audio").some(el => el.getAttribute("src") === "elsie.mp3"));
    p.q(".aip-hold")!.dispatchEvent(new dom.Event("animationend", { bubbles: true }) as unknown as Event);
    assert.match(p.text(".aip-hero"), /An empty seat.*Elsie was lost/s);
    const through = walks[1]!;
    assert.equal(through[0], "ch_manual", "playing through the link records its walk");
    assert.deepEqual((through[1] as { prefix: string[]; provenance: string }).prefix, ["ch_seal"], "with the route before it, so it replays");
    assert.equal((through[1] as { provenance: string }).provenance, "human");
    p.key("r"); p.click(p.q('[data-again="0"]'));
    p.click(p.all(".aip-choice").find(el => el.textContent?.includes("Rescue Elsie")));
    assert.match(p.root.textContent ?? "", /Elsie speaks/);
  });
  it("shows an authored disabled reason without making the unavailable choice selectable", () => {
    const options=storyOptions();
    options.story!.choices[2]!.unavailable={reason:'Elsie’s measurements are needed. <safe>'};
    const p=mount(options);
    p.click(p.all(".aip-choice").find(el=>el.textContent?.includes("Seal the bore")));
    assert.equal(p.root.getAttribute("data-mode"),"choice","a closed choice shown with its reason is one of the two, so the story stops (turn 246)");
    const disabled=p.all(".aip-choice").find(el=>el.textContent?.includes("Ask Elsie"))!;
    assert.ok(disabled.hasAttribute("disabled"));
    assert.match(disabled.textContent??"",/Elsie’s measurements are needed. <safe>/);
    assert.equal(disabled.querySelector("safe"),null,"the reason is literal text");
    p.click(disabled);
    assert.equal(p.all(".aip-choice").length,2,"the refused choice did not advance");
    p.key("1");
    assert.equal(p.root.getAttribute("data-mode"),"ending","shortcut one selects the first legal choice");
  });
  it("shows fact origins with a choose-again action at the exact originating choice", () => {
    const p=mount({...storyOptions(),author:{unwalked:[],onClose(){}}});
    p.click(p.all(".aip-choice").find(el=>el.textContent?.includes("Seal the bore")));
    p.key("r");
    const row=p.all(".aip-fact-row")[0]!;
    assert.match(row.textContent??"",/Elsie Ward.*Seal the bore.*false.*Choose again at The bore/);
    p.click(row.querySelector<HTMLButtonElement>("[data-again]"));
    assert.ok(p.all('[data-ref="panel"]')[0]!.hasAttribute("hidden"),"rewind closes the facts panel");
    assert.equal(p.all(".aip-choice").length,2,"the pre-loss choices are restored");
    p.key("r");
    assert.match(p.all(".aip-fact-row")[0]!.textContent??"",/Starting value.*true/);
  });
  it("keeps stateful coverage pending until the journal owner confirms it", () => {
    const p = mount({ ...storyOptions(), author: { unwalked: ["ch_seal"], onChoice() {} } });
    p.click(p.all(".aip-choice").find(el => el.textContent?.includes("Seal the bore")));
    assert.match(p.text(".aip-strip"), /1 choice not walked/);
    p.handle.setUnwalked([]);
    assert.match(p.text(".aip-strip"), /every choice walked/);
  });
  it("keeps separate saved playthroughs when the reader starts again", () => {
    const options = { ...storyOptions(), storageKey: "separate-runs" };
    const first = mount(options);
    first.click(first.all(".aip-choice").find(el => el.textContent?.includes("Seal the bore")));
    const prior = JSON.parse(store.get("separate-runs")!);
    first.key("r"); first.click(first.button("Start over"));
    const next = JSON.parse(store.get("separate-runs")!);
    assert.notEqual(next.playthroughId, prior.playthroughId);
    assert.deepEqual(JSON.parse(store.get("separate-runs-" + prior.playthroughId)!).route, ["ch_seal"]);
    first.handle.destroy();
    const resumed = mount({ ...options, playthroughId: prior.playthroughId });
    assert.equal(resumed.text(".aip-top").includes("The collar"), true, "the saved playthrough, at its scene");
    assert.equal(resumed.all(".aip-choice").length, 0, "whose one way on plays through rather than being offered");
    assert.doesNotMatch(resumed.root.textContent ?? "", /Elsie speaks/);
  });
  it("replays a saved prefix once and refuses a changed story with a restart notice", () => {
    const options = { ...storyOptions(), storageKey: "stateful-save" };
    const p = mount(options);
    p.click(p.all(".aip-choice").find(el => el.textContent?.includes("Seal the bore")));
    const saved = JSON.parse(store.get("stateful-save")!);
    assert.deepEqual(saved.route, ["ch_seal"]); assert.equal(saved.formatVersion, 2);
    p.handle.destroy();
    const resumed = mount(options);
    assert.equal(resumed.text(".aip-top").includes("The collar"), true);
    assert.equal(resumed.all(".aip-choice").length, 0);
    assert.doesNotMatch(resumed.root.textContent ?? "", /Elsie speaks/);
    resumed.handle.destroy();
    const changed = storyOptions(); changed.story!.choices[1]!.effects![0]!.value = true;
    const stale = mount({ ...changed, storageKey: "stateful-save" });
    assert.equal(stale.root.getAttribute("data-mode"), "poster");
    assert.match(stale.root.textContent ?? "", /changed story|damaged/);
  });
});
