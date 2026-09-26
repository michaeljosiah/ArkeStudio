import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { renderToString } from "react-dom/server";
import type { FoundingBuildState, GenesisReadiness } from "@arke-studio/contracts";
import { GenesisReadinessCard, FoundingProgressCard } from "../src/components/genesis-readiness.js";

it("offers fixes and optional unresolved choices without dismissing blockers", async () => {
  const dom = parseHTML("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const review: GenesisReadiness = { digest: "current", approved: [], reused: [], canBegin: false, findings: [
    { id: "link", category: "blocker", title: "Broken relationship", detail: "The lighthouse is missing.", records: [{ key: "character:maren", text: "Lives at the lighthouse." }], leftOpen: false },
    { id: "question", category: "open", title: "Open question", detail: "Who built the gate?", records: [], leftOpen: false },
  ] };
  const container = dom.document.createElement("div"), root = createRoot(container), calls: string[] = [];
  try {
    await act(async () => root.render(<GenesisReadinessCard review={review} busy={false} onRefresh={() => {}} onFix={text => calls.push(text)}
      onLeave={(id, digest) => calls.push(id + ":" + digest)} />));
    const leaves = [...container.querySelectorAll("button")].filter(button => button.textContent === "Leave unresolved");
    assert.equal(leaves.length, 1);
    await act(async () => leaves[0]!.click());
    assert.deepEqual(calls, ["question:current"]);
    assert.equal(leaves[0]!.hasAttribute("disabled"), true);
    const fix = [...container.querySelectorAll("button")].find(button => button.textContent === "Propose a fix")!;
    await act(async () => fix.click());
    assert.match(calls[1]!, /character:maren/);
    assert.match(calls[1]!, /approval/);
  } finally { await act(async () => root.unmount()); }
});
it("shows failed and held work with retry controls while retaining completed results", () => {
  const build: FoundingBuildState = { buildId: "fb_01J8E0000000000000000000B1", worldId: "01J8E0000000000000000000B1", genesisId: "gen-ready",
    worldName: "Harbour", status: "completed", stages: [], progress: { terminal: 2, authorized: 2 }, working: [], shortfall: { count: 1, cause: "Provider offline" },
    noticeDismissed: false, capMicroUsd: 40000, estimatedSpendMicroUsd: 0, items: [
      { key: "sheet", kind: "author-sheet", stage: 1, subject: "maren", name: "Maren", state: "landed", authorized: true, estimatedMicroUsd: 0 },
      { key: "photo", kind: "main-photo", stage: 2, subject: "maren", name: "Maren photo", state: "failed", detail: "Provider offline", authorized: true, estimatedMicroUsd: 40000 },
    ] };
  const html = renderToString(<FoundingProgressCard build={build} />).replaceAll("<!-- -->", "");
  assert.match(html, /Retry Maren photo/);
  assert.ok(!html.includes(">Retry Maren<"));
  assert.match(html, /Provider offline/);
  assert.match(html, /Keep completed work and leave the rest/);
  const held = { ...build, items: build.items.map(item => item.key === "photo" ? { ...item, state: "held" as const } : item) };
  const heldHtml = renderToString(<FoundingProgressCard build={held} />);
  assert.match(heldHtml, /Resolve in Activity/);
  assert.doesNotMatch(heldHtml, /Retry/);
  const completed = { ...build, shortfall: null, items: build.items.map(item => ({ ...item, state: "landed" as const })) };
  assert.equal(renderToString(<FoundingProgressCard build={completed} />), "");
});
