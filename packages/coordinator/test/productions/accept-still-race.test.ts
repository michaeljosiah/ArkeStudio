import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ClientMessage, DomainEvent, Take } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { encodePng, solidImage } from "../../src/references/png.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const PRODUCTION = "saltlight";
const SHOT = "sh_12";
const OLDER = "tk_01J8A0000000000000000000N1";
const NEWER = "tk_01J8A0000000000000000000N2";
const REPLACEMENT = "tk_01J8A0000000000000000000N3";
const CLOCK = "2026-09-01T12:00:00.000Z";

async function writeStill(worldDir: string, id: string): Promise<void> {
  const dir = join(worldDir, "productions", PRODUCTION, "takes", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "frame.jpg"), Buffer.from(`source-${id}`));
  const take: Take = {
    id: id as Take["id"],
    coversShots: [SHOT] as Take["coversShots"],
    kind: "frame",
    provider: "test",
    model: "slow-converter",
    provenance: { canonRevision: 42, sheets: {}, artDirectionVersion: 1 },
    references: [],
    params: {},
    cost: { estimatedMicroUsd: 1, actualMicroUsd: 1, actualSource: "local-zero" },
    dispatchedAt: CLOCK,
    completedAt: CLOCK,
    media: "frame.jpg",
  };
  await writeFile(join(dir, "take.json"), JSON.stringify(take, null, 2) + "\n");
}

describe("direct still acceptance authorization", () => {
  it("keeps an older conversion from overwriting a newer accept and still permits a later replacement", async () => {
    const { root, worldDir } = await makeTempRoot();
    await Promise.all([OLDER, NEWER, REPLACEMENT].map((id) => writeStill(worldDir, id)));
    const provider = new FsWorldProvider(root, { clock: () => CLOCK });
    await provider.listWorlds();
    await provider.loadWorld(WORLD_ID);

    let releaseOlder!: () => void;
    let olderEntered!: () => void;
    const held = new Promise<void>((resolve) => { releaseOlder = resolve; });
    const convertingOlder = new Promise<void>((resolve) => { olderEntered = resolve; });
    const events: DomainEvent[] = [];
    const coordinator = new Coordinator({
      provider,
      adapter: null,
      appVersion: "test",
      changeLogPath: join(root, "logs", "changes.jsonl"),
      observeEvent: (event) => events.push(event),
      boundaryFrameMaker: {
        write: async (input, output) => {
          if (input.includes(OLDER)) {
            olderEntered();
            await held;
          }
          await writeFile(output, encodePng(solidImage(8, 8, [20, 40, 60, 255])));
          return { ok: true };
        },
      },
    });
    const send = (takeId: string) =>
      (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage({
        kind: "accept-take",
        worldId: WORLD_ID,
        productionId: PRODUCTION,
        shotId: SHOT,
        takeId,
      });

    try {
      const older = send(OLDER);
      await convertingOlder;
      await send(NEWER);
      const selectedByNewer = provider.openStore()!.getBundle().productions
        .find((candidate) => candidate.meta.id === PRODUCTION)!.selections[SHOT]?.startFrameArtifactId;
      assert.ok(selectedByNewer);

      releaseOlder();
      await older;
      let bundle = provider.openStore()!.getBundle();
      let production = bundle.productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
      assert.equal(production.selections[SHOT]?.startFrameArtifactId, selectedByNewer);
      assert.ok(!production.reviews.some((review) => review.takeId === OLDER));
      assert.ok(!events.some((event) => event.type === "review.recorded" && event.review.takeId === OLDER));

      await send(REPLACEMENT);
      bundle = provider.openStore()!.getBundle();
      production = bundle.productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
      const replacementArtifact = bundle.artifacts.find(
        (artifact) => artifact.id === production.selections[SHOT]?.startFrameArtifactId,
      );
      assert.equal(
        replacementArtifact?.origin.by === "system" ? replacementArtifact.origin.producedBy : undefined,
        `accept:${REPLACEMENT}`,
        "an explicit accept started after the prior one completed still replaces it",
      );
      assert.ok(production.reviews.some((review) => review.takeId === NEWER));
      assert.ok(production.reviews.some((review) => review.takeId === REPLACEMENT));
    } finally {
      releaseOlder();
      await coordinator.stop();
      await provider.close();
    }
  });
});
