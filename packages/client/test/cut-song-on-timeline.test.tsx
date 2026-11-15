import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  ClientStateSchema,
  applyTimelineCommands,
  productionFrameRate,
  seedEmptyPictureTimeline,
  seedStoryPictureTimeline,
  type ArtifactSidecar,
  type ClientMessage,
  type ClientState,
  type ProductionTimeline,
} from "@arke-studio/contracts";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { CutScreen, songPlacementCommands } from "../src/screens/cut.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A song made the master after the timeline was saved (issue 3086). The person dropped the song
 * on the Library first, which saved the timeline; Arke then made it the master track. A saved
 * timeline is never rewritten by a spine edit (SPEC-037 R-4), so the Cut says the song is missing
 * and offers the one press that places it.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { matchMedia: (query: string) => ({ matches: false, media: query }) });
Object.assign(dom.HTMLElement.prototype, { focus() {} });
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

const SONG = "ar_01J8G0000000000000000000T1";
const BELLS = "ar_01J8G0000000000000000000R1";
const AT = "2026-07-30T18:22:00Z";

interface Mounted {
  container: HTMLElement;
  root: Root;
  sent: ClientMessage[];
}

/** The fixture production with a 60s song as its master, and the timeline the caller saves. */
type Production = NonNullable<ClientState["world"]>["productions"][number];

function songState(saved: (production: Production) => ProductionTimeline | null): ClientState {
  const base = structuredClone(FIXTURE_STATE) as ClientState;
  const world = base.world!;
  world.artifacts = [
    ...world.artifacts,
    {
      id: SONG,
      kind: "audio",
      file: "artifacts/why-you-do-me-like-that.mp3",
      hash: "sha256:6a1e02b9c44d7f32",
      origin: { by: "user" },
      links: [],
      created: "2026-06-11T10:00:00Z",
      mediaInfo: { durationSec: 60, hasAudio: true },
    } as (typeof world.artifacts)[number],
  ];
  const production = world.productions[0]!;
  production.spine = {
    schemaVersion: 1,
    revision: 1,
    trackArtifactId: SONG,
    markers: [],
    anchors: {},
    updatedAt: AT,
  } as typeof production.spine;
  const timeline = saved(production);
  if (timeline !== null) production.timeline = { status: "ready", timeline };
  return ClientStateSchema.parse(base);
}

/** What the Library import saved: an empty Picture track and the song in the Library, revision 1. */
function importedFirst(production: Production): ProductionTimeline {
  return applyTimelineCommands(seedEmptyPictureTimeline(production), [{ kind: "add-to-library", items: [{ kind: "artifact", artifactId: SONG }] }]);
}

async function mount(state: ClientState): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json: string) => sent.push(JSON.parse(json) as ClientMessage),
  } as unknown as NonNullable<Window["arke"]>);
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

function songNotice(screen: Mounted): HTMLElement | null {
  return screen.container.querySelector<HTMLElement>("[data-testid='song-notice']");
}

afterEach(() => {
  __setBridgeForTest(null);
  document.body.replaceChildren();
});

