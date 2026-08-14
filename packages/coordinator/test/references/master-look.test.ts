import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtDirectionRecord, ClientMessage, DomainEvent, ManifestModel, WorldMeta } from "@arke-studio/contracts";
import { ART_DIRECTION_PATH } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import {
  MASTER_LOOK_CANDIDATE,
  MASTER_LOOK_DIR,
  MASTER_LOOK_REFERENCE_DIR,
  masterLookFile,
  masterLookPrompt,
  masterLookRequest,
} from "../../src/references/master-look.js";
import { pngBytes } from "../queue/fake-provider.js";
import { tempDir } from "../tmp.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * The world look as a picture (issue 288).
 *
 * `masterLook` has been in the record since the look was versioned — history keeps one per
 * version, the reach counts it, the review names it, the art-direction screen explains how it
 * travels into other characters' work — and until now nothing in the app could put one there.
 * It could only arrive by hand-editing the JSON.
 *
 * The rule these tests hold: accepting a master look is a *look change*, not a file copy. It
 * lands under the next version's name and the record that names it is the next version, so no
 * accepted version is ever given an image it did not have while it was current.
 */

const CLOCK = "2026-08-14T12:00:00.000Z";

const meta = (): WorldMeta =>
  ({
    worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
    slug: "the-undersong",
    schemaVersion: 1,
    name: "The Undersong",
    canonRevision: 3,
    nextCanonId: 9,
    created: "2026-08-01T12:00:00.000Z",
    updated: "2026-08-02T12:00:00.000Z",
  }) as WorldMeta;

const model: ManifestModel = {
  id: "flux-2-pro",
  provider: "fal",
  capability: "image",
  displayName: "Flux 2 Pro",
  accepts: { referenceImages: 4, startFrame: false, endFrame: false },
  // Declared shapes, because the dialog only ever offers what a row declares — a fixture with
  // none would exercise the fallback and never the control.
  limits: { aspects: ["16:9", "1:1", "4:3"] },
  pricing: { kind: "perMegapixel", microUsdPerMegapixel: 30000 },
};

const direction = {
  version: 3,
  description: "Painterly, tidal, restrained. Wet basalt and sodium light.",
  acceptedAt: "2026-07-18T10:00:00Z",
  audio: { music: "environmental-only" as const, subtitles: "never" as const },
  failureModes: [],
  history: [],
  derived: false,
  reach: { visualAssets: 1, referenceKits: 1, productions: 1, earlierAcceptedTakes: 0 },
  overrides: [],
};

