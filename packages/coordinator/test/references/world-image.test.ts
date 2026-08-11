import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ManifestModel, WorldMeta } from "@arke-studio/contracts";
import { buildSessionConfig } from "@arke-studio/adapter-opencode";
import type { HarnessEvent } from "@arke-studio/contracts";
import { makeArtDirector, worldBrief } from "../../src/references/art-director.js";
import { tempDir } from "../tmp.js";
import {
  WORLD_IMAGE_CANDIDATE,
  WORLD_IMAGE_DIR,
  worldImagePrompt,
  worldImageRequest,
} from "../../src/references/world-image.js";

const meta = (over: Partial<WorldMeta> = {}): WorldMeta =>
  ({
    worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
    slug: "the-undersong",
    schemaVersion: 1,
    name: "The Undersong",
    logline: "A coastal city where a drowned god still sings, and some people can hear it.",
    tone: "quiet dread",
    genre: "folk horror",
    canonRevision: 3,
    nextCanonId: 9,
    created: "2026-08-01T12:00:00.000Z",
    updated: "2026-08-02T12:00:00.000Z",
    ...over,
  }) as WorldMeta;

const model: ManifestModel = {
  id: "flux-2-pro",
  provider: "fal",
  capability: "image",
  displayName: "Flux 2 Pro",
  accepts: { referenceImages: 4, startFrame: false, endFrame: false },
  limits: {},
  pricing: { kind: "perMegapixel", microUsdPerMegapixel: 30000 },
};

const direction = {
  version: 3,
  description: "Painterly, tidal, restrained.",
  masterLook: "world-art.png",
  acceptedAt: "2026-07-18T10:00:00Z",
  audio: { music: "environmental-only" as const, subtitles: "never" as const },
  failureModes: [],
  history: [],
  derived: false,
  reach: { visualAssets: 1, referenceKits: 1, productions: 1, earlierAcceptedTakes: 0 },
  overrides: [],
};

describe("the world's key image", () => {
  it("puts the author's own sentence in, as written", () => {
    const prompt = worldImagePrompt(meta());
    assert.ok(prompt.includes("A coastal city where a drowned god still sings"), "the logline is not paraphrased");
    assert.ok(prompt.includes("The Undersong"));
    assert.ok(prompt.includes("quiet dread") && prompt.includes("folk horror"));
  });

  it("asks for a place, not a face — character sheets are where a face is decided", () => {
    const prompt = worldImagePrompt(meta());
    assert.match(prompt, /no character portraits/i);
    assert.match(prompt, /no text, no logos/i);
  });

  it("says only what the world says: absent fields are left out, never invented", () => {
    const bare = worldImagePrompt(meta({ logline: undefined, tone: undefined, genre: undefined }));
    assert.ok(bare.includes("The Undersong"));
    assert.ok(!bare.includes("Tone:"), "no empty label with nothing after it");
    assert.ok(!bare.includes("Genre:"));
    assert.ok(!bare.includes("undefined"));
  });

  it("is an ordinary image job, so the queue can estimate, ledger and cancel it", () => {
    const request = worldImageRequest(meta(), model, direction);
    assert.equal(request.capability, "image");
    assert.equal(request.provider, "fal");
    assert.equal(request.model, "flux-2-pro");
    assert.equal(request.target.kind, "world-image");
    assert.equal(request.target.id, meta().worldId);
    assert.ok(request.estimatedMicroUsd > 0, "estimated before it runs, like everything that spends");
    assert.match(request.params.prompt, /Painterly, tidal, restrained/);
    assert.deepEqual(request.params.artDirection, { version: 3, source: "world", transport: "text" });
  });

  it("lands where it can be looked at and said yes to, not straight over the world's image", () => {
    const request = worldImageRequest(meta(), model);
    assert.equal(request.landing.dir, WORLD_IMAGE_DIR);
    assert.equal(request.landing.name, WORLD_IMAGE_CANDIDATE);
    assert.ok(!request.landing.dir.includes("world-art"), "the world keeps the image it has until asked");
  });
});

/** A harness that answers with whatever the test hands it, once. */
function directorAdapter(reply: string | null) {
  const subs = new Set<{ queue: HarnessEvent[]; wake: (() => void) | null }>();
  const push = (event: HarnessEvent) => {
    for (const s of subs) {
      s.queue.push(event);
      s.wake?.();
      s.wake = null;
    }
  };
  return {
    id: "director",
    capabilities: () => new Set([]),
    readiness: () => ({ ready: true }),
    async createSession() {
      return { sessionId: "art_1" };
    },
    async sendMessage(input: { sessionId: string }) {
      return { sessionId: input.sessionId, correlationId: "c" };
    },
    async dispatchAsync(input: { sessionId: string }) {
      if (reply !== null) void (async () => push({ type: "message.completed", sessionId: input.sessionId, text: reply }))();
      return { sessionId: input.sessionId, correlationId: "c" };
    },
    streamEvents(signal?: AbortSignal): AsyncIterable<HarnessEvent> {
      const sub: { queue: HarnessEvent[]; wake: (() => void) | null } = { queue: [], wake: null };
      subs.add(sub);
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
              subs.delete(sub);
            }
          })();
        },
      };
    },
  } as never;
}

describe("the art director", () => {
  const director = async (reply: string | null) =>
    makeArtDirector(directorAdapter(reply), () => buildSessionConfig({}), await tempDir("art-"));

  it("tells the model only what the world says about itself", () => {
    const brief = worldBrief(meta(), ["The tide is law in the harbour", "Bell-ringers are sworn, not hired"]);
    assert.ok(brief.includes("The Undersong"));
    assert.ok(brief.includes("A coastal city where a drowned god still sings"));
    assert.ok(brief.includes("The tide is law in the harbour"), "settled canon rides along");
    const bare = worldBrief(meta({ tone: undefined, genre: undefined }), []);
    assert.ok(!bare.includes("Tone:") && !bare.includes("Established"), "nothing is invented to fill a field");
  });

  it("returns the prompt it wrote, fenced or not", async () => {
    // How the answer really arrives: a sentence, then a fenced block.
    const fenced = ["Here you go:", "```json", '{"prompt": "A drowned harbour at dusk, wet basalt, sodium light"}', "```"].join("\n");
    const run = await director(fenced);
    assert.equal(await run("brief"), "A drowned harbour at dusk, wet basalt, sodium light");
  });

  it("returns null rather than nonsense when the answer is not a prompt", async () => {
    // Null is the caller's signal to fall back to the plain assembly. A picture still gets
    // made; the art director is a suggestion, never a gate.
    const prose = await director("I think a moody harbour would be lovely, don't you?");
    assert.equal(await prose("brief"), null);
    const empty = await director('{"prompt": ""}');
    assert.equal(await empty("brief"), null);
  });
});