describe("a song that never reached the saved timeline (issue 3086)", () => {
  it("says so in the Cut, and one press places it from 0:00 for its whole length", async () => {
    const state = songState(importedFirst);
    const frameRate = productionFrameRate(state.world!.productions[0]!.meta);
    const screen = await mount(state);
    try {
      const notice = songNotice(screen);
      assert.ok(notice, "the missing song is said");
      assert.match(notice.textContent ?? "", /The song isn't on the timeline\./);
      assert.equal(screen.container.querySelector("[data-testid='empty-notice']"), null, "not the empty start in its place");
      const add = [...notice.querySelectorAll("button")].find(button => button.textContent === "Add the song");
      assert.ok(add, "with the one press");
      await act(async () => add.click());
      const sent = screen.sent.filter((message): message is Extract<ClientMessage, { kind: "timeline-command" }> => message.kind === "timeline-command");
      assert.equal(sent.length, 1, "one batch: one revision and one Undo");
      const [command] = sent;
      assert.equal(command!.baseRevision, 1, "against the saved revision");
      assert.equal(command!.label, "Add the song");
      // Already in the Library from the import, so only the track and the clip.
      assert.deepEqual(command!.commands.map(c => c.kind), ["add-track", "place"]);
      assert.deepEqual(command!.commands[0], { kind: "add-track", trackId: "tr_music", trackKind: "music", name: "Music" });
      const place = command!.commands[1] as Extract<ClientMessage, { kind: "timeline-command" }>["commands"][number] & { kind: "place" };
      assert.equal(place.trackId, "tr_music");
      assert.equal(place.clip.startFrame, 0, "from 0:00");
      assert.equal(place.clip.durationFrames, 60 * frameRate, "for the song's measured length");
      assert.deepEqual(place.clip.source, { kind: "artifact", artifactId: SONG, label: "why-you-do-me-like-that.mp3" });
      assert.equal(place.clip.gainDb, 0, "its sound kept at its own level");
      assert.equal(place.clip.role, "music");
    } finally {
      await close(screen);
    }
  });

  it("says nothing once the song is on the timeline, and the header states the song's length", async () => {
    const state = songState(production => {
      const imported = importedFirst(production);
      const song = state0Artifact();
      return applyTimelineCommands(imported, songPlacementCommands(imported, song, 60 * productionFrameRate(production.meta), "cl_song"));
    });
    const screen = await mount(state);
    try {
      assert.equal(songNotice(screen), null);
      assert.ok(screen.container.querySelector("[data-clip='cl_song']"), "the song is drawn on its track");
      // The picture track is empty; the film is the song, not 0s.
      assert.match(screen.container.querySelector(".fy-cuthead__meta")?.textContent ?? "", /^60s · /);
    } finally {
      await close(screen);
    }
  });

  it("leaves a production with no master alone", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    production.timeline = { status: "ready", timeline: seedStoryPictureTimeline(production) };
    const screen = await mount(state);
    try {
      assert.equal(songNotice(screen), null);
    } finally {
      await close(screen);
    }
  });

  it("leaves a song not yet opened on the timeline to its own opening", async () => {
    const screen = await mount(songState(() => null));
    try {
      assert.equal(songNotice(screen), null, "an unsaved song has Open on the timeline");
    } finally {
      await close(screen);
    }
  });
});

describe("songPlacementCommands", () => {
  const production = structuredClone(FIXTURE_STATE).world!.productions[0]!;

  it("files the song in the Library and takes a new Music track when the first is busy at 0:00", () => {
    const busy = applyTimelineCommands(seedEmptyPictureTimeline(production), [
      { kind: "add-track", trackId: "tr_music", trackKind: "music", name: "Music" },
      { kind: "place", trackId: "tr_music", clip: { id: "cl_bells", startFrame: 0, durationFrames: 48, sourceInFrames: 0, source: { kind: "artifact", artifactId: BELLS, label: "harbour-bells.wav" } } },
    ]);
    const commands = songPlacementCommands(busy, state0Artifact(), 1440, "cl_song");
    assert.deepEqual(commands.map(c => c.kind), ["add-to-library", "add-track", "place"]);
    assert.deepEqual(commands[1], { kind: "add-track", trackId: "tr_music-2", trackKind: "music", name: "Music 2" });
    // The batch applies as it stands: the song lands where it was meant to.
    const after = applyTimelineCommands(busy, commands);
    const placed = after.tracks.find(track => track.id === "tr_music-2")?.clips[0];
    assert.equal(placed?.id, "cl_song");
    assert.equal(placed?.durationFrames, 1440);
  });

  it("uses a Music track that is free from 0:00 to the song's end", () => {
    const later = applyTimelineCommands(seedEmptyPictureTimeline(production), [
      { kind: "add-track", trackId: "tr_music", trackKind: "music", name: "Music" },
      { kind: "place", trackId: "tr_music", clip: { id: "cl_bells", startFrame: 2000, durationFrames: 48, sourceInFrames: 0, source: { kind: "artifact", artifactId: BELLS, label: "harbour-bells.wav" } } },
    ]);
    const commands = songPlacementCommands(later, state0Artifact(), 1440, "cl_song");
    assert.deepEqual(commands.map(c => c.kind), ["add-to-library", "place"]);
    assert.equal((commands[1] as { trackId: string }).trackId, "tr_music");
  });
});

function state0Artifact(): ArtifactSidecar {
  return {
    id: SONG,
    kind: "audio",
    file: "artifacts/why-you-do-me-like-that.mp3",
    hash: "sha256:6a1e02b9c44d7f32",
    origin: { by: "user" },
    links: [],
    created: "2026-06-11T10:00:00Z",
    mediaInfo: { durationSec: 60, hasAudio: true },
  } as ArtifactSidecar;
}
