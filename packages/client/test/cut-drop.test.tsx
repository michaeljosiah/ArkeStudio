import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { applyTimelineCommands, mediaPlacementCommands, seedEmptyPictureTimeline, type ClientMessage, type ClientState } from "@arke-studio/contracts";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { CutScreen } from "../src/screens/production.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Desktop files over the Cut (issue 1035; SPEC-043 R-3): the whole screen becomes a target the
 * moment a file is over the window, every lane says what a drop will do and refuses only a real
 * mismatch, the typed lanes and the new-lane strip take the drop where it lands, and the Library
 * lists each file as a row from the drop until it is real — or until its reason is dismissed.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, {
  matchMedia: (query: string) => ({ matches: false, media: query }),
  innerWidth: 1400,
  innerHeight: 880,
});
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLMediaElement: dom.HTMLMediaElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

type Upload = Extract<ClientMessage, { kind: "upload-artifacts" }>;

interface Mounted {
  container: HTMLElement;
  root: Root;
  sent: Array<ClientMessage | (Upload & { sourcePaths: string[] })>;
}

/** The desktop bridge's file drop: paths are the host's business, the renderer only hands over File objects. */
function bridge(sent: Mounted["sent"]) {
  return {
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json: string) => sent.push(JSON.parse(json) as ClientMessage),
    importDroppedMedia: (target: Omit<Upload, "kind" | "sourcePaths">, files: readonly File[]) => {
      sent.push({ ...target, kind: "upload-artifacts", sourcePaths: files.map((file) => file.name) });
      return { submitted: true, unresolved: [] };
    },
  } as unknown as NonNullable<Window["arke"]>;
}

/** A production with no story: one video placed on Picture, an overlay lane and a sound lane beside it. */
function lanesState(): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  production.scenes = []; production.spine = null; production.cut = { audio: [], overlays: [] };
  const video = { ...state.world!.artifacts[0]!, kind: "video" as const, file: "holiday.mp4", mediaInfo: { durationSec: 5, hasAudio: true } };
  state.world!.artifacts = [video];
  const seeded = seedEmptyPictureTimeline(production);
  production.timeline = {
    status: "ready",
    timeline: applyTimelineCommands(seeded, [
      ...mediaPlacementCommands(seeded, [video], "append", () => "cl_holiday"),
      { kind: "add-track", trackId: "tr_overlay-1", trackKind: "picture", name: "Overlay 1" },
      { kind: "add-track", trackId: "tr_audio-1", trackKind: "audio", name: "Audio 1" },
    ]),
  };
  return state;
}

