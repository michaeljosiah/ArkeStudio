import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import type { ClientMessage, ClientState } from "@arke-studio/contracts";
import { SamplingChip, SamplingDialog } from "../src/components/local-sampling.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { H3, withSampling } from "./local-sampling-fixture.js";

/**
 * Sampling for a local recipe (design turn 177): the line on the AI models tile, the dialog with
 * its presets, Custom and its one clause, Generate's chip, and the take saying what was sent.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Element: dom.Element,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.assign(dom.HTMLElement.prototype, { focus() {} });

function capture(): ClientMessage[] {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json)); } });
  return sent;
}

async function mounted(state: ClientState, node: ReactNode, run: (container: HTMLElement) => Promise<void>): Promise<void> {
  __setStateForTest(state);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter>{node}</MemoryRouter>));
    await run(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    __setBridgeForTest(null);
    __setStateForTest(FIXTURE_STATE);
  }
}

const click = (target: Element | null) => act(async () => {
  assert.ok(target, "there to press");
  (target as HTMLElement).click();
});

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.value = value;
    // linkedom answers no to React's `oninput` support probe, so an `input` dispatch never
    // reaches onChange (scene-workspace.test.tsx meets the same); the prop is called as a
    // keystroke would call it, with the value already on the node.
    const key = Object.keys(input).find((candidate) => candidate.startsWith("__reactProps$"));
    const props = key === undefined ? undefined : (input as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement }) => void }>)[key];
    assert.ok(props?.onChange, "the field listens for changes");
    props.onChange({ target: input });
  });
}

const SIXTY_A_STEP = [{ secPerStep: 60, fixedSec: 30, at: "2026-09-30T12:00:00.000Z" }];

describe("the dialog (design 177a, 177b)", () => {
  it("lists the catalogue's presets with values in mono and a dash until a run is measured", async () => {
    await mounted(withSampling(), <SamplingDialog model={H3} open onClose={() => {}} />, async () => {
      const rows = [...document.querySelectorAll(".fy-samp__opt")].map((row) => row.textContent);
      assert.deepEqual(rows, [
        "FastDefault8 steps · speed 1 · shift 12—",
        "Balanced10 steps · speed 0.75 · shift 9—",
        "Quality12 steps · speed 0.5 · shift 6—",
        "Custom—",
      ]);
    });
    await mounted(withSampling({ choices: {}, timings: { [H3.id]: SIXTY_A_STEP } }), <SamplingDialog model={H3} open onClose={() => {}} />, async () => {
      const times = [...document.querySelectorAll(".fy-samp__time")].map((cell) => cell.textContent);
      assert.deepEqual(times.slice(0, 3), ["~9 min", "~11 min", "~13 min"]);
    });
  });

  it("Custom out of range disables Save and shows the range as its one clause; in range saves the values", async () => {
    const sent = capture();
    let closed = false;
    await mounted(withSampling(), <SamplingDialog model={H3} open onClose={() => { closed = true; }} />, async () => {
      await click(document.querySelectorAll(".fy-samp__opt input")[3]!);
      const steps = document.querySelector<HTMLInputElement>("#fy-samp-steps")!;
      await type(steps, "40");
      const save = () => [...document.querySelectorAll("button")].find((button) => button.textContent === "Save") as HTMLButtonElement;
      assert.equal(save().disabled, true);
      const bad = document.querySelector(".fy-samp__field.is-bad")!;
      assert.equal(bad.querySelector(".fy-samp__range")!.textContent, "4 to 30");
      assert.equal(document.querySelectorAll(".fy-samp__field.is-bad").length, 1, "only the field that is wrong");
      await type(steps, "20");
      await type(document.querySelector<HTMLInputElement>("#fy-samp-speedAdapter")!, "0.33");
      assert.equal(save().disabled, true, "the speed adapter moves in 0.05");
      assert.equal(document.querySelector(".fy-samp__field.is-bad .fy-samp__range")!.textContent, "0 to 1 in 0.05");
      await type(document.querySelector<HTMLInputElement>("#fy-samp-speedAdapter")!, "0.6");
      assert.equal(save().disabled, false);
      await click(save());
    });
    assert.ok(closed);
    assert.deepEqual(sent.at(-1), {
      kind: "set-local-sampling",
      recipeId: H3.id,
      sampling: { preset: "custom", values: { steps: 20, speedAdapter: 0.6, shift: 12, sampler: "euler", scheduler: "simple" } },
    });
  });

  it("a preset saves by name, and Reset to Fast saves as nothing stored", async () => {
    const sent = capture();
    const saved = withSampling({ choices: { [H3.id]: { preset: "quality" } }, timings: {} });
    await mounted(saved, <SamplingDialog model={H3} open onClose={() => {}} />, async () => {
      await click(document.querySelectorAll(".fy-samp__opt input")[1]!);
      await click([...document.querySelectorAll("button")].find((button) => button.textContent === "Save")!);
    });
    assert.deepEqual(sent.at(-1), { kind: "set-local-sampling", recipeId: H3.id, sampling: { preset: "balanced" } });
    capture();
    const again = capture();
    await mounted(saved, <SamplingDialog model={H3} open onClose={() => {}} />, async () => {
      await click([...document.querySelectorAll("button")].find((button) => button.textContent === "Reset to Fast")!);
      assert.ok(document.querySelector(".fy-samp__opt")!.classList.contains("is-on"), "Fast is chosen again");
      await click([...document.querySelectorAll("button")].find((button) => button.textContent === "Save")!);
    });
    assert.deepEqual(again.at(-1), { kind: "set-local-sampling", recipeId: H3.id, sampling: null });
  });
});

describe("Generate's chip (design 177c)", () => {
  it("names the preset and its steps, and the menu writes the same Settings value", async () => {
    const sent = capture();
    await mounted(withSampling({ choices: {}, timings: { [H3.id]: SIXTY_A_STEP } }), <SamplingChip model={H3} />, async (container) => {
      const chip = container.querySelector('[data-testid="sampling-chip"]')!;
      assert.equal(chip.textContent, "Fast8 steps");
      await click(chip);
      const items = [...container.querySelectorAll(".fy-samp__item")].map((item) => item.textContent);
      assert.deepEqual(items, ["Fast~9 min", "Balanced~11 min", "Quality~13 min", "Custom—", "Edit in Settings"]);
      await click(container.querySelectorAll(".fy-samp__item")[2]!);
    });
    assert.deepEqual(sent.at(-1), { kind: "set-local-sampling", recipeId: H3.id, sampling: { preset: "quality" } });
  });
});

