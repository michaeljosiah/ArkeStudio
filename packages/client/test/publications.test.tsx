import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { applyTimelineCommands, seedEmptyPictureTimeline, type ClientState, type PublicationPlayback, type PublicationBridge } from "@arke-studio/contracts";
import { PublicationJobs, PublicationVideo, PublicationsScreen } from "../src/screens/publications.js";
import { PublicationExport } from "../src/screens/publication-export.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { readPublicationPreference, savePublicationPreference } from "../src/lib/publication-preferences.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const stored = new Map<string, string>();
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true, localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) } });
const publication: PublicationPlayback = { sessionId: "session", mediaType: 'video/mp4; codecs="avc1"', manifestSha256: "a".repeat(64),
  assets: { movie: "http://127.0.0.1:1234/media/session/movie", en: "http://127.0.0.1:1234/media/session/en", fr: "http://127.0.0.1:1234/media/session/fr" },
  manifest: { format: "arke-publication", schemaVersion: 1, id: "urn:uuid:00000000-0000-4000-8000-000000000001", edition: "1", profile: "video", profileVersion: 1,
    title: "Offline film", language: "en", requires: ["video-v1", "webvtt-v1"], assets: {},
    content: { video: "movie", textTracks: [
      { asset: "en", kind: "captions", language: "en", label: "English CC", default: true },
      { asset: "fr", kind: "subtitles", language: "fr", label: "French", default: false },
    ] }, build: { compiler: "test", compilerVersion: "1", dependencyFingerprint: "b".repeat(64) } } };

it("renders the world-independent screen and explains when its desktop host is absent", () => {
  const html = renderToString(<MemoryRouter><PublicationsScreen /></MemoryRouter>);
  assert.match(html, /data-screen="publications"/); assert.match(html, /No world needs to be open/);
  assert.match(html, /Open publications in the desktop app/);
});
it("preflights codecs, restores position, switches both caption kinds off/on and persists outside the package", async t => {
  const key = `arke-publication:${publication.manifest.id}:${publication.manifestSha256}`;
  savePublicationPreference(key, { time: 7, caption: "fr" });
  const tracks = [{ mode: "disabled" }, { mode: "disabled" }];
  const prototype = Object.getPrototypeOf(document.createElement("video"));
  Object.assign(prototype, { canPlayType: () => "probably", textTracks: tracks, currentTime: 0, duration: 20 });
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  t.after(async () => { await act(async () => root.unmount()); node.remove(); });
  await act(async () => root.render(<PublicationVideo publication={publication} />));
  const video = node.querySelector("video")!;
  await act(async () => video.dispatchEvent(new dom.Event("loadedmetadata")));
  assert.equal(video.currentTime, 7); assert.equal(tracks[1]!.mode, "showing"); assert.equal(tracks[0]!.mode, "disabled");
  const select = node.querySelector("select")!;
  Object.defineProperty(select, "value", { value: "", configurable: true });
  await act(async () => select.dispatchEvent(new dom.Event("change", { bubbles: true })));
  assert.deepEqual(tracks.map(track => track.mode), ["disabled", "disabled"]);
  assert.equal(readPublicationPreference(key, "en").caption, "");
  assert.equal(node.querySelectorAll("track").length, 2);
  assert.equal(node.querySelector("track")!.getAttribute("kind"), "captions");
  assert.equal(node.querySelector("track")!.hasAttribute("default"), false, "the package default must not override a saved track choice");
  assert.equal(node.querySelectorAll("track")[1]!.hasAttribute("default"), true);
  assert.equal(video.getAttribute("src"), publication.assets.movie);
  Object.assign(prototype, { canPlayType: () => "" });
  await act(async () => root.render(<PublicationVideo key="unsupported" publication={publication} />));
  assert.match(node.textContent!, /does not support/); assert.equal(node.querySelector("video")!.getAttribute("src"), null);
});
it("resume state is isolated by edition identity and manifest digest", () => {
  savePublicationPreference("edition-a:hash-a", { time: 50, caption: "fr" });
  assert.deepEqual(readPublicationPreference("edition-b:hash-b", "en"), { time: 0, caption: "en" });
  stored.set("bad", '{"time":-1,"caption":"en"}');
  assert.deepEqual(readPublicationPreference("bad", ""), { time: 0, caption: "" });
});

