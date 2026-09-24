import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import type { PublicationPlayback } from "@arke-studio/contracts";
import { PublicationVideo, PublicationsScreen } from "../src/screens/publications.js";
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
