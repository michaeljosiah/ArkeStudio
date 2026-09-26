import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { GenesisVoicesSchema } from "@arke-studio/contracts";
import { GenesisVoiceCards } from "../src/components/genesis-voices.js";

it("plays the actual audition and keeps generation and assignment decisions separate", async () => {
  const dom = parseHTML("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const voice = { provider: "kokoro", model: "kokoro-82m", voiceId: "af_heart", label: "Heart", local: true, canClone: false, attributes: [] };
  const plan = { intent: { id: "audition", target: "character:maren", voice: { provider: voice.provider, model: voice.model, voiceId: voice.voiceId }, text: "The gate stays closed." },
    title: "Maren", voice, text: "The gate stays closed.", format: "wav", digest: "digest", transfer: "Runs on this device.", estimatedMicroUsd: 0 };
  const candidate = { id: "candidate", plan, file: "media/" + "a".repeat(64) + ".wav", hash: "sha256:" + "a".repeat(64), createdAt: new Date().toISOString() };
  const voices = GenesisVoicesSchema.parse({ catalogue: [voice], plans: [plan], candidates: [candidate], selections: [], rejected: [], problems: [], attempts: {} });
  const container = dom.document.createElement("div"), root = createRoot(container);
  const calls: string[] = [];
  try {
    await act(async () => root.render(<GenesisVoiceCards genesisId="gen-voice" voices={voices} jobs={[]} busy={false}
      onGenerate={() => calls.push("generate")} onDecide={(target, decision, heard) => calls.push([target, decision, heard?.hash].join("|"))}
      onRefresh={() => {}} onCancel={() => {}} onRevise={() => {}} />));
    assert.ok(container.querySelector("audio")?.getAttribute("src")?.includes("a".repeat(64)));
    const button = (name: string) => [...container.querySelectorAll("button")].find(button => button.textContent === name)!;
    await act(async () => button("Generate audition").click());
    assert.deepEqual(calls, ["generate"]);
    await act(async () => button("Use this voice").click());
    assert.equal(calls[1], "character:maren|approve|" + candidate.hash);
    await act(async () => button("Reject voice").click());
    assert.match(calls[2]!, /reject/);
  } finally { await act(async () => root.unmount()); }
});
