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
  keyArtPrompt,
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
    // suffix inside worldImageRequest bound only the fallback.
    const constrained = { ...direction, failureModes: ["No lens flare on the harbour lamps."] };
    const directed = keyArtPrompt({
      composed: String(worldImageRequest(meta(), model, constrained).params.prompt),
      description: constrained.description,
      suffix: imageConstraintSuffix(constrained),
      directed: "A drawn prompt from the art director.",
    });
    assert.match(directed, /No lens flare on the harbour lamps\.$/);
    assert.match(directed, /A drawn prompt from the art director\./, "the director's words survive");
    assert.match(directed, /^Painterly, tidal, restrained\./, "a rewrite is a rewrite of the world's brief");
  });
});

/**
 * Whose words go, when more than one party has some (design 64).
 *
 * The author's outrank both, and the point of that is subtractive: an author who opened the box
 * and changed it has said what the picture is, so the studio writes nothing on top. What no branch
 * may do is drop the standing clause, which is not the author's to drop either.
 */
describe("the three sources of a key-art prompt", () => {
  const constrained = { ...direction, failureModes: ["No lens flare on the harbour lamps."] };
  const base = () => ({
    composed: String(worldImageRequest(meta(), model, constrained).params.prompt),
    description: constrained.description,
    suffix: imageConstraintSuffix(constrained),
  });

  it("sends the author's words as written, with nothing of ours in front", () => {
    const words = keyArtPrompt({ ...base(), authored: "A harbour at slack water, one lamp lit." });
    assert.match(words, /^A harbour at slack water, one lamp lit\./, "nothing is prefixed to them");
    assert.ok(!words.includes("Key art for"), "and the composition is not appended either");
  });

  it("lets the author outrank the art director rather than layering the two", () => {
    const words = keyArtPrompt({
      ...base(),
      authored: "A harbour at slack water.",
      directed: "A drawn prompt from the art director.",
    });
    assert.ok(!words.includes("art director"), "a rewrite on top of an author's words is our taste over theirs");
  });

  it("keeps the standing clause whoever wrote the rest", () => {
    const suffix = /No lens flare on the harbour lamps\.$/;
    assert.match(keyArtPrompt({ ...base(), authored: "A harbour." }), suffix);
    assert.match(keyArtPrompt({ ...base(), directed: "A harbour." }), suffix);
    assert.match(keyArtPrompt(base()), suffix, "and on the path where nobody wrote anything");
  });

  it("falls back to the composition, byte for byte, when nobody wrote anything", () => {
    assert.equal(keyArtPrompt(base()), base().composed);
    // An empty or absent director answer is the same as no answer; it must not produce a prompt
    // that is just the description and a full stop.
    assert.equal(keyArtPrompt({ ...base(), directed: null }), base().composed);
    assert.equal(keyArtPrompt({ ...base(), directed: "" }), base().composed);
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

  /**
   * Four asked for, four landed (design 65).
   *
   * The failure this guards is exact and has happened before, on the character candidates: four
   * jobs dispatched, four charges taken, and one file on disk because they all landed on the same
   * name. A set of one keeps the historical name so nothing about an existing world moves.
   */
  it("names every candidate of a set separately, and keeps the old name for a set of one", () => {
    const names = Array.from({ length: 4 }, (_, index) =>
      worldImageRequest(meta(), model, direction, { index, count: 4 }).landing.name,
    );
    assert.equal(new Set(names).size, 4, "four charges must not collapse onto one file");
    assert.deepEqual(names, ["candidate-1.png", "candidate-2.png", "candidate-3.png", "candidate-4.png"]);
    assert.equal(
      worldImageRequest(meta(), model, direction).landing.name,
      WORLD_IMAGE_CANDIDATE,
      "one is still candidate.png, so a world generated before the count reads back unchanged",
    );
  });

  it("prices and targets each of a set exactly as it prices and targets one", () => {
    const one = worldImageRequest(meta(), model, direction);
    const third = worldImageRequest(meta(), model, direction, { index: 2, count: 4 });
    assert.equal(third.estimatedMicroUsd, one.estimatedMicroUsd, "each image in the set costs the same");
    assert.deepEqual(third.target, one.target);
    assert.equal(third.params.prompt, one.params.prompt, "the same brief, sampled again — not reworded per slot");
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
      assert.deepEqual(offered.keyArtCandidates, ["incoming/world-image/candidate.jpg"]);
      assert.equal(offered.keyArt, "world-art.png", "an upload is an offer — the world keeps what it has");

      await send({ kind: "use-world-image", worldId: WORLD_ID });
      const after = provider.openStore()!.getBundle();
      // Named for the format it is. A JPEG written as world-art.png would be served as
      // image/png by a media route that reads the extension.
      assert.equal(after.keyArt, "world-art.jpg");
      assert.deepEqual(after.keyArtCandidates, []);
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
      assert.deepEqual(provider.openStore()!.getBundle().keyArtCandidates, []);
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
      assert.deepEqual(provider.openStore()!.getBundle().keyArtCandidates, []);
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
