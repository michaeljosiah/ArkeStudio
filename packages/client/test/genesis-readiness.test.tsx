import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { renderToString } from "react-dom/server";
import type { FoundingBuildState, GenesisReadiness } from "@arke-studio/contracts";
import { GenesisReadinessCard, FoundingProgressCard } from "../src/components/genesis-readiness.js";
import { __applyEventForTest, __setStateForTest, __setBridgeForTest, __stateForTest, reviewGenesisReadiness, leaveGenesisFinding } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("serializes readiness requests in the client and releases them after answers or failure", () => {
  const sent: string[] = [];
  __setStateForTest(FIXTURE_STATE);
  __setBridgeForTest({ send: (message: string) => sent.push(message) } as unknown as ArkeBridge);
  try {
    reviewGenesisReadiness("gen-ready"); reviewGenesisReadiness("gen-ready"); leaveGenesisFinding("gen-ready", "finding", "current");
    assert.equal(sent.length, 1);
    assert.equal(__stateForTest().genesis["gen-ready"]?.readinessPending, true);
    __applyEventForTest({ type: "genesis.readiness", at: new Date().toISOString(), genesisId: "gen-ready", review: {
      digest: "current", approved: [], reused: [], findings: [], canBegin: true,
    } });
    leaveGenesisFinding("gen-ready", "finding", "current");
    assert.equal(sent.length, 2);
    __applyEventForTest({ type: "genesis.status", at: new Date().toISOString(), genesisId: "gen-ready", status: "failed", detail: "Refresh the review." });
    assert.equal(__stateForTest().genesis["gen-ready"]?.readinessPending, false);
    reviewGenesisReadiness("gen-ready");
    assert.equal(sent.length, 3);
  } finally { __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE); }
});

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
  assert.match(html, /Review retry in Activity/);
  assert.ok(!html.includes(">Retry Maren<"));
  assert.match(html, /Provider offline/);
  assert.match(html, /Keep completed work and leave the rest/);
  const held = { ...build, items: build.items.map(item => item.key === "photo" ? { ...item, state: "held" as const } : item) };
  const heldHtml = renderToString(<FoundingProgressCard build={held} />);
  assert.match(heldHtml, /Resolve in Activity/);
  assert.doesNotMatch(heldHtml, /Retry/);
  const completed = { ...build, shortfall: null, items: build.items.map(item => ({ ...item, state: "landed" as const })) };
  assert.equal(renderToString(<FoundingProgressCard build={completed} />), "");
  const retrying = { ...build, noticeDismissed: true, items: build.items.map(item => item.key === "photo" ? { ...item, state: "running" as const } : item) };
  const retryHtml = renderToString(<FoundingProgressCard build={retrying} />);
  assert.match(retryHtml, /Stop and skip remaining work/);
  assert.doesNotMatch(retryHtml, /Keep completed work and leave the rest/);
});
it("keeps readiness requests behind a pending content decision", async () => {
  const store = await import("../src/lib/store.js");
  const sent: string[] = [];
  __setStateForTest(FIXTURE_STATE);
  __setBridgeForTest({ send: (message: string) => sent.push(message) } as unknown as ArkeBridge);
  try {
    store.decideGenesisDraft("gen-pending-content", [{ key: "world", digest: "reviewed" }], "approve");
    reviewGenesisReadiness("gen-pending-content");
    leaveGenesisFinding("gen-pending-content", "finding", "reviewed");
    assert.equal(sent.length, 1);
    assert.ok(!__stateForTest().genesis["gen-pending-content"]?.readinessPending);
  } finally { __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE); }
});

it("keeps readiness behind media and import decisions and permits it after settlement", async () => {
  const store = await import("../src/lib/store.js");
  const commands = [
    () => store.generateGenesisImage("gen-pending", "intent", "digest"),
    () => store.decideGenesisImage("gen-pending", "character:maren", "unassign"),
    () => store.generateGenesisVoice("gen-pending", "intent", "digest"),
    () => store.decideGenesisVoice("gen-pending", "maren", "unassign"),
    () => store.resolveGenesisImport("gen-pending", { id: "source", digest: "digest", decision: "reject" }),
  ];
  const sent: string[] = [];
  __setBridgeForTest({ send: (message: string) => sent.push(message) } as unknown as ArkeBridge);
  try {
    for (const command of commands) {
      __setStateForTest(FIXTURE_STATE);
      sent.length = 0;
      command();
      reviewGenesisReadiness("gen-pending");
      leaveGenesisFinding("gen-pending", "finding", "digest");
      assert.equal(sent.length, 1);
      assert.ok(__stateForTest().genesis["gen-pending"]?.decisionPending);
      __applyEventForTest({ type: "genesis.status", at: new Date().toISOString(), genesisId: "gen-pending", status: "failed" });
      reviewGenesisReadiness("gen-pending");
      assert.equal(sent.length, 2);
      command();
      assert.equal(sent.length, 2, "a pending readiness request also fences decisions");
    }
    __setStateForTest(FIXTURE_STATE);
    store.decideGenesisImage("gen-pending", "character:maren", "unassign");
    __applyEventForTest({ type: "genesis.images", at: new Date().toISOString(), genesisId: "gen-pending", images: {
      candidates: [], selections: [], plans: [], rejected: [], problems: [],
    } });
    assert.equal(__stateForTest().genesis["gen-pending"]?.decisionPending, undefined);
  } finally { __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE); }
});