describe("asking the look to illustrate itself", () => {
  it("sends the look's own description, unedited", () => {
    const prompt = masterLookPrompt(direction);
    assert.ok(prompt.startsWith(direction.description), "not paraphrased, not summarised, not re-ordered");
  });

  it("asks for a treatment and refuses a face, which is the rule the screen already states", () => {
    // "A face here can arrive in other characters' work" — the one asset that rides along with
    // somebody else's portrait must not contain a person.
    const prompt = masterLookPrompt(direction);
    assert.match(prompt, /No people, no faces/i);
    assert.match(prompt, /no text, no logos/i);
  });

  it("carries the world's standing failure modes like any other generation", () => {
    const request = masterLookRequest(meta(), model, {
      ...direction,
      failureModes: ["No lens flare on the harbour lamps."],
    });
    assert.match(String(request.params.prompt), /No lens flare on the harbour lamps\.$/);
  });

  it("is an ordinary image job, so the queue can estimate, ledger and cancel it", () => {
    const request = masterLookRequest(meta(), model, direction);
    assert.equal(request.capability, "image");
    assert.equal(request.target.kind, "master-look");
    assert.equal(request.target.id, meta().worldId);
    assert.ok(request.estimatedMicroUsd > 0);
    assert.deepEqual(request.params.artDirection, { version: 3, source: "world", transport: "text" });
  });

  /*
   * A real output spec, where this job used to send none.
   *
   * Without one the clients fell back to the provider's own default and the estimate assumed a
   * flat 1MP — so the size and shape controls in the dialog would have moved nothing but their
   * own highlight, and the figure beside them would have been the same number regardless.
   */
  it("carries the size and shape the dialog chose, and prices them", () => {
    const plain = masterLookRequest(meta(), model, direction);
    assert.ok(plain.params.output.width > 0 && plain.params.output.height > 0);
    assert.ok(plain.params.output.width > plain.params.output.height, "a look plate is landscape by default");

    const shaped = masterLookRequest(meta(), model, direction, { tier: "2K", aspect: "1:1" });
    assert.equal(shaped.params.output.aspect, "1:1");
    assert.equal(shaped.params.output.width, shaped.params.output.height);

    const big = masterLookRequest(meta(), model, direction, { tier: "4K", aspect: "1:1" });
    assert.ok(
      big.params.output.width > shaped.params.output.width,
      "the tier still decides the size once the shape is chosen",
    );
    // The money follows the pixels on a per-megapixel row, which is what this model is.
    assert.ok(big.estimatedMicroUsd > shaped.estimatedMicroUsd);
  });

  it("will not send a shape the model does not offer", () => {
    // The dialog never offers one, so this is the backstop rather than the gate — but a stale
    // saved choice reaching the wire would be refused by the provider after the estimate was
    // accepted, which is the expensive way to find out.
    const narrow: ManifestModel = { ...model, limits: { ...model.limits, aspects: ["1:1"] } };
    const request = masterLookRequest(meta(), narrow, direction, { aspect: "16:9" });
    assert.notEqual(request.params.output.aspect, "16:9", "the request does not claim it");
    const { width, height } = request.params.output;
    assert.ok(Math.abs(width / height - 16 / 9) > 0.1, `nor is it 16:9 in the dimensions (${width}x${height})`);
  });

  it("lands where it waits for a yes, never straight into the record", () => {
    const request = masterLookRequest(meta(), model, direction);
    assert.equal(request.landing.dir, MASTER_LOOK_DIR);
    assert.equal(request.landing.name, MASTER_LOOK_CANDIDATE);
    assert.ok(!request.landing.dir.startsWith("art-direction"), "the accepted look is not written to by a job");
  });

  /*
   * The dialog's own words, when there are any.
   *
   * The look's description is a brief for every generation; this is a brief for one image, and an
   * author who wants this picture to be the harbour at dusk rather than a swatch should be able to
   * say so without editing the look. What they may not do is drop the clause below — that is the
   * one thing this asset must carry, because it is the one that rides along with a portrait.
   */
  it("sends the author's own prompt when the dialog carried one", () => {
    const prompt = masterLookPrompt(direction, "The harbour at dusk, from the water.");
    assert.ok(prompt.startsWith("The harbour at dusk, from the water."), "sent as written");
    assert.ok(!prompt.includes(direction.description), "and instead of the look, not after it");
    assert.match(prompt, /No people, no faces/i, "the standing clause is not the author's to drop");
  });

  it("falls back to the look for an absent or blank override", () => {
    for (const override of [undefined, "", "   "]) {
      assert.ok(masterLookPrompt(direction, override).startsWith(direction.description), `for ${JSON.stringify(override)}`);
    }
  });

  it("carries a staged reference and prices it, or carries none at all", () => {
    const withRef = masterLookRequest(meta(), model, direction, {
      references: ["incoming/master-look-ref/reference.png"],
    });
    assert.deepEqual(withRef.params.references, ["incoming/master-look-ref/reference.png"]);
    const without = masterLookRequest(meta(), model, direction);
    assert.ok(!("references" in without.params), "an absent reference is absent, not an empty array");

    // On a row that charges for them, the estimate has to move: a reference is billable work, and
    // an estimate that ignores it is a figure the ledger will later disagree with. (This model is
    // priced per megapixel, which is why the count is asserted against one that is not.)
    const perImage: ManifestModel = {
      ...model,
      pricing: { kind: "perImage", microUsdPerImage: 40000, microUsdPerReferenceImage: 5000 },
    };
    assert.ok(
      masterLookRequest(meta(), perImage, direction, { references: ["incoming/master-look-ref/reference.png"] })
        .estimatedMicroUsd > masterLookRequest(meta(), perImage, direction).estimatedMicroUsd,
    );
  });
});

