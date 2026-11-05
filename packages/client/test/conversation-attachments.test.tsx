import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { newId, WorldChatWorkspaceSchema } from "@arke-studio/contracts";
import { ConversationAttachments } from "../src/components/conversation-attachments.js";
import { ConversationTranscript } from "../src/components/conversation.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const image = { id: newId("wca"), fileName: "reference.png", kind: "image" as const, readability: "not-readable" as const, promoted: false, imagePath: ".conversations/cv_example/attachments/wca_example/reference.png" };
const document = { id: newId("wca"), fileName: "notes.pdf", kind: "document" as const, readability: "extracted-text-available" as const, promoted: false };

it("renders attachments beside only the message that sent them", () => {
  __setStateForTest(FIXTURE_STATE);
  const workspace = WorldChatWorkspaceSchema.parse({ conversationId: newId("cv"), status: "open", points: [], attachments: [image, document], messages: [
    { id: newId("msg"), role: "user", text: "With files", attachmentIds: [image.id, document.id], receipts: [], createdAt: "2026-11-04T12:00:00Z" },
    { id: newId("msg"), role: "user", text: "Without files", receipts: [], createdAt: "2026-11-04T12:01:00Z" },
  ] });
  const html = renderToString(<MemoryRouter><ConversationTranscript workspace={workspace} running={false} progress={null} failure={null} canRetry={false} /></MemoryRouter>);
  const { document: dom } = parseHTML(html);
  const turns = dom.querySelectorAll(".fy-chat__turn--user");
  assert.equal(turns[0]!.querySelectorAll(".fy-chat-attachment").length, 2);
  assert.match(turns[0]!.textContent!, /notes.pdf · text only/);
  assert.match(turns[0]!.querySelector("img")!.getAttribute("src")!, /\/media\/the-undersong\/\.conversations\//);
  assert.equal(turns[1]!.querySelectorAll(".fy-chat-attachment").length, 0);
});

it("retains the file name when a thumbnail fails and labels missing attachment metadata", async () => {
  const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const container = dom.document.getElementById("root")!;
  const root = createRoot(container as unknown as HTMLElement);
  try {
    await act(async () => root.render(<ConversationAttachments ids={[image.id, "missing"]} attachments={[image]} worldSlug="the-undersong" />));
    await act(async () => container.querySelector("img")!.dispatchEvent(new dom.Event("error")));
    assert.equal(container.querySelector("img"), null);
    assert.match(container.textContent!, /Preview unavailable.*reference.png/);
    assert.match(container.textContent!, /Attachment unavailable/);
  } finally { await act(async () => root.unmount()); }
});
