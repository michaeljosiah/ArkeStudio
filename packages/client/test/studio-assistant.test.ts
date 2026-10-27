import assert from "node:assert/strict";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import type { StudioAssistantCommand, StudioAssistantSnapshot } from "@arke-studio/contracts";
import { StudioConversationClient } from "../src/lib/studio-assistant.js";

const id = "01J8F3K2QW9VZX4N7M0RTYB6HC", other = "01J8F3K2QW9VZX4N7M0RTYB6HD";
const state = (ids: string[] = []): StudioAssistantSnapshot => ({ audit: "available", accepting: true, busy: false, share: null, ephemeralReply: null,
  threads: ids.map(id => ({ id, createdAt: 1, updatedAt: 1, archived: false, messages: [], pending: null })) });
function fixture(documentReadMs = 30_000) {
  const sent: StudioAssistantCommand[] = [];
  const client = new StudioConversationClient({ id: randomUUID, send(message) { sent.push(message); return true; } }, 20, documentReadMs);
  client.setConnected(true); client.open();
  const deliver = (value: StudioAssistantSnapshot) => client.receive({ requestId: sent.findLast(message => message.command.action === "watch")!.requestId, response: { type: "state", state: value } });
  const reply = (request: StudioAssistantCommand, status: "ok" | "accepted", threadId: string | null = null) => client.receive({ requestId: request.requestId,
    response: { type: "result", status, reason: null, threadId, runId: status === "accepted" ? other : null } });
  return { client, sent, deliver, reply };
}
it("keeps selected documents in their original draft and sends only the captured bytes on an explicit request", async () => {
  const h = fixture(); h.deliver(state([id, other])); h.client.select(id); h.client.draft("Review these notes");
  let finish!: (bytes: ArrayBuffer) => void;
  const raw = new Promise<ArrayBuffer>(resolve => { finish = resolve; }), file = new File(["content"], "notes.txt");
  file.slice = () => { const blob = new Blob(); blob.arrayBuffer = () => raw; return blob; };
  const loading = h.client.attachFiles([file]); assert(h.client.getSnapshot().attaching);
  assert.equal(await h.client.send("provider/model"), false);
  h.client.select(other); h.client.draft("Other draft"); finish(new TextEncoder().encode("PRIVATE_DOCUMENT").buffer); assert.deepEqual(await loading, []);
  assert.equal(h.client.getSnapshot().attachments.length, 0); h.client.select(id);
  assert.equal(h.client.getSnapshot().attachments[0]?.text, "PRIVATE_DOCUMENT"); assert.equal(h.sent.length, 1, "selection and reads make no model request");
  const sending = h.client.send("provider/model"), request = h.sent.at(-1)!; assert(request.command.action === "send");
  assert.equal(request.command.attachments?.[0]?.text, "PRIVATE_DOCUMENT");
  h.client.removeDocument(h.client.getSnapshot().attachments[0]!.id); h.client.draft("New typing");
  h.reply(request, "accepted", id); assert(await sending); assert.equal(h.client.getSnapshot().draft, "New typing"); assert.equal(h.client.getSnapshot().attachments.length, 0);
  h.client.dispose();
});
it("close or reconnect abandons late file reads without admitting replacement reads or replaying", async () => {
  for (const end of ["close", "disconnect"] as const) {
    const h = fixture(); h.deliver(state([id])); h.client.select(null);
    let finish!: (bytes: ArrayBuffer) => void; const pending = new Promise<ArrayBuffer>(resolve => { finish = resolve; });
    const file = new File(["doc"], "notes.txt"); file.slice = () => { const blob = new Blob(); blob.arrayBuffer = () => pending; return blob; };
    let laterReads = 0; const later = new File(["later"], "later.txt"); later.slice = () => { laterReads++; throw Error("An abandoned read must not start the next file"); };
    const loading = h.client.attachFiles([file, later]);
    if (end === "close") { h.client.close(); h.client.open(); } else { h.client.setConnected(false); h.client.setConnected(true); }
    h.deliver(state([id])); assert(h.client.getSnapshot().attaching);
    assert((await h.client.attachFiles([new File(["other"], "other.txt")])).length > 0);
    finish(new TextEncoder().encode("LATE_DOCUMENT").buffer); assert.deepEqual(await loading, []);
    assert.equal(h.client.getSnapshot().attachments.length, 0); assert.equal(h.client.getSnapshot().attaching, false); assert.equal(laterReads, 0);
    assert(h.sent.every(row => ["watch", "unwatch"].includes(row.command.action))); h.client.dispose();
  }
});
it("retains a timed-out file read until actual settlement and never inserts its late content", async () => {
  const h = fixture(5); h.deliver(state([id]));
  let finish!: (bytes: ArrayBuffer) => void; const raw = new Promise<ArrayBuffer>(resolve => { finish = resolve; });
  const file = new File(["doc"], "notes.txt"); file.slice = () => { const blob = new Blob(); blob.arrayBuffer = () => raw; return blob; };
  const trouble = await h.client.attachFiles([file]); assert.match(trouble[0]!.reason, /timed out/);
  assert(h.client.getSnapshot().attaching); assert((await h.client.attachText("Replacement")).length > 0);
  finish(new TextEncoder().encode("LATE_DOCUMENT").buffer); await new Promise(resolve => setImmediate(resolve));
  assert(!h.client.getSnapshot().attaching); assert.equal(h.client.getSnapshot().attachments.length, 0);
  assert.deepEqual(await h.client.attachText("A fresh document"), []); h.client.dispose();
});
it("never retargets a native picker after changing conversation or closing and reopening Studio", async () => {
  for (const end of ["selection", "close"] as const) {
    const h = fixture(); h.deliver(state([id, other])); h.client.select(id); const choose = h.client.documentPickerTarget();
    const file = new File(["do not read"], "notes.txt"); file.slice = () => { throw Error("The obsolete picker must not start a read"); };
    if (end === "selection") h.client.select(other); else { h.client.close(); h.client.open(); h.deliver(state([id, other])); }
    assert.match((await choose([file]))[0]!.reason, /conversation changed/);
    assert.equal(h.client.getSnapshot().attachments.length, 0); h.client.dispose();
  }
});
it("moves new-conversation documents after create acknowledgement and retains unconfirmed sends", async () => {
  const h = fixture(); h.deliver(state()); h.client.draft("Review this text");
  assert.deepEqual(await h.client.attachText("PRIVATE_PASTED_DOCUMENT"), []);
  const sending = h.client.send("provider/model"), create = h.sent.at(-1)!; h.deliver(state([id])); assert.equal(h.client.getSnapshot().selected, null);
  h.reply(create, "ok", id); await new Promise(resolve => setImmediate(resolve));
  const request = h.sent.at(-1)!; assert(request.command.action === "send"); assert.equal(request.command.attachments?.[0]?.text, "PRIVATE_PASTED_DOCUMENT");
  h.reply(request, "accepted", id); assert(await sending); assert.equal(h.client.getSnapshot().attachments.length, 0);
  h.client.select(null); assert.equal(h.client.getSnapshot().attachments.length, 0);
  h.client.select(id); h.client.draft("Unconfirmed next turn"); await h.client.attachText("KEEP_DOCUMENT");
  assert.equal(await h.client.send("provider/model"), false); assert.equal(h.client.getSnapshot().attachments[0]?.text, "KEEP_DOCUMENT");
  const count = h.sent.filter(row => row.command.action === "send").length;
  h.client.setConnected(false); h.client.setConnected(true); h.deliver(state([id]));
  assert.equal(h.sent.filter(row => row.command.action === "send").length, count); h.client.dispose();
});
it("a changed or closed new draft cannot send documents after a delayed create receipt", async () => {
  for (const changed of ["remove", "close"] as const) {
    const h = fixture(); h.deliver(state()); h.client.draft("Review"); await h.client.attachText("Document");
    const sending = h.client.send("provider/model"), request = h.sent.at(-1)!;
    if (changed === "remove") h.client.removeDocument(h.client.getSnapshot().attachments[0]!.id); else h.client.close();
    h.reply(request, "ok", id); assert.equal(await sending, false); assert(!h.sent.some(row => row.command.action === "send")); h.client.dispose();
  }
});
it("requests private speech by reply ID, binds parts and keeps audio outside conversation state", async () => {
  const h = fixture(); h.deliver(state([id])); h.client.select(id); const control = new AbortController();
  const response = { type: "speech" as const, part: 0, parts: 2, source: "a".repeat(64), voiceId: "bm_george", format: "wav" as const, audioBase64: "AQID" };
  const pending = h.client.readReplyPart(id, other, 0, control.signal), first = h.sent.at(-1)!;
  assert.deepEqual(first.command, { action: "read-reply", threadId: id, messageId: other, part: 0 });
  h.client.receive({ requestId: first.requestId, response }); assert.deepEqual(await pending, response);
  assert(!JSON.stringify(h.client.getSnapshot()).includes("AQID"));
  const binding = { source: response.source, voiceId: response.voiceId };
  const next = h.client.readReplyPart(id, other, 1, control.signal, binding), request = h.sent.at(-1)!;
  assert(request.command.action === "read-reply" && request.command.source === response.source);
  binding.source = "b".repeat(64);
  h.client.receive({ requestId: request.requestId, response: { ...response, part: 1, source: "b".repeat(64) } }); assert.equal(await next, null);
  h.client.dispose();
});
it("cancels private speech on close, selection and abort, never resends on reconnect or consumes late audio", async () => {
  for (const end of ["close", "selection", "abort", "disconnect"] as const) {
    const h = fixture(); h.deliver(state([id, other])); h.client.select(id); const control = new AbortController();
    const pending = h.client.readReplyPart(id, other, 0, control.signal), first = h.sent.at(-1)!;
    if (end === "close") h.client.close(); else if (end === "selection") h.client.select(other); else if (end === "abort") control.abort(); else h.client.setConnected(false);
    assert.equal(await pending, null);
    const stops = h.sent.filter(message => message.command.action === "stop-reply-read"); assert.equal(stops.length, end === "disconnect" ? 0 : 1);
    h.client.receive({ requestId: first.requestId, response: { type: "speech", part: 0, parts: 1, source: "a".repeat(64), voiceId: "bm_george", format: "wav", audioBase64: "AQID" } });
    const count = h.sent.length; h.client.setConnected(true); h.client.open(); h.deliver(state([id, other]));
    assert(h.sent.slice(count).every(message => message.command.action === "watch")); assert(!JSON.stringify(h.client.getSnapshot()).includes("AQID"));
    h.client.dispose();
  }
});
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
