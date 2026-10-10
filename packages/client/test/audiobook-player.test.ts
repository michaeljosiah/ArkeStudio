import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { AUDIOBOOK_PLAYER_SOURCE, mountAudiobookPlayer, type AudiobookPlayerChapter, type AudiobookPlayerHandle, type AudiobookPlayerOptions } from "@arke-studio/contracts";

/**
 * The audiobook player (design turn 186), driven as a listener drives it: the one module the app
 * mounts and every exported package inlines. The DOM is linkedom; an <audio> is told it played,
 * moved on and ended the way a browser would tell it.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
/** Every source an element was told to play, in order. */
const started: string[] = [];
const store = new Map<string, string>();
const session: { metadata: { title: string; album: string; artwork: Array<{ src: string }> } | null; handlers: Map<string, ((details?: unknown) => void) | null>; positions: unknown[]; playbackState?: string } = {
  metadata: null,
  handlers: new Map(),
  positions: [],
};
Object.assign(dom.window, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});
// linkedom answers a fresh navigator on every read, so the session is handed to the player.
const mediaSession = {
  set metadata(value: typeof session.metadata) { session.metadata = value; },
  get metadata() { return session.metadata; },
  set playbackState(value: string) { session.playbackState = value; },
  setActionHandler: (action: string, handler: ((details?: unknown) => void) | null) => void session.handlers.set(action, handler),
  setPositionState: (state: unknown) => void session.positions.push(state),
};
class MediaMetadata {
  title: string; album: string; artwork: Array<{ src: string }>;
  constructor(init: { title: string; album: string; artwork: Array<{ src: string }> }) {
    this.title = init.title;
    this.album = init.album;
    this.artwork = init.artwork;
  }
}
// An <audio> as far as the player asks of one: play and pause, said the way a browser says them.
Object.assign(dom.HTMLElement.prototype, {
  paused: true,
  currentTime: 0,
  readyState: 2,
  play(this: HTMLMediaElement & { paused: boolean; ended: boolean }) {
    started.push(this.getAttribute("src") ?? "");
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new dom.Event("play") as unknown as Event);
    return Promise.resolve();
  },
  pause(this: HTMLMediaElement & { paused: boolean }) {
    if (this.paused === false) {
      this.paused = true;
      this.dispatchEvent(new dom.Event("pause") as unknown as Event);
    }
  },
});

const take = (key: string, at: number, seconds: number, text = `${key} words.`) => ({ key, at, seconds, src: `media/${key}.wav`, sentences: [{ at, text }] });
const CH1: AudiobookPlayerChapter = {
  id: "neap", order: 1, title: "Neap", state: "read", seconds: 30,
  blocks: [take("title", 0, 4, "Chapter 1 · Neap"), take("p0.0", 4, 16), take("p1.0", 20, 10)],
  gaps: [], pictures: [{ at: 4, src: "pics/stair.png" }], opening: "pics/cover.png",
};
// Read in part: its title and its last block made, the two between not read.
const CH2: AudiobookPlayerChapter = {
  id: "ink", order: 2, title: "The Same Ink", state: "part", seconds: 12,
  blocks: [take("c2.title", 0, 4, "Chapter 2 · The Same Ink"), take("c2.p2", 4, 8)],
  gaps: [{ at: 4, from: 2, to: 3 }], pictures: [], opening: "pics/cover.png",
};
const CH3: AudiobookPlayerChapter = { id: "nothing", order: 3, title: "Nothing Wrong", state: "not read", seconds: 0, blocks: [], gaps: [{ at: 0, from: 1, to: 9 }], pictures: [], opening: "pics/cover.png" };
const CH4: AudiobookPlayerChapter = {
  id: "hand", order: 4, title: "Her Own Hand", state: "read", seconds: 20,
  blocks: [take("c4.title", 0, 5, "Chapter 4 · Her Own Hand"), take("c4.p0", 5, 15)],
  gaps: [], pictures: [], opening: "pics/cover.png",
};
const BOOK = [CH1, CH2, CH3, CH4];
const OPTIONS: AudiobookPlayerOptions = { title: "The Undersong", cover: "pics/cover.png", chapters: BOOK, storageKey: "ab-test", autoplay: true };