it("shows a new-edition refusal without offering a retry that cannot recover it", async t => {
  const previous = window.arke;
  window.arke = { appVersion: "test", platform: "test", connect() {}, send() {}, subscribe() {}, publications: {
    list: async () => ({ ok: true, value: [{ operationId: "job", worldId: "world", productionId: "film", title: "Film", status: "failed", phase: "Create a new edition",
      reason: "The media encoder changed. Create a new edition.", retryable: false }] }),
    open: async () => ({ ok: false, reason: "unused" }), close: async () => {}, start: async () => ({ ok: false, reason: "unused" }),
    retry: async () => ({ ok: false, reason: "unused" }), cancel: async () => {}, reveal: async () => ({ ok: true, value: null }),
  } };
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  t.after(async () => { await act(async () => root.unmount()); node.remove(); window.arke = previous; });
  await act(async () => root.render(<MemoryRouter><PublicationJobs /></MemoryRouter>));
  assert.match(node.textContent!, /encoder changed/); assert.equal(node.querySelector("button"), null);
});

it("keeps the current movie on cancelled/invalid opens and releases it only after a successful replacement", async t => {
  Object.assign(Object.getPrototypeOf(document.createElement("video")), { canPlayType: () => "probably" });
  const previous = window.arke;
  const closed: string[] = []; let opening = 0;
  window.arke = { appVersion: "test", platform: "test", connect() {}, send() {}, subscribe() {}, publications: {
    list: async () => ({ ok: true, value: [] }), close: async id => { closed.push(id); },
    open: async () => {
      opening++;
      if (opening === 2) return { ok: false, cancelled: true, reason: "cancelled" };
      if (opening === 3) return { ok: false, reason: "unsupported package" };
      return { ok: true, value: { ...publication, sessionId: opening === 1 ? "first" : "second" } };
    },
    start: async () => ({ ok: false, reason: "unused" }), retry: async () => ({ ok: false, reason: "unused" }), cancel: async () => {}, reveal: async () => ({ ok: true, value: null }),
  } };
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  t.after(async () => { await act(async () => root.unmount()); node.remove(); window.arke = previous; });
  await act(async () => root.render(<MemoryRouter><PublicationsScreen /></MemoryRouter>));
  const open = async () => { await act(async () => Array.from(node.querySelectorAll("button")).find(button => button.textContent === "Open folder")!.click()); };
  await open(); const first = node.querySelector("video"); assert.ok(first);
  await open(); assert.equal(node.querySelector("video"), first); assert.equal(node.querySelector('[role="alert"]'), null);
  await open(); assert.equal(node.querySelector("video"), first); assert.match(node.textContent!, /unsupported package/);
  assert.deepEqual(closed, []);
  await open(); assert.notEqual(node.querySelector("video"), first); assert.deepEqual(closed, ["first"]);
});

it("submits a fresh edition identity with the saved revision and explicit publication options", async t => {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  const timeline = applyTimelineCommands(seedEmptyPictureTimeline(production), [
    { kind: "place", trackId: "tr_picture", clip: { id: "cl_blank", startFrame: 0, durationFrames: 48, sourceInFrames: 0,
      source: { kind: "artifact", artifactId: "ar_01J8G0000000000000000000A1", label: "Blank" } } },
  ]);
  timeline.tracks[0]!.muted = true;
  production.timeline = { status: "ready", timeline };
  const sent: Array<Parameters<PublicationBridge["start"]>[0]> = [];
  const previous = window.arke;
  window.arke = { appVersion: "test", platform: "test", connect() {}, send() {}, subscribe() {}, publications: {
    list: async () => ({ ok: true, value: [] }),
    start: async input => { sent.push(input); return { ok: true, value: { operationId: "job", worldId: "world", productionId: production.meta.id, title: input.request.title, status: "running", phase: "Rendering" } }; },
    open: async () => ({ ok: false, reason: "unused" }), close: async () => {}, retry: async () => ({ ok: false, reason: "unused" }), cancel: async () => {}, reveal: async () => ({ ok: true, value: null }),
  } };
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  t.after(async () => { await act(async () => root.unmount()); node.remove(); window.arke = previous; });
  await act(async () => root.render(<MemoryRouter><PublicationExport worldId="world" production={production} world={state.world} preset="master" disabled={false} /></MemoryRouter>));
  const button = (text: string) => Array.from(node.querySelectorAll("button")).find(item => item.textContent === text)!;
  await act(async () => button("Publish playable edition").click());
  assert.equal(button("Choose folder and publish").disabled, false, node.textContent!);
  await act(async () => button("Choose folder and publish").click());
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.request.id, /^urn:uuid:/);
  assert.notEqual(sent[0]!.request.id, "urn:uuid:00000000-0000-4000-8000-000000000000");
  assert.equal(sent[0]!.request.timelineRevision, timeline.revision);
  assert.equal(sent[0]!.request.preset, "master");
  assert.equal(sent[0]!.format, "zip");
  assert.deepEqual(sent[0]!.request.textTracks, [], "ordinary export burn-in choices never leak into publication tracks");
  assert.match(node.textContent!, /Publication started/);
});
