import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REFERENCE_FINALIZATION_TARGETS, type Job } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { acceptCharacterSheet } from "../../src/references/kit.js";
import { recordUploadedCharacterSheetTake, referenceReviewDecision } from "../../src/references/takes.js";
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

    // The human's own action rule: the composite the user asked for lands designated — the
    // person who pressed the button is not asked to approve their own press (build-test
    // feedback, 2026-08-09). The take id is derived from the job id; the review rides along.
    const kit = JSON.parse(await readFile(join(worldDir, "references", "maren-kest", "kit.json"), "utf8")) as {
      designatedCompilation?: string;
    };
    assert.equal(
      kit.designatedCompilation,
      `takes/tk_${job.id.slice(3)}/character-sheet-background.png`,
      "the landed composite is designated without a review step",
    );
    const reviews = await readFile(join(worldDir, "references", "reviews.jsonl"), "utf8");
    assert.ok(reviews.includes(`tk_${job.id.slice(3)}`), "the accept is recorded as a review");
    await provider.close();
  });

  it("does not designate itself over a sheet claimed after the job began", async () => {
    const { root, worldDir } = await makeTempRoot();
    const provider = new FsWorldProvider(root, { clock: () => CLOCK });
    await provider.loadWorld(WORLD_ID);
    const landed = "references/maren-kest/incoming/character-sheet-late.png";
    await mkdir(join(worldDir, "references", "maren-kest", "incoming"), { recursive: true });
    await writeFile(join(worldDir, landed), pngBytes());

    const coordinator = new Coordinator({
      provider,
      adapter: null,
      changeLogPath: join(root, "logs", "changes.jsonl"),
      appVersion: "test",
    });
    // A sheet the user brought in by hand while the generation was still running. Its acceptance
    // is stamped with the store's clock, which is after the job's createdAt below.
    const store = provider.openStore()!;
    const sheet = store.getBundle().sheets.find((candidate) => candidate.id === "maren-kest")!;
    const uploaded = await recordUploadedCharacterSheetTake(
      store,
      "maren-kest",
      "character-sheet-upload-late.png",
      pngBytes(),
    );
    await acceptCharacterSheet(store, sheet, {
      file: `takes/${uploaded.id}/${uploaded.media}`,
      takeId: uploaded.id,
      sheetVersion: sheet.version,
      artDirectionVersion: store.getBundle().artDirection.version,
      review: referenceReviewDecision(store.now(), uploaded, "accept"),
    });

    const job: Job = {
      id: "jb_01J8E00000000000000000BG9",
      idempotencyKey: "01J8E10000000000000000BG9",
      worldId: WORLD_ID,
      target: { kind: "character-sheet", id: "maren-kest/late" },
      capability: "image",
      provider: "fal",
      model: "flux-2-pro",
      params: {
        prompt: "one composite",
        provenance: {
          canonRevision: 42,
          sheets: { "maren-kest": sheet.version },
          artDirectionVersion: 3,
          anchorFile: "head-front.png",
        },
      },
      estimatedMicroUsd: 47000,
      status: "succeeded",
      providerJobId: "remote-late",
      attempt: 1,
      landing: { dir: "references/maren-kest/incoming" },
      landedFiles: [landed],
      error: null,
      // Begun before the upload was accepted — which is the whole point.
      createdAt: "2026-08-04T11:00:00.000Z",
      updatedAt: CLOCK,
    };
    await (coordinator as unknown as { onJobTerminal(terminal: Job): Promise<void> }).onJobTerminal(job);

    const kit = JSON.parse(await readFile(join(worldDir, "references", "maren-kest", "kit.json"), "utf8")) as {
      designatedCompilation?: string;
    };
    assert.equal(
      kit.designatedCompilation,
      `takes/${uploaded.id}/${uploaded.media}`,
      "the later human choice keeps the slot",
    );
    // Nothing is lost: the generated take is still recorded, and still offerable for review.
    const takes = await readdir(join(worldDir, "references", "maren-kest", "takes"));
    assert.ok(takes.includes(`tk_${job.id.slice(3)}`), "the generated take is still on disk");
    const reviews = await readFile(join(worldDir, "references", "reviews.jsonl"), "utf8").catch(() => "");
    assert.equal(reviews.includes(`tk_${job.id.slice(3)}`), false, "and is left undecided, not accepted");
    await provider.close();
  });

  /**
   * Every kind the published set names must actually reach the take recorder.
   *
   * This is the test that was missing. `finalize` carried its own inline list of the four kinds
   * that existed when it was written, while contracts published the same list as
   * REFERENCE_FINALIZATION_TARGETS. A fifth was added to the published set and not to the copy,
   * so `location-view-candidate` finalization fell through, recorded nothing, and reported
   * "complete" — the image sat in candidates/ and the accept path was unreachable. It shipped in
   * v0.5.0 and was found by running the app, because nothing here disagreed with it.
   *
   * Driven through the real onJobTerminal rather than asserting on the branch, so a future kind
   * added to the set fails here unless finalization genuinely records its take.
   */
  it("records a take for every reference kind the published set names", async () => {
    for (const kind of REFERENCE_FINALIZATION_TARGETS) {
      const { root, worldDir } = await makeTempRoot();
      const provider = new FsWorldProvider(root, { clock: () => CLOCK });
      await provider.loadWorld(WORLD_ID);
      const sheetId = kind === "location-view-candidate" ? "the-vigil" : "maren-kest";
      const landed = `references/${sheetId}/incoming/${kind}.png`;
      await mkdir(join(worldDir, "references", sheetId, "incoming"), { recursive: true });
      await writeFile(join(worldDir, landed), pngBytes());

      const coordinator = new Coordinator({
        provider,
        adapter: null,
        changeLogPath: join(root, "logs", "changes.jsonl"),
        appVersion: "test",
      });
      const sheetVersion = provider.openStore()?.getBundle().sheets.find((s) => s.id === sheetId)?.version ?? 1;
      const job: Job = {
        id: `jb_01J8E00000000000000000${String([...REFERENCE_FINALIZATION_TARGETS].indexOf(kind)).padStart(3, "0")}`,
        idempotencyKey: `01J8E10000000000000000${String([...REFERENCE_FINALIZATION_TARGETS].indexOf(kind)).padStart(3, "0")}`,
        worldId: WORLD_ID,
        target: { kind, id: `${sheetId}/cover` },
        capability: "image",
        provider: "fal",
        model: "flux-2-pro",
        params: {
          prompt: "one image",
          references: [],
          provenance: { canonRevision: 42, sheets: { [sheetId]: sheetVersion }, artDirectionVersion: 1 },
        },
        estimatedMicroUsd: 47000,
        status: "succeeded",
        providerJobId: `remote-${kind}`,
        attempt: 1,
        landing: { dir: `references/${sheetId}/incoming` },
        landedFiles: [landed],
        error: null,
        createdAt: CLOCK,
        updatedAt: CLOCK,
      };
      await (coordinator as unknown as { onJobTerminal(terminal: Job): Promise<void> }).onJobTerminal(job);

      const takes = await readdir(join(worldDir, "references", sheetId, "takes")).catch(() => [] as string[]);
      assert.ok(
        takes.includes(`tk_${job.id.slice(3)}`),
        `${kind} finalization recorded no take — its image would sit in the landing dir with nothing able to review it`,
      );
      await provider.close();
    }
  });
});
