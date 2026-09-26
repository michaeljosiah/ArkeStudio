import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { GenesisImageCards } from "../src/components/genesis-images.js";
import { GenesisBlueprintSchema, GenesisImagesSchema, type GenesisImageCandidate } from "@arke-studio/contracts";

it("previews character and location results inline and sends the displayed version with each decision", async () => {
  const dom = parseHTML("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const blueprint = GenesisBlueprintSchema.parse({ name: "Harbour", characters: [{ slug: "maren", name: "Maren" }], locations: [{ slug: "vigil", name: "The Vigil" }] });
  const images = GenesisImagesSchema.parse({ plans: [], selections: [], rejected: [], problems: [],
    candidates: ["character:maren", "location:vigil"].map((target, index) => ({
      id: `image-${index}`, file: `media/${String(index).repeat(64)}.png`, hash: `sha256:${String(index).repeat(64)}`,
      label: index ? "The Vigil" : "Maren", source: "generated", target, createdAt: "2026-09-25T10:00:00.000Z",
    })),
  });
  const decisions: Array<{ target: string; decision: string; candidate?: GenesisImageCandidate }> = [];
  const revisions: string[] = [];
  const container = dom.document.createElement("div"), root = createRoot(container);
  dom.document.body.appendChild(container);
  try {
    await act(async () => root.render(<GenesisImageCards genesisId="gen-images" blueprint={blueprint} images={images} jobs={[]} busy={false}
      onGenerate={() => {}} onCancel={() => {}} onDecide={(target, decision, candidate) => decisions.push({ target, decision, candidate })} onRevise={text => revisions.push(text)} />));
    assert.equal(container.querySelectorAll("img").length, 2);
    for (const [index, article] of [...container.querySelectorAll("article")].entries()) {
      const img = article.querySelector("img")!;
      assert.ok(img.getAttribute("src")?.includes(images.candidates[index]!.file.split("/")[1]!));
      const button = (label: string) => [...article.querySelectorAll("button")].find(button => button.textContent === label)!;
      await act(async () => button("Use this image").click());
      assert.equal(decisions.at(-1)?.candidate?.hash, images.candidates[index]?.hash);
      assert.equal(decisions.at(-1)?.target, images.candidates[index]?.target);
      await act(async () => button("Reject").click());
      assert.equal(decisions.at(-1)?.decision, "reject");
      await act(async () => button("Request changes").click());
    }
    assert.equal(revisions.length, 2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("keeps image failures separate from conversation lifecycle and clears them on recovery", async () => {
  const store = await import("../src/lib/store.js");
  const { FIXTURE_STATE } = await import("./fixture-state.js");
  store.__setStateForTest(FIXTURE_STATE);
  const at = new Date().toISOString(), genesisId = "gen-image-error";
  store.__applyEventForTest({ type: "genesis.status", at, genesisId, status: "completed" });
  store.__applyEventForTest({ type: "genesis.image-error", at, genesisId, detail: "Review the changed prompt." });
  assert.equal(store.__stateForTest().genesis[genesisId]?.status, "completed");
  assert.equal(store.__stateForTest().genesis[genesisId]?.imageError, "Review the changed prompt.");
  store.__applyEventForTest({ type: "genesis.images", at, genesisId, images: GenesisImagesSchema.parse({ plans: [], candidates: [], selections: [], rejected: [], problems: [] }) });
  assert.equal(store.__stateForTest().genesis[genesisId]?.imageError, undefined);
  store.__setStateForTest(FIXTURE_STATE);
});
