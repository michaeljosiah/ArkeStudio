import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pictureLookChanged, type AudiobookLook, type ClientMessage, type DomainEvent, type ManifestModel, type WorldBundle } from "@arke-studio/contracts";
import { BenchStore, sessionDir } from "../../src/bench/store.js";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { AUDIOBOOK_LOOK_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readAudiobook } from "../../src/productions/audiobook.js";
import { type LookDeriver } from "../../src/productions/audiobook-look.js";
import { buildPicturePrompt, clipPrompt, pictureAspect, pictureQuote, pictureWho, promptRoom, type PictureDeriver, type PictureDeriverInput } from "../../src/productions/audiobook-picture-suggest.js";
import { pngBytes } from "../queue/fake-provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * Suggest picture and Generate (design turn 191a, SPEC-047 R-99, R-100): one editable prompt drafted
 * from the block, the chapter and who is in it; each person riding by their sheet's main picture up
 * to the model's limit; nothing made until Generate, which goes through the Bench on the price shown
 * and lands as the block's picture — one that keeps the look it was made under.
 */
const CLOCK = "2026-10-03T09:00:00.000Z";
const LEDGER = "the-ledger-of-nights";
const CHAPTER = "04-her-own-hand";
const REQUEST = "01J00000000000000000000001";
const IMAGE: ManifestModel = {
  id: "stair-image",
  provider: "fal",
  capability: "image",
  displayName: "Stair Image",
  accepts: { referenceImages: 2, startFrame: false, endFrame: false },
  limits: { aspects: ["16:9", "1:1"], maxPromptChars: 4000 },
  pricing: { kind: "perImage", microUsdPerImage: 40_000, microUsdPerReferenceImage: 5_000 },
};

type SuggestionEvent = Extract<DomainEvent, { type: "audiobook.picture-suggestion" }>;
type MadeEvent = Extract<DomainEvent, { type: "audiobook.picture-made" }>;
interface Harness {
  worldDir: string;
  events: DomainEvent[];
  send: (message: ClientMessage) => Promise<void>;
  schemaVersion: () => number;
  seen: PictureDeriverInput[];
  enqueued: Array<{ params: Record<string, unknown>; estimatedMicroUsd: number }>;
  cancelled: string[];
  store: () => ReturnType<NonNullable<FsWorldProvider["openStore"]>>;
}

async function withHarness(run: (h: Harness) => Promise<void>, options: { picture?: PictureDeriver; look?: LookDeriver; model?: ManifestModel | null; land?: boolean | "fail"; prepare?: (worldDir: string) => Promise<void> } = {}): Promise<void> {
  const { root, worldDir } = await makeTempRoot();
  await mkdir(join(worldDir, "productions", LEDGER, ".voices"), { recursive: true });
  await options.prepare?.(worldDir);
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const seen: PictureDeriverInput[] = [];
  const enqueued: Harness["enqueued"] = [];
  const cancelled: string[] = [];
  const models = options.model === null ? [] : [options.model ?? IMAGE];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    cipher: devCipher(),
    credentialsFileName: "credentials.dev.dat",
    manifest: { manifestVersion: 1, generated: "2026-10-03", models },
    observeEvent: (event) => events.push(event),
    pictureDeriver: options.picture ?? (async (input) => {
      seen.push(input);
      return { prompt: "Maren on the rail with Bray beside her, telling a story to fill the quiet; grey dawn.", who: ["maren-kest", "bray-half-hitch", "nobody"], place: null };
    }),
    lookDeriver: options.look ?? (async () => ({ place: { text: "The rail desk at dawn, grey light." }, characters: [{ who: "maren-kest", text: "Oilskin coat, dark with salt." }, { who: "bray-half-hitch", text: "Three belts, a wet cap." }] })),
  });
  // The job queue is the one thing stood in for: it accepts the job and lands its picture the way a
  // finished job lands a Bench take — the session log says the take completed.
  (coordinator as unknown as { jobQueue: unknown }).jobQueue = {
    enqueue: async (input: { target: { id: string }; landing: { dir: string }; params: Record<string, unknown>; estimatedMicroUsd: number }) => {
      enqueued.push({ params: input.params, estimatedMicroUsd: input.estimatedMicroUsd });
      if (options.land === false) return { id: "jb_01J00000000000000000000001" };
      if (options.land === "fail") {
        const [failedSession, failedTake] = input.target.id.split("/") as [string, string];
        await new BenchStore(sessionDir(worldDir, failedSession as never)).append({ type: "take-status", takeId: failedTake as never, status: "failed", error: "the provider refused the prompt" }, { at: CLOCK });
        return { id: "jb_01J00000000000000000000001" };
      }
      const [sessionId, takeId] = input.target.id.split("/") as [string, string];
      await mkdir(join(worldDir, input.landing.dir), { recursive: true });
      await writeFile(join(worldDir, input.landing.dir, "made.png"), pngBytes());
      await new BenchStore(sessionDir(worldDir, sessionId as never)).append(
        { type: "take-completed", takeId: takeId as never, media: { file: "made.png", hash: "sha256:0123456789abcdef" as never }, cost: { estimatedMicroUsd: input.estimatedMicroUsd, actualMicroUsd: input.estimatedMicroUsd }, completedAt: CLOCK },
        { at: CLOCK },
      );
      return { id: "jb_01J00000000000000000000001" };
    },
    cancel: async (jobId: string) => void cancelled.push(jobId),
  };
  const send = (message: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  coordinator.serverApplication.attachTransport({ broadcast() {}, broadcastSnapshot() {} });
  try {
    await run({ worldDir, events, send, seen, enqueued, cancelled, schemaVersion: () => provider.openStore!()!.getBundle().meta.schemaVersion, store: () => provider.openStore!() });
  } finally {
    await provider.close();
  }
}