const mounted: AudiobookPlayerHandle[] = [];
let wall = 1_000_000;
function mount(over: Partial<AudiobookPlayerOptions> = {}) {
  const root = dom.document.createElement("div");
  dom.document.body.append(root);
  const handle = mountAudiobookPlayer(root, { now: () => wall, mediaSession, MediaMetadata, ...OPTIONS, ...over });
  mounted.push(handle);
  const q = (selector: string) => root.querySelector(selector) as unknown as HTMLElement | null;
  const all = (selector: string) => [...root.querySelectorAll(selector)] as unknown as HTMLElement[];
  const text = (selector: string) => (q(selector)?.textContent ?? "").replace(/\s+/g, " ").trim();
  const audios = () => all("audio") as unknown as Array<HTMLAudioElement & { paused: boolean }>;
  const playingAudio = () => audios().find((audio) => audio.paused === false) ?? null;
  const fire = (target: EventTarget, name: string) => target.dispatchEvent(new dom.Event(name) as unknown as Event);
  /** The playing element says it is this far into its piece. */
  const at = (seconds: number) => {
    const audio = playingAudio();
    assert.ok(audio, "something is playing");
    audio.currentTime = seconds;
    fire(audio, "timeupdate");
  };
  /** The playing take reaches its end as a browser says it: paused on the way, then ended. */
  const end = () => {
    const audio = playingAudio() as (HTMLAudioElement & { paused: boolean; ended: boolean }) | null;
    assert.ok(audio, "something is playing");
    audio.ended = true;
    audio.paused = true;
    fire(audio, "pause");
    fire(audio, "ended");
  };
  const press = (label: string) => {
    const button = all("button").find((el) => el.getAttribute("aria-label") === label || (el.textContent ?? "").replace(/\s+/g, " ").trim() === label);
    assert.ok(button, `the ${label} button exists`);
    button.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event);
  };
  const key = (name: string) => {
    const event = new dom.Event("keydown", { bubbles: true }) as unknown as KeyboardEvent;
    Object.assign(event, { key: name });
    root.dispatchEvent(event);
  };
  return { root, handle, q, all, text, audios, playingAudio, at, end, press, key };
}

afterEach(() => {
  for (const handle of mounted.splice(0)) handle.destroy();
  dom.document.body.replaceChildren();
  store.clear();
  session.metadata = null;
  session.handlers.clear();
  session.positions = [];
});

