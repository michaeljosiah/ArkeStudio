import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessAdapter, HarnessEvent } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { AskService, excerptAppears, extractJson, verifyClaims } from "../../src/canon/ask.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";

/** A scripted model: each dispatch consumes the next canned reply. */
function scriptedAdapter(replies: string[]): HarnessAdapter & { sessionsCreated: number; prompts: string[] } {
  const subscribers = new Set<{ queue: HarnessEvent[]; wake: (() => void) | null }>();
  const push = (event: HarnessEvent) => {
    for (const sub of subscribers) {
      sub.queue.push(event);
      sub.wake?.();
      sub.wake = null;
    }
  };
  const adapter: HarnessAdapter & { sessionsCreated: number; prompts: string[] } = {
    id: "scripted",
    sessionsCreated: 0,
    prompts: [],
    capabilities: () => new Set(),
    readiness: () => ({ ready: true }),
    async createSession() {
      adapter.sessionsCreated++;
      return { sessionId: "ses_scripted" };
    },
    async sendMessage(input) {
      return { sessionId: input.sessionId, correlationId: "c" };
    },
    async dispatchAsync(input) {
      adapter.prompts.push(input.parts.map((p) => p.text).join("\n"));
      const reply = replies.shift() ?? '{"outcome":"cannot_answer"}';
      queueMicrotask(() => push({ type: "message.completed", sessionId: input.sessionId, text: reply }));
      return { sessionId: input.sessionId, correlationId: "c" };
    },
    streamEvents(signal?: AbortSignal): AsyncIterable<HarnessEvent> {
      const sub: { queue: HarnessEvent[]; wake: (() => void) | null } = { queue: [], wake: null };
      subscribers.add(sub);
      return {
        [Symbol.asyncIterator]() {
          return (async function* () {
            try {
              while (!signal?.aborted) {
                const next = sub.queue.shift();
                if (next) {
                  yield next;
                  continue;
                }
                await new Promise<void>((resolve) => {
                  signal?.addEventListener("abort", () => resolve(), { once: true });
                  sub.wake = resolve;
                });
              }
            } finally {
              subscribers.delete(sub);
            }
          })();
        },
      };
    },
  };
  return adapter;
}

async function askWith(replies: string[], question: string) {
  const store = await WorldStore.open(await makeTempWorld(), { clock: CLOCK });
  const adapter = scriptedAdapter(replies);
  const service = new AskService(adapter, {
    sessionInput: (input) => input,
    scratchRoot: await tempDir("arke-ask-"),
    wallClockMs: 10_000,
  });
  const result = await service.ask(store, question);
  await store.close();
  return { result, adapter };
}

// The fixture's CANON-002 statement, verbatim.
const TIDE_SPAN = "A caller cannot move a tide she has not stood in.";

describe("verification primitives (R-6)", () => {
  it("normalises whitespace, line endings and unicode — formatting is not fabrication", () => {
    assert.ok(excerptAppears("A caller  cannot\r\nmove a tide", "A caller cannot move a tide she has not stood in."));
    assert.ok(excerptAppears("café at the rail", "The café at the rail was quiet."));
    assert.ok(!excerptAppears("A caller can move any tide", "A caller cannot move a tide."));
  });

  it("rejects claims citing entries outside the candidate set", () => {
    const failures = verifyClaims(
      [{ entryId: "CANON-999", excerpt: "anything" }],
      new Map([["CANON-002", { title: "Tide-calling", statement: TIDE_SPAN }]]),
    );
    assert.deepEqual(failures, [{ entryId: "CANON-999", reason: "not-a-candidate" }]);
  });

  it("extracts JSON from fenced and prose-wrapped replies", () => {
    assert.deepEqual(extractJson('Sure!\n```json\n{"outcome":"cannot_answer"}\n```'), { outcome: "cannot_answer" });
    assert.deepEqual(extractJson('{"outcome":"cannot_answer"}'), { outcome: "cannot_answer" });
    assert.throws(() => extractJson("no json here"));
  });
});

