import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSessionConfig } from "@arke-studio/adapter-opencode";
import type { HarnessAdapter, HarnessEvent } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { makeAdapterExtractor } from "../../src/artifacts/model.js";

/**
 * An extraction harness that answers when told to, and — like the real thing on a bad day —
 * can be asked to say nothing at all. `interrupted` records whether the session was actually
 * told to stop, which is the difference between a Stop button and a Stop-shaped button.
 */
function extractionAdapter(reply: string | null): HarnessAdapter & { interrupted: string[] } {
  const subscribers = new Set<{ queue: HarnessEvent[]; wake: (() => void) | null }>();
  const push = (event: HarnessEvent) => {
    for (const sub of subscribers) {
      sub.queue.push(event);
      sub.wake?.();
      sub.wake = null;
    }
  };
  const adapter: HarnessAdapter & { interrupted: string[] } = {
    interrupted: [] as string[],
    id: "extractor",
    capabilities: () => new Set([]),
    readiness: () => ({ ready: true }),
    async createSession() {
      return { sessionId: "ex_1" };
    },
    async sendMessage(input) {
      return { sessionId: input.sessionId, correlationId: "c" };
    },
    async dispatchAsync(input) {
      if (reply !== null) {
        void (async () => push({ type: "message.completed", sessionId: input.sessionId, text: reply }))();
      }
      return { sessionId: input.sessionId, correlationId: "c" };
    },
    async interrupt(sessionId: string) {
      // Deliberately silent: a session that started no turn answers an interrupt with nothing.
      adapter.interrupted.push(sessionId);
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

const CANDIDATES = JSON.stringify({
  candidates: [
    { kind: "canon", name: "The tide-law", body: "The tide is law here.", quote: "the tide is law" },
  ],
});

describe("reading a document through the harness", () => {
  it("returns what the model quoted", async () => {
    const adapter = extractionAdapter(CANDIDATES);
    const extract = makeAdapterExtractor(adapter, () => buildSessionConfig({}), await tempDir("extract-"));
    const found = await extract("In the harbour the tide is law.", "bible.md");
    assert.equal(found.length, 1);
    assert.equal(found[0]!.quote, "the tide is law");
  });

  it("stops when told to, and tells the session so rather than just walking away", async () => {
    // The failure this guards against: a Stop that abandons the wait but leaves a turn running
    // in the harness, still spending. And the opposite one — asking the harness to stop and
    // then waiting for it to confirm, which a silent session never does.
    const adapter = extractionAdapter(null); // never answers
    const extract = makeAdapterExtractor(adapter, () => buildSessionConfig({}), await tempDir("extract-"));
    const control = new AbortController();
    const running = extract("In the harbour the tide is law.", "bible.md", control.signal);
    setTimeout(() => control.abort(), 50).unref?.();

    await assert.rejects(running, /stopped/, "a stop is an ending, not an empty result");
    assert.deepEqual(adapter.interrupted, ["ex_1"], "the session was told");
  });

  it("does not even open a session when it was stopped before it began", async () => {
    const adapter = extractionAdapter(CANDIDATES);
    const extract = makeAdapterExtractor(adapter, () => buildSessionConfig({}), await tempDir("extract-"));
    const control = new AbortController();
    control.abort();
    await assert.rejects(extract("anything", "bible.md", control.signal), /stopped/);
    assert.deepEqual(adapter.interrupted, [], "nothing to interrupt — nothing was started");
  });
});