describe("the book, not a chapter (186a, R-67)", () => {
  it("keeps a muted clip on the narration clock through repeats, seeking, pause and destruction", () => {
    const motion: AudiobookPlayerChapter = { ...CH1, pictures: [{ at: 4, src: "pics/stair.png", motion: { src: "clips/stair.mp4", seconds: 5, behavior: "repeat" } }] };
    const p = mount({ chapters: [motion], startAt: 4 });
    const clip = p.all("video").find((v) => v.getAttribute("src") === "clips/stair.mp4") as unknown as HTMLVideoElement;
    assert.ok(clip);
    Object.assign(clip, { readyState: 2, currentTime: 0 });
    p.at(7);
    assert.equal(clip.currentTime, 2);
    assert.equal(clip.muted, true);
    p.press("Pause");
    assert.equal(clip.paused, true);
    p.handle.update([{ ...motion, pictures: [{ ...motion.pictures[0]!, motion: { src: "clips/stair.mp4", seconds: 5, behavior: "hold" } }] }]);
    p.press("Play");
    p.at(9);
    const held = p.all("video").find((v) => v.classList.contains("on")) as unknown as HTMLVideoElement;
    Object.assign(held, { readyState: 2, currentTime: 0 });
    p.at(10);
    assert.ok(held.currentTime > 4.98 && held.currentTime < 5);
    assert.equal(held.paused, true);
    p.handle.destroy();
    assert.equal(held.getAttribute("src"), null);
  });

  it("reports a missing clip while retaining its still", () => {
    const p = mount({ chapters: [{ ...CH1, pictures: [{ at: 4, src: "pics/stair.png", motionProblem: "clip unavailable · showing the still", motion: { src: "clips/missing.mp4", seconds: 5, behavior: "repeat" } }] }], startAt: 4 });
    assert.match(p.text(".abp-clipnote"), /showing the still/);
    assert.equal(p.q("img.on")?.getAttribute("src"), "pics/stair.png");
    assert.equal(p.all("video.on").length, 0);
  });
  it("plays a chapter's takes back to back: the next is waiting in the other element when one ends", () => {
    const p = mount();
    assert.equal(p.root.getAttribute("data-mode"), "playing");
    assert.equal(p.playingAudio()?.getAttribute("src"), "media/title.wav");
    const waiting = p.audios().find((audio) => audio !== p.playingAudio());
    assert.equal(waiting?.getAttribute("src"), "media/p0.0.wav", "the next take is loaded before this one ends");
    p.end();
    assert.ok(p.playingAudio() === waiting, "the waiting element plays on: nothing added between takes");
    p.at(6);
    assert.equal(p.text(".abp-now"), "0:10");
    assert.match(p.text(".abp-chap"), /Chapter 01 · Neap/);
  });

  it("runs on through a chapter read in part, and passes over a chapter not read to the next with takes", () => {
    const p = mount();
    p.end(); p.end(); p.end();
    assert.match(p.text(".abp-chap"), /Chapter 02 · The Same Ink/, "runs on to the next chapter");
    assert.equal(p.playingAudio()?.getAttribute("src"), "media/c2.title.wav");
    p.end();
    assert.equal(p.playingAudio()?.getAttribute("src"), "media/c2.p2.wav", "the gap is skipped, no stall");
    p.end();
    assert.match(p.text(".abp-chap"), /Chapter 04 · Her Own Hand/, "chapter 3 has nothing made: passed over");
    assert.equal(p.text(".abp-of"), "chapter 4 of 4");
  });

  it("marks a gap on the scrubber and says it in Text, then reads on", () => {
    const p = mount({ chapterId: "ink" });
    assert.equal(p.all(".abp-line u").length, 1, "the gap marked on the scrubber");
    assert.equal(p.q(".abp-follow")?.hidden, true, "Text is off by default");
    p.press("Text");
    assert.match(p.text(".abp-follow"), /Chapter 2 · The Same Ink\s*2 blocks not read/, "the gap is the next thing said");
    p.end();
    p.at(1);
    assert.match(p.text(".abp-follow"), /^2 blocks not read\s*c2\.p2 words\./, "said just after the clock crosses it");
    p.at(6);
    assert.doesNotMatch(p.text(".abp-follow"), /not read/);
  });

  it("lists every chapter in Chapters: what is read and how far, a part's unread blocks, and one not read held", () => {
    const p = mount();
    p.press("Chapters");
    assert.equal(p.text(".abp-sheet h4"), "Chapters · 4 · 2 read");
    const rows = p.all(".abp-ch");
    assert.deepEqual(rows.map((row) => row.textContent?.replace(/\s+/g, " ").trim()), ["01Neap0:30", "02The Same Ink2 not read0:12", "03Nothing Wrongnot read", "04Her Own Hand0:20"]);
    assert.equal(rows[2]!.hasAttribute("disabled"), true, "not read: listed and held");
    rows[3]!.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event);
    assert.match(p.text(".abp-chap"), /Chapter 04/);
    assert.equal(p.q(".abp-sheet")?.hidden, true);
  });

  it("ticks the scrubber at each picture and crossfades to the picture of the moment, the cover before it", () => {
    const p = mount();
    assert.equal(p.all(".abp-line b").length, 1);
    const shown = () => p.all(".abp-pic.on").map((img) => img.getAttribute("src"));
    assert.deepEqual(shown(), ["pics/cover.png"], "the chapter opens on its opening picture");
    p.end();
    p.at(0.5);
    assert.deepEqual(shown(), ["pics/stair.png"]);
    assert.equal(p.all("img.abp-pic").length, 2, "two still layers, so one fades into the other");
  });
});

