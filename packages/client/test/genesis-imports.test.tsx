import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { GenesisImportsSchema, type GenesisImportResolve } from "@arke-studio/contracts";
import { GenesisImportCards } from "../src/components/genesis-imports.js";

it("shows exact source evidence separately from interpretation and sends the reviewed merge revision", async () => {
  const dom = parseHTML("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const imports = GenesisImportsSchema.parse({ documents: [{ name: "notes.md", supported: true, detail: "Ready" }], problems: [],
    cards: [{ id: "a".repeat(64), digest: "reviewed-digest", proposal: { source: "notes.md", kind: "character", name: "Maren", body: "Keeper", quote: "Maren keeps the light." },
      source: { hash: "sha256:" + "b".repeat(64), name: "notes.md", quote: "Maren keeps the light.", line: 3,
        candidateId: "a".repeat(64), originalName: "Maren", originalBody: "Keeper", modified: false },
      matches: [{ key: "character:maren", name: "Maren", text: "Lives inland." }], status: "pending" }] });
  const decisions: GenesisImportResolve[] = [], extracted: string[] = [];
  const container = dom.document.createElement("div"), root = createRoot(container);
  dom.document.body.appendChild(container);
  try {
    await act(async () => root.render(<GenesisImportCards imports={imports} busy={false} onResolve={decision => decisions.push(decision)}
      onExtract={name => extracted.push(name)} onRefresh={() => {}} />));
    assert.equal(container.querySelector("blockquote")?.textContent, "Maren keeps the light.");
    assert.match(container.textContent!, /interpretation/);
    assert.match(container.textContent!, /Lives inland/);
    const button = (text: string) => [...container.querySelectorAll("button")].find(button => button.textContent === text)!;
    await act(async () => button("Prepare for approval").click());
    assert.equal(decisions[0]?.digest, "reviewed-digest");
    assert.equal(decisions[0]?.target, "character:maren");
    assert.equal(decisions[0]?.decision, "prepare");
    await act(async () => button("Leave undecided").click());
    assert.equal(decisions.at(-1)?.decision, "defer");
    await act(async () => button("Extract proposals in chat").click());
    assert.deepEqual(extracted, ["notes.md"]);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
