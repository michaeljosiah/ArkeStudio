import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientMessage, DomainEvent, ReferenceKit } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { recordUploadedCharacterSheetTake } from "../../src/references/takes.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { pngBytes } from "../queue/fake-provider.js";
import { tempDir } from "../tmp.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * Bringing a main photo or a character sheet in by hand (PR #241).
 *
 * The picker belongs to the host, so these tests stand in for it: what matters here is that the
 * path it hands back is copied, validated and accepted without a provider ever being asked, and
 * that every way it can go wrong says so instead of leaving the card unchanged and silent.
 */

const CLOCK = "2026-08-10T12:00:00.000Z";

async function harness(picked: () => readonly string[], before?: (provider: FsWorldProvider) => Promise<unknown>) {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await before?.(provider);
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const asked: Array<readonly string[]> = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    observeEvent: (event) => events.push(event),
    pickFiles: async ({ accept }) => {
      asked.push(accept);
      return picked();
    },
  });
  const send = (msg: ClientMessage) =>
    coordinator.dispatch(msg);
  const kitOf = async (sheetId: string) =>
    JSON.parse(await readFile(join(worldDir, "references", sheetId, "kit.json"), "utf8")) as ReferenceKit;
  return { provider, worldDir, events, asked, send, kitOf };
}

/** A real image somewhere else on the disk — the only kind of source these paths ever have. */
async function fileOutsideTheWorld(name: string, bytes: Uint8Array | string = pngBytes()) {
  const path = join(await tempDir("arke-picked-"), name);
  await writeFile(path, bytes);
  return path;
}

/** Whole enough to pass the same signature-and-trailer check the dispatcher lands artifacts by. */
function jpegBytes(): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, ...Array.from({ length: 32 }, () => 0x00), 0xff, 0xd9]);
}

/** A PNG that stopped arriving: the signature is there, the IEND that closes it is not. */
function truncatedPngBytes(): Uint8Array {
  return pngBytes().slice(0, 20);
}

/** The one report this action owes. Exactly one: reporting twice is its own kind of wrong. */
function theReport<T extends DomainEvent["type"]>(events: DomainEvent[], type: T): Extract<DomainEvent, { type: T }> {
  const found = events.filter((event) => event.type === type);
  assert.equal(found.length, 1, `expected exactly one ${type}`);
  return found[0] as Extract<DomainEvent, { type: T }>;
}

