import assert from "node:assert/strict";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import type { StudioAssistantCommand, StudioAssistantSnapshot } from "@arke-studio/contracts";
import { StudioConversationClient } from "../src/lib/studio-assistant.js";

const id = "01J8F3K2QW9VZX4N7M0RTYB6HC", other = "01J8F3K2QW9VZX4N7M0RTYB6HD";
const state = (ids: string[] = []): StudioAssistantSnapshot => ({ audit: "available", accepting: true, busy: false, share: null, ephemeralReply: null,
  threads: ids.map(id => ({ id, createdAt: 1, updatedAt: 1, archived: false, messages: [], pending: null })) });
function fixture() {
  const sent: StudioAssistantCommand[] = [];
  const client = new StudioConversationClient({ id: randomUUID, send(message) { sent.push(message); return true; } }, 20);
  client.setConnected(true); client.open();
  const deliver = (value: StudioAssistantSnapshot) => client.receive({ requestId: sent.findLast(message => message.command.action === "watch")!.requestId, response: { type: "state", state: value } });
  const reply = (request: StudioAssistantCommand, status: "ok" | "accepted", threadId: string | null = null) => client.receive({ requestId: request.requestId,
    response: { type: "result", status, reason: null, threadId, runId: status === "accepted" ? other : null } });
  return { client, sent, deliver, reply };
}
it("private dictation appends to its captured draft, preserves newer typing and never sends a model request", async () => {
  const h = fixture(); h.deliver(state([id, other])); h.client.select(id); h.client.draft("Typed first");
  const destination = h.client.dictationTarget(), control = new AbortController();
  const dictating = destination("AQID", "audio/webm", control.signal), request = h.sent.at(-1)!;
  assert.equal(request.command.action, "dictate");
  assert.equal(await h.client.send("provider/model"), false, "a request cannot send during pending dictation");
  h.client.draft("New typing"); h.client.select(other); h.client.draft("Other conversation");
  h.client.receive({ requestId: request.requestId, response: { type: "dictation", text: "Spoken words" } });
  assert(await dictating); assert.equal(h.client.getSnapshot().draft, "Other conversation");
  h.client.select(id); assert.equal(h.client.getSnapshot().draft, "New typing Spoken words");
  assert.deepEqual(h.sent.map(message => message.command.action), ["watch", "dictate"]); h.client.dispose();
});
it("cancelled, disconnected and closed Studio dictation cannot rebind or replay a late transcript", async () => {
  for (const end of ["abort", "disconnect", "close"] as const) {
    const h = fixture(); h.deliver(state([id])); h.client.draft("Keep typed words"); const control = new AbortController();
    const dictating = h.client.dictationTarget()("AQID", "audio/webm", control.signal), request = h.sent.at(-1)!;
    if (end === "abort") control.abort(); else if (end === "disconnect") h.client.setConnected(false); else { h.client.close(); h.client.open(); h.deliver(state([id])); }
    h.client.receive({ requestId: request.requestId, response: { type: "dictation", text: "DO_NOT_INSERT" } });
    assert.equal(await dictating, false); assert.equal(h.client.getSnapshot().draft, "Keep typed words");
    const before = h.sent.length; if (end === "disconnect") h.client.setConnected(true); else h.client.open();
    assert(h.sent.slice(before).every(message => message.command.action === "watch")); h.client.dispose();
  }
});
it("dictation preserves a new-conversation destination and refuses overflow, unsupported recordings and archived targets", async () => {
  const h = fixture(); h.deliver(state([id])); h.client.select(null); h.client.draft("A new request");
  const control = new AbortController(), destination = h.client.dictationTarget();
  h.deliver(state([id, other])); assert.equal(h.client.getSnapshot().selected, null);
  let dictating = destination("AQID", "audio/webm", control.signal);
  h.client.receive({ requestId: h.sent.at(-1)!.requestId, response: { type: "dictation", text: "dictated" } });
  assert(await dictating); assert.equal(h.client.getSnapshot().draft, "A new request dictated");
  h.client.draft("x".repeat(8000)); dictating = h.client.dictationTarget()("AQID", "audio/webm", control.signal);
  h.client.receive({ requestId: h.sent.at(-1)!.requestId, response: { type: "dictation", text: "Too much" } });
  assert.equal(await dictating, false); assert.equal(h.client.getSnapshot().draft.length, 8000);
  const count = h.sent.length; assert.equal(await destination("AQID", "application/javascript", control.signal), false); assert.equal(h.sent.length, count);
  h.client.select(id); dictating = h.client.dictationTarget()("AQID", "audio/webm", control.signal);
  const snapshot = state([id]); snapshot.threads[0]!.archived = true; h.deliver(snapshot);
  h.client.receive({ requestId: h.sent.at(-1)!.requestId, response: { type: "dictation", text: "Archived words" } });
  assert.equal(await dictating, false); h.client.dispose();
});
it("keeps drafts on close/world-independent history changes and restores only observation on reconnect", async () => {
  const h = fixture(); h.deliver(state([id])); h.client.draft("Keep this Studio draft");
  h.client.close(); assert.equal(h.client.getSnapshot().draft, "Keep this Studio draft"); h.client.open(); h.deliver(state([id, other]));
  assert.equal(h.client.getSnapshot().selected, id); assert.equal(h.client.getSnapshot().draft, "Keep this Studio draft");
  const pending = h.client.request({ action: "send", threadId: id, text: "one request", model: "provider/model" });
  h.client.setConnected(false); assert.equal((await pending).status, "unconfirmed");
  const before = h.sent.length; h.client.setConnected(true); assert.deepEqual(h.sent.slice(before).map(message => message.command.action), ["watch"]);
  assert.equal(h.sent.filter(message => message.command.action === "send").length, 1); h.client.dispose();
});
it("creates a new conversation without a watch update stealing its draft, then sends only after its correlated receipt", async () => {
  const h = fixture(); h.deliver(state()); h.client.draft("An explicit request");
  const sending = h.client.send("provider/model"), create = h.sent.at(-1)!;
  assert.equal(await h.client.send("provider/model"), false, "a repeated press cannot create another thread/send");
  assert.equal(create.command.action, "create"); h.deliver(state([id])); assert.equal(h.client.getSnapshot().draft, "An explicit request"); assert.equal(h.client.getSnapshot().selected, null);
  h.reply(create, "ok", id); await new Promise(resolve => setImmediate(resolve));
  const send = h.sent.at(-1)!; assert.equal(send.command.action, "send"); h.reply(send, "accepted", id); assert.equal(await sending, true);
  assert.equal(h.client.getSnapshot().draft, ""); h.client.select(null); assert.equal(h.client.getSnapshot().draft, "", "a successful first send must not seed New with the sent text"); h.client.dispose();
});
it("a delayed receipt cannot erase new typing or a different conversation's draft", async () => {
  const h = fixture(); h.deliver(state([id, other])); h.client.select(id); h.client.draft("The request");
  const sending = h.client.send("provider/model"), send = h.sent.at(-1)!;
  h.client.draft("New typing"); h.client.select(other); h.client.draft("Other thread"); h.reply(send, "accepted", id); assert(await sending);
  assert.equal(h.client.getSnapshot().draft, "Other thread"); h.client.select(id); assert.equal(h.client.getSnapshot().draft, "New typing"); h.client.dispose();
});
it("an unconfirmed mutation retains the draft and is never automatically retried", async () => {
  const h = fixture(); h.deliver(state([id])); h.client.draft("Retain after timeout");
  assert.equal(await h.client.send("provider/model"), false); assert.equal(h.client.getSnapshot().draft, "Retain after timeout");
  assert.match(h.client.getSnapshot().trouble!, /unconfirmed/); assert.equal(h.sent.filter(message => message.command.action === "send").length, 1); h.client.dispose();
});
it("keeps explicit model choices with their thread, including a newly created one", async () => {
  const h = fixture(); h.deliver(state([other])); h.client.select(null); h.client.draft("A new thread"); h.client.pickModel("provider/chosen");
  const sending = h.client.send("provider/chosen"); h.deliver(state([other, id])); h.reply(h.sent.at(-1)!, "ok", id);
  await new Promise(resolve => setImmediate(resolve)); h.reply(h.sent.at(-1)!, "accepted", id); assert(await sending);
  h.client.select(other); assert.equal(h.client.getSnapshot().model, undefined); h.client.select(id); assert.equal(h.client.getSnapshot().model, "provider/chosen"); h.client.dispose();
});