const suggest = (send: Harness["send"], block = "p0.0") =>
  send({ kind: "suggest-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, block, requestId: REQUEST });
const suggestion = (events: DomainEvent[]): SuggestionEvent => {
  const found = events.filter((event): event is SuggestionEvent => event.type === "audiobook.picture-suggestion").at(-1);
  assert.ok(found, "the suggestion is answered");
  return found;
};
const madeEvents = (events: DomainEvent[]): MadeEvent[] => events.filter((event): event is MadeEvent => event.type === "audiobook.picture-made");

describe("Suggest picture (R-99)", () => {
  it("reads the look first, drafts one prompt, and says who rides, the model, the ratio and the price", () =>
    withHarness(async ({ events, send, seen, schemaVersion, store }) => {
      await suggest(send);
      const answer = suggestion(events);
      assert.equal(answer.refused, undefined);
      assert.equal(answer.requestId, REQUEST);
      const picked = answer.suggestion!;
      assert.equal(picked.block, "p0.0");
      assert.match(picked.prompt, /^Maren on the rail with Bray/);
      assert.equal(picked.model.id, "stair-image");
      assert.equal(picked.model.references, 2, "the model's own limit");
      assert.equal(picked.aspect, "16:9");
      // The look the chapter did not have was read for it, kept, and is what the prompt was written from.
      const held = await readAudiobook(store()!, LEDGER, CHAPTER);
      assert.ok(held !== null && held !== "unreadable" && held.look !== undefined);
      assert.equal(schemaVersion(), AUDIOBOOK_LOOK_SCHEMA_VERSION);
      assert.deepEqual(seen[0]!.lines.map((line) => line.label), ["Place", "Maren Kest", "Bray Half-Hitch"]);
      assert.deepEqual(picked.lines.map((line) => line.label), ["Place", "Maren Kest", "Bray Half-Hitch"], "the look lines it used");
      // Who is in it: the model's own names, held to the chapter — "nobody" is no one.
      assert.deepEqual(picked.who.map((who) => [who.key, who.carried, who.reference !== null]), [["maren-kest", true, true], ["bray-half-hitch", false, false]]);
      // The price: one picture and the one reference that rides, from the manifest's own figures.
      assert.equal(picked.estimatedMicroUsd, 45_000);
      assert.equal(picked.look?.who.join(","), "maren-kest,bray-half-hitch");
      // Nothing was made or spent.
      assert.equal(madeEvents(events).length, 0);
    }));

  it("is refused in one clause with no writing service and with no picture model, and leaves the chapter as it was", async () => {
    await withHarness(async ({ events, send, store }) => {
      await suggest(send);
      assert.equal(suggestion(events).refused, "no picture model is on");
      assert.equal(await readAudiobook(store()!, LEDGER, CHAPTER), null, "no look was read for a picture that cannot be made");
    }, { model: null });
  });

  it("holds a prompt to the room the model leaves for the references and the look", async () => {
    const small: ManifestModel = { ...IMAGE, limits: { aspects: ["16:9"], maxPromptChars: 1000 } };
    await withHarness(async ({ events, send }) => {
      await suggest(send);
      const picked = suggestion(events).suggestion!;
      assert.ok(picked.prompt.length <= promptRoom(small));
      assert.ok(picked.prompt.endsWith("."), "cut after a whole sentence, not mid-word");
    }, { model: small, picture: async () => ({ prompt: `${"She stood at the rail. ".repeat(60)}`, who: [], place: null }) });
  });

  it("names no one the sheet says is never to be pictured, and tells the model to leave them out", async () => {
    await withHarness(
      async ({ events, send, seen }) => {
        await suggest(send);
        const picked = suggestion(events).suggestion!;
        assert.ok(!picked.who.some((who) => who.key === "bray-half-hitch"));
        assert.deepEqual(seen[0]!.never, ["Bray Half-Hitch"]);
        assert.ok(!seen[0]!.people.some((person) => person.key === "bray-half-hitch"));
        assert.match(buildPicturePrompt(seen[0]!), /Never show, name or hint at: Bray Half-Hitch/);
      },
      {
        prepare: async (worldDir) => {
          const file = join(worldDir, "characters", "bray-half-hitch.md");
          const text = await readFile(file, "utf8");
          await writeFile(file, text.replace("billing: support", "billing: support\nneverDepicted: true"), "utf8");
        },
      },
    );
  });
});

describe("who rides as a reference (R-100)", () => {
  const world = (kits: string[], places: string[] = []): Pick<WorldBundle, "referenceKits" | "sheets"> =>
    ({
      sheets: [
        ...["maren", "bray", "odile"].map((id) => ({ id, type: "character", name: id })),
        ...["stair", "quarter"].map((id) => ({ id, type: "location", name: id })),
      ],
      referenceKits: [...kits, ...places].map((sheetId) => ({ sheetId, tiles: [], compilations: [], mainPhoto: { file: "head-front.png", source: "legacy" }, locationViews: [] })),
    }) as never;
  const chosen = [
    { key: "maren", name: "Maren", sheet: "maren", kind: "character" as const, billing: "lead" },
    { key: "bray", name: "Bray", sheet: "bray", kind: "character" as const, billing: "support" },
    { key: "odile", name: "Odile", sheet: "odile", kind: "character" as const, billing: "support" },
    { key: "stair", name: "The stair", sheet: "stair", kind: "place" as const },
  ];

  it("carries up to the number the model takes, characters before the place, leads first — and names the rest, never silently", () => {
    const model = (referenceImages: number): ManifestModel => ({ ...IMAGE, accepts: { ...IMAGE.accepts, referenceImages } });
    const full = pictureWho({ getBundle: () => world(["maren", "bray", "odile"], ["stair"]) as never }, model(3), chosen);
    assert.deepEqual(full.map((who) => [who.key, who.carried]), [["maren", true], ["bray", true], ["odile", true], ["stair", false]]);
    const wide = pictureWho({ getBundle: () => world(["maren", "bray", "odile"], ["stair"]) as never }, model(9), chosen);
    assert.ok(wide.every((who) => who.carried), "the model's limit is the only limit");
    const none = pictureWho({ getBundle: () => world(["maren"]) as never }, model(0), chosen);
    assert.ok(none.every((who) => !who.carried), "a model that takes none carries none");
    assert.equal(none[0]!.reference, "references/maren/head-front.png", "the picture is still named, for the card");
  });

  it("lists a sheet with no picture as having none, so the card can say `Make a reference`", () => {
    const who = pictureWho({ getBundle: () => world(["maren"]) as never }, IMAGE, chosen);
    assert.deepEqual(who.map((entry) => [entry.key, entry.reference, entry.carried]), [["maren", "references/maren/head-front.png", true], ["bray", null, false], ["odile", null, false], ["stair", null, false]]);
  });
});

describe("the prompt and the price", () => {
  it("is cut after the last whole sentence that fits, else at a word", () => {
    assert.equal(clipPrompt("One. Two. Three is longer.", 14), "One. Two.");
    assert.equal(clipPrompt("alpha beta gamma delta", 12), "alpha beta");
    assert.equal(clipPrompt("  short   one  ", 50), "short one");
  });

  it("asks for widescreen only where the model offers it, and prices what the Bench will plan", () => {
    assert.equal(pictureAspect(IMAGE), "16:9");
    assert.equal(pictureAspect({ ...IMAGE, provider: "openai", limits: { aspects: ["1:1"] } }), undefined);
    assert.equal(pictureQuote(IMAGE, 0), 40_000);
    assert.equal(pictureQuote(IMAGE, 2), 50_000);
  });

  it("sends the block, the look lines and the people with their sheets' words, and the book's art direction", () => {
    const prompt = buildPicturePrompt({
      title: "Her own hand",
      art: "Salt-bleached realism.",
      synopsis: "Maren audits the ledger.",
      block: { key: "p0.0", text: "Maren reads it twice." },
      before: "The rail is wet.",
      lines: [{ label: "Place", text: "Dawn." }, { label: "Maren", text: "Oilskin." }],
      people: [{ key: "maren-kest", name: "Maren", appearance: "Wiry." }],
      places: [{ key: "the-vigil", name: "The Vigil" }],
      never: [],
      maxChars: 900,
    });
    for (const part of ["Maren: Oilskin.", "[maren-kest] Maren — Wiry.", "[the-vigil] The Vigil", "Salt-bleached realism.", "Before: The rail is wet.", "at most 900 characters", "## The block [p0.0]"]) assert.ok(prompt.includes(part), part);
  });
});

describe("Generate (R-99)", () => {
  const make = (send: Harness["send"], over: Partial<Extract<ClientMessage, { kind: "make-audiobook-picture" }>> = {}) =>
    send({ kind: "make-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, block: "p0.0", prompt: "Maren on the rail at dawn.", who: ["maren-kest", "bray-half-hitch"], confirmedMicroUsd: 45_000, requestId: "01J00000000000000000000002", ...over });

  it("goes through the Bench: a session of its own, the references attached, the price held to the press, the picture filed on the block", () =>
    withHarness(async ({ events, send, store, worldDir, enqueued, schemaVersion }) => {
      await suggest(send);
      await make(send);
      const states = madeEvents(events).map((event) => event.state);
      assert.deepEqual(states, ["making", "made"]);
      const done = madeEvents(events).at(-1)!;
      assert.ok(done.sessionId, "the Bench session it was made in");
      const record = done.record!;
      const picture = record.pictures!["p0.0"]!;
      assert.equal(picture.source, "generated");
      assert.match(picture.file, /^artifacts\//);
      assert.deepEqual(picture.look?.who, ["maren-kest", "bray-half-hitch"], "it keeps who was in it and the lines it was made under");
      // Every window learns of the picture as it learns of any record write: the margin and the panel read it there.
      const written = events.filter((event) => event.type === "audiobook.record" && event.record?.pictures?.["p0.0"] !== undefined);
      assert.equal(written.length, 1, "the record the picture stands in is sent as a record");
      assert.equal((written[0] as { requestId?: string }).requestId, "01J00000000000000000000002");
      assert.equal(schemaVersion(), AUDIOBOOK_LOOK_SCHEMA_VERSION);
      // The Bench's own gate planned it: one job, the price of one picture and one reference.
      assert.equal(enqueued.length, 1);
      assert.equal(enqueued[0]!.estimatedMicroUsd, 45_000);
      assert.deepEqual((enqueued[0]!.params as { references?: string[] }).references, ["references/maren-kest/head-front.png"], "Maren by her sheet's main picture; Bray has none and is not sent");
      const session = await new BenchStore(sessionDir(worldDir, done.sessionId as never)).fold();
      const take = session!.takes[0]!;
      assert.equal(take.request.references.length, 1);
      assert.match(take.request.brief, /Maren on the rail at dawn\./);
      assert.match(take.request.brief, /Maren Kest is shown in @Image 1\./);
      assert.match(take.request.brief, /The look: /);
      assert.equal(take.disposition, "filed", "kept as an artifact of the world");
      assert.ok(store()!.getBundle().artifacts.some((artifact) => `artifacts/${artifact.file}` === picture.file));
      // The look has since changed: the picture is marked, never remade.
      const look: AudiobookLook = { ...(record.look as AudiobookLook), characters: { ...record.look!.characters, "maren-kest": { ...record.look!.characters["maren-kest"]!, text: "A red coat." } } };
      assert.equal(pictureLookChanged(picture.look, look), true);
    }));

  it("refuses a price that has moved past the one the press showed, and spends nothing", () =>
    withHarness(async ({ events, send, enqueued }) => {
      await suggest(send);
      await make(send, { confirmedMicroUsd: 44_999 });
      const failed = madeEvents(events).at(-1)!;
      assert.equal(failed.state, "failed");
      assert.match(failed.reason ?? "", /^the price moved · ~\$0\.05/);
      assert.equal(enqueued.length, 0, "no job was queued");
      assert.ok(failed.sessionId, "the session stays in the Bench to be opened");
    }));

  it("holds a take that fails with the provider's reason and leaves the block as it was", async () => {
    await withHarness(async ({ events, send, store }) => {
      await suggest(send);
      await make(send);
      const failed = madeEvents(events).at(-1)!;
      assert.equal(failed.state, "failed");
      assert.equal(failed.reason, "the provider refused the prompt");
      assert.equal(failed.record, undefined);
      const held = await readAudiobook(store()!, LEDGER, CHAPTER);
      assert.ok(held !== null && held !== "unreadable");
      assert.equal(held.pictures, undefined, "no picture was set on the block");
    }, { land: "fail" });
  });

  it("makes only a block the chapter still has, and says so in one clause", () =>
    withHarness(async ({ events, send, enqueued }) => {
      await suggest(send);
      await make(send, { block: "p99.0" });
      const failed = madeEvents(events).at(-1)!;
      assert.equal(failed.state, "failed");
      assert.equal(failed.reason, "that block is no longer in the chapter");
      assert.equal(enqueued.length, 0);
    }));
});
