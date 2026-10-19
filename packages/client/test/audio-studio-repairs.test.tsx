import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { newAudioClip, resolveAudioArrangement, type AudioArrangementCommand, type AudioStudioSnapshot } from "@arke-studio/contracts";
import { AudioStudioRepairs } from "../src/screens/audio-studio-repairs.js";
import { audioStudioReview } from "../src/lib/audio-studio-edit.js";

it("offers a reviewed removal for a deleted passage even when no reattachment target exists", async () => {
  const { document, window } = parseHTML("<html><body><main></main></body></html>");
  Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const source = { file: "artifacts/voice.wav", hash: `sha256:${"a".repeat(64)}`, samples: 4800, rate: 48000, channels: 2, label: "Deleted line" };
  const snapshot: AudioStudioSnapshot = { base: "a".repeat(64), revision: 1, undo: null, redo: null, passages: [], library: [], script: { hash: "new", passages: [] },
    state: { manuscriptHash: "old", passages: [{ id: "deleted", key: "p0.0", textHash: "words" }], tracks: [{ id: "voice", name: "Voice", gainDb: 0, muted: false }],
      clips: [{ ...newAudioClip("voice", "voice", source, 4800), role: "speech", passageId: "deleted", placement: { kind: "sequence", offset: 0 } }], omissions: [], master: { targetLufs: -18, ceilingDb: -1 } } };
  const reviews: AudioArrangementCommand[][] = [], root = createRoot(document.querySelector("main")!);
  try {
    await act(async () => root.render(<AudioStudioRepairs snapshot={snapshot} plan={resolveAudioArrangement(snapshot.state, snapshot.script)} disabled={false} onSelect={() => {}} onReview={(_label, commands) => reviews.push(commands)} />));
    const remove = [...document.querySelectorAll("button")].find(button => button.textContent === "Review removal"); assert.ok(remove);
    await act(async () => { remove.dispatchEvent(new window.Event("click", { bubbles: true })); });
    assert.deepEqual(reviews, [[{ kind: "remove-passage", id: "deleted" }]]);
    const review = audioStudioReview(snapshot, { kind: "commands", label: "Remove deleted audio", commands: reviews[0]! });
    assert.deepEqual(review.removed.map(entry => entry.clip.label), ["Deleted line"], "unresolved clips are named in the review even though they have no timeline position");
  } finally { await act(async () => root.unmount()); }
});

it("names a sound it could not place, and an episode's unread line by its words (issue 1888)", async () => {
  const { document, window } = parseHTML("<html><body><main></main></body></html>");
  Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const key = "01M59437SMGZY0V4MP1DZMXHH2";
  const snapshot: AudioStudioSnapshot = { base: "a".repeat(64), revision: 0, undo: null, redo: null, library: [],
    passages: [{ key, text: "Narrator: Prediction is written at dusk." }], script: { hash: "s", passages: [{ key, textHash: "t" }] },
    unavailable: [{ file: "artifacts/harbour-bells.wav", message: "A page turned close to the lamp: the file could not be decoded" }],
    state: { manuscriptHash: "s", passages: [{ id: "p1", key, textHash: "t" }], tracks: [{ id: "voice", name: "Voice", gainDb: 0, muted: false }], clips: [], omissions: [], master: { targetLufs: -18, ceilingDb: -1 } } };
  const root = createRoot(document.querySelector("main")!);
  try {
    await act(async () => root.render(<AudioStudioRepairs snapshot={snapshot} plan={resolveAudioArrangement(snapshot.state, snapshot.script)} disabled={false} onSelect={() => {}} onReview={() => {}} />));
    const text = document.querySelector("details")!.textContent!;
    assert.match(text, /Not placed · A page turned close to the lamp: the file could not be decoded/);
    assert.match(text, /Narrator: Prediction is written at dusk\. · /, "the line by its words");
    assert.doesNotMatch(text, new RegExp(key), "never by its block id");
    assert.match(document.querySelector("summary")!.textContent!, /^2 repairs before final delivery$/);
  } finally { await act(async () => root.unmount()); }
});
