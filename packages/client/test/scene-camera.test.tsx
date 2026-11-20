import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { SceneDefaultsPatch, SceneRecord } from "@arke-studio/contracts";
import { SceneCamera } from "../src/screens/scene-workspace/scene-camera.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The scene's camera (issue 3247): the one place a film's light and look is said for every shot
 * in a scene. What matters is what each control sends, because the shot cards and the prompt
 * read whatever lands in the scene's `defaults`.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (time: number) => void) => setTimeout(() => cb(0), 0),
});

const open: Array<{ container: HTMLElement; root: Root }> = [];
afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
});

function sceneWith(defaults?: SceneRecord["defaults"]): SceneRecord {
  const scene = structuredClone(FIXTURE_STATE.world!.productions[0]!.scenes[0]!) as SceneRecord;
  if (defaults === undefined) delete scene.defaults;
  else scene.defaults = defaults;
  return scene;
}

async function mount(scene: SceneRecord, disabled = false) {
  const sent: SceneDefaultsPatch[] = [];
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container as never);
  const root = createRoot(container);
  open.push({ container, root });
  await act(async () => root.render(<SceneCamera scene={scene} disabled={disabled} onCommit={(patch) => sent.push(patch)} />));
  return { container, sent };
}

describe("the scene's camera (issue 3247)", () => {
  it("offers the conditions a scene holds, and not a shot's own moves or the time it already inherits", async () => {
    const { container } = await mount(sceneWith());
    const labels = [...container.querySelectorAll("select, input")].map((control) => control.getAttribute("aria-label"));
    assert.deepEqual(labels, ["Scene lens", "Scene focus", "Scene lighting", "Scene grade"]);
    assert.equal(container.querySelector("[role=group]")?.getAttribute("aria-label"), "Scene camera");
  });

  it("sends one field per choice, and null for a field put back to none", async () => {
    const { container, sent } = await mount(sceneWith({ lens: "35mm" }));
    const select = (label: string) => container.querySelector(`select[aria-label="${label}"]`) as unknown as HTMLSelectElement;
    const choose = async (label: string, value: string) => {
      const control = select(label);
      await act(async () => {
        Object.defineProperty(control, "value", { configurable: true, value });
        control.dispatchEvent(new dom.window.Event("change", { bubbles: true }) as unknown as Event);
      });
    };
    await choose("Scene lighting", "Practical lantern");
    await choose("Scene lens", "");
    assert.deepEqual(sent, [{ lighting: "Practical lantern" }, { lens: null }]);
  });

  it("shows a light Arke wrote that the list does not hold, rather than reading as unset", async () => {
    const { container } = await mount(sceneWith({ lighting: "a storm lantern far behind her" }));
    const options = [...container.querySelectorAll('select[aria-label="Scene lighting"] option')].map((option) => option.getAttribute("value"));
    assert.ok(options.includes("a storm lantern far behind her"));
    assert.equal(options[0], "", "none is still the first choice");
  });

  it("commits the grade when the line is left, trimmed, and clears it when emptied", async () => {
    const { container, sent } = await mount(sceneWith({ grade: "cold, high contrast" }));
    const line = container.querySelector('input[aria-label="Scene grade"]') as unknown as HTMLInputElement;
    const leave = async (value: string) => {
      await act(async () => {
        Object.defineProperty(line, "value", { configurable: true, value });
        // linkedom's blur() does not raise focusout on its own; the commit path is the blur handler.
        line.dispatchEvent(new dom.window.Event("focusout", { bubbles: true }) as unknown as Event);
      });
    };
    await leave("cold, high contrast");
    assert.deepEqual(sent, [], "leaving the line unchanged writes nothing");
    await leave("  35mm film, a little underexposed  ");
    await leave("");
    assert.deepEqual(sent, [{ grade: "35mm film, a little underexposed" }, { grade: null }]);
  });

  it("locks with the scene: a staged proposal or a write in flight takes no second edit", async () => {
    const { container } = await mount(sceneWith(), true);
    assert.ok([...container.querySelectorAll("select, input")].every((control) => control.hasAttribute("disabled")));
  });
});