describe("the grounded pipeline, adversarially (§3.2)", () => {
  it("refuses below the floor with NO model call — nothing to argue with (R-10)", async () => {
    // The probe must share no vocabulary with the fixture world. "paperwork" stopped being
    // alien when the canon grew an administrative-horror spine, and the fixture will keep
    // growing — pick words no coastal ghost story will ever want.
    const { result, adapter } = await askWith([], "bicycle warranty umbrella typewriter");
    assert.equal(result.outcome, "refusal");
    assert.equal(result.outcome === "refusal" && result.cause, "nothing-retrieved");
    assert.equal(result.outcome === "refusal" && result.searched, 28, "open threads are not searched (R-16)");
    assert.equal(adapter.sessionsCreated, 0, "no session was created");
  });

  it("answers when the model quotes verbatim spans, with citations (R-5)", async () => {
    const reply = JSON.stringify({
      outcome: "answer",
      claims: [{ text: "No — she must have stood in it.", entryId: "CANON-002", excerpt: TIDE_SPAN }],
    });
    const { result } = await askWith([reply], "can Maren call a tide she has not stood in?");
    assert.equal(result.outcome, "answer");
    assert.equal(result.outcome === "answer" && result.claims[0]!.entryId, "CANON-002");
  });

  it("the Drowned-Quarter case: heavy vocabulary, cannot_answer → distinct refusal (R-8, R-12)", async () => {
    const { result } = await askWith(['{"outcome":"cannot_answer"}'], "who collects the tide tithe at the Vigil rail");
    assert.equal(result.outcome, "refusal");
    assert.equal(result.outcome === "refusal" && result.cause, "unsupporting");
    assert.ok(result.outcome === "refusal" && result.closest.length > 0, "closest entries shown as receipts");
  });

  it("a paraphrase fails verification, the retry names it, a second paraphrase refuses (R-6, D3)", async () => {
    const paraphrase = JSON.stringify({
      outcome: "answer",
      claims: [{ text: "No.", entryId: "CANON-002", excerpt: "Callers may only move tides they have already entered." }],
    });
    const { result, adapter } = await askWith([paraphrase, paraphrase], "can Maren call an unknown tide?");
    assert.equal(result.outcome, "refusal");
    assert.equal(result.outcome === "refusal" && result.cause, "unsupporting");
    assert.equal(adapter.prompts.length, 2, "exactly one verification retry");
    assert.match(adapter.prompts[1]!, /does not appear in it/, "the retry names the failure");
    assert.match(adapter.prompts[1]!, /CANON-002/);
  });

  it("four verified claims and one failure refuse ENTIRELY — never a partial answer (R-6, D2)", async () => {
    const claims = [
      { text: "a", entryId: "CANON-002", excerpt: TIDE_SPAN },
      { text: "b", entryId: "CANON-002", excerpt: "The song costs hearing" },
      { text: "c", entryId: "CANON-002", excerpt: "one verse at a time" },
      { text: "d", entryId: "CANON-002", excerpt: "what is spent does not come back" },
      { text: "e", entryId: "CANON-002", excerpt: "this sentence is fabricated entirely" },
    ];
    const reply = JSON.stringify({ outcome: "answer", claims });
    const { result } = await askWith([reply, reply], "what does tide calling cost?");
    assert.equal(result.outcome, "refusal", "4/5 verifying must not render");
  });

  it("a fabricated excerpt on a real entry id fails", async () => {
    const reply = JSON.stringify({
      outcome: "answer",
      claims: [{ text: "x", entryId: "CANON-001", excerpt: "The god forgives those who sing back." }],
    });
    const { result } = await askWith([reply, reply], "does the drowned god forgive?");
    assert.equal(result.outcome, "refusal");
  });

  it("a claim citing an entry outside the retrieved set fails even if the text is real", async () => {
    const reply = JSON.stringify({
      outcome: "answer",
      claims: [{ text: "x", entryId: "CANON-044", excerpt: "True notes are taught, not overheard." }],
    });
    const { result } = await askWith([reply, reply], "what does tide calling cost?");
    assert.equal(result.outcome, "refusal", "open threads are never citable answers (R-16)");
  });

  it("malformed JSON retries once then refuses, never errors (R-7)", async () => {
    const { result, adapter } = await askWith(["this is prose, not json", "still not { valid"], "what does tide calling cost?");
    assert.equal(result.outcome, "refusal");
    assert.equal(adapter.prompts.length, 2);
    assert.match(adapter.prompts[1]!, /not valid JSON/);
  });

  it("the parse retry and the verification retry are independent stages (D3)", async () => {
    const paraphrase = JSON.stringify({
      outcome: "answer",
      claims: [{ text: "x", entryId: "CANON-002", excerpt: "a paraphrased span" }],
    });
    const good = JSON.stringify({
      outcome: "answer",
      claims: [{ text: "x", entryId: "CANON-002", excerpt: TIDE_SPAN }],
    });
    // Parse fails once (uses the parse retry), then verification fails once (uses its own).
    const { result, adapter } = await askWith(["not json", paraphrase, good], "what does tide calling cost?");
    assert.equal(result.outcome, "answer", "three prompts: parse retry, then verify retry, then success");
    assert.equal(adapter.prompts.length, 3);
  });

  it("degrades honestly when the harness is absent but candidates exist (R-4 of SPEC-005)", async () => {
    const store = await WorldStore.open(await makeTempWorld(), { clock: CLOCK });
    const service = new AskService(null, {
      sessionInput: (input) => input,
      scratchRoot: await tempDir("arke-ask-"),
    });
    const result = await service.ask(store, "what does tide calling cost?");
    assert.equal(result.outcome, "unavailable");
    assert.ok(result.outcome === "unavailable" && result.closest.length > 0);
    await store.close();
  });
});