async function harness(picked: () => readonly string[], prepare?: (worldDir: string) => Promise<void>) {
  const { root, worldDir } = await makeTempRoot();
  await prepare?.(worldDir);
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
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
  const record = async () =>
    JSON.parse(await readFile(join(worldDir, ART_DIRECTION_PATH), "utf8")) as ArtDirectionRecord;
  return { provider, worldDir, events, send, record };
}

async function fileOutsideTheWorld(name: string, bytes: Uint8Array | string = pngBytes()) {
  const path = join(await tempDir("arke-look-"), name);
  await writeFile(path, bytes);
  return path;
}

describe("bringing a master look in by hand", () => {
  it("offers the picked file rather than adopting it, then makes accepting it the next look version", async () => {
    const picked = await fileOutsideTheWorld("my-look.png");
    const { provider, worldDir, send, record } = await harness(() => [picked]);
    try {
      const before = provider.openStore()!.getBundle().artDirection;

      await send({ kind: "upload-master-look", worldId: WORLD_ID, requestId: "01J8F3K2QW9VZX4N7M0RTYB61A" });
      const offered = provider.openStore()!.getBundle();
      assert.equal(offered.masterLookCandidate, `${MASTER_LOOK_DIR}/candidate.png`);
      assert.equal(
        offered.artDirection.masterLook,
        before.masterLook,
        "an upload is an offer — the accepted look is untouched until somebody says yes",
      );

      await send({ kind: "use-master-look", worldId: WORLD_ID });
      const after = await record();
      assert.equal(after.version, before.version + 1, "accepting a master look is a look change");
      assert.equal(after.masterLook, masterLookFile(before.version + 1, ".png"));
      assert.equal(after.description, before.description, "the words are not touched by an image");

      // The bytes are where the record says they are, and the offer is gone.
      assert.deepEqual(
        new Uint8Array(await readFile(join(worldDir, after.masterLook!))),
        new Uint8Array(await readFile(picked)),
      );
      assert.deepEqual(await readdir(join(worldDir, MASTER_LOOK_DIR)).catch(() => []), []);
      assert.ok(await readFile(picked), "the user's own file is never moved");

      // The version it replaces keeps what it had, which is the whole reason for the bump: a take
      // made under v3 must not come to claim an image that did not exist while v3 was current.
      const previous = after.history.find((entry) => entry.version === before.version);
      assert.equal(previous?.masterLook, before.masterLook);
    } finally {
      await provider.close();
    }
  });

  it("keeps the format the bytes actually carry, not the one the name claims", async () => {
    // A JPEG named .png is stored as the JPEG it is — the same rule every other import follows.
    const jpeg = Uint8Array.from([0xff, 0xd8, ...Array.from({ length: 32 }, () => 0x00), 0xff, 0xd9]);
    const picked = await fileOutsideTheWorld("mislabelled.png", jpeg);
    const { provider, send, record } = await harness(() => [picked]);
    try {
      await send({ kind: "upload-master-look", worldId: WORLD_ID, requestId: "01J8F3K2QW9VZX4N7M0RTYB61B" });
      assert.equal(provider.openStore()!.getBundle().masterLookCandidate, `${MASTER_LOOK_DIR}/candidate.jpg`);
      await send({ kind: "use-master-look", worldId: WORLD_ID });
      assert.match((await record()).masterLook ?? "", /\.jpg$/);
    } finally {
      await provider.close();
    }
  });

  it("says why when the file is not an image, and changes nothing", async () => {
    const picked = await fileOutsideTheWorld("notes.png", "this is not a picture");
    const { provider, events, send } = await harness(() => [picked]);
    try {
      const before = provider.openStore()!.getBundle().artDirection.version;
      await send({ kind: "upload-master-look", worldId: WORLD_ID, requestId: "01J8F3K2QW9VZX4N7M0RTYB61C" });
      const result = events.find((event) => event.type === "queue.enqueue-result");
      assert.equal(result?.type === "queue.enqueue-result" ? result.disposition : null, "rejected");
      assert.equal(provider.openStore()!.getBundle().masterLookCandidate, null);
      assert.equal(provider.openStore()!.getBundle().artDirection.version, before, "nothing moved");
    } finally {
      await provider.close();
    }
  });

  it("says nothing at all when the dialog is closed", async () => {
    const { provider, events, send } = await harness(() => []);
    try {
      await send({ kind: "upload-master-look", worldId: WORLD_ID, requestId: "01J8F3K2QW9VZX4N7M0RTYB61D" });
      const result = events.find((event) => event.type === "queue.enqueue-result");
      // Not a failure: nothing was queued, and a toast over a dialog somebody deliberately closed
      // is the app arguing with a decision.
      assert.equal(result?.type === "queue.enqueue-result" ? result.disposition : null, "not-queued");
      assert.equal(provider.openStore()!.getBundle().masterLookCandidate, null);
    } finally {
      await provider.close();
    }
  });

  it("replaces the waiting candidate rather than accumulating offers", async () => {
    const first = await fileOutsideTheWorld("first.png");
    const jpeg = Uint8Array.from([0xff, 0xd8, ...Array.from({ length: 32 }, () => 0x00), 0xff, 0xd9]);
    const second = await fileOutsideTheWorld("second.png", jpeg);
    let next = first;
    const { provider, worldDir, send } = await harness(() => [next]);
    try {
      await send({ kind: "upload-master-look", worldId: WORLD_ID, requestId: "01J8F3K2QW9VZX4N7M0RTYB61E" });
      next = second;
      await send({ kind: "upload-master-look", worldId: WORLD_ID, requestId: "01J8F3K2QW9VZX4N7M0RTYB61F" });
      // One offer, not two: a leftover .png beside a new .jpg would be found first by the scan
      // and accepted in place of the file the person actually chose.
      assert.deepEqual(await readdir(join(worldDir, MASTER_LOOK_DIR)), ["candidate.jpg"]);
    } finally {
      await provider.close();
    }
  });

  it("works on a world whose look is still derived, where art-direction/ does not exist yet", async () => {
    // The most likely first use of this feature: a young world, no record on disk, the look
    // resolved from tone and genre. The folder the image lands in arrives with the first record,
    // so there is nothing to copy into until this makes it.
    const picked = await fileOutsideTheWorld("first-look.png");
    const { provider, send, record } = await harness(
      () => [picked],
      async (worldDir) => rm(join(worldDir, "art-direction"), { recursive: true, force: true }),
    );
    try {
      assert.equal(provider.openStore()!.getBundle().artDirection.derived, true, "no record to start from");
      await send({ kind: "upload-master-look", worldId: WORLD_ID, requestId: "01J8F3K2QW9VZX4N7M0RTYB61J" });
      await send({ kind: "use-master-look", worldId: WORLD_ID });
      const after = await record();
      assert.equal(after.version, 2, "the derived look is v1, so the first authored one is v2");
      assert.equal(after.masterLook, masterLookFile(2, ".png"));
    } finally {
      await provider.close();
    }
  });

  it("puts the candidate back when the gate refuses, rather than stranding the image", async () => {
    // The gate allows one open look change at a time. The screen greys the button out, but the
    // refusal has to be survivable anyway: a copied image the record does not name is an orphan
    // nothing can show and nobody can remove.
    const picked = await fileOutsideTheWorld("blocked.png");
    const { provider, worldDir, send } = await harness(() => [picked]);
    try {
      await send({ kind: "upload-master-look", worldId: WORLD_ID, requestId: "01J8F3K2QW9VZX4N7M0RTYB61H" });
      await send({
        kind: "stage-art-direction-change",
        worldId: WORLD_ID,
        description: "A different look, staged by an agent and still waiting.",
      });
      const before = provider.openStore()!.getBundle().artDirection.version;

      await send({ kind: "use-master-look", worldId: WORLD_ID });

      const after = provider.openStore()!.getBundle();
      assert.equal(after.artDirection.version, before, "the refusal changed nothing");
      assert.equal(after.masterLookCandidate, `${MASTER_LOOK_DIR}/candidate.png`, "the offer is still on the screen");
      assert.deepEqual(
        await readdir(join(worldDir, "art-direction")),
        ["art-direction.json"],
        "no image left behind under a version that never happened",
      );
    } finally {
      await provider.close();
    }
  });

  it("throws the candidate away on discard, and leaves the look alone", async () => {
    const picked = await fileOutsideTheWorld("no-thanks.png");
    const { provider, send } = await harness(() => [picked]);
    try {
      const before = provider.openStore()!.getBundle().artDirection.version;
      await send({ kind: "upload-master-look", worldId: WORLD_ID, requestId: "01J8F3K2QW9VZX4N7M0RTYB61G" });
      await send({ kind: "discard-master-look", worldId: WORLD_ID });
      assert.equal(provider.openStore()!.getBundle().masterLookCandidate, null);
      assert.equal(provider.openStore()!.getBundle().artDirection.version, before, "discarding is not a change");
    } finally {
      await provider.close();
    }
  });
});

