import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { TimelineClip, TimelineClipCommand } from "@arke-studio/contracts";
import { PictureClipTiming } from "../src/screens/editor-timeline.js";

/**
 * The Inspector's timing rows as a keyboard (SPEC-037 R-23): a timecode typed into In, Out,
 * Duration or Position becomes exactly one command on blur or Enter, clamped the way a grip drag
 * is, and the row always settles back to the record rather than to what was typed.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

/** A 3:47 song at 25fps, alone on its lane. */
const song: TimelineClip = {
  id: "cl_song",
  startFrame: 0,
  durationFrames: 5675,
  sourceInFrames: 0,
  source: { kind: "artifact", artifactId: "ar_01ARZ3NDEKTSV4RRFFQ69G5FAV", label: "cover.m4a" },
  gainDb: 0,
};

const open: Array<{ container: HTMLElement; root: Root }> = [];

async function mount(clip: TimelineClip, sent: Array<{ commands: TimelineClipCommand[]; label?: string }>, disabled = false): Promise<HTMLElement> {
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <PictureClipTiming
        clip={clip}
        clips={[clip]}
        frameRate={25}
        disabled={disabled}
        onCommands={(commands, label) => sent.push({ commands, ...(label === undefined ? {} : { label }) })}
        sourceLength={() => 5675}
      />,
    );
  });
  open.push({ container, root });
  return container;
}

afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
});

const field = (container: HTMLElement, label: string): HTMLInputElement =>
  container.querySelector(`input[aria-label="${label} timecode"]`) as HTMLInputElement;

const typeAndBlur = async (input: HTMLInputElement, value: string) => {
  input.value = value;
  await act(async () => input.dispatchEvent(new dom.window.Event("focusout", { bubbles: true })));
};

// linkedom has no KeyboardEvent; React reads `key` off the native event, so a plain one carries it.
const press = async (input: HTMLInputElement, key: string) => {
  const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  await act(async () => input.dispatchEvent(event));
};

describe("typing a timecode into the Inspector", () => {
  it("shows every row as timecode and sends one trim for a typed Out", async () => {
    const sent: Array<{ commands: TimelineClipCommand[]; label?: string }> = [];
    const container = await mount(song, sent);
    assert.deepEqual(
      ["Position", "In", "Out", "Duration"].map((label) => field(container, label).value),
      ["00:00:00:00", "00:00:00:00", "00:03:47:00", "00:03:47:00"],
    );
    await typeAndBlur(field(container, "Out"), "0:48");
    assert.deepEqual(sent, [{ commands: [{ kind: "trim", clipId: "cl_song", edge: "end", deltaFrames: -4475 }], label: "Trim clip tail" }]);
    // The record has not moved yet, so the row reads the record, not the wish.
    assert.equal(field(container, "Out").value, "00:03:47:00");
  });

  it("routes Duration and In to their edges and Position to a move", async () => {
    const sent: Array<{ commands: TimelineClipCommand[]; label?: string }> = [];
    const container = await mount(song, sent);
    await typeAndBlur(field(container, "Duration"), "10");
    await typeAndBlur(field(container, "In"), "0:10");
    await typeAndBlur(field(container, "Position"), "1:00");
    assert.deepEqual(sent.map((entry) => entry.commands[0]), [
      { kind: "trim", clipId: "cl_song", edge: "end", deltaFrames: -5425 },
      { kind: "trim", clipId: "cl_song", edge: "start", deltaFrames: 250 },
      { kind: "move-to-frame", clipId: "cl_song", startFrame: 1500 },
    ]);
  });

  it("sends nothing for text that is not a time, an unchanged value, or a tail already at its source", async () => {
    const sent: Array<{ commands: TimelineClipCommand[]; label?: string }> = [];
    const container = await mount(song, sent);
    await typeAndBlur(field(container, "Out"), "later");
    await typeAndBlur(field(container, "Out"), "00:03:47:00");
    await typeAndBlur(field(container, "Out"), "9:59");
    assert.equal(sent.length, 0);
    assert.equal(field(container, "Out").value, "00:03:47:00", "the row settles back to the record");
  });

  it("commits on Enter and drops the edit on Escape", async () => {
    const sent: Array<{ commands: TimelineClipCommand[]; label?: string }> = [];
    const container = await mount(song, sent);
    const out = field(container, "Out");
    out.value = "1:00";
    await press(out, "Escape");
    await act(async () => out.dispatchEvent(new dom.window.Event("focusout", { bubbles: true })));
    assert.equal(sent.length, 0, "Escape restores the record before the blur commits");
    out.value = "1:00";
    await press(out, "Enter");
    // linkedom's blur() does not raise focusout on its own; the commit path is the blur handler.
    await act(async () => out.dispatchEvent(new dom.window.Event("focusout", { bubbles: true })));
    assert.deepEqual(sent.map((entry) => entry.commands[0]), [{ kind: "trim", clipId: "cl_song", edge: "end", deltaFrames: -4175 }]);
  });

  it("is inert while the record cannot be edited", async () => {
    const sent: Array<{ commands: TimelineClipCommand[]; label?: string }> = [];
    const container = await mount(song, sent, true);
    assert.ok(field(container, "Out").disabled);
  });
});