describe("what codex found on PR 1493", () => {
  it("says the blocks not read before a chapter's first take as the chapter opens", () => {
    const leading: AudiobookPlayerChapter = { ...CH2, id: "lead", gaps: [{ at: 0, from: 1, to: 3 }], blocks: [take("c2.p3", 0, 8)], seconds: 8 };
    const p = mount({ chapters: [leading, CH4], chapterId: "lead" });
    p.press("Text");
    assert.match(p.text(".abp-follow"), /^3 blocks not read/);
  });

  it("at End of chapter, never starts the next chapter's first words", () => {
    const p = mount();
    p.press("Sleep timer");
    p.end(); p.end();
    started.length = 0;
    p.end();
    assert.deepEqual(started, [], "nothing played after the chapter ended");
    assert.match(p.text(".abp-chap"), /Chapter 02/);
  });

  it("stops what was sounding when a newer plan leaves nothing to play", () => {
    const p = mount();
    p.handle.update([CH3]);
    assert.ok(p.playingAudio() === null);
    assert.ok(p.audios().every((audio) => !audio.hasAttribute("src")), "the stale take is let go");
  });

  it("keeps the listener's place through a plan with nothing to play, and returns to it (codex on PR 1495)", () => {
    const p = mount({ chapterId: "ink" });
    p.end();
    p.at(3); // 0:07, three seconds into c2.p2
    p.handle.update([CH3]);
    p.handle.update(BOOK);
    assert.match(p.text(".abp-chap"), /Chapter 02/);
    assert.equal(p.text(".abp-now"), "0:07");
  });

  it("pauses when another read takes the app's voice", () => {
    const p = mount();
    assert.ok(p.playingAudio());
    p.handle.pause();
    assert.ok(p.playingAudio() === null);
  });

  it("lands on the last chapter with takes before the place when none follows it", () => {
    const p = mount({ chapterId: "hand" });
    p.handle.update([CH1, CH2, CH3, { ...CH4, state: "not read", seconds: 0, blocks: [], gaps: [{ at: 0, from: 1, to: 2 }] }]);
    assert.match(p.text(".abp-chap"), /Chapter 02/, "not chapter 1 by default");
  });
});

describe("the transport (R-68)", () => {
  it("seeks back 15 and forward 30, steps chapters, and keys play, pause and seek", () => {
    const p = mount();
    p.end();
    p.at(10); // 0:14
    p.press("Back 15 seconds");
    assert.equal(p.text(".abp-now"), "0:00");
    p.press("Forward 30 seconds");
    assert.equal(p.text(".abp-now"), "0:29", "held inside the chapter");
    p.press("Next chapter");
    assert.match(p.text(".abp-chap"), /Chapter 02/);
    assert.equal(p.playingAudio()?.getAttribute("src"), "media/c2.title.wav", "plays on in the next chapter");
    p.key(" ");
    assert.ok(p.playingAudio() === null, "Space pauses");
    assert.equal(p.q("[data-act='toggle']")?.getAttribute("aria-label"), "Play");
    p.key(" ");
    assert.ok(p.playingAudio());
    p.key("ArrowRight");
    assert.equal(p.text(".abp-now"), "0:05");
    p.press("Previous chapter");
    assert.match(p.text(".abp-chap"), /Chapter 01/);
  });

  it("changes speed from 0.8× to 2× with the pitch kept, and keeps it on this device", () => {
    const p = mount();
    assert.equal(p.text("[data-act='speed']"), "1.0×");
    p.press("Speed");
    assert.equal(p.text("[data-act='speed']"), "1.2×");
    const audio = p.playingAudio() as unknown as { playbackRate: number; preservesPitch: boolean };
    assert.equal(audio.playbackRate, 1.2);
    assert.equal(audio.preservesPitch, true);
    for (let i = 0; i < 4; i += 1) p.press("Speed");
    assert.equal(p.text("[data-act='speed']"), "0.8×", "past 2× it comes round to 0.8×");
    assert.equal(JSON.parse(store.get("ab-test")!).speed, 0.8);
  });

  it("sleeps after the minutes chosen, counted while playing, and the choice is kept", () => {
    const p = mount();
    p.press("Sleep timer"); // End of chapter
    p.press("End of chapter"); // 15 min
    assert.match(p.text("[data-act='sleep']"), /15:00/);
    p.at(1);
    wall += 14 * 60 * 1000;
    p.at(2);
    assert.ok(p.playingAudio(), "still playing at fourteen minutes");
    wall += 61 * 1000;
    p.at(3);
    assert.ok(p.playingAudio() === null, "asleep after fifteen");
    assert.equal(JSON.parse(store.get("ab-test")!).sleep, 15);
  });

  it("at End of chapter, stops at the next chapter's start", () => {
    const p = mount();
    p.press("Sleep timer");
    assert.equal(p.text("[data-act='sleep']"), "End of chapter");
    p.end(); p.end(); p.end();
    assert.ok(p.playingAudio() === null);
    assert.match(p.text(".abp-chap"), /Chapter 02/);
    assert.equal(p.text(".abp-now"), "0:00");
  });

  it("says the book's line: the chapter of how many, and what is left", () => {
    const p = mount();
    p.end();
    p.at(6); // 0:10 into a 62-second book
    assert.equal(p.text(".abp-of"), "chapter 1 of 4");
    assert.equal(p.text(".abp-left"), "52 s left");
  });
});