/**
 * The picture you hand the model before it starts.
 *
 * Staged on disk rather than held in the renderer, for the same reason the candidate is: the
 * renderer never touches bytes, and an attachment that survives a reload is one the person can
 * still see they made.
 */
describe("staging a reference for the next master look", () => {
  it("copies the picked file into the world and shows it as attached", async () => {
    const picked = await fileOutsideTheWorld("mood.png");
    const { provider, send } = await harness(() => [picked]);
    try {
      await send({
        kind: "pick-master-look-reference",
        worldId: WORLD_ID,
        requestId: "01J8F3K2QW9VZX4N7M0RTYB62A",
      });
      assert.equal(
        provider.openStore()!.getBundle().masterLookReference,
        `${MASTER_LOOK_REFERENCE_DIR}/reference.png`,
      );
    } finally {
      await provider.close();
    }
  });

  it("keeps one reference rather than accumulating one per pick", async () => {
    const first = await fileOutsideTheWorld("first.png");
    const second = await fileOutsideTheWorld("second.png");
    let next = first;
    const { provider, worldDir, send } = await harness(() => [next]);
    try {
      await send({
        kind: "pick-master-look-reference",
        worldId: WORLD_ID,
        requestId: "01J8F3K2QW9VZX4N7M0RTYB62B",
      });
      next = second;
      await send({
        kind: "pick-master-look-reference",
        worldId: WORLD_ID,
        requestId: "01J8F3K2QW9VZX4N7M0RTYB62C",
      });
      assert.deepEqual(await readdir(join(worldDir, "incoming", "master-look-ref")), ["reference.png"]);
    } finally {
      await provider.close();
    }
  });

  it("unstages on request", async () => {
    const picked = await fileOutsideTheWorld("mood.png");
    const { provider, send } = await harness(() => [picked]);
    try {
      await send({
        kind: "pick-master-look-reference",
        worldId: WORLD_ID,
        requestId: "01J8F3K2QW9VZX4N7M0RTYB62D",
      });
      await send({ kind: "clear-master-look-reference", worldId: WORLD_ID });
      assert.equal(provider.openStore()!.getBundle().masterLookReference, null);
    } finally {
      await provider.close();
    }
  });

  /*
   * A reference kept past the picture it produced would silently join the next generation, which
   * nobody asked it to — and the dialog would open with an attachment the person does not
   * remember making.
   */
  it("is thrown away once the offer it helped make is settled", async () => {
    const picked = await fileOutsideTheWorld("mood.png");
    const { provider, send } = await harness(() => [picked]);
    try {
      await send({
        kind: "pick-master-look-reference",
        worldId: WORLD_ID,
        requestId: "01J8F3K2QW9VZX4N7M0RTYB62E",
      });
      await send({ kind: "upload-master-look", worldId: WORLD_ID, requestId: "01J8F3K2QW9VZX4N7M0RTYB62F" });
      assert.ok(provider.openStore()!.getBundle().masterLookReference !== null, "still staged while it waits");

      await send({ kind: "discard-master-look", worldId: WORLD_ID });
      assert.equal(provider.openStore()!.getBundle().masterLookReference, null);
    } finally {
      await provider.close();
    }
  });
});
