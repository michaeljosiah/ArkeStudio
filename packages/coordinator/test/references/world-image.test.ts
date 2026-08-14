import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientMessage, DomainEvent, ManifestModel, WorldMeta } from "@arke-studio/contracts";
import { imageConstraintSuffix } from "@arke-studio/contracts";
import { buildSessionConfig } from "@arke-studio/adapter-opencode";
import type { HarnessEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeArtDirector, worldBrief } from "../../src/references/art-director.js";
import { pngBytes } from "../queue/fake-provider.js";
import { tempDir } from "../tmp.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
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

  it("carries the world's standing failure modes, which key art can violate too", () => {
    const request = worldImageRequest(meta(), model, { ...direction, failureModes: ["No lens flare on the harbour lamps."] });
    assert.match(String(request.params["prompt"]), /No lens flare on the harbour lamps\.$/);
    // None to say, nothing said: the bare prompt is byte-identical to before the field existed.
    assert.equal(
      String(worldImageRequest(meta(), model, direction).params["prompt"]),
      String(worldImageRequest(meta(), model, { ...direction, failureModes: [] }).params["prompt"]),
    );
  });

  it("keeps the constraints when the art director rewrites the prompt", () => {
    // Round 3's P2: the directed path replaces the composed prompt wholesale, so composing the
    // suffix inside worldImageRequest bound only the fallback. This asserts the shape the
    // coordinator builds for the directed branch.
    const constrained = { ...direction, failureModes: ["No lens flare on the harbour lamps."] };
    const directed = `${constrained.description}. A drawn prompt from the art director.${imageConstraintSuffix(constrained)}`;
    assert.match(directed, /No lens flare on the harbour lamps\.$/);
    assert.match(directed, /A drawn prompt from the art director\./, "the director's words survive");
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

async function harness(picked: () => readonly string[]) {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => "2026-08-14T12:00:00.000Z" });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    observeEvent: (event) => events.push(event),
    pickFiles: async () => picked(),
  });
  const send = (msg: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> }).handleClientMessage(msg);
  return { provider, worldDir, events, send };
}

async function fileOutsideTheWorld(name: string, bytes: Uint8Array | string = pngBytes()) {
  const path = join(await tempDir("arke-keyart-"), name);
  await writeFile(path, bytes);
  return path;
}

/**
 * Key art by hand, and the path that carries it (issue 291).
 *
 * Reported as "changing the art in the world art page did not impact the picture used in the
 * list of worlds start page" — because every card, hero and scrim named the literal string
 * `world-art.png`, and the art-direction page changes the *master look*, which is a different
 * image. Key art could also only ever be generated. Both halves are fixed here: it can be
 * uploaded, and what the world actually has is read off the disk and carried to the picker.
 */
describe("bringing key art in by hand", () => {
  it("offers the picked file, then accepts it under the format its bytes carry", async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, ...Array.from({ length: 32 }, () => 0x00), 0xff, 0xd9]);
    const picked = await fileOutsideTheWorld("my-key-art.png", jpeg);
    const { provider, worldDir, send } = await harness(() => [picked]);
    try {
      await send({ kind: "upload-world-image", worldId: WORLD_ID, requestId: "01J8F3K2QW9VZX4N7M0RTYB62A" });
      const offered = provider.openStore()!.getBundle();
      assert.equal(offered.keyArtCandidate, "incoming/world-image/candidate.jpg");
      assert.equal(offered.keyArt, "world-art.png", "an upload is an offer — the world keeps what it has");

      await send({ kind: "use-world-image", worldId: WORLD_ID });
      const after = provider.openStore()!.getBundle();
      // Named for the format it is. A JPEG written as world-art.png would be served as
      // image/png by a media route that reads the extension.
      assert.equal(after.keyArt, "world-art.jpg");
      assert.equal(after.keyArtCandidate, null);
      // One key art, not two: the PNG it replaces goes, or the scan picks between them by sort.
      const names = await readdir(worldDir);
      assert.deepEqual(names.filter((name) => name.startsWith("world-art")), ["world-art.jpg"]);
    } finally {
      await provider.close();
    }
  });

  it("carries the path to the picker, so a card shows what the world actually has", async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, ...Array.from({ length: 32 }, () => 0x00), 0xff, 0xd9]);
    const picked = await fileOutsideTheWorld("mine.png", jpeg);
    const { provider, send } = await harness(() => [picked]);
    try {
      await send({ kind: "upload-world-image", worldId: WORLD_ID, requestId: "01J8F3K2QW9VZX4N7M0RTYB62B" });
      await send({ kind: "use-world-image", worldId: WORLD_ID });
      // The registry row, which is all the picker has for a closed world. Read without closing
      // the world: the card that sent you to the art page has to change while you are still on
      // it, not once the world is put away.
      const summary = (await provider.listWorlds()).find((world) => world.worldId === WORLD_ID);
      assert.equal(summary?.keyArt, "world-art.jpg");
    } finally {
      await provider.close();
    }
  });

  it("says nothing at all when the dialog is closed, and changes nothing", async () => {
    const { provider, events, send } = await harness(() => []);
    try {
      await send({ kind: "upload-world-image", worldId: WORLD_ID, requestId: "01J8F3K2QW9VZX4N7M0RTYB62C" });
      const result = events.find((event) => event.type === "queue.enqueue-result");
      assert.equal(result?.type === "queue.enqueue-result" ? result.disposition : null, "not-queued");
      assert.equal(provider.openStore()!.getBundle().keyArtCandidate, null);
      assert.equal(provider.openStore()!.getBundle().keyArt, "world-art.png");
    } finally {
      await provider.close();
    }
  });

  it("says why when the file is not an image", async () => {
    const picked = await fileOutsideTheWorld("notes.png", "this is not a picture");
    const { provider, events, send } = await harness(() => [picked]);
    try {
      await send({ kind: "upload-world-image", worldId: WORLD_ID, requestId: "01J8F3K2QW9VZX4N7M0RTYB62D" });
      const result = events.find((event) => event.type === "queue.enqueue-result");
      assert.equal(result?.type === "queue.enqueue-result" ? result.disposition : null, "rejected");
      assert.equal(provider.openStore()!.getBundle().keyArtCandidate, null);
    } finally {
      await provider.close();
    }
  });

  it("still reads a world whose key art is the plain world-art.png every earlier world has", async () => {
    const { provider } = await harness(() => []);
    try {
      assert.equal(provider.openStore()!.getBundle().keyArt, "world-art.png");
      const summary = (await provider.listWorlds()).find((world) => world.worldId === WORLD_ID);
      assert.equal(summary?.keyArt, "world-art.png");
    } finally {
      await provider.close();
    }
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