describe("the listener's place (R-71)", () => {
  it("keeps the place by block and offset, so a return lands in the same words after earlier blocks are made", () => {
    const first = mount({ chapterId: "ink" });
    first.end();
    first.at(3); // three seconds into c2.p2, 0:07
    first.handle.destroy();
    // The two blocks between are read since: c2.p2 now starts at 0:20.
    const later: AudiobookPlayerChapter = {
      ...CH2, state: "read", seconds: 28, gaps: [],
      blocks: [take("c2.title", 0, 4), take("c2.p0", 4, 9), take("c2.p1", 13, 7), take("c2.p2", 20, 8)],
    };
    const again = mount({ chapters: [CH1, later, CH3, CH4], autoplay: false });
    assert.equal(again.root.getAttribute("data-mode"), "poster");
    assert.match(again.text(".abp-poster"), /Continue · chapter 2 · 0:23/, "the same words, three seconds in");
    again.press("Start over");
    assert.match(again.text(".abp-chap"), /Chapter 01/);
  });

  it("Listen on the book plays at once the first time, and opens on Continue once a place is kept", () => {
    const first = mount({ continueFirst: true });
    assert.equal(first.root.getAttribute("data-mode"), "playing");
    first.at(2);
    first.handle.destroy();
    const again = mount({ continueFirst: true });
    assert.equal(again.root.getAttribute("data-mode"), "poster");
    assert.match(again.text(".abp-poster"), /Continue · chapter 1 · 0:02/);
  });

  it("opens on Play with no place kept", () => {
    const p = mount({ autoplay: false });
    assert.match(p.text(".abp-poster"), /The Undersong\s*Play/);
    p.press("Play");
    assert.equal(p.root.getAttribute("data-mode"), "playing");
  });

  it("takes a newer plan while playing: the take playing plays on, its place recomputed", () => {
    const p = mount({ chapterId: "ink" });
    p.end();
    p.at(2);
    const playing = p.playingAudio();
    const filled: AudiobookPlayerChapter = { ...CH2, state: "read", seconds: 28, gaps: [], blocks: [take("c2.title", 0, 4), take("c2.p0", 4, 9), take("c2.p1", 13, 7), take("c2.p2", 20, 8)] };
    p.handle.update([CH1, filled, CH3, CH4]);
    assert.ok(p.playingAudio() === playing, "not interrupted");
    assert.equal(playing?.getAttribute("src"), "media/c2.p2.wav");
    assert.equal(p.text(".abp-now"), "0:22", "the same words, on the new clock");
    assert.equal(p.all(".abp-line u").length, 0, "the gap is gone");
  });

  it("keeps Text on for this device once it is turned on", () => {
    const p = mount();
    p.press("Text");
    p.handle.destroy();
    const again = mount();
    assert.equal(again.q(".abp-follow")?.hidden, false);
  });
});

describe("the lock screen and a headset (R-71)", () => {
  it("names the chapter with the picture of the moment, and drives the player from the session's buttons", () => {
    const p = mount();
    assert.equal(session.metadata?.title, "Chapter 01 · Neap");
    assert.equal(session.metadata?.album, "The Undersong");
    assert.match(session.metadata?.artwork[0]?.src ?? "", /pics\/cover\.png$/);
    p.end();
    p.at(1);
    assert.match(session.metadata?.artwork[0]?.src ?? "", /pics\/stair\.png$/, "the artwork follows the picture");
    session.handlers.get("pause")?.();
    assert.ok(p.playingAudio() === null);
    session.handlers.get("play")?.();
    assert.ok(p.playingAudio());
    session.handlers.get("nexttrack")?.();
    assert.match(p.text(".abp-chap"), /Chapter 02/);
    session.handlers.get("seekto")?.({ seekTime: 6 });
    assert.equal(p.text(".abp-now"), "0:06");
    assert.ok(session.positions.length > 0, "the position is told to the session");
    p.handle.destroy();
    assert.equal(session.handlers.get("play"), null, "the handlers go with the player");
  });
});

describe("one player, two homes (R-66)", () => {
  it("is the same text the exporter inlines", () => {
    assert.match(AUDIOBOOK_PLAYER_SOURCE, /export function mountAudiobookPlayer\(root, options\)/);
    assert.doesNotMatch(AUDIOBOOK_PLAYER_SOURCE, /^\s*import\s/m,"no imports: it runs in a page with nothing else on it");
  });
});