describe("uploading a main photo by hand", () => {
  it("accepts the existing portrait through the public command without opening a picker", async () => {
    const { provider, events, asked, send, kitOf } = await harness(() => []);
    try {
      await send({ kind: "choose-anchor", worldId: WORLD_ID, sheetId: "bray-half-hitch", selection: { source: "legacy-portrait" } });
      assert.equal(theReport(events, "main-photo.acceptance").status, "accepted");
      assert.match((await kitOf("bray-half-hitch")).mainPhoto!.file, /^takes\//);
      assert.deepEqual(asked, []);
    } finally { await provider.close(); }
  });

  it("makes the picked file the identity anchor, through the same accept a chosen candidate takes", async () => {
    const picked = await fileOutsideTheWorld("my-portrait.png");
    const { provider, worldDir, events, asked, send, kitOf } = await harness(() => [picked]);
    try {
      await send({ kind: "import-main-photo", worldId: WORLD_ID, sheetId: "maren-kest" });

      const kit = await kitOf("maren-kest");
      assert.equal(kit.mainPhoto?.source, "upload");
      assert.match(kit.mainPhoto?.file ?? "", /^takes\/tk_[0-9A-Z]+\/upload-[0-9a-z]+\.png$/);
      assert.equal(kit.anchor, kit.mainPhoto?.file, "the anchor moves with it");

      // The bytes live in the take, and nowhere else: the working copy is swept once the
      // permanent one is durable, exactly as a chosen candidate's is.
      const stored = join(worldDir, "references", "maren-kest", kit.mainPhoto!.file);
      assert.deepEqual(new Uint8Array(await readFile(stored)), new Uint8Array(await readFile(picked)));
      const candidates = await readdir(join(worldDir, "references", "maren-kest", "candidates")).catch(() => []);
      assert.deepEqual(candidates.filter((name) => name.startsWith("upload-")), []);
      assert.ok(await readFile(picked), "the user's own file is never moved");

      const takeId = kit.mainPhoto!.file.split("/")[1]!;
      const take = JSON.parse(
        await readFile(join(worldDir, "references", "maren-kest", "takes", takeId, "take.json"), "utf8"),
      ) as { provider: string; model: string; cost: { estimatedMicroUsd: number } };
      assert.equal(take.provider, "user");
      assert.equal(take.model, "upload");
      assert.equal(take.cost.estimatedMicroUsd, 0, "no provider was asked, so nothing was spent");

      // Bare, no dots: Electron rejects a dotted filter outright, and the caller's catch would
      // turn that into what looks like a cancelled dialog.
      assert.deepEqual(asked, [["png", "jpg", "jpeg", "webp"]]);
      assert.equal(theReport(events, "main-photo.acceptance").status, "accepted");
    } finally {
      await provider.close();
    }
  });

  it("answers a closed dialog with a cancellation, and changes nothing", async () => {
    const { provider, worldDir, events, send } = await harness(() => []);
    try {
      const before = await readFile(join(worldDir, "references", "maren-kest", "kit.json"), "utf8");
      await send({ kind: "import-main-photo", worldId: WORLD_ID, sheetId: "maren-kest" });
      assert.equal(await readFile(join(worldDir, "references", "maren-kest", "kit.json"), "utf8"), before);
      // Reported, but as a cancellation carrying no reason: the button that opened the dialog is
      // waiting for an ending, and an error under a card the user chose to leave alone reads as
      // a fault that is not there.
      const reported = theReport(events, "main-photo.acceptance");
      assert.equal(reported.status, "cancelled");
      assert.equal(reported.reason, undefined);
    } finally {
      await provider.close();
    }
  });

  it("ignores a frame written for a world that is no longer the open one", async () => {
    const picked = await fileOutsideTheWorld("my-portrait.png");
    const { provider, worldDir, asked, send } = await harness(() => [picked]);
    const elsewhere = "01J8F3K2QW9VZX4N7M0RTYB6HD";
    try {
      // Sheet slugs recur across worlds, so a stale frame would otherwise file this image under
      // the same-named character in whichever world happens to be open.
      for (const kind of ["import-main-photo-candidate", "import-main-photo", "import-character-sheet"] as const) {
        await send({ kind, worldId: elsewhere, sheetId: "maren-kest" });
      }
      assert.deepEqual(asked, [], "and the dialog never even opens");
      const candidates = await readdir(join(worldDir, "references", "maren-kest", "candidates")).catch(() => []);
      assert.deepEqual(candidates.filter((name) => name.startsWith("upload-")), []);
    } finally {
      await provider.close();
    }
  });

  it("refuses a file that is not an image, and names what would work", async () => {
    const picked = await fileOutsideTheWorld("notes.txt", "not an image");
    const { provider, worldDir, events, send } = await harness(() => [picked]);
    try {
      const before = await readFile(join(worldDir, "references", "maren-kest", "kit.json"), "utf8");
      await send({ kind: "import-main-photo", worldId: WORLD_ID, sheetId: "maren-kest" });
      assert.equal(await readFile(join(worldDir, "references", "maren-kest", "kit.json"), "utf8"), before);
      const reported = theReport(events, "main-photo.acceptance");
      assert.equal(reported.status, "failed");
      assert.match(reported.reason ?? "", /PNG, JPEG or WebP/);
    } finally {
      await provider.close();
    }
  });

  // The case a suffix check cannot see, and the reason the check reads bytes: this file is named
  // .png and starts like one. Accepting it would have committed an unopenable identity anchor and
  // reported success, leaving the failure to surface at dispatch, far from the choosing.
  it("refuses a truncated image rather than accepting a broken anchor", async () => {
    const picked = await fileOutsideTheWorld("half-a-portrait.png", truncatedPngBytes());
    const { provider, worldDir, events, send } = await harness(() => [picked]);
    try {
      const before = await readFile(join(worldDir, "references", "maren-kest", "kit.json"), "utf8");
      await send({ kind: "import-main-photo", worldId: WORLD_ID, sheetId: "maren-kest" });
      assert.equal(await readFile(join(worldDir, "references", "maren-kest", "kit.json"), "utf8"), before);
      assert.equal(theReport(events, "main-photo.acceptance").status, "failed");
      const candidates = await readdir(join(worldDir, "references", "maren-kest", "candidates")).catch(() => []);
      assert.deepEqual(candidates.filter((name) => name.startsWith("upload-")), [], "and nothing was copied in");
    } finally {
      await provider.close();
    }
  });

  it("refuses several selections rather than importing one and calling it done", async () => {
    const one = await fileOutsideTheWorld("first.png");
    const two = await fileOutsideTheWorld("second.png");
    const { provider, worldDir, events, send } = await harness(() => [one, two]);
    try {
      const before = await readFile(join(worldDir, "references", "maren-kest", "kit.json"), "utf8");
      await send({ kind: "import-main-photo", worldId: WORLD_ID, sheetId: "maren-kest" });
      assert.equal(await readFile(join(worldDir, "references", "maren-kest", "kit.json"), "utf8"), before);
      const reported = theReport(events, "main-photo.acceptance");
      assert.equal(reported.status, "failed");
      assert.match(reported.reason ?? "", /single image/);
    } finally {
      await provider.close();
    }
  });

  it("stores what the bytes are, not what the name claims", async () => {
    const picked = await fileOutsideTheWorld("actually-a-jpeg.png", jpegBytes());
    const { provider, send, kitOf } = await harness(() => [picked]);
    try {
      await send({ kind: "import-main-photo", worldId: WORLD_ID, sheetId: "maren-kest" });
      assert.match((await kitOf("maren-kest")).mainPhoto?.file ?? "", /\.jpg$/);
    } finally {
      await provider.close();
    }
  });
});

describe("uploading a character sheet by hand", () => {
  it("designates the picked composite without a review step and without claiming an anchor", async () => {
    const picked = await fileOutsideTheWorld("my-own-sheet.png");
    const { provider, worldDir, events, send, kitOf } = await harness(() => [picked]);
    try {
      await send({ kind: "import-character-sheet", worldId: WORLD_ID, sheetId: "maren-kest" });

      const kit = await kitOf("maren-kest");
      const file = kit.designatedCompilation!;
      assert.match(file, /^takes\/tk_[0-9A-Z]+\/character-sheet-upload-[0-9a-z]+\.png$/);
      const compilation = kit.compilations.find((candidate) => candidate.file === file)!;
      assert.equal(compilation.format, "character-sheet");
      assert.equal(compilation.accepted, true);
      assert.equal(compilation.anchorFile, undefined, "it was not drawn from the main photo");
      assert.equal(compilation.source, file.split("/")[1], "the take that owns the bytes");
      assert.equal(kit.mainPhoto?.file, "head-front.png", "and the identity is left where it was");

      assert.deepEqual(
        new Uint8Array(await readFile(join(worldDir, "references", "maren-kest", file))),
        new Uint8Array(await readFile(picked)),
      );
      // The human's own action rule: nobody reviews a file they just picked by hand.
      const reviews = await readFile(join(worldDir, "references", "reviews.jsonl"), "utf8");
      assert.ok(reviews.includes(file.split("/")[1]!), "the accept is recorded as a review");

      assert.equal(theReport(events, "character-sheet.acceptance").status, "accepted");
    } finally {
      await provider.close();
    }
  });

  it("does not wait on a main photo the way generation does", async () => {
    const picked = await fileOutsideTheWorld("bought-elsewhere.png");
    // Perrin has no reference kit at all — no anchor, no photo, nothing to be conditioned on.
    const { provider, events, send, kitOf } = await harness(() => [picked]);
    try {
      await send({ kind: "import-character-sheet", worldId: WORLD_ID, sheetId: "perrin-tallow" });

      const kit = await kitOf("perrin-tallow");
      assert.match(kit.designatedCompilation ?? "", /\.png$/);
      assert.equal(kit.mainPhoto, undefined, "an uploaded sheet invents no identity anchor");
      assert.equal(theReport(events, "character-sheet.acceptance").status, "accepted");
    } finally {
      await provider.close();
    }
  });

  // The recovery path: if the commit after the copy fails, the take is durable and undecided, so
  // the card offers "Accept this sheet". That button used to be inert on an upload — the handler
  // demanded the anchor a generated take carries and an uploaded one never has.
  it("can still be accepted from the card when its first commit did not land", async () => {
    const picked = await fileOutsideTheWorld("my-own-sheet.png");
    const { provider, worldDir, send, kitOf } = await harness(() => [picked]);
    try {
      const store = provider.openStore()!;
      const take = await recordUploadedCharacterSheetTake(
        store,
        "maren-kest",
        "character-sheet-upload-orphan.png",
        pngBytes(),
      );
      assert.equal(
        store.getBundle().referenceReviews.some((review) => review.takeId === take.id),
        false,
        "undecided, exactly as a failed commit leaves it",
      );

      await send({ kind: "accept-character-sheet", worldId: WORLD_ID, sheetId: "maren-kest", takeId: take.id });

      assert.equal((await kitOf("maren-kest")).designatedCompilation, `takes/${take.id}/${take.media}`);
      const reviews = await readFile(join(worldDir, "references", "reviews.jsonl"), "utf8");
      assert.ok(reviews.includes(take.id), "and the press is recorded as the review it is");
    } finally {
      await provider.close();
    }
  });

  // The button is disabled against the jobs the screen could see when it was pressed. A job that
  // starts while the dialog stands open — or from another connected client — is invisible to it,
  // and would land afterwards, designate itself, and replace the upload without a word.
  for (const conflicting of [
    { what: "is still running", status: "running" as const },
    // Succeeded, but its take was never recorded — and Activity still offers to retry that.
    // A successful retry runs the same acceptance and lands the older generated sheet on top.
    {
      what: "succeeded with a finalization that can still be retried",
      status: "succeeded" as const,
      finalization: { status: "failed" as const, error: "the take could not be recorded", updatedAt: CLOCK },
    },
  ]) {
    it(`refuses while a generated sheet for this character ${conflicting.what}`, async () => {
      const { root, worldDir } = await makeTempRoot();
      const job = {
        id: "jb_01J8E0000000000000000000JX",
        idempotencyKey: "01J8E1000000000000000000KX",
        worldId: WORLD_ID,
        target: { kind: "character-sheet", id: "maren-kest/gx" },
        capability: "image",
        provider: "fal",
        model: "flux-pro-1.1",
        params: {},
        estimatedMicroUsd: 40000,
        status: conflicting.status,
        providerJobId: "rm_x",
        attempt: 1,
        error: null,
        createdAt: CLOCK,
        updatedAt: CLOCK,
        ...(conflicting.finalization ? { finalization: conflicting.finalization } : {}),
      };
      await mkdir(join(root, "queue"), { recursive: true });
      await writeFile(join(root, "queue", "jobs.jsonl"), `${JSON.stringify(job)}\n`, "utf8");

      const picked = await fileOutsideTheWorld("my-own-sheet.png");
      const provider = new FsWorldProvider(root, { clock: () => CLOCK });
      await provider.loadWorld(WORLD_ID);
      const events: DomainEvent[] = [];
      const coordinator = new Coordinator({
        provider,
        adapter: null,
        changeLogPath: join(root, "logs", "changes.jsonl"),
        appVersion: "test",
        appRoot: root,
        // Any dispatch surface at all is enough for the queue to exist; nothing here submits.
        dispatchClients: {},
        observeEvent: (event) => events.push(event),
        pickFiles: async () => [picked],
      });
      await coordinator.start(0);
      try {
        const before = await readFile(join(worldDir, "references", "maren-kest", "kit.json"), "utf8");
        await coordinator.dispatch({ kind: "import-character-sheet", worldId: WORLD_ID, sheetId: "maren-kest" });

        assert.equal(await readFile(join(worldDir, "references", "maren-kest", "kit.json"), "utf8"), before);
        const reported = theReport(events, "character-sheet.acceptance");
        assert.equal(reported.status, "failed");
        assert.match(reported.reason ?? "", /has not finished/);
      } finally {
        await coordinator.stop();
        await provider.close();
      }
    });
  }

  it("refuses a file that is not an image, and leaves the designated sheet standing", async () => {
    const picked = await fileOutsideTheWorld("sheet.pdf", "not an image");
    const { provider, events, send, kitOf } = await harness(() => [picked]);
    try {
      await send({ kind: "import-character-sheet", worldId: WORLD_ID, sheetId: "maren-kest" });
      assert.equal((await kitOf("maren-kest")).designatedCompilation, "model-sheet-v4.png");
      assert.equal(theReport(events, "character-sheet.acceptance").status, "failed");
    } finally {
      await provider.close();
    }
  });
});

/**
 * A file dropped on the slot (issue 3146). The choosing happened in the drop, so the picker is
 * never asked; from the path on, it is the Upload button's import, refusals included.
 */
describe("a file dropped on a main photo or character sheet", () => {
  it("makes a dropped file the main photo exactly as a picked one", async () => {
    const dropped = await fileOutsideTheWorld("dropped-portrait.png");
    const { provider, events, asked, send, kitOf } = await harness(() => []);
    try {
      await send({ kind: "import-main-photo", worldId: WORLD_ID, sheetId: "maren-kest", sourcePath: dropped });
      const kit = await kitOf("maren-kest");
      assert.equal(kit.mainPhoto?.source, "upload");
      assert.match(kit.mainPhoto?.file ?? "", /^takes\/tk_[0-9A-Z]+\/upload-[0-9a-z]+\.png$/);
      assert.equal(kit.anchor, kit.mainPhoto?.file);
      assert.equal(theReport(events, "main-photo.acceptance").status, "accepted");
      assert.deepEqual(asked, [], "a drop opens no dialog");
    } finally {
      await provider.close();
    }
  });

  it("refuses a dropped file that is not an image in the Upload button's words", async () => {
    const dropped = await fileOutsideTheWorld("notes.txt", "not an image");
    const { provider, worldDir, events, asked, send } = await harness(() => []);
    try {
      const before = await readFile(join(worldDir, "references", "maren-kest", "kit.json"), "utf8");
      await send({ kind: "import-main-photo", worldId: WORLD_ID, sheetId: "maren-kest", sourcePath: dropped });
      await send({ kind: "import-character-sheet", worldId: WORLD_ID, sheetId: "maren-kest", sourcePath: dropped });
      assert.equal(await readFile(join(worldDir, "references", "maren-kest", "kit.json"), "utf8"), before);
      assert.match(theReport(events, "main-photo.acceptance").reason ?? "", /PNG, JPEG or WebP/);
      assert.match(theReport(events, "character-sheet.acceptance").reason ?? "", /PNG, JPEG or WebP/);
      assert.deepEqual(asked, []);
    } finally {
      await provider.close();
    }
  });

  it("designates a dropped character sheet", async () => {
    const dropped = await fileOutsideTheWorld("dropped-sheet.png");
    const { provider, events, asked, send, kitOf } = await harness(() => []);
    try {
      await send({ kind: "import-character-sheet", worldId: WORLD_ID, sheetId: "maren-kest", sourcePath: dropped });
      const kit = await kitOf("maren-kest");
      assert.match(kit.designatedCompilation ?? "", /^takes\/tk_[0-9A-Z]+\/character-sheet-upload-[0-9a-z]+\.png$/);
      assert.equal(theReport(events, "character-sheet.acceptance").status, "accepted");
      assert.deepEqual(asked, []);
    } finally {
      await provider.close();
    }
  });

  it("adds a file dropped in the main photo dialog to its candidates", async () => {
    const dropped = await fileOutsideTheWorld("dropped-candidate.png");
    const { provider, worldDir, asked, send } = await harness(() => []);
    try {
      await send({ kind: "import-main-photo-candidate", worldId: WORLD_ID, sheetId: "maren-kest", sourcePath: dropped });
      const candidates = await readdir(join(worldDir, "references", "maren-kest", "candidates"));
      assert.equal(candidates.filter((name) => name.startsWith("upload-")).length, 1);
      assert.deepEqual(asked, []);
    } finally {
      await provider.close();
    }
  });
});

/**
 * A picture already in the studio used as the photo itself (issue 3146): the picture the
 * reference picker offers, copied in by the coordinator and taken through the upload's own
 * acceptance, keeping where it came from.
 */
describe("a picture already in the studio as the main photo or character sheet", () => {
  /** Another world holding one finished portrait, created before this one opens. */
  async function anotherWorld(provider: FsWorldProvider): Promise<{ slug: string; sourceDir: string }> {
    const source = await provider.createWorld({ name: "Lagos Nights" });
    const sourceDir = await provider.worldDir(source.worldId);
    await mkdir(join(sourceDir, "references", "timi-j"), { recursive: true });
    await writeFile(join(sourceDir, "references", "timi-j", "main-photo.png"), pngBytes());
    await writeFile(join(sourceDir, "references", "timi-j", "kit.json"), JSON.stringify({
      sheetId: "timi-j", anchor: "main-photo.png", tiles: [], compilations: [],
    }));
    return { slug: source.slug, sourceDir };
  }

  it("lands this world's picture as a candidate, and choosing it makes it the main photo as an upload", async () => {
    const { provider, worldDir, events, asked, send, kitOf } = await harness(() => []);
    try {
      const store = provider.openStore()!;
      await send({ kind: "import-main-photo-candidate", worldId: WORLD_ID, sheetId: "perrin-tallow",
        image: { slug: "the-undersong", path: "references/maren-kest/head-front.png" } });
      const take = store.getBundle().referenceTakes.find((candidate) => candidate.reference?.sheetId === "perrin-tallow");
      assert.ok(take, "an undecided main photo take, beside the candidates");
      assert.equal(take.kind, "main-photo");
      assert.equal(take.provider, "user");
      assert.equal(take.params["copiedFrom"], "references/maren-kest/head-front.png", "and where in this world it came from");
      assert.equal(take.provenance.borrowedImages, undefined, "nothing was borrowed");
      assert.equal(store.getBundle().referenceReviews.some((review) => review.takeId === take.id), false);

      await send({ kind: "choose-anchor", worldId: WORLD_ID, sheetId: "perrin-tallow", selection: { source: "take", takeId: take.id } });
      const kit = await kitOf("perrin-tallow");
      assert.equal(kit.mainPhoto?.file, `takes/${take.id}/${take.media}`);
      assert.equal(kit.mainPhoto?.source, "upload", "accepted the way an upload is");
      assert.deepEqual(
        new Uint8Array(await readFile(join(worldDir, "references", "perrin-tallow", kit.mainPhoto!.file))),
        new Uint8Array(await readFile(join(worldDir, "references", "maren-kest", "head-front.png"))),
      );
      assert.equal(theReport(events, "main-photo.acceptance").status, "accepted");
      assert.deepEqual(asked, [], "no dialog opened");
    } finally {
      await provider.close();
    }
  });

  it("copies another world's picture as a candidate with the borrow's own record of where it came from", async () => {
    let slug = "";
    let sourceDir = "";
    const { provider, worldDir, send } = await harness(() => [], async (owner) => ({ slug, sourceDir } = await anotherWorld(owner)));
    try {
      const store = provider.openStore()!;
      await send({ kind: "import-main-photo-candidate", worldId: WORLD_ID, sheetId: "maren-kest",
        image: { slug, path: "references/timi-j/main-photo.png" } });
      const take = store.getBundle().referenceTakes.find((candidate) => candidate.reference?.sheetId === "maren-kest" && candidate.kind === "main-photo")!;
      assert.ok(take);
      assert.deepEqual(take.provenance.borrowedImages, [{ worldName: "Lagos Nights", imageName: "main-photo.png", copiedAt: take.provenance.borrowedImages![0]!.copiedAt }]);
      assert.equal(take.params["copiedFrom"], undefined, "no path into another world is kept");
      const stored = JSON.parse(await readFile(join(worldDir, "references", "maren-kest", "takes", take.id, "take.json"), "utf8"));
      assert.equal(stored.provenance.borrowedImages[0].worldName, "Lagos Nights");

      // A copy, not a link: what happens over there afterwards changes nothing here.
      await writeFile(join(sourceDir, "references", "timi-j", "main-photo.png"), "changed");
      assert.deepEqual(
        new Uint8Array(await readFile(join(worldDir, "references", "maren-kest", "takes", take.id, take.media!))),
        pngBytes(),
      );
    } finally {
      await provider.close();
    }
  });

  it("designates another world's picture as the character sheet, keeping where it came from", async () => {
    let slug = "";
    const { provider, events, asked, send, kitOf } = await harness(() => [], async (owner) => ({ slug } = await anotherWorld(owner)));
    try {
      const store = provider.openStore()!;
      await send({ kind: "import-character-sheet", worldId: WORLD_ID, sheetId: "maren-kest",
        image: { slug, path: "references/timi-j/main-photo.png" } });
      const kit = await kitOf("maren-kest");
      const file = kit.designatedCompilation!;
      assert.match(file, /^takes\/tk_[0-9A-Z]+\/character-sheet-upload-[0-9a-z]+\.png$/);
      assert.equal(kit.compilations.find((candidate) => candidate.file === file)?.anchorFile, undefined);
      const take = store.getBundle().referenceTakes.find((candidate) => candidate.id === file.split("/")[1])!;
      assert.equal(take.provenance.borrowedImages?.[0]?.worldName, "Lagos Nights");
      assert.equal(theReport(events, "character-sheet.acceptance").status, "accepted");
      assert.deepEqual(asked, []);
    } finally {
      await provider.close();
    }
  });

  it("refuses a picture the studio no longer offers, and changes nothing", async () => {
    const { provider, worldDir, events, send } = await harness(() => []);
    try {
      const before = await readFile(join(worldDir, "references", "maren-kest", "kit.json"), "utf8");
      // A file in the world, but not one of its pictures: the catalogue decides, not the path.
      await send({ kind: "import-character-sheet", worldId: WORLD_ID, sheetId: "maren-kest",
        image: { slug: "the-undersong", path: "references/maren-kest/kit.json" } });
      await send({ kind: "import-main-photo-candidate", worldId: WORLD_ID, sheetId: "maren-kest",
        image: { slug: "no-such-world", path: "references/maren-kest/head-front.png" } });
      assert.equal(await readFile(join(worldDir, "references", "maren-kest", "kit.json"), "utf8"), before);
      assert.match(theReport(events, "character-sheet.acceptance").reason ?? "", /no longer available/);
      assert.match(theReport(events, "main-photo.acceptance").reason ?? "", /no longer available/);
      assert.equal(provider.openStore()!.getBundle().referenceTakes.some((take) => take.reference?.sheetId === "maren-kest" && take.provider === "user"), false);
    } finally {
      await provider.close();
    }
  });
});
