import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { GenesisBlueprintSchema, GenesisImportsSchema, type GenesisImportResolve } from "@arke-studio/contracts";
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
    assert.equal(button("Prepare for approval").disabled, true);
    const resolution = container.querySelector('[aria-label="Import resolution"]')!;
    const resolutionProps = (resolution as unknown as Record<string, { onChange(event: { target: { value: string } }): void }>)[Object.keys(resolution).find(key => key.startsWith("__reactProps$"))!]!;
    await act(async () => resolutionProps.onChange({ target: { value: "append" } }));
    assert.equal(button("Prepare for approval").disabled, false);
    await act(async () => button("Prepare for approval").click());
    assert.equal(decisions[0]?.digest, "reviewed-digest");
    assert.equal(decisions[0]?.target, "character:maren");
    assert.equal(decisions[0]?.decision, "prepare");
    await act(async () => button("Leave undecided").click());
    assert.equal(decisions.at(-1)?.decision, "defer");
    await act(async () => button("Extract proposals in chat").click());
    assert.deepEqual(extracted, ["notes.md"]);
    const change = async (selector: string, value: string) => {
      const input = container.querySelector(selector)!;
      const props = (input as unknown as Record<string, { onChange(event: { target: { value: string } }): void }>)[Object.keys(input).find(key => key.startsWith("__reactProps$"))!]!;
      await act(async () => props.onChange({ target: { value } }));
    };
    const blueprint = GenesisBlueprintSchema.parse({ characters: [{ slug: "rue", name: "Rue", line: "Captain" }], locations: [], factions: [], threads: [], dropped: [] });
    await change('[aria-label="Imported name"]', "Rue");
    await change('[aria-label="Imported interpretation"]', "My edited interpretation");
    const refreshed = { ...imports, cards: imports.cards.map(card => ({ ...card, digest: "new-digest", proposal: { ...card.proposal, name: "Updated source name", body: "Updated extraction" } })) };
    await act(async () => root.render(<GenesisImportCards imports={refreshed} blueprint={blueprint} busy={false}
      onResolve={decision => decisions.push(decision)} onExtract={() => {}} onRefresh={() => {}} />));
    assert.equal((container.querySelector('[aria-label="Imported name"]') as HTMLInputElement).value, "Rue");
    assert.equal((container.querySelector('[aria-label="Imported interpretation"]') as HTMLTextAreaElement).value, "My edited interpretation");
    await change('[aria-label="Import resolution"]', "append");
    await act(async () => button("Prepare for approval").click());
    assert.equal(decisions.at(-1)?.target, "character:rue");
    assert.equal(decisions.at(-1)?.digest, "new-digest");
    assert.equal(decisions.at(-1)?.body, "My edited interpretation");
  } finally { await act(async () => root.unmount()); container.remove(); }
});
