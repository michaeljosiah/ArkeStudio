import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import type { ClientMessage, CreatorPackagePreview, CreatorPublication } from "@arke-studio/contracts";
import { CreatorPublicationHistory, CreatorPublishingPanel } from "../src/components/creator-publishing.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Element: dom.Element, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
const scope = "a".repeat(64), worldId = FIXTURE_STATE.world!.meta.worldId;
const account = { kind: "signed-in" as const, person: { name: "Creator", email: "creator@example.invalid", picture: null }, plan: { name: "Creator", paid: false }, session: "ok" as const, creatorScope: scope, pages: [] };
const publication: CreatorPublication = { id: "11111111-1111-4111-8111-111111111111", worldId, productionId: "story", exportId: "ap_export", title: "Synthetic edition", edition: "2026-11-05", packageSha256: "b".repeat(64), packageBytes: 2048, receiptId: "22222222-2222-4222-8222-222222222222", revisionId: "33333333-3333-4333-8333-333333333333", revisionNumber: 1, status: "approved", transfer: "complete", receivedBytes: 2048, updatedAt: "2026-11-05T12:00:00Z", message: null, decisions: [] };
async function mounted(run: (container: HTMLElement, sent: ClientMessage[]) => Promise<void>) {
  const sent: ClientMessage[] = []; __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json)); } });
  __setStateForTest({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, account } }, { connection: "open" });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try { await act(async () => root.render(<MemoryRouter><CreatorPublishingPanel worldId={worldId} productionId="story" exportId="ap_export" /><CreatorPublicationHistory worldId={worldId} /></MemoryRouter>)); await run(container, sent); }
  finally { await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE); }
}
function reply(publications: CreatorPublication[], replyScope = scope) { __applyEventForTest({ at: "2026-11-05T12:00:00Z", type: "creator-publishing.changed", worldId, state: { configured: true, scopeId: replyScope, publications, refusal: null } }); }
it("offers single-line declaration fields matching AONIK's current metadata contract", async () => {
  await mounted(async container => {
    await act(async () => { const panel = container.querySelector("details")!; panel.open = true; panel.dispatchEvent(new Event("toggle")); });
    const preview: CreatorPackagePreview = { candidateId: publication.id, exportId: publication.exportId, title: publication.title, creatorDisplayName: "Creator", summary: "Synthetic description", worldId, edition: publication.edition, fileName: "fixture.zip", bytes: publication.packageBytes, sha256: publication.packageSha256, kind: "world", channelKey: "test", rightsDeclarationVersion: "test-v1", permissionText: "Synthetic permission", artworkAssetId: "cover", assets: [{ id: "cover", path: "cover.png", mediaType: "image/png", bytes: 10 }] };
    await act(async () => __applyEventForTest({ at: "2026-11-05T12:00:00Z", type: "creator-publishing.changed", worldId, state: { configured: true, scopeId: scope, publications: [], refusal: null, preview } }));
    for (const label of ["Public description", "Artwork, writing and voice attribution", "Distribution rights for every included file"]) {
      const field = container.querySelector(`[aria-label="${label}"]`); assert.equal(field?.tagName, "INPUT");
    }
    assert.equal(container.querySelector("textarea"), null); assert.match(container.textContent!, /Use one line for each field/);
  });
});
it("shows approval separately from delivery and sends only typed receipt controls", async () => {
  await mounted(async (container, sent) => { await act(async () => reply([publication])); assert.match(container.textContent!, /Approved · awaiting publication/); assert.ok(!container.querySelector("progress"));
    await act(async () => (Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Refresh receipt")!).click()); const command = sent.find(c => c.kind === "creator-publishing-control"); assert.equal(command?.kind, "creator-publishing-control"); if (command?.kind === "creator-publishing-control") { assert.equal(command.id, publication.id); assert.equal(command.action, "refresh"); }
    assert.ok(!JSON.stringify(sent).includes("Authorization")); await act(async () => reply([{ ...publication, status: "published" }])); assert.match(container.textContent!, /Published/);
  });
});
it("clears the previous creator's receipts and ignores their late responses", async () => {
  await mounted(async container => { await act(async () => reply([publication])); assert.match(container.textContent!, /Synthetic edition/);
    await act(async () => __setStateForTest({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, account: { ...account, creatorScope: "c".repeat(64) } } }, { connection: "open" })); await act(async () => reply([publication])); assert.ok(!container.textContent!.includes("Synthetic edition"));
  });
});
it("shows safe feedback for the current revision and retains resume after interruption", async () => {
  await mounted(async (container, sent) => { await act(async () => reply([{ ...publication, status: "changes-requested", transfer: "paused", receivedBytes: 1024, decisions: [{ revisionId: publication.revisionId!, decision: "request-changes", message: "Please correct the cover attribution", decidedAt: "2026-11-05T12:00:00Z" }, { revisionId: "44444444-4444-4444-8444-444444444444", decision: "reject", message: "Old revision message", decidedAt: "2026-11-04T12:00:00Z" }] }])); assert.match(container.textContent!, /correct the cover attribution/); assert.ok(!container.textContent!.includes("Old revision message")); assert.equal(container.querySelector("progress")?.getAttribute("value"), "1024");
    await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Resume upload")!.click()); assert.ok(sent.some(c => c.kind === "creator-publishing-control" && c.action === "resume"));
  });
});
