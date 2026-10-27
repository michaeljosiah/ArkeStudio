import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import type { StudioAssistantCommand, StudioAssistantResponse } from "@arke-studio/contracts";
import { StudioAssistantService } from "../../src/studio-assistant/service.js";
import { StudioAssistantHost } from "../../src/studio-assistant/host.js";
import { studioDiagnosticEvidence } from "../../src/studio-assistant/evidence.js";

const threadId = "01J8F3K2QW9VZX4N7M0RTYB6HC", messageId = "01J8F3K2QW9VZX4N7M0RTYB6HD", userId = "01J8F3K2QW9VZX4N7M0RTYB6HE";
function service() {
  return new StudioAssistantService({ store: { load: async () => ({ version: 1, threads: [{ id: threadId, createdAt: 1, updatedAt: 1, archived: false, pending: null,
    messages: [{ id: userId, role: "user", text: "Private question", at: 1 }, { id: messageId, role: "arke", text: "Private reply. ".repeat(90), at: 1 }] }] }), save: async () => {} },
    model: { busy: () => false, run: async () => { throw Error("No model call"); }, stop: async () => {} }, evidence: topic => studioDiagnosticEvidence(topic, {}, Date.now()) });
}
const requester = () => { const control = new AbortController(), replies: Array<{ id: string; response: StudioAssistantResponse }> = [];
  return { control, replies, port: { signal: control.signal, reply(id: string, response: StudioAssistantResponse) { replies.push({ id, response }); return true; } } }; };
it("reads only an authoritative Arke reply, binds subsequent parts and never reads renderer text or another role", async () => {
  const source = service(); let calls = 0;
  const host = new StudioAssistantHost(source, 100, undefined, async (text, expected) => {
    calls++; assert(text.length <= 450); assert(text.includes("Private reply.")); assert(expected === undefined || expected === "bm_george");
    return { voiceId: "bm_george", audio: new Uint8Array(60) };
  });
  const actor = requester(); const command = async (command: StudioAssistantCommand["command"]) => {
    const requestId = randomUUID(); await host.handle({ kind: "studio-assistant", requestId, command }, actor.port); return actor.replies.find(row => row.id === requestId)!.response;
  };
  try {
    const first = await command({ action: "read-reply", threadId, messageId, part: 0 }); assert(first.type === "speech"); assert(first.parts > 1); assert.equal(calls, 1);
    for (const patch of [{ messageId: userId }, { part: 127 }, { part: 1 }, { part: 1, source: "a".repeat(64), voiceId: "bm_george" }]) {
      const refused = await command({ action: "read-reply", threadId, messageId, part: 0, ...patch }); assert(refused.type === "result" && refused.status === "refused");
    }
    assert.equal(calls, 1);
    const next = await command({ action: "read-reply", threadId, messageId, part: 1, source: first.source, voiceId: first.voiceId }); assert(next.type === "speech"); assert.equal(next.source, first.source); assert.equal(calls, 2);
    await source.archive(threadId, true);
    const archived = await command({ action: "read-reply", threadId, messageId, part: 0 }); assert(archived.type === "result" && archived.status === "refused"); assert.equal(calls, 2);
  } finally { actor.control.abort(); await host.stop(); }
});
it("only the original requester can cancel a read, retaining busy ownership until its work actually settles", async () => {
  const source = service(), actor = requester(), other = requester(); let finish!: () => void, entered!: () => void, signal: AbortSignal | undefined, calls = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { finish = resolve; });
  const host = new StudioAssistantHost(source, 100, undefined, async (_text, _voice, observed) => { calls++; signal = observed; entered(); await held; return { voiceId: "bm_george", audio: new Uint8Array(60) }; });
  const requestId = randomUUID();
  try {
    const work = host.handle({ kind: "studio-assistant", requestId, command: { action: "read-reply", threadId, messageId, part: 0 } }, actor.port); await ready;
    await host.handle({ kind: "studio-assistant", requestId: randomUUID(), command: { action: "stop-reply-read", readRequestId: requestId } }, other.port); assert(!signal?.aborted);
    await host.handle({ kind: "studio-assistant", requestId: randomUUID(), command: { action: "stop-reply-read", readRequestId: requestId } }, actor.port); await work; assert(signal?.aborted);
    await host.handle({ kind: "studio-assistant", requestId: randomUUID(), command: { action: "read-reply", threadId, messageId, part: 0 } }, other.port);
    assert.equal(calls, 1); const busy = other.replies.at(-1)!.response; assert(busy.type === "result" && busy.reason === "busy");
    finish(); await new Promise(resolve => setImmediate(resolve)); assert(!actor.replies.some(row => row.response.type === "speech"));
  } finally { finish(); actor.control.abort(); other.control.abort(); await host.stop(); }
});
it("a private read deadline suppresses late audio and cannot retry its still-active owner", async context => {
  const source = service(), actor = requester(); let finish!: () => void, entered!: () => void, calls = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { finish = resolve; });
  const host = new StudioAssistantHost(source, 100, undefined, async () => { calls++; entered(); await held; return { voiceId: "bm_george", audio: new Uint8Array(60) }; });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const work = host.handle({ kind: "studio-assistant", requestId: randomUUID(), command: { action: "read-reply", threadId, messageId, part: 0 } }, actor.port); await ready;
    context.mock.timers.tick(50_000); await work;
    const timeout = actor.replies.at(-1)!.response; assert(timeout.type === "result" && timeout.status === "unconfirmed");
    await host.handle({ kind: "studio-assistant", requestId: randomUUID(), command: { action: "read-reply", threadId, messageId, part: 0 } }, actor.port); assert.equal(calls, 1);
    finish(); await new Promise(resolve => setImmediate(resolve)); assert(!actor.replies.some(row => row.response.type === "speech"));
  } finally { finish(); actor.control.abort(); await host.stop(); context.mock.timers.reset(); }
});

it("withholds audio if the original thread is archived during synthesis", async () => {
  const source = service(), actor = requester(); let finish!: () => void, entered!: () => void, current!: () => boolean;
  const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { finish = resolve; });
  const host = new StudioAssistantHost(source, 100, undefined, async (_text, _voice, _signal, allowed) => { current = allowed; entered(); await held; return { voiceId: "bm_george", audio: new Uint8Array(60) }; });
  try {
    const work = host.handle({ kind: "studio-assistant", requestId: randomUUID(), command: { action: "read-reply", threadId, messageId, part: 0 } }, actor.port);
    await ready; assert(current()); await source.archive(threadId, true); assert(!current()); finish(); await work;
    const last = actor.replies.at(-1)!.response; assert(last.type === "result" && last.status === "refused"); assert(!actor.replies.some(row => row.response.type === "speech"));
  } finally { finish(); actor.control.abort(); await host.stop(); }
});
