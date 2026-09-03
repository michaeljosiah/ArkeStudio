import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientMessage, DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { encodePng, solidImage } from "../../src/references/png.js";
import type { BoundaryFrameMaker } from "../../src/takes/boundary.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { jpegBytes } from "../queue/fake-provider.js";
import { tempDir } from "../tmp.js";
import { FIXTURE_WORLD, makeTempRoot, WORLD_ID } from "../world/helpers.js";

const CLOCK = "2026-08-31T12:00:00.000Z";
const PRODUCTION = "saltlight";
const SHOT = "sh_12";
const OTHER_WORLD = "01J8F3K2QW9VZX4N7M0RTYB6HD";

const framePngBytes = () => encodePng(solidImage(4, 4, [20, 30, 40, 255]));

async function sourceFile(name: string, bytes: Uint8Array | string): Promise<string> {
  const dir = await tempDir("shot-frame-upload-");
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

async function harness(
  picked: () => readonly string[] | Promise<readonly string[]>,
  boundaryFrameMaker?: BoundaryFrameMaker,
) {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.listWorlds();
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const asked: Array<readonly string[]> = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    observeEvent: (event) => events.push(event),
    boundaryFrameMaker,
    pickFiles: async ({ accept }) => {
      asked.push(accept);
      return picked();
    },
  });
  const handle = (coordinator as unknown as { handleClientMessage(msg: ClientMessage): Promise<void> }).handleClientMessage.bind(coordinator);
  const send = (requestId: string) =>
    handle({
      kind: "import-shot-frame",
      worldId: WORLD_ID,
      productionId: PRODUCTION,
      shotId: SHOT,
      requestId,
    });
  const accept = (takeId: string) => handle({
    kind: "accept-take",
    worldId: WORLD_ID,
    productionId: PRODUCTION,
    takeId,
    shotId: SHOT,
  });
  return { coordinator, provider, root, worldDir, events, asked, send, accept };
}

function result(events: DomainEvent[], requestId?: string) {
  return events.find(
    (event): event is Extract<DomainEvent, { type: "queue.enqueue-result" }> =>
      event.type === "queue.enqueue-result" &&
      event.command === "import-shot-frame" &&
      (requestId === undefined || event.requestId === requestId),
  );
}