async function mount(state: ClientState): Promise<Mounted> {
  const sent: Mounted["sent"] = [];
  __setBridgeForTest(bridge(sent));
  __setStateForTest(state);
  const production = state.world!.productions[0]!;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/p/${production.meta.id}/cut`]}>
        <Routes>
          <Route path="/w/:worldId/p/:prodId/cut" element={<CutScreen />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return { container, root, sent };
}

async function close(screen: Mounted): Promise<void> {
  await act(async () => screen.root.unmount());
  screen.container.remove();
}

function reactProps(element: Element): Record<string, (event: unknown) => void> {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps$"));
  assert.ok(key, "the element is React's");
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key]!;
}

/** A drag carrying files, as the browser stages it: MIME types readable, the files themselves only on drop. */
function fileTransfer(files: File[]) {
  let dropEffect = "copy";
  return {
    types: ["Files"],
    items: files.map((file) => ({ kind: "file", type: file.type })),
    files,
    getData: () => "",
    get dropEffect() { return dropEffect; },
    set dropEffect(value: string) { dropEffect = value; },
  };
}

function dragEvent(files: File[], x = 50) {
  return {
    preventDefault() {},
    stopPropagation() {},
    clientX: x,
    dataTransfer: fileTransfer(files),
    currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 100 }), contains: () => false },
    relatedTarget: null,
  };
}

async function filesOverWindow(files: File[]): Promise<void> {
  await act(async () => {
    const enter = new Event("dragenter", { bubbles: true, cancelable: true });
    Object.defineProperty(enter, "dataTransfer", { value: fileTransfer(files) });
    window.dispatchEvent(enter);
  });
}

const video = () => new File(["bytes"], "clip.mp4", { type: "video/mp4" });
const sound = () => new File(["bytes"], "bed.wav", { type: "audio/wav" });
const still = () => new File(["bytes"], "plate.png", { type: "image/png" });

const uploads = (screen: Mounted) => screen.sent.filter((message): message is Upload & { sourcePaths: string[] } => message.kind === "upload-artifacts");

afterEach(() => {
  __setBridgeForTest(null);
  document.body.replaceChildren();
});

describe("files over the window", () => {
  it("turns the Library and every lane into a named target, and clears when the drag ends", async () => {
    const screen = await mount(lanesState());
    try {
      assert.equal(screen.container.querySelector("[data-testid='library-dropzone']"), null);
      await filesOverWindow([video()]);
      assert.match(screen.container.querySelector("[data-testid='library-dropzone']")?.textContent ?? "", /Drop to import/);
      assert.equal(screen.container.querySelector("[data-track='picture'] .fy-track__lane")?.getAttribute("data-dropping"), "true");
      assert.equal(screen.container.querySelector("[data-track-id='tr_audio-1'] .fy-track__lane")?.getAttribute("data-dropping"), "true");
      assert.ok(screen.container.querySelector(".fy-track--new")?.classList.contains("fy-track--files"), "the new-lane strip lights too");
      assert.match(screen.container.querySelector(".fy-track--new .fy-track__empty")?.textContent ?? "", /Drop to add · new lane/);
      await act(async () => window.dispatchEvent(new Event("drop", { bubbles: true })));
      assert.equal(screen.container.querySelector("[data-testid='library-dropzone']"), null, "the target clears on drop");
    } finally {
      await close(screen);
    }
  });
});

describe("what each lane says", () => {
  it("names the landing on a lane that takes the kind, and refuses only a real mismatch", async () => {
    const screen = await mount(lanesState());
    try {
      const sound1 = screen.container.querySelector<HTMLElement>("[data-track-id='tr_audio-1'] .fy-track__lane")!;
      const refused = dragEvent([still()]);
      await act(async () => reactProps(sound1)["onDragOver"]!(refused));
      assert.equal(refused.dataTransfer.dropEffect, "none", "a still has no sound to put on a sound lane");
      assert.match(sound1.textContent ?? "", /sound lanes take sound/);
      const accepted = dragEvent([video()]);
      await act(async () => reactProps(sound1)["onDragOver"]!(accepted));
      assert.equal(accepted.dataTransfer.dropEffect, "copy", "a video may carry sound; the import decides");
      assert.match(sound1.querySelector("[role='status']")?.textContent ?? "", /Drop to add · Audio 1 at 00:00:/);
      assert.ok(sound1.querySelector("[data-testid='landing']"), "the landing rectangle is drawn");

      const picture = screen.container.querySelector<HTMLElement>("[data-track='picture'] .fy-track__lane")!;
      const wrong = dragEvent([sound()]);
      await act(async () => reactProps(picture)["onDragOver"]!(wrong));
      assert.equal(wrong.dataTransfer.dropEffect, "none");
      assert.match(picture.textContent ?? "", /picture lanes take picture/);
      await act(async () => reactProps(picture)["onDrop"]!(wrong));
      assert.equal(uploads(screen).length, 0, "a refused drop imports nothing");
    } finally {
      await close(screen);
    }
  });
});

describe("where a drop lands", () => {
  it("imports onto the lane it was dropped on, lists the file as a row until it is real, and keeps a failure until dismissed", async () => {
    const screen = await mount(lanesState());
    try {
      const overlay = screen.container.querySelector<HTMLElement>("[data-track-id='tr_overlay-1'] .fy-track__lane")!;
      await act(async () => reactProps(overlay)["onDrop"]!(dragEvent([video()], 50)));
      const [request] = uploads(screen);
      assert.ok(request, "the drop was imported");
      assert.deepEqual(request.sourcePaths, ["clip.mp4"]);
      assert.deepEqual(Object.keys(request.editor!.destination as object).sort(), ["frame", "trackId"]);
      assert.equal((request.editor!.destination as { trackId: string }).trackId, "tr_overlay-1");
      const pending = screen.container.querySelector<HTMLElement>("[data-testid='pending-import']");
      assert.ok(pending, "the file is a row while it imports");
      assert.match(pending.textContent ?? "", /clip\.mp4/);
      assert.match(pending.textContent ?? "", /importing…/);
      assert.ok(screen.container.querySelector("[data-track-id='tr_overlay-1'] [data-testid='pending-slot']"), "the lane holds the slot until the clip is real");

      await act(async () => __applyEventForTest({ type: "queue.enqueue-result", at: "2026-09-09T12:00:00Z", command: "upload-artifacts", requestId: request.requestId,
        disposition: "rejected", requestedCount: 1, acceptedJobIds: [], failures: [{ index: 0, reason: "clip.mp4: saved, but has no picture; Overlay 1 takes picture" }] }));
      const failed = screen.container.querySelector<HTMLElement>("[data-testid='pending-import']");
      assert.ok(failed, "a file that did not land keeps its row");
      assert.match(failed.textContent ?? "", /Overlay 1 takes picture/);
      assert.equal(screen.container.querySelector("[data-testid='pending-slot']"), null, "and the slot is gone");
      await act(async () => failed.querySelector<HTMLButtonElement>("button[aria-label='Dismiss clip.mp4']")!.click());
      assert.equal(screen.container.querySelector("[data-testid='pending-import']"), null);
    } finally {
      await close(screen);
    }
  });

  it("keeps only the files that did not land after a partial failure", async () => {
    const screen = await mount(lanesState());
    try {
      const overlay = screen.container.querySelector<HTMLElement>("[data-track-id='tr_overlay-1'] .fy-track__lane")!;
      await act(async () => reactProps(overlay)["onDrop"]!(dragEvent([video(), still()], 50)));
      const [request] = uploads(screen);
      assert.equal(screen.container.querySelectorAll("[data-testid='pending-import']").length, 2);
      await act(async () => __applyEventForTest({ type: "queue.enqueue-result", at: "2026-09-09T12:00:00Z", command: "upload-artifacts", requestId: request!.requestId,
        disposition: "partial", requestedCount: 2, acceptedJobIds: [], failures: [{ index: 1, reason: "plate.png: saved, but has no sound; Overlay 1 takes picture" }] }));
      const rows = [...screen.container.querySelectorAll<HTMLElement>("[data-testid='pending-import']")];
      assert.equal(rows.length, 1, "the file that landed is a real row now");
      assert.match(rows[0]!.textContent ?? "", /plate\.png/);
      assert.doesNotMatch(rows[0]!.textContent ?? "", /clip\.mp4/);
    } finally {
      await close(screen);
    }
  });

  it("clears the row when every file landed", async () => {
    const screen = await mount(lanesState());
    try {
      const picture = screen.container.querySelector<HTMLElement>("[data-track='picture'] .fy-track__lane")!;
      await act(async () => reactProps(picture)["onDrop"]!(dragEvent([video()], 80)));
      const [request] = uploads(screen);
      assert.equal(typeof request!.editor!.destination, "number", "the base track takes a bare frame");
      assert.ok(screen.container.querySelector("[data-track='picture'] [data-testid='pending-slot']"));
      await act(async () => __applyEventForTest({ type: "queue.enqueue-result", at: "2026-09-09T12:00:00Z", command: "upload-artifacts", requestId: request!.requestId,
        disposition: "accepted", requestedCount: 1, acceptedJobIds: [], failures: [] }));
      assert.equal(screen.container.querySelector("[data-testid='pending-import']"), null, "the real row replaces it");
    } finally {
      await close(screen);
    }
  });

  it("leaves a desktop file on a legacy overlay lane to the chrome, which appends it", async () => {
    // An unmigrated cut still draws its overlay lanes. They take artifact drags only; a file they
    // claimed went nowhere, because the chrome's append fallback stands down for a drop a lane
    // has answered. So they answer nothing for files, and the fallback appends.
    const state = lanesState();
    const production = state.world!.productions[0]!;
    production.cut = { audio: [], overlays: [{ id: "ov_01J8G0000000000000000000A1", artifactId: state.world!.artifacts[0]!.id, startSec: 0, endSec: 4, lane: 1, audio: "keep" }] } as typeof production.cut;
    const screen = await mount(state);
    try {
      const lane = screen.container.querySelector<HTMLElement>(".fy-ovlane");
      assert.ok(lane, "the legacy lanes are drawn");
      let claimed = 0;
      await act(async () => reactProps(lane)["onDragOver"]!({ ...dragEvent([video()]), preventDefault() { claimed += 1; } }));
      await act(async () => reactProps(lane)["onDrop"]!({ ...dragEvent([video()]), preventDefault() { claimed += 1; } }));
      assert.equal(claimed, 0, "the lane does not claim a file");
      assert.equal(uploads(screen).length, 0);
      const drop = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", { value: fileTransfer([video()]) });
      Object.defineProperty(drop, "clientX", { value: 50 });
      await act(async () => { lane.dispatchEvent(drop); });
      const [appended] = uploads(screen);
      assert.equal(appended?.editor?.destination, "append", "the chrome appends what the lane left alone");
    } finally {
      await close(screen);
    }
  });

  it("makes a new lane from the strip, and files to the Library from the panel", async () => {
    const screen = await mount(lanesState());
    try {
      const strip = screen.container.querySelector<HTMLElement>(".fy-track--new .fy-track__lane")!;
      const over = dragEvent([sound()]);
      await act(async () => reactProps(strip)["onDragOver"]!(over));
      assert.equal(over.dataTransfer.dropEffect, "copy");
      await act(async () => reactProps(strip)["onDrop"]!(dragEvent([sound()], 25)));
      const [fromStrip] = uploads(screen);
      assert.deepEqual(Object.keys(fromStrip!.editor!.destination as object).sort(), ["frame", "newTrack"]);
      // One import at a time: the next drop waits for this one to answer.
      await act(async () => __applyEventForTest({ type: "queue.enqueue-result", at: "2026-09-09T12:00:00Z", command: "upload-artifacts", requestId: fromStrip!.requestId,
        disposition: "accepted", requestedCount: 1, acceptedJobIds: [], failures: [] }));
      const panel = screen.container.querySelector<HTMLElement>(".fy-artpanel")!;
      await act(async () => reactProps(panel)["onDrop"]!(dragEvent([video()])));
      const [, fromPanel] = uploads(screen);
      assert.equal(fromPanel!.editor!.destination, "library");
      assert.equal(screen.container.querySelectorAll("[data-testid='pending-import']").length, 1);
    } finally {
      await close(screen);
    }
  });
});

describe("a cut with no scenes (issue 1033)", () => {
  it("shows no scene controls, no shot picker, and invites the Library rather than a scene", async () => {
    const state = lanesState();
    state.world!.productions[0]!.timeline = { status: "ready", timeline: seedEmptyPictureTimeline(state.world!.productions[0]!) };
    const screen = await mount(state);
    try {
      assert.equal(screen.container.querySelector("select[aria-label='Scene']"), null);
      assert.equal(screen.container.querySelector(".fy-artpanel__add"), null, "nothing to pick shots from");
      assert.equal([...screen.container.querySelectorAll<HTMLButtonElement>(".fy-artpanel__filters button")].some((button) => button.textContent === "Needs a take"), false);
      assert.match(screen.container.querySelector("[data-track='picture'] .fy-track__empty")?.textContent ?? "", /add from the Library/);
      // The world's one video is a row without being picked, with its picture, kind and length.
      const row = screen.container.querySelector<HTMLElement>("[data-library-item^='artifact:']");
      assert.ok(row, "the file is listed directly");
      assert.match(row.querySelector(".fy-artrow__meta")?.textContent ?? "", /video · 5s/);
      assert.match(row.querySelector(".fy-artrow__swatch img")?.getAttribute("src") ?? "", /\.index\/posters\//, "the row carries its poster");
    } finally {
      await close(screen);
    }
  });
});
