import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Job } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { pngBytes } from "../queue/fake-provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const CLOCK = "2026-08-04T12:00:00.000Z";

describe("background world finalization", () => {
  it("records a character take in its owning world without changing the selected world", async () => {
    const { root, worldDir } = await makeTempRoot();
    const provider = new FsWorldProvider(root, { clock: () => CLOCK });
    const selected = await provider.createWorld({ name: "Selected World" });
    await provider.loadWorld(selected.worldId);
    const landed = "references/maren-kest/incoming/character-sheet-background.png";
    await mkdir(join(worldDir, "references", "maren-kest", "incoming"), { recursive: true });
    await writeFile(join(worldDir, landed), pngBytes());

    const coordinator = new Coordinator({
      provider,
      adapter: null,
      changeLogPath: join(root, "logs", "changes.jsonl"),
      appVersion: "test",
    });
    const job: Job = {
      id: "jb_01J8E00000000000000000BG1",
      idempotencyKey: "01J8E10000000000000000BG1",
      worldId: WORLD_ID,
      target: { kind: "character-sheet", id: "maren-kest/background" },
      capability: "image",
      provider: "fal",
      model: "flux-2-pro",
      params: {
        prompt: "one composite",
        references: ["references/maren-kest/head-front.png"],
        provenance: {
          canonRevision: 42,
          sheets: { "maren-kest": 4 },
          artDirectionVersion: 3,
          anchorFile: "head-front.png",
        },
      },
      estimatedMicroUsd: 47000,
      status: "succeeded",
      providerJobId: "remote-background",
      attempt: 1,
      landing: { dir: "references/maren-kest/incoming" },
      landedFiles: [landed],
      error: null,
      createdAt: CLOCK,
      updatedAt: CLOCK,
    };

    await (coordinator as unknown as { onJobTerminal(terminal: Job): Promise<void> }).onJobTerminal(job);

    assert.equal(provider.openStore()?.worldId, selected.worldId);
    const takes = await readdir(join(worldDir, "references", "maren-kest", "takes"));
    const backgroundTake = await Promise.all(
      takes.map(async (id) => ({
        id,
        raw: await readFile(join(worldDir, "references", "maren-kest", "takes", id, "take.json"), "utf8"),
      })),
    );
    assert.equal(backgroundTake.filter((take) => take.raw.includes(job.id)).length, 1);
    await provider.close();
  });
});