describe("importing a shot frame", () => {
  it("keeps a zero-cost user/upload Variant and accepts it through the drawn-frame path", async () => {
    const bytes = framePngBytes();
    const source = await sourceFile("my-opening-frame.png", bytes);
    const { provider, worldDir, events, asked, send } = await harness(() => [source]);
    try {
      const before = provider.openStore()!.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
      const previousClip = before.selections[SHOT]?.acceptedTakeId;

      await send("01J8E1000000000000000000V1");

      const bundle = provider.openStore()!.getBundle();
      const production = bundle.productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
      const take = production.takes.find(
        (candidate) =>
          candidate.provider === "user" && candidate.model === "upload" && candidate.coversShots.includes(SHOT),
      );
      assert.ok(take, "the upload is a durable Variant");
      assert.equal(take.kind, "frame");
      assert.deepEqual(take.cost, {
        estimatedMicroUsd: 0,
        actualMicroUsd: 0,
        actualSource: "local-zero",
      });
      assert.equal(take.jobId, undefined, "no provider job was invented");
      assert.deepEqual(take.provenance.sheets, {}, "an upload cites no unrelated reference sheets");
      assert.deepEqual(
        new Uint8Array(
          await readFile(join(worldDir, "productions", PRODUCTION, "takes", take.id, take.media!)),
        ),
        new Uint8Array(bytes),
      );
      assert.deepEqual(new Uint8Array(await readFile(source)), new Uint8Array(bytes), "the picked file is copied, never moved");

      const review = production.reviews.find((candidate) => candidate.takeId === take.id);
      assert.equal(review?.decision, "accept");
      assert.equal(review?.shotId, SHOT);
      assert.equal(review?.by, "user");
      const selection = production.selections[SHOT]!;
      assert.match(selection.startFrameArtifactId ?? "", /^ar_/);
      assert.equal(selection.startFrameTakeId, null);
      assert.equal(selection.acceptedTakeId, previousClip, "a still never replaces the selected clip");
      const artifact = bundle.artifacts.find((candidate) => candidate.id === selection.startFrameArtifactId);
      assert.equal(artifact?.kind, "image");
      assert.ok(artifact?.links.includes(take.id));
      assert.equal(artifact?.origin.by, "system");
      assert.equal(artifact?.origin.by === "system" ? artifact.origin.producedBy : undefined, `accept:${take.id}`);

      assert.deepEqual(asked, [["png", "jpg", "jpeg", "webp"]]);
      assert.equal(result(events)?.disposition, "not-queued");
      assert.deepEqual(result(events)?.failures, []);
      assert.ok(events.some((event) => event.type === "review.recorded" && event.review.takeId === take.id));
      assert.ok(events.some((event) => event.type === "selection.changed" && event.shotId === SHOT));
    } finally {
      await provider.close();
    }
  });

  it("restores a Variant by selecting its existing artifact instead of copying it (#670)", async () => {
    const firstBytes = encodePng(solidImage(4, 4, [20, 30, 40, 255]));
    const secondBytes = encodePng(solidImage(4, 4, [80, 90, 100, 255]));
    const firstSource = await sourceFile("first-frame.png", firstBytes);
    const secondSource = await sourceFile("second-frame.png", secondBytes);
    let picks = 0;
    const { provider, worldDir, send, accept } = await harness(() => [picks++ === 0 ? firstSource : secondSource]);
    try {
      await send("01J8E1000000000000000000W1");
      const firstBundle = provider.openStore()!.getBundle();
      const firstProduction = firstBundle.productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
      const firstTake = firstProduction.takes.find(
        (candidate) => candidate.provider === "user" && candidate.model === "upload" && candidate.coversShots.includes(SHOT),
      )!;
      const firstArtifactId = firstProduction.selections[SHOT]!.startFrameArtifactId!;
      const firstArtifact = firstBundle.artifacts.find((candidate) => candidate.id === firstArtifactId)!;

      await send("01J8E1000000000000000000W2");
      const before = provider.openStore()!.getBundle();
      const beforeProduction = before.productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
      assert.notEqual(beforeProduction.selections[SHOT]?.startFrameArtifactId, firstArtifactId, "the second image holds the slot");
      const artifactFilesBefore = (await readdir(join(worldDir, "artifacts"))).sort();

      await accept(firstTake.id);

      const after = provider.openStore()!.getBundle();
      const afterProduction = after.productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
      assert.equal(afterProduction.selections[SHOT]?.startFrameArtifactId, firstArtifactId, "restore moves the pointer back");
      assert.equal(after.artifacts.length, before.artifacts.length, "restore creates no artifact sidecar");
      assert.deepEqual((await readdir(join(worldDir, "artifacts"))).sort(), artifactFilesBefore, "restore writes no artifact bytes");
      assert.deepEqual(new Uint8Array(await readFile(join(worldDir, "artifacts", firstArtifact.file))), new Uint8Array(firstBytes));
      assert.equal(afterProduction.reviews.at(-1)?.takeId, firstTake.id, "the new acceptance remains durable");
      assert.equal(afterProduction.reviews.at(-1)?.decision, "accept");
    } finally {
      await provider.close();
    }
  });

  it("treats a closed picker as cancellation and changes nothing", async () => {
    const { provider, events, send } = await harness(() => []);
    try {
      const bundle = provider.openStore()!.getBundle();
      const production = bundle.productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
      const before = {
        takes: production.takes.length,
        reviews: production.reviews.length,
        artifacts: bundle.artifacts.length,
        selection: production.selections[SHOT],
      };

      await send("01J8E1000000000000000000V2");

      const afterBundle = provider.openStore()!.getBundle();
      const after = afterBundle.productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
      assert.equal(after.takes.length, before.takes);
      assert.equal(after.reviews.length, before.reviews);
      assert.equal(afterBundle.artifacts.length, before.artifacts);
      assert.deepEqual(after.selections[SHOT], before.selection);
      assert.equal(result(events)?.disposition, "not-queued");
      assert.deepEqual(result(events)?.failures, []);
    } finally {
      await provider.close();
    }
  });

  it("keeps a non-PNG Variant unselected when PNG conversion is unavailable", async () => {
    const source = await sourceFile("opening-frame.jpg", jpegBytes());
    const { provider, events, send } = await harness(() => [source]);
    try {
      const beforeBundle = provider.openStore()!.getBundle();
      const before = beforeBundle.productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
      const previousSelection = before.selections[SHOT];

      await send("01J8E1000000000000000000V8");

      const afterBundle = provider.openStore()!.getBundle();
      const after = afterBundle.productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
      const take = after.takes.find(
        (candidate) => candidate.provider === "user" && candidate.model === "upload" && candidate.media?.endsWith(".jpg"),
      );
      assert.ok(take, "the immutable upload remains available as a Variant");
      assert.deepEqual(after.selections[SHOT], previousSelection, "an unreadable board frame is never selected");
      assert.ok(!after.reviews.some((review) => review.takeId === take.id));
      assert.ok(!afterBundle.artifacts.some((artifact) => artifact.links.includes(take.id)));
      assert.equal(result(events)?.disposition, "rejected");
      assert.match(result(events)?.failures[0]?.reason ?? "", /kept as a Variant.*board-compatible PNG/);
    } finally {
      await provider.close();
    }
  });

  it("keeps a non-PNG Variant unselected when PNG conversion fails", async () => {
    const source = await sourceFile("opening-frame.jpg", jpegBytes());
    const converter: BoundaryFrameMaker = { write: async () => ({ ok: false, reason: "process-failed" }) };
    const { provider, events, send } = await harness(() => [source], converter);
    try {
      const before = provider.openStore()!.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
      const previousSelection = before.selections[SHOT];

      await send("01J8E1000000000000000000V9");

      const after = provider.openStore()!.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
      assert.deepEqual(after.selections[SHOT], previousSelection);
      assert.equal(result(events)?.disposition, "rejected");
      assert.match(result(events)?.failures[0]?.reason ?? "", /kept as a Variant.*board-compatible PNG/);
    } finally {
      await provider.close();
    }
  });

  it("refuses a non-image by its bytes without creating history", async () => {
    const source = await sourceFile("renamed.png", "not an image");
    const { provider, events, send } = await harness(() => [source]);
    try {
      const before = provider.openStore()!.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
      await send("01J8E1000000000000000000V3");
      const after = provider.openStore()!.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;

      assert.equal(after.takes.length, before.takes.length);
      assert.equal(after.reviews.length, before.reviews.length);
      assert.equal(result(events)?.disposition, "rejected");
      assert.match(result(events)?.failures[0]?.reason ?? "", /PNG, JPEG or WebP/);
    } finally {
      await provider.close();
    }
  });

  it("refuses several selections instead of silently taking the first", async () => {
    const first = await sourceFile("first.png", framePngBytes());
    const second = await sourceFile("second.png", framePngBytes());
    const { provider, events, send } = await harness(() => [first, second]);
    try {
      const before = provider.openStore()!.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
      await send("01J8E1000000000000000000V4");
      const after = provider.openStore()!.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;

      assert.equal(after.takes.length, before.takes.length);
      assert.equal(result(events)?.disposition, "rejected");
      assert.match(result(events)?.failures[0]?.reason ?? "", /single image/);
    } finally {
      await provider.close();
    }
  });

  it("keeps an older picker completion from replacing a newer frame", async () => {
    const olderSource = await sourceFile("older.png", framePngBytes());
    const newerSource = await sourceFile("newer.png", framePngBytes());
    let picks = 0;
    let releaseOlder!: (paths: readonly string[]) => void;
    const olderPick = new Promise<readonly string[]>((resolve) => { releaseOlder = resolve; });
    const { provider, events, send } = await harness(() => {
      picks += 1;
      return picks === 1 ? olderPick : [newerSource];
    });
    try {
      const older = send("01J8E1000000000000000000V6");
      await send("01J8E1000000000000000000V7");
      const selectedByNewer = provider.openStore()!.getBundle().productions
        .find((candidate) => candidate.meta.id === PRODUCTION)!.selections[SHOT]?.startFrameArtifactId;
      assert.ok(selectedByNewer);

      releaseOlder([olderSource]);
      await older;
      const after = provider.openStore()!.getBundle().productions
        .find((candidate) => candidate.meta.id === PRODUCTION)!;
      assert.equal(after.selections[SHOT]?.startFrameArtifactId, selectedByNewer);
      assert.equal(result(events, "01J8E1000000000000000000V6")?.disposition, "rejected");
      assert.match(result(events, "01J8E1000000000000000000V6")?.failures[0]?.reason ?? "", /kept as a Variant/);
      assert.equal(
        after.takes.filter((candidate) => candidate.provider === "user" && candidate.model === "upload").length,
        2,
        "both images remain browsable as Variants",
      );
    } finally {
      await provider.close();
    }
  });

  it("does not reopen a world that changed while the frame was being filed", async () => {
    const source = await sourceFile("late-opening-frame.png", framePngBytes());
    const { provider, root, events, send } = await harness(() => [source]);
    try {
      const secondDir = join(root, "worlds", "another-world");
      await cp(FIXTURE_WORLD, secondDir, { recursive: true });
      const worldPath = join(secondDir, "world.json");
      const world = JSON.parse(await readFile(worldPath, "utf8")) as Record<string, unknown>;
      await writeFile(
        worldPath,
        `${JSON.stringify({ ...world, worldId: OTHER_WORLD, slug: "another-world", name: "Another World" }, null, 2)}\n`,
      );
      const beforeAttention = (await provider.listWorlds()).find((world) => world.worldId === WORLD_ID)?.attention?.unreviewedTakes;
      assert.notEqual(beforeAttention, undefined);

      const store = provider.openStore()!;
      const gateOp = store.gateOp.bind(store);
      let gates = 0;
      let entered!: () => void;
      let release!: () => void;
      const filingEntered = new Promise<void>((resolve) => { entered = resolve; });
      const letFilingCommit = new Promise<void>((resolve) => { release = resolve; });
      store.gateOp = async <T>(operation: () => Promise<T>): Promise<T> => {
        gates += 1;
        if (gates !== 2) return gateOp(operation);
        return gateOp(async () => {
          entered();
          await letFilingCommit;
          return operation();
        });
      };

      const sending = send("01J8E1000000000000000000V5");
      await filingEntered;
      const switching = provider.loadWorld(OTHER_WORLD);
      for (let attempt = 0; attempt < 100 && provider.openStore() === store; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      assert.notEqual(provider.openStore(), store, "the switch is waiting for the admitted commit to drain");
      release();
      await Promise.all([sending, switching]);

      assert.equal(provider.openStore()?.worldId, OTHER_WORLD, "the newer world stays open");
      assert.equal(result(events)?.disposition, "not-queued", "the completed upload is never reported as a refusal");
      assert.deepEqual(result(events)?.failures, []);
      assert.ok(!events.some((event) => event.type === "review.recorded"), "stale world events are not published");
      const afterAttention = (await provider.listWorlds()).find((world) => world.worldId === WORLD_ID)?.attention?.unreviewedTakes;
      assert.equal(afterAttention, beforeAttention, "the closed-world registry sees the accept that drained before close");
    } finally {
      await provider.close();
    }
  });
});
